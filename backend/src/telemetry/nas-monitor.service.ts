import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { isPrimaryInstance } from '../common/cluster-util';

/**
 * NasMonitorService — MRTG-style per-NAS monitoring built on radacct.
 *
 *  • Every 5 minutes it snapshots each NAS: cumulative in/out octets and the
 *    online session count (whole-NAS and per-VLAN). Graphs derive a bit-rate
 *    from the delta between consecutive samples (counter resets clamped to 0).
 *  • It also watches for a sudden drop in a NAS's online count (mass
 *    disconnect / link down) and raises an alert so the operator looks into it.
 */
@Injectable()
export class NasMonitorService {
  private readonly log = new Logger('NasMonitor');
  // Remember each NAS's last online count to detect drops between ticks.
  private lastOnline = new Map<number, number>();

  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sample() {
    if (!isPrimaryInstance()) return;
    try {
      const nases = await this.prisma.nas.findMany({ where: { isActive: true }, select: { id: true, nasIp: true, nasname: true, shortname: true } });
      for (const nas of nases) {
        const ip = nas.nasIp || nas.nasname;
        if (!ip) continue;

        // Whole-NAS snapshot from currently-open sessions.
        const totals = await this.prisma.$queryRaw<Array<{ inb: bigint; outb: bigint; n: number }>>`
          SELECT COALESCE(SUM(acctinputoctets),0)::bigint AS inb,
                 COALESCE(SUM(acctoutputoctets),0)::bigint AS outb,
                 COUNT(*)::int AS n
          FROM radacct
          WHERE acctstoptime IS NULL AND nasipaddress = ${ip}::inet
            AND COALESCE(acctupdatetime, acctstarttime) > NOW() - INTERVAL '15 minutes'`;
        const t = totals[0] || { inb: 0n, outb: 0n, n: 0 };
        await this.prisma.nasTrafficSample.create({
          data: { nasId: nas.id, inBytes: t.inb, outBytes: t.outb, online: Number(t.n), vlan: null },
        });

        // Per-VLAN snapshots (nasportid usually carries the VLAN, e.g. "vlan175").
        const vlans = await this.prisma.$queryRaw<Array<{ vlan: string; inb: bigint; outb: bigint; n: number }>>`
          SELECT COALESCE(nasportid,'-') AS vlan,
                 COALESCE(SUM(acctinputoctets),0)::bigint AS inb,
                 COALESCE(SUM(acctoutputoctets),0)::bigint AS outb,
                 COUNT(*)::int AS n
          FROM radacct
          WHERE acctstoptime IS NULL AND nasipaddress = ${ip}::inet
            AND COALESCE(acctupdatetime, acctstarttime) > NOW() - INTERVAL '15 minutes'
          GROUP BY COALESCE(nasportid,'-')`;
        for (const v of vlans) {
          await this.prisma.nasTrafficSample.create({
            data: { nasId: nas.id, inBytes: v.inb, outBytes: v.outb, online: Number(v.n), vlan: v.vlan.slice(0, 64) },
          });
        }

        // Drop detection: a big fall in online count since last tick = investigate.
        const prev = this.lastOnline.get(nas.id);
        const now = Number(t.n);
        if (prev != null && prev >= 10 && now <= prev * 0.5) {
          this.log.warn(`NAS "${nas.shortname || nas.nasname}" online dropped ${prev} → ${now}`);
          await this.prisma.systemLog.create({
            data: {
              level: 'WARN', source: 'nas-monitor',
              message: `NAS "${nas.shortname || nas.nasname}" (${ip}): online subscribers dropped ${prev} → ${now} in 5 min — possible link/power outage.`,
            },
          }).catch(() => null);
          this.notifications.send({
            channel: 'SYSTEM', event: 'NAS_MASS_DISCONNECT', recipient: 'admin',
            body: `⚠️ ${nas.shortname || nas.nasname}: ${prev - now} subscribers dropped offline in 5 minutes.`,
          } as any).catch(() => null);
        }
        this.lastOnline.set(nas.id, now);
      }
    } catch (e: any) {
      this.log.warn(`NAS sample failed: ${e?.message || e}`);
    }
  }

  /** Nightly: keep the sample table bounded (30 days of history). */
  @Cron('40 3 * * *')
  async prune() {
    if (!isPrimaryInstance()) return;
    await this.prisma.nasTrafficSample.deleteMany({ where: { ts: { lt: new Date(Date.now() - 31 * 86400_000) } } })
      .catch((e) => this.log.warn(`Sample prune failed: ${e?.message || e}`));
  }

  private rangeToInterval(range: string): { since: Date; bucketSec: number } {
    const now = Date.now();
    switch (range) {
      case '1h':  return { since: new Date(now - 3600_000), bucketSec: 300 };
      case '6h':  return { since: new Date(now - 6 * 3600_000), bucketSec: 900 };
      case '30d': return { since: new Date(now - 30 * 86400_000), bucketSec: 6 * 3600 };
      case '7d':
      default:    return { since: new Date(now - 7 * 86400_000), bucketSec: 3600 };
    }
  }

  /** Time-series bit-rate + online count for a NAS (optionally one VLAN). */
  async traffic(nasId: number, range = '7d', vlan?: string) {
    const { since } = this.rangeToInterval(range);
    const rows = await this.prisma.nasTrafficSample.findMany({
      where: { nasId, vlan: vlan ?? null, ts: { gte: since } },
      orderBy: { ts: 'asc' },
      select: { ts: true, inBytes: true, outBytes: true, online: true },
    });

    const points: Array<{ ts: Date; inBps: number; outBps: number; online: number }> = [];
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      const secs = (b.ts.getTime() - a.ts.getTime()) / 1000;
      if (secs <= 0) continue;
      const din = Number(b.inBytes - a.inBytes);
      const dout = Number(b.outBytes - a.outBytes);
      points.push({
        ts: b.ts,
        inBps: Math.max(0, din) * 8 / secs,   // bits per second
        outBps: Math.max(0, dout) * 8 / secs,
        online: b.online,
      });
    }
    const peakIn = points.reduce((m, p) => Math.max(m, p.inBps), 0);
    const peakOut = points.reduce((m, p) => Math.max(m, p.outBps), 0);
    return { nasId, range, vlan: vlan ?? null, points, peakIn, peakOut, samples: rows.length };
  }

  /** Current per-VLAN online + throughput snapshot (latest bucket). */
  async vlanBreakdown(nasId: number) {
    const nas = await this.prisma.nas.findUnique({ where: { id: nasId }, select: { nasIp: true, nasname: true } });
    const ip = nas?.nasIp || nas?.nasname;
    if (!ip) return { nasId, vlans: [] };
    const rows = await this.prisma.$queryRaw<Array<{ vlan: string; n: number; inb: bigint; outb: bigint }>>`
      SELECT COALESCE(nasportid,'-') AS vlan, COUNT(*)::int AS n,
             COALESCE(SUM(acctinputoctets),0)::bigint AS inb,
             COALESCE(SUM(acctoutputoctets),0)::bigint AS outb
      FROM radacct
      WHERE acctstoptime IS NULL AND nasipaddress = ${ip}::inet
        AND COALESCE(acctupdatetime, acctstarttime) > NOW() - INTERVAL '15 minutes'
      GROUP BY COALESCE(nasportid,'-')
      ORDER BY n DESC`;
    return {
      nasId,
      vlans: rows.map((r) => ({ vlan: r.vlan, online: Number(r.n), inBytes: Number(r.inb), outBytes: Number(r.outb) })),
    };
  }
}
