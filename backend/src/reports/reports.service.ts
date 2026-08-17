import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  /**
   * Restrict a subscriber-linked query to the caller's own subtree.
   * Every count below runs through this — an unscoped total is a headline
   * number for someone else's business.
   */
  private async scoped(actor?: Actor): Promise<any> {
    if (!actor || this.scope.isAdmin(actor.role)) return {};
    const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
    return { userId: { in: ids } };
  }

  private async viaSubscriber(actor?: Actor): Promise<any> {
    if (!actor || this.scope.isAdmin(actor.role)) return {};
    const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
    return { subscriber: { userId: { in: ids } } };
  }

  async getDashboardStats(actor?: Actor) {
    const isAdmin = !actor || this.scope.isAdmin(actor.role);
    const ids = isAdmin ? null : await this.scope.descendantIds(await this.scope.rootId(actor!));
    const sub: any = ids ? { userId: { in: ids } } : {};
    const bySub: any = ids ? { subscriber: { userId: { in: ids } } } : {};
    const owned: any = ids ? { ownerId: { in: ids } } : {};
    const userWhere: any = ids ? { id: { in: ids } } : {};
    const voucherWhere: any = ids ? { createdBy: { in: ids } } : {};

    const [
      subscribers,
      packages,
      areas,
      nas,
      invoices,
      vouchers,
      users,
      tickets,
      payments,
    ] = await Promise.all([
      this.prisma.subscriber.count({ where: sub }),
      this.prisma.package.count(),                  // catalogue — shared
      this.prisma.area.count({ where: owned }),
      this.prisma.nas.count({ where: await this.scope.nasWhere(actor as any) }),
      this.prisma.invoice.count({ where: bySub }),
      this.prisma.voucher.count({ where: voucherWhere }),   // scoped — was leaking every tenant's voucher count
      // "users" for a reseller means their own downline, not every staff
      // account in the system.
      this.prisma.user.count({ where: userWhere }),
      this.prisma.ticket.count({ where: bySub }),
      this.prisma.payment.aggregate({ where: bySub, _sum: { amount: true } }),
    ]);

    return {
      subscribers,
      packages,
      areas,
      nas,
      invoices,
      vouchers,
      users,
      tickets,
      totalRevenue: payments._sum.amount ?? 0,
    };
  }

  async getRevenueReport(startDate?: string, endDate?: string, actor?: Actor) {
    const where: any = await this.viaSubscriber(actor);
    if (startDate && endDate) {
      where.paymentDate = {
        gte: new Date(startDate),
        lte: new Date(endDate),
      };
    }

    const payments = await this.prisma.payment.findMany({
      where,
      include: {
        subscriber: true,
        invoice:    true,
      },
      orderBy: { paymentDate: 'desc' },
    });

    const total    = payments.reduce((sum, p) => sum + p.amount, 0);
    const byMethod = payments.reduce((acc: any, p) => {
      acc[p.method] = (acc[p.method] || 0) + p.amount;
      return acc;
    }, {});

    return { payments, total, byMethod, count: payments.length };
  }

  async getSubscriberReport(actor?: Actor) {
    const s = await this.scoped(actor);
    const active    = await this.prisma.subscriber.count({ where: { ...s, status: 'ACTIVE' } });
    const inactive  = await this.prisma.subscriber.count({ where: { ...s, status: 'INACTIVE' } });
    const expired   = await this.prisma.subscriber.count({ where: { ...s, status: 'EXPIRED' } });
    const suspended = await this.prisma.subscriber.count({ where: { ...s, status: 'SUSPENDED' } });

    const byPackage = await this.prisma.subscriber.groupBy({
      by:    ['packageId'],
      _count: true,
      where: { ...s, packageId: { not: null } },
    });

    return {
      active,
      inactive,
      expired,
      suspended,
      total: active + inactive + expired + suspended,
      byPackage,
    };
  }

  async getTicketReport(actor?: Actor) {
    const t = await this.viaSubscriber(actor);
    const open       = await this.prisma.ticket.count({ where: { ...t, status: 'OPEN' } });
    const inProgress = await this.prisma.ticket.count({ where: { ...t, status: 'IN_PROGRESS' } });
    const resolved   = await this.prisma.ticket.count({ where: { ...t, status: 'RESOLVED' } });
    const closed     = await this.prisma.ticket.count({ where: { ...t, status: 'CLOSED' } });

    const byCategory = await this.prisma.ticket.groupBy({
      by:    ['category'],
      _count: true,
      where: t,
    });

    return {
      open,
      inProgress,
      resolved,
      closed,
      total: open + inProgress + resolved + closed,
      byCategory,
    };
  }

  /**
   * Aged receivables — unpaid/partial invoices bucketed by how overdue they
   * are. The oldest debt is rarely the largest, so this ranks buckets by amount
   * and lists the biggest debtors, which is what actually hurts cash flow.
   */
  async getAgedDebt(actor?: Actor) {
    const where: any = { status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, dueAmount: { gt: 0 } };
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.subscriber = { userId: { in: ids } };
    }
    const invoices = await this.prisma.invoice.findMany({
      where,
      select: { id: true, invoiceNo: true, dueAmount: true, dueDate: true, invoiceDate: true,
        subscriber: { select: { id: true, fullName: true, username: true } } },
    });

    const now = Date.now();
    const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    const byDebtor = new Map<number, any>();
    let total = 0;
    for (const inv of invoices) {
      const due = inv.dueAmount || 0;
      total += due;
      const ageDays = Math.floor((now - new Date(inv.dueDate || inv.invoiceDate).getTime()) / 86400000);
      const b = ageDays <= 0 ? 'current' : ageDays <= 30 ? 'd1_30' : ageDays <= 60 ? 'd31_60' : ageDays <= 90 ? 'd61_90' : 'd90plus';
      (buckets as any)[b] += due;
      const key = inv.subscriber?.id ?? 0;
      const row = byDebtor.get(key) || { subscriberId: key, name: inv.subscriber?.fullName || 'Unknown', username: inv.subscriber?.username || '', owed: 0, oldestDays: 0, invoices: 0 };
      row.owed = Math.round((row.owed + due) * 100) / 100;
      row.oldestDays = Math.max(row.oldestDays, ageDays);
      row.invoices += 1;
      byDebtor.set(key, row);
    }
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    Object.keys(buckets).forEach((k) => ((buckets as any)[k] = round2((buckets as any)[k])));
    const debtors = [...byDebtor.values()].sort((a, b) => b.owed - a.owed).slice(0, 100);
    return { total: round2(total), buckets, count: invoices.length, debtors };
  }

  /**
   * Reseller performance — per account in the caller's subtree: active
   * subscribers, monthly recurring revenue (sell price), cost, profit, and
   * current wallet balance. The picture of who is actually earning.
   */
  async getResellerPerformance(actor?: Actor) {
    const userWhere: any = { role: { in: ['RESELLER', 'SUB_RESELLER', 'RETAILER', 'SALES'] } };
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      userWhere.id = { in: ids };
    }
    const users = await this.prisma.user.findMany({
      where: userWhere,
      select: { id: true, name: true, role: true, balance: true },
    });
    const round2 = (n: number) => Math.round(((n || 0) + Number.EPSILON) * 100) / 100;

    // Aggregate ALL subscribers in TWO grouped queries instead of one query per
    // reseller (was N+1 — 100 resellers = 100 round-trips). Now it's constant.
    const ids = users.map((u) => u.id);
    const byOwner = new Map<number, { subscribers: number; active: number; mrr: number; cost: number }>();
    if (ids.length) {
      const totalCounts = await this.prisma.subscriber.groupBy({
        by: ['userId'], where: { userId: { in: ids } }, _count: { _all: true },
      });
      const activeAgg = await this.prisma.subscriber.groupBy({
        by: ['userId'], where: { userId: { in: ids }, status: 'ACTIVE' },
        _count: { _all: true }, _sum: { sellPrice: true, costPrice: true },
      });
      for (const r of totalCounts) byOwner.set(r.userId!, { subscribers: r._count._all, active: 0, mrr: 0, cost: 0 });
      for (const r of activeAgg) {
        const e = byOwner.get(r.userId!) || { subscribers: 0, active: 0, mrr: 0, cost: 0 };
        e.active = r._count._all;
        e.mrr = round2(r._sum.sellPrice || 0);
        e.cost = round2(r._sum.costPrice || 0);
        byOwner.set(r.userId!, e);
      }
    }
    const rows = users.map((u) => {
      const e = byOwner.get(u.id) || { subscribers: 0, active: 0, mrr: 0, cost: 0 };
      return { userId: u.id, name: u.name, role: u.role, balance: round2(u.balance),
        subscribers: e.subscribers, active: e.active, mrr: e.mrr, cost: e.cost, profit: round2(e.mrr - e.cost) };
    });
    rows.sort((a, b) => b.mrr - a.mrr);
    return {
      accounts: rows,
      totals: {
        subscribers: rows.reduce((t, r) => t + r.subscribers, 0),
        active: rows.reduce((t, r) => t + r.active, 0),
        mrr: round2(rows.reduce((t, r) => t + r.mrr, 0)),
        profit: round2(rows.reduce((t, r) => t + r.profit, 0)),
      },
    };
  }
}
