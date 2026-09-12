import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LicenceService, licensingDisabled } from './licence.service';
import { isPrimaryInstance } from '../common/cluster-util';

/**
 * Publishes subscriber and NAS counts for the licence agent's heartbeat.
 *
 * The agent has no database credentials and cannot read subscriber data even
 * in principle — it reads a two-integer file this service writes. That is
 * deliberate: the only thing that ever leaves an ISP's server is two numbers.
 *
 * The counts are UNSCOPED on purpose. Everywhere else in the app counts are
 * filtered through ScopeService to a reseller's subtree; here we want the true
 * total for the whole installation, which is what the plan tier is sold
 * against.
 */
@Injectable()
export class LicenceCountsService {
  private readonly log = new Logger(LicenceCountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly licence: LicenceService,
  ) {}

  /**
   * Hourly is plenty — the agent only reports every 6 hours, and a subscriber
   * count that is an hour stale changes no decision anyone makes.
   */
  @Cron('7 * * * *')
  async publish(): Promise<void> {
    // Same gate every other cron in this codebase uses, so a pm2 cluster does
    // not have four processes writing the same file.
    if (!isPrimaryInstance()) return;
    if (licensingDisabled()) return;

    await this.publishNow();
  }

  /** Also run once at boot so the first heartbeat has real numbers. */
  async onApplicationBootstrap(): Promise<void> {
    if (!isPrimaryInstance()) return;
    if (licensingDisabled()) return;
    await this.publishNow();
  }

  async publishNow(): Promise<void> {
    try {
      const [subscribers, nas] = await Promise.all([
        this.prisma.subscriber.count(),
        this.prisma.nas.count(),
      ]);
      this.licence.publishCounts(subscribers, nas);
    } catch (err) {
      // Never let a counting failure surface anywhere. This is telemetry for
      // billing conversations, not a critical path.
      this.log.debug(`could not publish licence counts: ${(err as Error).message}`);
    }
  }
}
