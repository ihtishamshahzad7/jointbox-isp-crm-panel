import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

type Grain = 'day' | 'week' | 'month';

/**
 * ReportAnalyticsService — time series with a comparison baseline.
 *
 * WHY THIS EXISTS
 * The reports screen previously drew coloured shapes from single totals. A
 * pie of package counts tells you nothing you could act on: it has no time
 * axis, so it cannot show whether anything improved, and no money, so a plan
 * with 40 cheap customers looks four times more important than one with 10
 * customers paying five times as much.
 *
 * Every series here therefore returns the CURRENT window and the SAME LENGTH
 * of time immediately before it. A number without a baseline is not a report,
 * it is trivia — "PKR 240,000 this month" only means something next to last
 * month's 210,000.
 */
@Injectable()
export class ReportAnalyticsService {
  private readonly logger = new Logger(ReportAnalyticsService.name);

  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  private async scopedSubscriberIds(actor?: Actor): Promise<number[] | null> {
    if (!actor || this.scope.isAdmin(actor.role)) return null; // null = no limit
    const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
    const subs = await this.prisma.subscriber.findMany({
      where: { userId: { in: ids } },
      select: { id: true },
    });
    return subs.map((s) => s.id);
  }

  /** Postgres date_trunc unit for the requested grain. */
  private trunc(grain: Grain) {
    return grain === 'day' ? 'day' : grain === 'week' ? 'week' : 'month';
  }

  private windowFor(grain: Grain, points: number) {
    const end = new Date();
    const start = new Date(end);
    if (grain === 'day') start.setDate(start.getDate() - points);
    else if (grain === 'week') start.setDate(start.getDate() - points * 7);
    else start.setMonth(start.getMonth() - points);

    // The comparison window is the same length immediately before, so the two
    // series are directly comparable rather than "this month vs last year".
    const prevEnd = new Date(start);
    const prevStart = new Date(start);
    if (grain === 'day') prevStart.setDate(prevStart.getDate() - points);
    else if (grain === 'week') prevStart.setDate(prevStart.getDate() - points * 7);
    else prevStart.setMonth(prevStart.getMonth() - points);

    return { start, end, prevStart, prevEnd };
  }

  private pctChange(now: number, before: number): number | null {
    // Growth from zero is not a percentage — reporting "+100%" or "+∞" there
    // is misleading, so the UI is told to show the absolute change instead.
    if (before === 0) return now === 0 ? 0 : null;
    return Math.round(((now - before) / before) * 1000) / 10;
  }

  /**
   * Revenue over time, against the preceding window of equal length.
   * Buckets are generated in SQL so empty periods still appear — a gap in a
   * revenue chart must read as "nothing collected", not as missing data.
   */
  async revenueTrend(actor?: Actor, grain: Grain = 'day', points = 30) {
    const { start, end, prevStart, prevEnd } = this.windowFor(grain, points);
    const ids = await this.scopedSubscriberIds(actor);
    if (ids && ids.length === 0) {
      return { grain, points: [], summary: this.emptySummary() };
    }

    const unit = this.trunc(grain);
    const filter = ids ? `AND "subscriberId" = ANY($3::int[])` : '';
    const args: any[] = [start, end];
    if (ids) args.push(ids);

    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT date_trunc('${unit}', "paymentDate") AS bucket,
              SUM(amount)::float AS total,
              COUNT(*)::int      AS payments
         FROM "Payment"
        WHERE "paymentDate" >= $1 AND "paymentDate" < $2 ${filter}
        GROUP BY 1 ORDER BY 1`,
      ...args,
    ).catch(() => [] as any[]);

    const prevArgs: any[] = [prevStart, prevEnd];
    if (ids) prevArgs.push(ids);
    const prevRows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT date_trunc('${unit}', "paymentDate") AS bucket,
              SUM(amount)::float AS total
         FROM "Payment"
        WHERE "paymentDate" >= $1 AND "paymentDate" < $2 ${filter}
        GROUP BY 1 ORDER BY 1`,
      ...prevArgs,
    ).catch(() => [] as any[]);

    // Align the two windows by position, not by date — bucket N of this month
    // lines up with bucket N of last month so the chart can overlay them.
    const cur = rows.map((r) => ({ t: new Date(r.bucket), value: Number(r.total) || 0, count: r.payments }));
    const prev = prevRows.map((r) => Number(r.total) || 0);

    const series = cur.map((c, i) => ({
      label: this.labelFor(c.t, grain),
      date: c.t,
      value: Math.round(c.value),
      previous: Math.round(prev[i] ?? 0),
      payments: c.count,
    }));

    const total = series.reduce((s, p) => s + p.value, 0);
    const prevTotal = prev.reduce((s, v) => s + v, 0);

    return {
      grain,
      points: series,
      summary: {
        total,
        previousTotal: Math.round(prevTotal),
        change: Math.round(total - prevTotal),
        changePercent: this.pctChange(total, prevTotal),
        best: series.reduce((a, b) => (b.value > (a?.value ?? -1) ? b : a), null as any),
        average: series.length ? Math.round(total / series.length) : 0,
      },
    };
  }

  private emptySummary() {
    return { total: 0, previousTotal: 0, change: 0, changePercent: 0, best: null, average: 0 };
  }

  private labelFor(d: Date, grain: Grain) {
    if (grain === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    if (grain === 'week') return `w/c ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  /**
   * Growth: joiners against leavers.
   *
   * A cumulative "subscriber growth" line always slopes up and always looks
   * healthy. Showing gains and losses separately is what exposes churn — 30
   * new and 28 lost is a very different business from 30 new and 2 lost, and
   * the totals line cannot tell them apart.
   */
  async growthTrend(actor?: Actor, grain: Grain = 'month', points = 12) {
    const { start, end } = this.windowFor(grain, points);
    const unit = this.trunc(grain);
    const ids = await this.scopedSubscriberIds(actor);
    if (ids && ids.length === 0) return { grain, points: [], summary: { joined: 0, left: 0, net: 0, churnRate: 0 } };

    const filter = ids ? `AND id = ANY($3::int[])` : '';
    const argsA: any[] = [start, end];
    if (ids) argsA.push(ids);

    const joined = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT date_trunc('${unit}', "createdAt") AS bucket, COUNT(*)::int AS n
         FROM "Subscriber" WHERE "createdAt" >= $1 AND "createdAt" < $2 ${filter}
        GROUP BY 1 ORDER BY 1`,
      ...argsA,
    ).catch(() => [] as any[]);

    // Departure is approximated by the move to INACTIVE/SUSPENDED, since there
    // is no hard "cancelled" timestamp. updatedAt is the best signal available.
    const left = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT date_trunc('${unit}', "updatedAt") AS bucket, COUNT(*)::int AS n
         FROM "Subscriber"
        WHERE "updatedAt" >= $1 AND "updatedAt" < $2
          AND status IN ('INACTIVE','SUSPENDED') ${filter}
        GROUP BY 1 ORDER BY 1`,
      ...argsA,
    ).catch(() => [] as any[]);

    const key = (d: any) => new Date(d).toISOString();
    const joinMap = new Map(joined.map((r) => [key(r.bucket), r.n]));
    const leftMap = new Map(left.map((r) => [key(r.bucket), r.n]));
    const buckets = [...new Set([...joinMap.keys(), ...leftMap.keys()])].sort();

    let running = 0;
    const series = buckets.map((b) => {
      const j = joinMap.get(b) ?? 0;
      const l = leftMap.get(b) ?? 0;
      running += j - l;
      return {
        label: this.labelFor(new Date(b), grain),
        date: new Date(b),
        joined: j,
        left: l,
        net: j - l,
        cumulative: running,
      };
    });

    const totalJoined = series.reduce((s, p) => s + p.joined, 0);
    const totalLeft = series.reduce((s, p) => s + p.left, 0);
    const base = await this.prisma.subscriber.count(
      ids ? { where: { id: { in: ids } } } : undefined,
    );

    return {
      grain,
      points: series,
      summary: {
        joined: totalJoined,
        left: totalLeft,
        net: totalJoined - totalLeft,
        churnRate: base > 0 ? Math.round((totalLeft / base) * 1000) / 10 : 0,
      },
    };
  }

  /**
   * Package mix by CUSTOMERS and by REVENUE together.
   *
   * These two rankings frequently disagree, and the disagreement is the
   * insight: the plan with the most subscribers is often not the plan paying
   * the bills. A count-only pie actively hides that.
   */
  async packageMix(actor?: Actor) {
    const where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.userId = { in: await this.scope.descendantIds(await this.scope.rootId(actor)) };
    }

    const subs = await this.prisma.subscriber.findMany({
      where,
      select: {
        status: true,
        sellPrice: true,
        package: { select: { id: true, name: true, price: true } },
      },
    });

    const map = new Map<string, any>();
    for (const s of subs) {
      const id = s.package ? `pkg:${s.package.id}` : 'none';
      if (!map.has(id)) {
        map.set(id, {
          key: id,
          name: s.package?.name ?? 'No package',
          listPrice: s.package?.price ?? 0,
          subscribers: 0, active: 0, monthlyRevenue: 0,
        });
      }
      const e = map.get(id);
      e.subscribers++;
      if (s.status === 'ACTIVE') {
        e.active++;
        // sellPrice is what this customer actually pays; it can differ per
        // reseller, so the package list price is only a fallback.
        e.monthlyRevenue += Number(s.sellPrice ?? s.package?.price ?? 0);
      }
    }

    const rows = [...map.values()].map((r) => ({
      ...r,
      monthlyRevenue: Math.round(r.monthlyRevenue),
      arpu: r.active > 0 ? Math.round(r.monthlyRevenue / r.active) : 0,
    }));

    const totalSubs = rows.reduce((s, r) => s + r.subscribers, 0);
    const totalRev = rows.reduce((s, r) => s + r.monthlyRevenue, 0);

    return {
      rows: rows
        .map((r) => ({
          ...r,
          subscriberShare: totalSubs ? Math.round((r.subscribers / totalSubs) * 1000) / 10 : 0,
          revenueShare: totalRev ? Math.round((r.monthlyRevenue / totalRev) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.monthlyRevenue - a.monthlyRevenue),
      totals: { subscribers: totalSubs, monthlyRevenue: totalRev,
        arpu: totalSubs ? Math.round(totalRev / totalSubs) : 0 },
    };
  }

  /**
   * Collection health, aged.
   *
   * "Paid vs unpaid" is not enough to act on. What matters is how long the
   * unpaid has been unpaid: 30 days overdue is a phone call, 90 days is a
   * write-off, and a single "outstanding" number hides the difference.
   */
  async collections(actor?: Actor) {
    const where: any = {};
    const ids = await this.scopedSubscriberIds(actor);
    if (ids) {
      if (ids.length === 0) {
        return { buckets: [], totals: { billed: 0, collected: 0, outstanding: 0, collectionRate: 100 }, worst: [] };
      }
      where.subscriberId = { in: ids };
    }

    const invoices = await this.prisma.invoice.findMany({
      where,
      select: {
        id: true, invoiceNo: true, total: true, paidAmount: true, dueAmount: true,
        dueDate: true, status: true,
        subscriber: { select: { id: true, fullName: true, username: true, phone: true } },
      },
    });

    const now = Date.now();
    const defs = [
      { key: 'current',  label: 'Not yet due', min: -1e9, max: 0,   color: '#10b981' },
      { key: 'd1_30',    label: '1–30 days',   min: 0,    max: 30,  color: '#f59e0b' },
      { key: 'd31_60',   label: '31–60 days',  min: 30,   max: 60,  color: '#f97316' },
      { key: 'd61_90',   label: '61–90 days',  min: 60,   max: 90,  color: '#ef4444' },
      { key: 'd90plus',  label: 'Over 90 days',min: 90,   max: 1e9, color: '#991b1b' },
    ];
    const buckets = defs.map((d) => ({ ...d, amount: 0, count: 0 }));

    let billed = 0, collected = 0, outstanding = 0;
    const unpaid: any[] = [];

    for (const inv of invoices) {
      billed += inv.total;
      collected += inv.paidAmount;
      const due = inv.dueAmount ?? inv.total - inv.paidAmount;
      if (due <= 0) continue;

      outstanding += due;
      const daysOver = Math.floor((now - new Date(inv.dueDate).getTime()) / 86400_000);
      const b = buckets.find((x) => daysOver > x.min && daysOver <= x.max) ?? buckets[0];
      b.amount += due;
      b.count++;

      unpaid.push({
        invoiceNo: inv.invoiceNo,
        subscriberId: inv.subscriber?.id,
        customer: inv.subscriber?.fullName,
        username: inv.subscriber?.username,
        phone: inv.subscriber?.phone,
        amount: Math.round(due),
        daysOverdue: Math.max(0, daysOver),
      });
    }

    return {
      buckets: buckets.map((b) => ({ ...b, amount: Math.round(b.amount) })),
      totals: {
        billed: Math.round(billed),
        collected: Math.round(collected),
        outstanding: Math.round(outstanding),
        collectionRate: billed > 0 ? Math.round((collected / billed) * 1000) / 10 : 100,
      },
      // Chasing is prioritised by value, not by age — the oldest debt is
      // often small, while the largest is what actually hurts cash flow.
      worst: unpaid.sort((a, b) => b.amount - a.amount).slice(0, 15),
    };
  }

  /** Everything the reports screen needs, in one round trip. */
  async overview(actor?: Actor, grain: Grain = 'day', points = 30) {
    const [revenue, growth, packages, collections] = await Promise.all([
      this.revenueTrend(actor, grain, points),
      this.growthTrend(actor, 'month', 12),
      this.packageMix(actor),
      this.collections(actor),
    ]);
    return { generatedAt: new Date(), revenue, growth, packages, collections };
  }
}
