import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { isPrimaryInstance } from '../common/cluster-util';

/**
 * DemoService — self-serve sandbox accounts.
 *
 * A demo account is a real RESELLER (franchise) user, so it can do ALL franchise
 * work: create subscribers, downline users, NAS, run activation/billing, etc.
 * It is blocked from console / RADIUS admin / logs (BlockDemoGuard + role gates)
 * so nothing sensitive leaks. The whole account and everything it created is
 * auto-deleted 7 days after creation, so demo data never persists.
 */
@Injectable()
export class DemoService {
  private readonly log = new Logger('Demo');
  private static readonly DAYS = 7;

  constructor(private prisma: PrismaService) {}

  /** How many demo accounts are currently live — used to cap public creation. */
  async liveCount(): Promise<number> {
    return this.prisma.user.count({ where: { isDemo: true } }).catch(() => 0);
  }

  /** Create a fresh demo franchise account and return its login credentials. */
  async create() {
    const rand = Math.random().toString(36).slice(2, 8);
    const email = `demo-${rand}@demo.jointbox`;
    const password = `Demo-${Math.random().toString(36).slice(2, 8)}`;
    const hash = await bcrypt.hash(password, 10);
    const expiresAt = new Date(Date.now() + DemoService.DAYS * 86400_000);

    const user = await this.prisma.user.create({
      data: {
        name: `Demo Franchise ${rand}`,
        email,
        password: hash,
        role: 'RESELLER',
        isActive: true,
        isDemo: true,
        demoExpiresAt: expiresAt,
        // Full franchise powers so the demo can exercise everything.
        canAddNas: true,
        canTopupDownline: true,
        canSetPackagePrice: true,
        balance: 100000, // sandbox wallet so activation/billing works
      },
      select: { id: true, email: true },
    });

    this.log.log(`Demo account #${user.id} created (${email}) — expires ${expiresAt.toISOString()}`);
    return {
      email,
      password,
      role: 'Franchise (demo)',
      expiresAt,
      note: 'This is a sandbox. Everything you create is automatically deleted after 7 days. Console, RADIUS admin and logs are disabled.',
    };
  }

  /** Daily: delete demo accounts past their expiry, and everything they made. */
  @Cron('30 3 * * *')
  async cleanupExpired() {
    if (!isPrimaryInstance()) return;
    const expired = await this.prisma.user.findMany({
      where: { isDemo: true, demoExpiresAt: { lt: new Date() } },
      select: { id: true, email: true },
    });
    for (const demo of expired) {
      await this.purgeAccount(demo.id).catch((e) =>
        this.log.warn(`Demo purge failed for #${demo.id}: ${e?.message || e}`));
    }
    if (expired.length) this.log.log(`Demo cleanup: removed ${expired.length} expired account(s).`);
    return { removed: expired.length };
  }

  /** Best-effort delete of a demo account's whole footprint (FK-safe order). */
  async purgeAccount(rootId: number) {
    // The demo account + any downline it created.
    const subtree = await this.prisma.$queryRaw<Array<{ id: number }>>`
      WITH RECURSIVE t AS (
        SELECT id FROM "User" WHERE id = ${rootId}
        UNION ALL SELECT u.id FROM "User" u JOIN t ON u."parentId" = t.id
      ) SELECT id FROM t`;
    const userIds = subtree.map((r) => r.id);
    if (!userIds.length) return;

    // Subscribers owned anywhere in the demo subtree.
    const subs = await this.prisma.subscriber.findMany({ where: { userId: { in: userIds } }, select: { id: true, username: true } });
    const subIds = subs.map((s) => s.id);
    const usernames = subs.map((s) => s.username).filter(Boolean);

    // 1) Strip RADIUS rows for those subscribers (no auth leftovers).
    if (usernames.length) {
      await this.prisma.$executeRawUnsafe(`DELETE FROM radcheck WHERE username = ANY($1)`, usernames).catch(() => null);
      await this.prisma.$executeRawUnsafe(`DELETE FROM radreply WHERE username = ANY($1)`, usernames).catch(() => null);
      await this.prisma.$executeRawUnsafe(`DELETE FROM radacct WHERE username = ANY($1)`, usernames).catch(() => null);
    }
    // 2) Child records of those subscribers, then the subscribers.
    if (subIds.length) {
      for (const model of ['payment', 'invoice', 'serviceSettings', 'balanceTransaction', 'temporaryBoost', 'activityLog'] as const) {
        await (this.prisma as any)[model]?.deleteMany?.({ where: { subscriberId: { in: subIds } } }).catch(() => null);
      }
      await this.prisma.subscriber.deleteMany({ where: { id: { in: subIds } } }).catch((e) => this.log.warn(`sub delete: ${e?.message}`));
    }
    // 3) NAS owned by the demo subtree.
    await this.prisma.nas.deleteMany({ where: { ownerId: { in: userIds } } }).catch(() => null);
    // 4) The demo users themselves (children first via ordering by depth is
    //    unnecessary — SetNull/Cascade FKs handle parent links).
    await this.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch((e) => this.log.warn(`user delete: ${e?.message}`));
  }
}
