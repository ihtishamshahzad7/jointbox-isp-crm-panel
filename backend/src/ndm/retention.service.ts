import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { isPrimaryInstance } from '../common/cluster-util';

/**
 * Retention service — nightly pruning so the raw feed stays within the
 * promised windows (raw syslog 30d, interface traffic history 90d,
 * device health + network events 1y). Alerts are deliberately never pruned:
 * they are the audit trail.
 *
 * All thresholds come from env with the defaults baked in:
 *   NDM_SYSLOG_RETENTION_DAYS   (30)
 *   NDM_TRAFFIC_RETENTION_DAYS  (90)
 *   NDM_HISTORY_RETENTION_DAYS  (365)
 */
@Injectable()
export class NdmRetentionService {
  private readonly log = new Logger('NdmRetention');

  constructor(private prisma: PrismaService) {}

  @Cron('40 3 * * *')
  async prune() {
    if (!isPrimaryInstance()) return;
    const syslogDays = int(process.env.NDM_SYSLOG_RETENTION_DAYS, 30);
    const trafficDays = int(process.env.NDM_TRAFFIC_RETENTION_DAYS, 90);
    const historyDays = int(process.env.NDM_HISTORY_RETENTION_DAYS, 365);
    const now = Date.now();

    const jobs: { name: string; days: number; run: () => Promise<{ count: number }> }[] = [
      {
        name: 'syslog', days: syslogDays,
        run: () => this.prisma.syslogEvent.deleteMany({ where: { receivedAt: { lt: new Date(now - syslogDays * 86400_000) } } }),
      },
      {
        name: 'interface traffic history', days: trafficDays,
        run: () => this.prisma.interfaceTrafficHistory.deleteMany({ where: { at: { lt: new Date(now - trafficDays * 86400_000) } } }),
      },
      {
        name: 'device health history', days: historyDays,
        run: () => this.prisma.deviceHealthMetric.deleteMany({ where: { ts: { lt: new Date(now - historyDays * 86400_000) } } }),
      },
      {
        name: 'resolved network events', days: historyDays,
        run: () => this.prisma.networkEvent.deleteMany({ where: { status: 'CLEARED', resolvedAt: { lt: new Date(now - historyDays * 86400_000) } } }),
      },
    ];
    for (const j of jobs) {
      try {
        const { count } = await j.run();
        if (count > 0) this.log.log(`Retention: pruned ${count} ${j.name} row(s) older than ${j.days}d`);
      } catch (e: any) {
        this.log.warn(`Retention ${j.name} failed: ${e?.message || e}`);
      }
    }
  }
}

function int(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}