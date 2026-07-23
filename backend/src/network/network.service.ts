import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import { PrismaService } from '../prisma/prisma.service';
import { RadiusSyncService } from '../nas/radius-sync.service';

const execAsync = promisify(exec);

/**
 * Phase 5 network operations. RADIUS tables live in the same Postgres DB,
 * so MAC binding is pure Prisma. Live sessions come from radacct.
 *
 * CoA disconnect uses the `radclient` CLI (freeradius-utils) when present:
 *   RADIUS_SERVER_IP:incomingPort with the NAS secret. If radclient isn't
 *   installed, we still close the session in radacct and report degraded mode.
 */
@Injectable()
export class NetworkService {
  private readonly logger = new Logger(NetworkService.name);

  constructor(
    private prisma: PrismaService,
    private radiusSync: RadiusSyncService,
  ) {}

  // ── Live sessions ─────────────────────────────────────────────
  async liveSessions(nasIp?: string) {
    const rows = await this.radiusSync.getActiveSessions(nasIp).catch(() => []);
    if (!rows.length) return [];
    const usernames = [...new Set(rows.map((r: any) => r.username).filter(Boolean))];
    const subs = await this.prisma.subscriber.findMany({
      where: { username: { in: usernames } },
      select: { id: true, username: true, fullName: true, phone: true, package: { select: { name: true } } },
    });
    const byUsername = new Map(subs.map((s) => [s.username, s]));
    return rows.map((r: any) => {
      const sub = byUsername.get(r.username);
      const up = Number(r.upload_bytes || 0);
      const down = Number(r.download_bytes || 0);
      const secs = Number(r.duration_seconds || 0);
      return {
        username: r.username,
        subscriberId: sub?.id ?? null,
        fullName: sub?.fullName ?? null,
        phone: sub?.phone ?? null,
        package: sub?.package?.name ?? null,
        nasIp: r.nasipaddress,
        framedIp: r.framedipaddress,
        mac: r.callingstationid,
        startTime: r.acctstarttime,
        durationSeconds: secs,
        uploadBytes: up,
        downloadBytes: down,
        // rough live throughput = total bytes / session seconds
        rateBps: secs > 0 ? Math.round(((up + down) * 8) / secs) : 0,
      };
    });
  }

  async liveStats() {
    const sessions = await this.liveSessions();
    const totalUp = sessions.reduce((a, s) => a + s.uploadBytes, 0);
    const totalDown = sessions.reduce((a, s) => a + s.downloadBytes, 0);
    return {
      online: sessions.length,
      knownSubscribers: sessions.filter((s) => s.subscriberId).length,
      totalUploadBytes: totalUp,
      totalDownloadBytes: totalDown,
      topTalkers: [...sessions].sort((a, b) => b.rateBps - a.rateBps).slice(0, 5),
    };
  }

  // ── CoA disconnect ────────────────────────────────────────────
  async disconnect(username: string) {
    // find the live session to get NAS IP + acct session id
    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT acctsessionid, nasipaddress, framedipaddress
      FROM radacct WHERE username = ${username} AND acctstoptime IS NULL
      ORDER BY acctstarttime DESC LIMIT 1`;
    if (!rows.length) throw new BadRequestException('No active session for this user');
    const session = rows[0];

    const nas = await this.prisma.nas.findFirst({ where: { nasIp: session.nasipaddress } });
    const secret = nas?.secret || 'testing123';
    const coaPort = nas?.incomingPort && nas.incomingPort !== 1812 && nas.incomingPort !== 1813 ? nas.incomingPort : 3799;

    let method = 'radacct-only';
    try {
      const payload = [
        `User-Name=${username}`,
        `Acct-Session-Id=${session.acctsessionid}`,
        `NAS-IP-Address=${session.nasipaddress}`,
      ].join(',');
      const cmd = `echo "${payload}" | radclient -x ${session.nasipaddress}:${coaPort} disconnect "${secret}"`;
      await execAsync(cmd, { timeout: 8000 });
      method = 'coa';
      this.logger.log(`CoA disconnect sent for ${username} → ${session.nasipaddress}:${coaPort}`);
    } catch (e: any) {
      this.logger.warn(`radclient CoA unavailable (${e.message?.split('\n')[0]}); closing session in DB only`);
    }

    // always close the session record so dashboards reflect reality
    await this.prisma.$executeRaw`
      UPDATE radacct SET acctstoptime = NOW(), acctterminatecause = 'Admin-Reset'
      WHERE acctsessionid = ${session.acctsessionid} AND acctstoptime IS NULL`;

    await this.prisma.activityLog.create({
      data: { action: 'DISCONNECT', entity: 'Session', details: `${username} via ${method}` },
    });
    return { disconnected: true, method };
  }

  // ── MAC binding (radcheck Calling-Station-Id) ─────────────────
  async getMacBinding(username: string) {
    const rows = await this.prisma.radCheck.findMany({
      where: { username, attribute: 'Calling-Station-Id' },
      select: { value: true },
    });
    return { username, boundMacs: rows.map((r) => r.value) };
  }

  async bindMac(username: string, mac: string) {
    const clean = (mac || '').trim().toUpperCase();
    if (!/^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/.test(clean)) {
      throw new BadRequestException('Invalid MAC address (expected AA:BB:CC:DD:EE:FF)');
    }
    const sub = await this.prisma.subscriber.findUnique({ where: { username } });
    if (!sub) throw new BadRequestException('Subscriber not found');

    const exists = await this.prisma.radCheck.findFirst({
      where: { username, attribute: 'Calling-Station-Id', value: clean },
    });
    if (exists) return { bound: true, already: true };

    await this.prisma.radCheck.create({
      data: { username, attribute: 'Calling-Station-Id', op: '==', value: clean },
    });
    await this.prisma.serviceSettings.updateMany({ where: { subscriberId: sub.id }, data: { macAddress: clean } });
    await this.prisma.activityLog.create({
      data: { action: 'MAC_BIND', entity: 'Subscriber', entityId: sub.id, details: `${username} → ${clean}` },
    });
    return { bound: true };
  }

  async unbindMac(username: string, mac?: string) {
    await this.prisma.radCheck.deleteMany({
      where: { username, attribute: 'Calling-Station-Id', ...(mac ? { value: mac.toUpperCase() } : {}) },
    });
    await this.prisma.activityLog.create({
      data: { action: 'MAC_UNBIND', entity: 'Subscriber', details: `${username}${mac ? ` → ${mac}` : ' (all)'}` },
    });
    return { unbound: true };
  }

  /** Auto-learn: bind the MAC currently seen in the live session. */
  async autolearnMac(username: string) {
    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT callingstationid FROM radacct
      WHERE username = ${username} AND acctstoptime IS NULL AND callingstationid IS NOT NULL
      ORDER BY acctstarttime DESC LIMIT 1`;
    if (!rows.length || !rows[0].callingstationid) {
      throw new BadRequestException('No active session with a MAC to learn from');
    }
    return this.bindMac(username, rows[0].callingstationid);
  }
}
