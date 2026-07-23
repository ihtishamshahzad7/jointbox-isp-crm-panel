import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache.service';
import { ScopeService, Actor } from '../common/scope.service';

/**
 * AnalyticsService — the numbers that tell you whether the business is working.
 *
 * Everything here is derived from data already captured: payments, subscriber
 * lifecycle, the pricing stamps on each customer, and RADIUS sessions. Nothing
 * new needs recording.
 *
 * The four that actually drive decisions:
 *   ARPU      — average revenue per user. Falling ARPU with rising customers
 *               means you are discounting your way to nowhere.
 *   Churn     — the leak in the bucket. At 5%/month you replace your entire
 *               customer base every 20 months just to stand still.
 *   LTV       — ARPU ÷ churn. What a customer is worth, and therefore what you
 *               can afford to spend acquiring one.
 *   Net growth— new minus lost. The only number that says if you are growing.
 *
 * All queries are scoped to the caller's subtree and cached briefly, since
 * dashboards get refreshed far more often than the numbers actually change.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
    private scope: ScopeService,
  ) {}

  /** Subscriber ids visible to this actor — null means "everything" (ISP). */
  private async visibleOwnerIds(actor?: Actor): Promise<number[] | null> {
    if (!actor || this.scope.isAdmin(actor.role)) return null;
    return this.scope.descendantIds(await this.scope.rootId(actor));
  }

  /**
   * Builds an owner restriction for raw SQL.
   *
   * The ids come from ScopeService (database integers, never request input),
   * so this is not injectable today. It is coerced anyway: this string is
   * concatenated straight into SQL, and the day someone passes a value from a
   * query parameter here it becomes a live injection. Number() plus a finite
   * check means that mistake fails closed instead of executing.
   */
  private ownerFilter(ids: number[] | null, column = '"userId"') {
    if (!ids) return '';
    const safe = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    // No valid ids means "see nothing", not "see everything".
    return `AND s.${column} IN (${safe.length ? safe.join(',') : '0'})`;
  }

  // ─────────────────────────────────────────────────────────────
  // HEADLINE KPIs
  // ─────────────────────────────────────────────────────────────
  async overview(actor?: Actor, days = 30) {
    const ids = await this.visibleOwnerIds(actor);
    const key = `analytics:overview:${ids ? ids.join('_') : 'all'}:${days}`;

    return this.cache.wrap(key, 120, async () => {
      const since = new Date(Date.now() - days * 86400_000);
      const prevSince = new Date(Date.now() - days * 2 * 86400_000);
      const own = this.ownerFilter(ids);

      const [counts, revenue, prevRevenue, newSubs, lostSubs] = await Promise.all([
        this.prisma.$queryRawUnsafe<any[]>(`
          SELECT
            COUNT(*)::int                                        AS total,
            COUNT(*) FILTER (WHERE s.status = 'ACTIVE')::int      AS active,
            COUNT(*) FILTER (WHERE s.status = 'EXPIRED')::int     AS expired,
            COUNT(*) FILTER (WHERE s.status = 'SUSPENDED')::int   AS suspended
          FROM "Subscriber" s WHERE 1=1 ${own}`),

        this.prisma.$queryRawUnsafe<any[]>(`
          SELECT COALESCE(SUM(p.amount),0)::float AS total, COUNT(*)::int AS payments
          FROM "Payment" p JOIN "Subscriber" s ON s.id = p."subscriberId"
          WHERE p."paymentDate" >= $1 AND p."refundedAt" IS NULL ${own}`, since),

        this.prisma.$queryRawUnsafe<any[]>(`
          SELECT COALESCE(SUM(p.amount),0)::float AS total
          FROM "Payment" p JOIN "Subscriber" s ON s.id = p."subscriberId"
          WHERE p."paymentDate" >= $1 AND p."paymentDate" < $2 AND p."refundedAt" IS NULL ${own}`,
          prevSince, since),

        this.prisma.$queryRawUnsafe<any[]>(`
          SELECT COUNT(*)::int AS n FROM "Subscriber" s
          WHERE s."createdAt" >= $1 ${own}`, since),

        // "Lost" = moved out of ACTIVE during the window.
        this.prisma.$queryRawUnsafe<any[]>(`
          SELECT COUNT(*)::int AS n FROM "Subscriber" s
          WHERE s.status IN ('EXPIRED','INACTIVE') AND s."updatedAt" >= $1 ${own}`, since),
      ]);

      const c = counts[0] || {};
      const rev = Number(revenue[0]?.total || 0);
      const prevRev = Number(prevRevenue[0]?.total || 0);
      const gained = Number(newSubs[0]?.n || 0);
      const lost = Number(lostSubs[0]?.n || 0);
      const active = Number(c.active || 0);

      // ARPU over the window, annualised to a monthly figure.
      const monthlyFactor = 30 / days;
      const arpu = active > 0 ? (rev / active) * monthlyFactor : 0;

      // Churn against the population at the START of the window.
      const startPopulation = active + lost - gained;
      const churnRate = startPopulation > 0 ? (lost / startPopulation) * 100 : 0;
      const monthlyChurn = churnRate * monthlyFactor;

      // Lifetime value: how many months a customer stays × what they pay.
      const ltv = monthlyChurn > 0 ? arpu / (monthlyChurn / 100) : arpu * 24;

      return {
        periodDays: days,
        subscribers: {
          total: Number(c.total || 0),
          active,
          expired: Number(c.expired || 0),
          suspended: Number(c.suspended || 0),
        },
        growth: {
          new: gained,
          lost,
          net: gained - lost,
          growthRate: startPopulation > 0 ? round2(((gained - lost) / startPopulation) * 100) : 0,
        },
        revenue: {
          total: round2(rev),
          previousPeriod: round2(prevRev),
          changePercent: prevRev > 0 ? round2(((rev - prevRev) / prevRev) * 100) : null,
          payments: Number(revenue[0]?.payments || 0),
        },
        kpis: {
          arpu: round2(arpu),
          churnRatePercent: round2(monthlyChurn),
          estimatedLtv: round2(ltv),
          // Months to recover acquisition cost, once you know CAC.
          avgLifetimeMonths: monthlyChurn > 0 ? round2(100 / monthlyChurn) : null,
        },
      };
    });
  }

  // ─────────────────────────────────────────────────────────────
  // TRENDS — 12 months of revenue, growth and churn
  // ─────────────────────────────────────────────────────────────
  async monthlyTrend(actor?: Actor, months = 12) {
    const ids = await this.visibleOwnerIds(actor);
    const key = `analytics:trend:${ids ? ids.join('_') : 'all'}:${months}`;

    return this.cache.wrap(key, 300, async () => {
      const own = this.ownerFilter(ids);
      const since = new Date();
      since.setMonth(since.getMonth() - months);
      since.setDate(1);

      const [revenue, signups, losses] = await Promise.all([
        this.prisma.$queryRawUnsafe<any[]>(`
          SELECT to_char(date_trunc('month', p."paymentDate"), 'YYYY-MM') AS month,
                 COALESCE(SUM(p.amount),0)::float AS revenue
          FROM "Payment" p JOIN "Subscriber" s ON s.id = p."subscriberId"
          WHERE p."paymentDate" >= $1 AND p."refundedAt" IS NULL ${own}
          GROUP BY 1 ORDER BY 1`, since),

        this.prisma.$queryRawUnsafe<any[]>(`
          SELECT to_char(date_trunc('month', s."createdAt"), 'YYYY-MM') AS month,
                 COUNT(*)::int AS n
          FROM "Subscriber" s WHERE s."createdAt" >= $1 ${own}
          GROUP BY 1 ORDER BY 1`, since),

        this.prisma.$queryRawUnsafe<any[]>(`
          SELECT to_char(date_trunc('month', s."updatedAt"), 'YYYY-MM') AS month,
                 COUNT(*)::int AS n
          FROM "Subscriber" s
          WHERE s."updatedAt" >= $1 AND s.status IN ('EXPIRED','INACTIVE') ${own}
          GROUP BY 1 ORDER BY 1`, since),
      ]);

      const map = new Map<string, any>();
      const touch = (m: string) =>
        map.get(m) ?? map.set(m, { month: m, revenue: 0, new: 0, lost: 0 }).get(m);

      revenue.forEach((r) => (touch(r.month).revenue = round2(Number(r.revenue))));
      signups.forEach((r) => (touch(r.month).new = Number(r.n)));
      losses.forEach((r) => (touch(r.month).lost = Number(r.n)));

      return [...map.values()]
        .sort((a, b) => a.month.localeCompare(b.month))
        .map((m) => ({ ...m, net: m.new - m.lost }));
    });
  }

  // ─────────────────────────────────────────────────────────────
  // RESELLER LEAGUE TABLE
  // ─────────────────────────────────────────────────────────────
  /**
   * Who is actually performing. Deliberately ranks on ACTIVE customers and
   * revenue rather than headline totals — a reseller with 200 expired customers
   * is not outperforming one with 80 paying ones.
   */
  async resellerLeaderboard(actor?: Actor, days = 30) {
    const ids = await this.visibleOwnerIds(actor);
    const key = `analytics:leaderboard:${ids ? ids.join('_') : 'all'}:${days}`;

    return this.cache.wrap(key, 300, async () => {
      const since = new Date(Date.now() - days * 86400_000);
      const filter = ids ? `AND u.id IN (${ids.length ? ids.join(',') : '0'})` : '';

      const rows = await this.prisma.$queryRawUnsafe<any[]>(`
        SELECT u.id, u.name, u.role, u.balance,
               COUNT(s.id)::int                                        AS total_subs,
               COUNT(s.id) FILTER (WHERE s.status = 'ACTIVE')::int      AS active_subs,
               COUNT(s.id) FILTER (WHERE s."createdAt" >= $1)::int      AS new_subs,
               COALESCE(SUM(s.profit),0)::float                         AS total_margin,
               COALESCE((
                 SELECT SUM(p.amount) FROM "Payment" p
                 JOIN "Subscriber" s2 ON s2.id = p."subscriberId"
                 WHERE s2."userId" = u.id AND p."paymentDate" >= $1 AND p."refundedAt" IS NULL
               ),0)::float                                              AS revenue
          FROM "User" u
          LEFT JOIN "Subscriber" s ON s."userId" = u.id
         WHERE u.role IN ('RESELLER','SUB_RESELLER','RETAILER') ${filter}
         GROUP BY u.id, u.name, u.role, u.balance
         ORDER BY revenue DESC, active_subs DESC`, since);

      return rows.map((r, i) => {
        const active = Number(r.active_subs || 0);
        const revenue = Number(r.revenue || 0);
        return {
          rank: i + 1,
          userId: Number(r.id),
          name: r.name,
          role: r.role,
          walletBalance: round2(Number(r.balance || 0)),
          totalSubscribers: Number(r.total_subs || 0),
          activeSubscribers: active,
          newInPeriod: Number(r.new_subs || 0),
          revenue: round2(revenue),
          margin: round2(Number(r.total_margin || 0)),
          arpu: active > 0 ? round2(revenue / active) : 0,
        };
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // ORGANISATION TREE — the whole network, with numbers on every node
  // ─────────────────────────────────────────────────────────────
  /**
   * The full reseller hierarchy with metrics attached at each level.
   *
   * Two counts per node, deliberately:
   *   • `direct`   — customers this account owns itself
   *   • `total`    — everything beneath it, rolled up
   * A franchise with 5 direct customers and 400 in its subtree is a
   * distributor, not a small reseller — and the difference decides how you
   * treat them commercially.
   *
   * Built with three grouped queries and assembled in memory, so it stays a
   * handful of round trips no matter how deep the tree goes.
   */
  async hierarchy(actor?: Actor, days = 30) {
    const ids = await this.visibleOwnerIds(actor);
    const key = `analytics:hierarchy:${ids ? ids.join('_') : 'all'}:${days}`;

    return this.cache.wrap(key, 180, async () => {
      const since = new Date(Date.now() - days * 86400_000);

      const users = await this.prisma.user.findMany({
        where: ids ? { id: { in: ids } } : {},
        select: {
          id: true, name: true, email: true, role: true, parentId: true,
          balance: true, isActive: true, commissionPercent: true, createdAt: true,
        },
        orderBy: { id: 'asc' },
      });
      if (!users.length) return { nodes: [], roots: [], summary: null };

      const userIds = users.map((u) => u.id);

      const [subGroups, activeGroups, revenueRows, marginRows] = await Promise.all([
        this.prisma.subscriber.groupBy({
          by: ['userId'], where: { userId: { in: userIds } }, _count: { _all: true },
        }),
        this.prisma.subscriber.groupBy({
          by: ['userId'], where: { userId: { in: userIds }, status: 'ACTIVE' }, _count: { _all: true },
        }),
        this.prisma.$queryRawUnsafe<any[]>(`
          SELECT s."userId" AS uid, COALESCE(SUM(p.amount),0)::float AS revenue
            FROM "Payment" p JOIN "Subscriber" s ON s.id = p."subscriberId"
           WHERE p."paymentDate" >= $1 AND p."refundedAt" IS NULL
             AND s."userId" = ANY($2::int[])
           GROUP BY s."userId"`, since, userIds),
        this.prisma.$queryRawUnsafe<any[]>(`
          SELECT "userId" AS uid, COALESCE(SUM(profit),0)::float AS margin
            FROM "Subscriber" WHERE "userId" = ANY($1::int[])
           GROUP BY "userId"`, userIds),
      ]);

      const num = (rows: any[], key: string, val: string) =>
        new Map(rows.map((r) => [Number(r[key]), Number(r[val]) || 0]));
      const directSubs = new Map(subGroups.map((g) => [g.userId!, g._count._all]));
      const activeSubs = new Map(activeGroups.map((g) => [g.userId!, g._count._all]));
      const revenueBy = num(revenueRows, 'uid', 'revenue');
      const marginBy = num(marginRows, 'uid', 'margin');

      // Build nodes
      const nodes = new Map<number, any>();
      for (const u of users) {
        nodes.set(u.id, {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          parentId: u.parentId,
          isActive: u.isActive,
          walletBalance: round2(u.balance || 0),
          commissionPercent: u.commissionPercent || 0,
          joinedAt: u.createdAt,
          direct: {
            subscribers: directSubs.get(u.id) ?? 0,
            active: activeSubs.get(u.id) ?? 0,
            revenue: round2(revenueBy.get(u.id) ?? 0),
            margin: round2(marginBy.get(u.id) ?? 0),
          },
          // Filled by the roll-up below.
          total: { subscribers: 0, active: 0, revenue: 0, margin: 0, accounts: 0 },
          children: [] as any[],
        });
      }

      // Link parents → children
      const roots: any[] = [];
      for (const n of nodes.values()) {
        const parent = n.parentId ? nodes.get(n.parentId) : null;
        if (parent) parent.children.push(n);
        else roots.push(n);
      }

      // Roll totals up from the leaves. Recursive rather than iterative so the
      // depth of the tree doesn't need to be known in advance.
      const rollup = (n: any): any => {
        let t = {
          subscribers: n.direct.subscribers,
          active: n.direct.active,
          revenue: n.direct.revenue,
          margin: n.direct.margin,
          accounts: 0,
        };
        for (const c of n.children) {
          const ct = rollup(c);
          t.subscribers += ct.subscribers;
          t.active += ct.active;
          t.revenue += ct.revenue;
          t.margin += ct.margin;
          t.accounts += ct.accounts + 1;
        }
        n.total = {
          subscribers: t.subscribers,
          active: t.active,
          revenue: round2(t.revenue),
          margin: round2(t.margin),
          accounts: t.accounts,
        };
        // Sort children by contribution so the biggest branch reads first.
        n.children.sort((a: any, b: any) => b.total.revenue - a.total.revenue);
        return t;
      };
      roots.forEach(rollup);

      // Role distribution, for the summary chart.
      const byRole: Record<string, number> = {};
      for (const n of nodes.values()) byRole[n.role] = (byRole[n.role] || 0) + 1;

      const all = [...nodes.values()];
      return {
        roots,
        summary: {
          accounts: all.length,
          byRole,
          totalSubscribers: roots.reduce((s, r) => s + r.total.subscribers, 0),
          activeSubscribers: roots.reduce((s, r) => s + r.total.active, 0),
          totalRevenue: round2(roots.reduce((s, r) => s + r.total.revenue, 0)),
          totalWallet: round2(all.reduce((s, n) => s + n.walletBalance, 0)),
          // Negative wallets mean credit issued beyond what was funded — worth
          // seeing at a glance rather than discovering at month end.
          negativeWallets: all.filter((n) => n.walletBalance < 0).length,
          depth: (function depth(ns: any[]): number {
            return ns.length ? 1 + Math.max(...ns.map((n: any) => depth(n.children))) : 0;
          })(roots),
          periodDays: days,
        },
      };
    });
  }

  // ─────────────────────────────────────────────────────────────
  // SEGMENTATION — where the business actually is
  // ─────────────────────────────────────────────────────────────
  async byPackage(actor?: Actor) {
    const ids = await this.visibleOwnerIds(actor);
    const own = this.ownerFilter(ids);
    const rows = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT pk.id, pk.name, pk.price,
             COUNT(s.id)::int AS subscribers,
             COUNT(s.id) FILTER (WHERE s.status = 'ACTIVE')::int AS active,
             (COUNT(s.id) FILTER (WHERE s.status = 'ACTIVE') * pk.price)::float AS mrr
        FROM packages pk
        LEFT JOIN "Subscriber" s ON s."packageId" = pk.id ${own ? own.replace('AND s.', 'AND s.') : ''}
       GROUP BY pk.id, pk.name, pk.price
       ORDER BY active DESC`);

    return rows.map((r) => ({
      packageId: Number(r.id),
      name: r.name,
      price: round2(Number(r.price)),
      subscribers: Number(r.subscribers || 0),
      active: Number(r.active || 0),
      monthlyRecurringRevenue: round2(Number(r.mrr || 0)),
    }));
  }

  /** Which areas grow, and which quietly bleed customers. */
  async byArea(actor?: Actor) {
    const ids = await this.visibleOwnerIds(actor);
    const own = this.ownerFilter(ids);
    const rows = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT a.id, a.name, a.city,
             COUNT(s.id)::int AS subscribers,
             COUNT(s.id) FILTER (WHERE s.status = 'ACTIVE')::int  AS active,
             COUNT(s.id) FILTER (WHERE s.status = 'EXPIRED')::int AS expired
        FROM "Area" a
        LEFT JOIN "Subscriber" s ON s."areaId" = a.id ${own}
       GROUP BY a.id, a.name, a.city
       ORDER BY active DESC`);

    return rows.map((r) => {
      const total = Number(r.subscribers || 0);
      const expired = Number(r.expired || 0);
      return {
        areaId: Number(r.id),
        name: r.name,
        city: r.city,
        subscribers: total,
        active: Number(r.active || 0),
        expired,
        // A high churn share in one area usually means a network problem there,
        // not a sales problem.
        churnSharePercent: total > 0 ? round2((expired / total) * 100) : 0,
      };
    });
  }

  /**
   * Customers at risk — expiring within N days and not yet renewed.
   * This is the single most actionable list in the system: call these people.
   */
  async atRisk(actor?: Actor, days = 7) {
    const ids = await this.visibleOwnerIds(actor);
    const until = new Date(Date.now() + days * 86400_000);

    const where: any = {
      status: 'ACTIVE',
      serviceSettings: { is: { expiryDate: { not: null, lte: until } } },
    };
    if (ids) where.userId = { in: ids };

    const rows = await this.prisma.subscriber.findMany({
      where,
      select: {
        id: true, fullName: true, phone: true, username: true, balance: true,
        package: { select: { name: true, price: true } },
        serviceSettings: { select: { expiryDate: true } },
        user: { select: { id: true, name: true } },
      },
      take: 500,
    });

    return rows
      .map((s) => {
        const expiry = s.serviceSettings?.expiryDate ?? null;
        const daysLeft = expiry
          ? Math.ceil((new Date(expiry).getTime() - Date.now()) / 86400_000)
          : null;
        const price = s.package?.price ?? 0;
        return {
          subscriberId: s.id,
          name: s.fullName,
          phone: s.phone,
          username: s.username,
          package: s.package?.name ?? null,
          expiryDate: expiry,
          daysLeft,
          walletBalance: round2(s.balance || 0),
          // If their wallet covers it, auto-renewal will handle it — the ones
          // that need a phone call are those who cannot pay themselves.
          canAutoRenew: (s.balance || 0) >= price,
          owner: s.user?.name ?? null,
        };
      })
      .sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99));
  }
}

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
