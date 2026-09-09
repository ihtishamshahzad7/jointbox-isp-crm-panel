import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { isPrimaryInstance } from '../common/cluster-util';
import { DemoDataService } from './demo-data.service';

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
export class DemoService implements OnModuleInit {
  private readonly log = new Logger('Demo');
  private static readonly DAYS = 7;

  constructor(
    private prisma: PrismaService,
    private readonly demoData: DemoDataService,
  ) {}

  /** Keep the published demo login and its realistic sandbox synchronized whenever the backend starts. */
  async onModuleInit() {
    await this.ensureShared().catch((e) =>
      this.log.warn(`Shared demo initialization failed: ${e?.message || e}`),
    );
  }

  async liveCount(): Promise<number> {
    return this.prisma.user.count({ where: { isDemo: true } }).catch(() => 0);
  }

  /** Create a fresh demo franchise account and return exactly what the login UI needs. */
  async create() {
    // Generate a fresh login and retry if an extremely unlikely random collision occurs.
    for (let attempt = 0; attempt < 3; attempt++) {
      const rand = Math.random().toString(36).slice(2, 8);
      const email = `demo-${rand}@demo.jointbox`;
      const password = `Demo-${Math.random().toString(36).slice(2, 8)}`;
      const hash = await bcrypt.hash(password, 10);
      const expiresAt = new Date(Date.now() + DemoService.DAYS * 86400_000);

      try {
        const user = await this.prisma.user.create({
          data: {
            name: `Demo Franchise ${rand}`,
            email,
            password: hash,
            role: 'RESELLER',
            isActive: true,
            isDemo: true,
            demoExpiresAt: expiresAt,
            canAddNas: true,
            canTopupDownline: true,
            canSetPackagePrice: true,
            balance: 100000,
          },
          select: { id: true, email: true },
        });

        // Build a complete synthetic ISP sandbox before returning credentials.
        // The login screen therefore never lands in an empty dashboard.
        const dataset = await this.demoData.seedForUser(user.id, 10_000);

        this.log.log(`Demo account #${user.id} created (${email}) — expires ${expiresAt.toISOString()}`);
        return {
          email: user.email,
          username: user.email,
          password,
          role: 'Franchise (demo)',
          expiresAt,
          dataset,
          credentials: { email: user.email, username: user.email, password },
          note: 'This is a sandbox with synthetic Pakistan ISP data: 500 NAS, 20 areas, 50 IP pools, 12 packages, 10,000 subscribers, active sessions and traffic/signal graphs. Everything you create is automatically deleted after 7 days. Console, RADIUS admin and logs are disabled.',
        };
      } catch (e: any) {
        // A random collision on the unique email is safe to retry; other DB
        // errors must surface to the frontend rather than returning unusable credentials.
        if (e?.code !== 'P2002' || attempt === 2) throw e;
      }
    }
    throw new Error('Unable to create a unique demo account');
  }

  private get sharedEmail() { return (process.env.DEMO_EMAIL || 'demo@jointbox.net').trim().toLowerCase(); }
  private get sharedPassword() { return process.env.DEMO_PASSWORD || 'JointboxDemo2026'; }

  publicCredentials() {
    return {
      enabled: process.env.DEMO_PUBLIC !== '0',
      email: this.sharedEmail,
      username: this.sharedEmail,
      password: this.sharedPassword,
      role: 'Franchise (sandbox)',
      note: 'Shared demo. You see only this sandbox account\'s own synthetic data — never a real customer\'s.',
    };
  }

  async ensureShared() {
    if (process.env.DEMO_PUBLIC === '0') return;
    const hash = await bcrypt.hash(this.sharedPassword, 10);
    const far = new Date(Date.now() + 3650 * 86400_000);
    const existing = await this.prisma.user.findFirst({ where: { email: this.sharedEmail }, select: { id: true } });
    let userId: number;
    if (existing) {
      userId = existing.id;
      await this.prisma.user.update({
        where: { id: existing.id },
        data: { password: hash, isDemo: true, isActive: true, demoExpiresAt: far, role: 'RESELLER', canAddNas: true, canTopupDownline: true, canSetPackagePrice: true },
      });
    } else {
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
      userId = u.id;
      this.log.log(`Shared public demo account ready (#${u.id}, ${this.sharedEmail})`);
    }

    // Existing installations may have the account but no sandbox records.
    // seedForUser is idempotent and repairs a partial demo dataset.
    const dataset = await this.demoData.seedForUser(userId, 10_000).catch((e) => {
      this.log.warn(`Demo dataset seed failed for #${userId}: ${e?.message || e}`);
      return null;
    });
    if (dataset?.seeded) this.log.log(`Shared demo dataset ready: ${JSON.stringify(dataset)}`);
  }

  @Cron('0 4 * * 1')
  async resetShared() {
    if (!isPrimaryInstance() || process.env.DEMO_PUBLIC === '0') return;
    const u = await this.prisma.user.findFirst({ where: { email: this.sharedEmail, isDemo: true }, select: { id: true } });
    if (!u) return;
    const kids = await this.prisma.user.findMany({ where: { parentId: u.id }, select: { id: true } });
    for (const k of kids) await this.purgeAccount(k.id).catch(() => null);
    await this.demoData.resetForUser(u.id).catch((e) => this.log.warn(`Shared demo dataset reset failed: ${e?.message || e}`));
    await this.prisma.user.update({ where: { id: u.id }, data: { balance: 100000, isActive: true } }).catch(() => null);
    this.log.log('Shared demo account and synthetic ISP dataset reset for the week.');
  }

  private async purgeSubscribersOf(userId: number) {
    const subs = await this.prisma.subscriber.findMany({ where: { userId }, select: { id: true, username: true } });
    if (!subs.length) return;
    const ids = subs.map((s) => s.id);
    const usernames = subs.map((s) => s.username).filter(Boolean);
    if (usernames.length) {
      await this.prisma.$executeRawUnsafe(`DELETE FROM radcheck WHERE username = ANY($1)`, usernames).catch(() => null);
      await this.prisma.$executeRawUnsafe(`DELETE FROM radreply WHERE username = ANY($1)`, usernames).catch(() => null);
      await this.prisma.$executeRawUnsafe(`DELETE FROM radacct WHERE username = ANY($1)`, usernames).catch(() => null);
    }
    await this.prisma.subscriberTrafficSample.deleteMany({ where: { subscriberId: { in: ids } } }).catch(() => null);
    await this.prisma.linkSignal.deleteMany({ where: { subscriberId: { in: ids } } }).catch(() => null);
    await this.prisma.subscriber.deleteMany({ where: { id: { in: ids } } }).catch(() => null);
  }

  @Cron('30 3 * * *')
  async cleanupExpired() {
    if (!isPrimaryInstance()) return;
    const expired = await this.prisma.user.findMany({ where: { isDemo: true, demoExpiresAt: { lt: new Date() } }, select: { id: true, email: true } });
    for (const demo of expired) await this.purgeAccount(demo.id).catch((e) => this.log.warn(`Demo purge failed for #${demo.id}: ${e?.message || e}`));
    if (expired.length) this.log.log(`Demo cleanup: removed ${expired.length} expired account(s).`);
    return { removed: expired.length };
  }

  async purgeAccount(rootId: number) {
    const subtree = await this.prisma.$queryRaw<Array<{ id: number }>>`
      WITH RECURSIVE t AS (
        SELECT id FROM "User" WHERE id = ${rootId}
        UNION ALL SELECT u.id FROM "User" u JOIN t ON u."parentId" = t.id
      ) SELECT id FROM t`;
    const userIds = subtree.map((r) => r.id);
    if (!userIds.length) return;

    const subs = await this.prisma.subscriber.findMany({ where: { userId: { in: userIds } }, select: { id: true, username: true } });
    const subIds = subs.map((s) => s.id);
    const usernames = subs.map((s) => s.username).filter(Boolean);
    if (usernames.length) {
      await this.prisma.$executeRawUnsafe(`DELETE FROM radcheck WHERE username = ANY($1)`, usernames).catch(() => null);
      await this.prisma.$executeRawUnsafe(`DELETE FROM radreply WHERE username = ANY($1)`, usernames).catch(() => null);
      await this.prisma.$executeRawUnsafe(`DELETE FROM radacct WHERE username = ANY($1)`, usernames).catch(() => null);
    }
    if (subIds.length) {
      for (const model of ['payment', 'invoice', 'serviceSettings', 'balanceTransaction', 'temporaryBoost', 'activityLog'] as const) {
        await (this.prisma as any)[model]?.deleteMany?.({ where: { subscriberId: { in: subIds } } }).catch(() => null);
      }
      await this.prisma.subscriber.deleteMany({ where: { id: { in: subIds } } }).catch((e) => this.log.warn(`sub delete: ${e?.message}`));
    }
    await this.prisma.nas.deleteMany({ where: { ownerId: { in: userIds } } }).catch(() => null);
    await this.prisma.ipPool.deleteMany({ where: { ownerId: { in: userIds } } }).catch(() => null);
    await this.prisma.package.deleteMany({ where: { ownerId: { in: userIds } } }).catch(() => null);
    await this.prisma.area.deleteMany({ where: { ownerId: { in: userIds } } }).catch(() => null);
    await this.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch((e) => this.log.warn(`user delete: ${e?.message}`));
  }
}
