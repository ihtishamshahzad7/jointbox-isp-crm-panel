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

  // ── Shared public demo ────────────────────────────────────────────────────
  // One published login that anyone can use, as opposed to a fresh throwaway
  // account per visitor. Its credentials are fixed so they can be printed on a
  // website, and its DATA is wiped weekly rather than the account itself —
  // deleting the account would break every link that points at it.
  private get sharedEmail() { return (process.env.DEMO_EMAIL || 'demo@jointbox.net').toLowerCase(); }
  private get sharedPassword() { return process.env.DEMO_PASSWORD || 'JointboxDemo2026'; }

  /** The credentials to publish. Safe to call from an unauthenticated route. */
  publicCredentials() {
    return {
      enabled: process.env.DEMO_PUBLIC !== '0',
      email: this.sharedEmail,
      password: this.sharedPassword,
      role: 'Franchise (sandbox)',
      note:
        'Shared demo. You see only this sandbox account\'s own data — never a real ' +
        'customer\'s. Server console, RADIUS admin and system logs are disabled, and ' +
        'everything created here is wiped every week.',
    };
  }

  /**
   * Create the shared demo account if it is missing, and keep its password in
   * step with the environment. Runs at boot.
   *
   * `demoExpiresAt` is set far in the future ON PURPOSE: the nightly purge
   * deletes expired demo accounts, and this one must survive that. Its content
   * is cleared by resetShared() instead.
   */
  async ensureShared() {
    if (process.env.DEMO_PUBLIC === '0') return;
    const hash = await bcrypt.hash(this.sharedPassword, 10);
    const far = new Date(Date.now() + 3650 * 86400_000);
    const existing = await this.prisma.user.findFirst({
      where: { email: this.sharedEmail },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.user.update({
        where: { id: existing.id },
        data: { password: hash, isDemo: true, isActive: true, demoExpiresAt: far },
      });
      return;
    }
    const u = await this.prisma.user.create({
      data: {
        name: 'Jointbox Demo',
        email: this.sharedEmail,
        password: hash,
        role: 'RESELLER',
        isActive: true,
        isDemo: true,
        demoExpiresAt: far,
        canAddNas: true,
        canTopupDownline: true,
        canSetPackagePrice: true,
        balance: 100000,
      },
      select: { id: true },
    });
    this.log.log(`Shared public demo account ready (#${u.id}, ${this.sharedEmail})`);
  }

  /** Weekly: wipe what visitors made in the shared demo, keep the account. */
  @Cron('0 4 * * 1')
  async resetShared() {
    if (!isPrimaryInstance() || process.env.DEMO_PUBLIC === '0') return;
    const u = await this.prisma.user.findFirst({
      where: { email: this.sharedEmail, isDemo: true },
      select: { id: true },
    });
    if (!u) return;
    // purgeAccount removes the subtree the account created. Passing its own id
    // would delete the account too, so clear the children and reset the wallet.
    const kids = await this.prisma.user.findMany({
      where: { parentId: u.id }, select: { id: true },
    });
    for (const k of kids) await this.purgeAccount(k.id).catch(() => null);
    await this.purgeSubscribersOf(u.id).catch(() => null);
    await this.prisma.user.update({ where: { id: u.id }, data: { balance: 100000 } }).catch(() => null);
    this.log.log('Shared demo account reset for the week.');
  }

  /** Delete just the subscribers belonging to one account (not the account). */
  private async purgeSubscribersOf(userId: number) {
    const subs = await this.prisma.subscriber.findMany({
      where: { userId }, select: { id: true },
    });
    if (!subs.length) return;
    const ids = subs.map((s) => s.id);
    await this.prisma.subscriber.deleteMany({ where: { id: { in: ids } } }).catch(() => null);
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
