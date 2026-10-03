import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LicenceService, licensingDisabled } from './licence.service';
import { isPrimaryInstance } from '../common/cluster-util';
import { NON_DEMO_OWNED, NON_DEMO_SUBSCRIBER } from '../common/scope.service';

/**
 * Publishes subscriber, NAS, dealer and company counts for the licence
 * agent's heartbeat.
 *
 * The agent has no database credentials and cannot read subscriber data even
 * in principle — it reads a small file of integers this service writes. That
 * is deliberate: the only thing that ever leaves an ISP's server is counts —
 * never a name, a number or an address.
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
      /**
       * Unscoped across tenants — the plan is sold for the installation — but
       * NEVER including the demo sandbox. It seeds 10,000 subscribers and 500
       * routers, and these two numbers are what the licence server bills and
       * caps on: a server with 16 real customers was reported as 10,016 and
       * flagged "over plan" on a 25-subscriber trial.
       */
      const [subscribers, nas, dealers, companies] = await Promise.all([
        this.prisma.subscriber.count({ where: NON_DEMO_SUBSCRIBER as any }),
        this.prisma.nas.count({ where: NON_DEMO_OWNED as any }),
        // The reseller network: franchise, dealer, sub-dealer. Suspended
        // accounts still count — they exist and can be switched back on.
        this.prisma.user.count({
          where: {
            role: {
              in: [UserRole.RESELLER, UserRole.SUB_RESELLER, UserRole.RETAILER],
            },
            isDemo: false,
          },
        }),
        // ISP companies hosted under the platform owner (multi-tenancy).
        this.prisma.user.count({
          where: { role: UserRole.ADMIN, isDemo: false },
        }),
      ]);
      this.licence.publishCounts(subscribers, nas, dealers, companies);
    } catch (err) {
      // Never let a counting failure surface anywhere. This is telemetry for
      // billing conversations, not a critical path.
      this.log.debug(`could not publish licence counts: ${(err as Error).message}`);
    }
  }
}
