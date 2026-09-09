import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { isPrimaryInstance } from '../common/cluster-util';
import { DemoDataService } from './demo-data.service';
import { DemoHierarchyService } from './demo-hierarchy.service';

/**
 * DemoService — self-serve sandbox accounts.
 *
 * HARD SAFETY RULE: demo data is only ever created for users already marked
 * isDemo=true. A real account can NEVER be converted into a demo account.
 * Demo records are scoped to the demo root/downline and are cleaned separately.
 */
@Injectable()
export class DemoService implements OnModuleInit {
  private readonly log = new Logger('Demo');
  private static readonly DAYS = 7;

  constructor(
    private prisma: PrismaService,
    private readonly demoData: DemoDataService,
    private readonly demoHierarchy: DemoHierarchyService,
  ) {}

  async onModuleInit() {
    await this.ensureShared().catch((e) =>
      this.log.warn(`Shared demo initialization failed: ${e?.message || e}`),
    );
  }

  async liveCount(): Promise<number> {
    return this.prisma.user.count({ where: { isDemo: true } }).catch(() => 0);
  }

  async create() {
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

        const dataset = await this.demoData.seedForUser(user.id, 10_000);
        const hierarchy = await this.demoHierarchy.seed(user.id);

        this.log.log(`Demo account #${user.id} created (${email}) — expires ${expiresAt.toISOString()}`);
        return {
          email: user.email,
          username: user.email,
          password,
          role: 'Franchise (demo)',
          expiresAt,
          dataset: { ...dataset, hierarchy },
          credentials: { email: user.email, username: user.email, password },
          note: 'Sandbox only: synthetic Pakistan ISP data with 500 NAS, 20 areas, 50 pools, packages, 10,000 subscribers, franchise/dealer/sub-dealer hierarchy, sessions and graphs. Demo data is isolated from real accounts and expires automatically.',
        };
      } catch (e: any) {
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
      note: 'Shared demo: synthetic sandbox data only; real customer and real tenant data is never exposed.',
    };
  }

  async ensureShared() {
    if (process.env.DEMO_PUBLIC === '0') return;
    const hash = await bcrypt.hash(this.sharedPassword, 10);
    const far = new Date(Date.now() + 3650 * 86400_000);
    const existing = await this.prisma.user.findFirst({ where: { email: this.sharedEmail }, select: { id: true, isDemo: true } });

    let userId: number;
    if (existing) {
      // NEVER convert a real account into a demo account. This prevents a
      // DEMO_EMAIL collision from changing a customer's/admin's credentials,
      // role, expiry, or ownership data.
      if (!existing.isDemo) {
        this.log.error(`Refusing shared demo initialization: ${this.sharedEmail} belongs to a real user (#${existing.id}). Set DEMO_EMAIL to a dedicated demo address.`);
        return;
      }
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

    const dataset = await this.demoData.seedForUser(userId, 10_000).catch((e) => {
      this.log.warn(`Demo dataset seed failed for #${userId}: ${e?.message || e}`);
      return null;
    });
    const hierarchy = await this.demoHierarchy.seed(userId).catch((e) => {
      this.log.warn(`Demo hierarchy seed failed for #${userId}: ${e?.message || e}`);
      return null;
    });
    if (dataset?.seeded || hierarchy?.seeded) this.log.log(`Shared demo sandbox ready: ${JSON.stringify({ dataset, hierarchy })}`);
  }

  @Cron('0 4 * * 1')
  async resetShared() {
    if (!isPrimaryInstance() || process.env.DEMO_PUBLIC === '0') return;
    const u = await this.prisma.user.findFirst({ where: { email: this.sharedEmail, isDemo: true }, select: { id: true } });
    if (!u) return;
    const kids = await this.prisma.user.findMany({ where: { parentId: u.id, isDemo: true }, select: { id: true } });
    for (const k of kids) await this.purgeAccount(k.id).catch(() => null);
    await this.demoData.resetForUser(u.id).catch((e) => this.log.warn(`Shared demo dataset reset failed: ${e?.message || e}`));
    await this.demoHierarchy.seed(u.id).catch((e) => this.log.warn(`Shared demo hierarchy reset failed: ${e?.message || e}`));
    await this.prisma.user.update({ where: { id: u.id }, data: { balance: 100000, isActive: true } }).catch(() => null);
    this.log.log('Shared demo account and synthetic ISP hierarchy reset for the week.');
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
    const root = await this.prisma.user.findUnique({ where: { id: rootId }, select: { isDemo: true } });
    // Purge is a destructive demo operation; refuse to touch any real account.
    if (!root?.isDemo) throw new Error(`Refusing to purge non-demo account #${rootId}`);

    const subtree = await this.prisma.$queryRaw<Array<{ id: number }>>`
      WITH RECURSIVE t AS (
        SELECT id FROM "User" WHERE id = ${rootId} AND "isDemo" = true
        UNION ALL SELECT u.id FROM "User" u JOIN t ON u."parentId" = t.id WHERE u."isDemo" = true
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
    await this.prisma.nas.deleteMany({ where: { ownerId: { in: userIds } }).catch(() => null);
    await this.prisma.ipPool.deleteMany({ where: { ownerId: { in: userIds } }).catch(() => null);
    await this.prisma.package.deleteMany({ where: { ownerId: { in: userIds } }).catch(() => null);
    await this.prisma.area.deleteMany({ where: { ownerId: { in: userIds } }).catch(() => null);
    await this.prisma.user.deleteMany({ where: { id: { in: userIds }, isDemo: true } }).catch((e) => this.log.warn(`user delete: ${e?.message}`));
  }
}
