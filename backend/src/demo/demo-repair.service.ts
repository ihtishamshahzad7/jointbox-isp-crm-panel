import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { DemoService } from './demo.service';
import { isPrimaryInstance } from '../common/cluster-util';

/**
 * Keeps the shared demo account usable after hierarchy distribution.
 *
 * The hierarchy is still created for demonstration, but the shared demo login
 * must be able to show the complete synthetic dataset. This repair only ever
 * touches rows owned by demo accounts and never changes real-tenant rows.
 */
@Injectable()
export class DemoRepairService implements OnModuleInit {
  private readonly log = new Logger('DemoRepair');

  constructor(
    private readonly prisma: PrismaService,
    private readonly demo: DemoService,
  ) {}

  async onModuleInit() {
    // DemoService also initializes on module startup. Delay this repair so its
    // normal seed/hierarchy pass can finish before ownership is normalized.
    setTimeout(() => this.repair().catch((e) => this.log.warn(`Demo repair failed: ${e?.message || e}`)), 5000);
  }

  private async repair() {
    if (process.env.DEMO_PUBLIC === '0') return;

    await this.demo.ensureShared();
    const email = (process.env.DEMO_EMAIL || 'demo@jointbox.net').trim().toLowerCase();
    const root = await this.prisma.user.findFirst({ where: { email, isDemo: true }, select: { id: true } });
    if (!root) return;

    const rows = await this.prisma.$queryRaw<Array<{ id: number }>>`
      WITH RECURSIVE t AS (
        SELECT id FROM "User" WHERE id = ${root.id} AND "isDemo" = true
        UNION ALL
        SELECT u.id FROM "User" u JOIN t ON u."parentId" = t.id WHERE u."isDemo" = true
      )
      SELECT id FROM t`;
    const ids = rows.map((r) => Number(r.id));
    if (!ids.length) return;

    const [subscriberCount, nasCount, poolCount, packageCount, areaCount] = await Promise.all([
      this.prisma.subscriber.count({ where: { userId: { in: ids } } }),
      this.prisma.nas.count({ where: { ownerId: { in: ids } } }),
      this.prisma.ipPool.count({ where: { ownerId: { in: ids } } }),
      this.prisma.package.count({ where: { ownerId: { in: ids } } }),
      this.prisma.area.count({ where: { ownerId: { in: ids } } }),
    ]);

    // Normalize ownership back to the shared demo root so the existing
    // production ScopeService exposes the entire demo dataset to demo@...
    // without weakening isolation for real users.
    if (subscriberCount) await this.prisma.subscriber.updateMany({ where: { userId: { in: ids }, NOT: { userId: root.id } }, data: { userId: root.id } });
    if (nasCount) await this.prisma.nas.updateMany({ where: { ownerId: { in: ids }, NOT: { ownerId: root.id } }, data: { ownerId: root.id } });
    if (poolCount) await this.prisma.ipPool.updateMany({ where: { ownerId: { in: ids }, NOT: { ownerId: root.id } }, data: { ownerId: root.id } });
    if (packageCount) await this.prisma.package.updateMany({ where: { ownerId: { in: ids }, NOT: { ownerId: root.id } }, data: { ownerId: root.id } });
    if (areaCount) await this.prisma.area.updateMany({ where: { ownerId: { in: ids }, NOT: { ownerId: root.id } }, data: { ownerId: root.id } });

    this.log.log(`Shared demo visibility repaired for #${root.id}: ${subscriberCount} subscribers, ${nasCount} NAS, ${poolCount} pools, ${packageCount} packages, ${areaCount} areas.`);

    await this.revokeDemoRadiusCredentials();

    /**
     * Refresh immediately, not only on the next cron tick.
     *
     * The cron keeps the sandbox alive from then on, but it fires on the
     * wall clock: a panel restarted or re-seeded at 16:57 would show a busy
     * network for fifteen minutes and an empty one until the tick after that.
     * Whoever restarted it is looking at the screen right now, so this is
     * exactly the window that must not be dark.
     */
    const refreshed = await this.refreshDemoSessions();
    this.log.log(
      refreshed
        ? `Demo live sessions refreshed at boot: ${refreshed} session(s) now reporting as online.`
        : `Demo live sessions: nothing to refresh (no open radacct rows owned by a demo account).`,
    );
  }

  /**
   * Delete any RADIUS credentials a previous seed wrote for demo subscribers.
   *
   * The seeder used to fill `radcheck` with `Cleartext-Password` rows and
   * `radreply` with addresses. Those tables are FreeRADIUS's, not the panel's:
   * it reads them straight from Postgres on every authentication, keyed by
   * username alone, with no owner column and no awareness of demo accounts. So
   * what the sandbox actually created was ten thousand working subscriber
   * logins on the production RADIUS server, with a password anyone could derive
   * after seeing one of them.
   *
   * Removing the seeding stops new ones. This removes the ones already written,
   * because a fix that only applies to future installs leaves every existing
   * one exposed — and nobody re-reads a seeder to find out.
   *
   * The match goes through Subscriber → User.isDemo rather than a `demo-%`
   * username pattern. A pattern would delete the credentials of any real
   * customer whose username happens to start with "demo", which would take that
   * customer off the network — a far worse outcome than the one being fixed.
   */
  async revokeDemoRadiusCredentials(): Promise<{ radcheck: number; radreply: number }> {
    const scope = `
      username IN (
        SELECT s.username FROM "Subscriber" s
        JOIN "User" u ON u.id = s."userId"
        WHERE u."isDemo" = true AND s.username IS NOT NULL
      )`;
    const radcheck = await this.prisma.$executeRawUnsafe(`DELETE FROM radcheck WHERE ${scope}`).catch(() => 0);
    const radreply = await this.prisma.$executeRawUnsafe(`DELETE FROM radreply WHERE ${scope}`).catch(() => 0);
    if (radcheck || radreply) {
      this.log.warn(
        `Revoked demo RADIUS credentials: ${radcheck} radcheck and ${radreply} radreply row(s). ` +
        `These were valid logins on the live RADIUS server; they are now gone.`,
      );
    }
    return { radcheck: Number(radcheck), radreply: Number(radreply) };
  }

  /**
   * Keep the sandbox looking like a live network.
   *
   * "Online now" counts a session only if the NAS reported on it within the
   * last 15 minutes — correct for a real network, where an un-updated session
   * means the router stopped talking. But nothing updates a SEEDED session, so
   * the demo showed ~2,500 users online for a quarter of an hour after the
   * weekly reset and then an empty network for the rest of the week. A visitor
   * evaluating the product almost always arrived during the empty part.
   *
   * So the demo's own sessions get their accounting refreshed on the same
   * cadence a real NAS would use. Counters advance by a per-row amount as well,
   * because a live graph that holds a perfectly flat line reads as broken just
   * as clearly as an empty one does.
   *
   * Every row touched is reached through `User.isDemo = true`; a real session
   * cannot match this statement.
   */
  @Cron('*/5 * * * *')
  async refreshDemoSessions(): Promise<number> {
    if (!isPrimaryInstance() || process.env.DEMO_PUBLIC === '0') return 0;
    const updated = await this.prisma.$executeRawUnsafe(`
      UPDATE radacct a
      SET acctupdatetime  = NOW(),
          acctsessiontime = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - a.acctstarttime))::bigint),
          acctinputoctets  = COALESCE(a.acctinputoctets, 0)  + ((a.radacctid % 97) + 3) * 1500000,
          acctoutputoctets = COALESCE(a.acctoutputoctets, 0) + ((a.radacctid % 89) + 5) * 6000000
      FROM "Subscriber" s
      JOIN "User" u ON u.id = s."userId"
      WHERE a.username = s.username
        AND u."isDemo" = true
        AND a.acctstoptime IS NULL
        AND a.acctstarttime IS NOT NULL
    `).catch((e) => { this.log.warn(`Demo session refresh failed: ${e?.message || e}`); return 0; });
    // Debug on the cron path so twelve ticks an hour do not fill the log; the
    // boot path above logs at info, which is where an operator looks first.
    this.log.debug(`Demo session refresh touched ${Number(updated)} row(s).`);
    return Number(updated);
  }
}
