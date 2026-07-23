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
      this.prisma.voucher.count(),
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
}
