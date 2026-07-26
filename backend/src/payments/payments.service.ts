import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentMethod } from '@prisma/client';
import { AccountingService } from '../accounting/accounting.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationService } from '../organization/organization.service';
import { ScopeService } from '../common/scope.service';
import { EventsService } from '../common/events.service';

@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private accounting: AccountingService,
    private notifications: NotificationsService,
    private organization: OrganizationService,
    private scope: ScopeService,
    private events: EventsService,
  ) {}

  /**
   * Payments this account may see.
   *
   * Was unscoped. Sibling dealers under one franchise could read each other's
   * collections — who paid, how much, when. That is a competitor's revenue.
   *
   * NOTE the count() also has to be filtered. An unfiltered total next to a
   * filtered page is its own leak: "showing 12 of 480" tells a dealer exactly
   * how much business everyone else is doing.
   */
  /**
   * Cash-collection reconciliation. Who took how much, by method, over a
   * period — net of refunds — so the drawer can be balanced at day-end.
   * Defaults to today. Subtree-scoped like every other money view.
   */
  async getCollections(query: any, actor?: any) {
    const now = new Date();
    const from = query?.from ? new Date(query.from) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const to = query?.to ? new Date(query.to) : new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);

    const where: any = { paymentDate: { gte: from, lt: to } };
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.subscriber = { userId: { in: ids } };
    }

    const payments = await this.prisma.payment.findMany({
      where,
      select: { amount: true, method: true, refundedAt: true, refundedAmount: true, receivedBy: true, receivedByUser: { select: { name: true } } },
    });

    const round2 = (n: number) => Math.round(((n || 0) + Number.EPSILON) * 100) / 100;
    const byStaff = new Map<string, any>();
    const byMethod = new Map<string, number>();
    let gross = 0, refunded = 0;

    for (const p of payments) {
      const net = round2((p.amount || 0) - (((p as any).refundedAmount) || 0));
      gross += p.amount || 0;
      refunded += ((p as any).refundedAmount) || 0;
      byMethod.set(p.method, round2((byMethod.get(p.method) || 0) + net));
      const key = String(p.receivedBy ?? 'unknown');
      const row = byStaff.get(key) || { receivedBy: p.receivedBy ?? null, name: p.receivedByUser?.name || 'Unattributed', net: 0, count: 0, methods: {} as Record<string, number> };
      row.net = round2(row.net + net);
      row.count += 1;
      row.methods[p.method] = round2((row.methods[p.method] || 0) + net);
      byStaff.set(key, row);
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      gross: round2(gross),
      refunded: round2(refunded),
      net: round2(gross - refunded),
      count: payments.length,
      byMethod: [...byMethod.entries()].map(([method, net]) => ({ method, net })).sort((a, b) => b.net - a.net),
      byStaff: [...byStaff.values()].sort((a, b) => b.net - a.net),
    };
  }

  async findAll(options?: { page?: number; limit?: number }, actor?: any) {
    const { page, limit } = options || {};

    const where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.subscriber = { userId: { in: ids } };
    }

    const includeOptions = {
      invoice: { select: { invoiceNo: true } },
      subscriber: { select: { fullName: true, phone: true } },
      receivedByUser: { select: { name: true } },
    };

    if (page && limit) {
      // Return paginated response
      const skip = (page - 1) * limit;
      const [data, total] = await Promise.all([
        this.prisma.payment.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: includeOptions,
        }),
        this.prisma.payment.count({ where }),
      ]);

      return { data, total, page, limit };
    }

    // Return array directly for simple requests (will be wrapped by controller)
    return this.prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: includeOptions,
    });
  }

  async getStats() {
    const [total, totalAmount, cashCount, bankCount, onlineCount, chequeCount] = await Promise.all([
      this.prisma.payment.count(),
      this.prisma.payment.aggregate({ _sum: { amount: true } }),
      this.prisma.payment.count({ where: { method: PaymentMethod.CASH } }),
      this.prisma.payment.count({ where: { method: PaymentMethod.BANK_TRANSFER } }),
      this.prisma.payment.count({ where: { method: PaymentMethod.ONLINE } }),
      this.prisma.payment.count({ where: { method: PaymentMethod.CHEQUE } }),
    ]);

    return {
      total,
      totalAmount: totalAmount._sum.amount || 0,
      cashCount,
      bankCount,
      onlineCount,
      chequeCount,
      cardCount: 0,
    };
  }

  async findOne(id: number) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: {
        invoice: true,
        subscriber: true,
        receivedByUser: true,
      },
    });
    
    if (!payment) {
      throw new NotFoundException(`Payment with ID ${id} not found`);
    }
    
    return payment;
  }

  async create(data: any) {
    // Refuse a payment dated into a closed accounting period (no backdating).
    await this.accounting.assertPeriodOpen(data.paymentDate);

    // Duplicate guard. A double-click, a network retry, or two staff entering
    // the same cash all post the money twice. Reject a payment that matches a
    // very recent one (same subscriber/invoice, amount and method) unless the
    // caller explicitly confirms it is a genuine second payment (force: true).
    if (!data.force && data.amount != null && (data.subscriberId != null || data.invoiceId != null)) {
      const WINDOW_MS = 90_000;
      const recent = await this.prisma.payment.findFirst({
        where: {
          amount: data.amount,
          method: data.method || PaymentMethod.CASH,
          refundedAt: null,
          createdAt: { gte: new Date(Date.now() - WINDOW_MS) },
          ...(data.subscriberId != null ? { subscriberId: data.subscriberId } : {}),
          ...(data.invoiceId != null ? { invoiceId: data.invoiceId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, paymentNo: true, createdAt: true },
      });
      if (recent) {
        const secs = Math.round((Date.now() - new Date(recent.createdAt).getTime()) / 1000);
        throw new ConflictException(
          `A matching payment (${recent.paymentNo}) for the same amount was recorded ${secs}s ago. ` +
          `If this is a genuine second payment, submit again to confirm.`,
        );
      }
    }

    const paymentNo = data.paymentNo || `PAY-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const payment = await this.prisma.payment.create({
      data: {
        paymentNo,
        invoiceId: data.invoiceId,
        subscriberId: data.subscriberId,
        amount: data.amount,
        method: data.method || PaymentMethod.CASH,
        referenceNo: data.referenceNo,
        notes: data.notes,
        receivedBy: data.receivedBy,
        paymentDate: data.paymentDate ? new Date(data.paymentDate) : new Date(),
      },
      include: {
        invoice: { select: { invoiceNo: true } },
        subscriber: { select: { fullName: true, phone: true } },
        receivedByUser: { select: { name: true } },
      },
    });

    // Update the invoice's paid/due amounts + status (was missing — invoices stayed UNPAID)
    if (payment.invoiceId) {
      const invoice = await this.prisma.invoice.findUnique({ where: { id: payment.invoiceId } });
      if (invoice) {
        const newPaid = invoice.paidAmount + payment.amount;
        const newDue = Math.max(invoice.total - newPaid, 0);
        const status = newPaid >= invoice.total ? 'PAID' : newPaid > 0 ? 'PARTIAL' : invoice.status;
        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: { paidAmount: newPaid, dueAmount: newDue, status, paidDate: status === 'PAID' ? new Date() : invoice.paidDate },
        });
      }
    }

    // Phase 1: double-entry posting (Cash ↔ AR)
    await this.accounting.postPaymentReceived(payment, data.receivedBy);

    // Phase 4B: reseller commission chain
    void this.organization.distributeCommission(payment);

    // Phase 2: payment notification
    const subscriber = payment.subscriberId
      ? await this.prisma.subscriber.findUnique({
          where: { id: payment.subscriberId },
          include: { package: true, serviceSettings: true },
        })
      : null;
    void this.notifications.fireEvent('PAYMENT_RECEIVED', subscriber, {
      amount: payment.amount,
      invoiceNo: payment.invoice?.invoiceNo,
    });
    this.events.broadcast('payment', {
      id: payment.id,
      amount: payment.amount,
      method: payment.method,
      invoiceNo: payment.invoice?.invoiceNo,
      subscriberName: payment.subscriber?.fullName,
    });
    return payment;
  }

  async update(id: number, data: any) {
    const updateData: any = {};
    
    if (data.amount !== undefined) updateData.amount = data.amount;
    if (data.method !== undefined) updateData.method = data.method;
    if (data.referenceNo !== undefined) updateData.referenceNo = data.referenceNo;
    if (data.notes !== undefined) updateData.notes = data.notes;
    if (data.paymentDate !== undefined) updateData.paymentDate = new Date(data.paymentDate);
    
    try {
      return await this.prisma.payment.update({
        where: { id },
        data: updateData,
        include: {
          invoice: { select: { invoiceNo: true } },
          subscriber: { select: { fullName: true, phone: true } },
          receivedByUser: { select: { name: true } },
        },
      });
    } catch (error) {
      throw new NotFoundException(`Payment with ID ${id} not found`);
    }
  }

  async remove(id: number) {
    try {
      return await this.prisma.payment.delete({ where: { id } });
    } catch (error) {
      throw new NotFoundException(`Payment with ID ${id} not found`);
    }
  }
}