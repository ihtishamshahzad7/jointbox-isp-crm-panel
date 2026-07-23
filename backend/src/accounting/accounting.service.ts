import {
  BadRequestException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache.service';
import { ScopeService, Actor } from '../common/scope.service';

export interface LedgerLine {
  account: 'CASH' | 'ACCOUNTS_RECEIVABLE' | 'REVENUE' | 'EXPENSE' | 'SUBSCRIBER_BALANCE' | 'RESELLER_BALANCE' | 'COMMISSION';
  debit?: number;
  credit?: number;
  description?: string;
  refType?: 'INVOICE' | 'PAYMENT' | 'REFUND' | 'REVERSAL' | 'EXPENSE' | 'BALANCE';
  refId?: number;
  /**
   * Nullable because invoices and payments now OUTLIVE the subscriber. When a
   * customer record is deleted the financial rows detach rather than being
   * destroyed, so a ledger line can legitimately have no subscriber attached.
   * The money still happened; only the link to the person is gone.
   */
  subscriberId?: number | null;
  createdBy?: number;
}

@Injectable()
export class AccountingService {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
    private scope: ScopeService,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // LEDGER — double-entry postings
  // ─────────────────────────────────────────────────────────────

  /** Post a balanced set of ledger lines. Throws if debits ≠ credits. */
  async post(lines: LedgerLine[]) {
    const debits = lines.reduce((s, l) => s + (l.debit || 0), 0);
    const credits = lines.reduce((s, l) => s + (l.credit || 0), 0);
    if (Math.abs(debits - credits) > 0.005) {
      throw new BadRequestException(`Unbalanced ledger posting: debits ${debits} ≠ credits ${credits}`);
    }
    await this.prisma.ledgerEntry.createMany({
      data: lines.map((l) => ({
        account: l.account,
        debit: l.debit || 0,
        credit: l.credit || 0,
        description: l.description,
        refType: l.refType,
        refId: l.refId,
        subscriberId: l.subscriberId,
        createdBy: l.createdBy,
      })),
    });
    void this.cache.delPrefix('accounting:');
  }

  /** Cursor-paginated ledger view with filters. */
  async getLedger(query: any, actor?: Actor) {
    const where: any = {};
    // The ledger is the ISP's own books — every debit and credit across the
    // whole business. A reseller has no place in it at all, so rather than
    // filtering it down to a misleading subset, it is refused outright.
    if (actor && !this.scope.isAdmin(actor.role)) {
      throw new ForbiddenException(
        'The general ledger is the ISP\'s accounts. Your own earnings are under Reseller Pricing.',
      );
    }
    if (query?.account) where.account = query.account;
    if (query?.refType) where.refType = query.refType;
    if (query?.subscriberId) where.subscriberId = Number(query.subscriberId);
    if (query?.dateFrom || query?.dateTo) {
      where.entryDate = {};
      if (query.dateFrom) where.entryDate.gte = new Date(query.dateFrom);
      if (query.dateTo) where.entryDate.lte = new Date(query.dateTo);
    }
    const limit = Math.min(Number(query?.limit) || 50, 200);
    const cursor = Number(query?.cursor) || 0;

    const rows = await this.prisma.ledgerEntry.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
      ...(cursor > 0 ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null, hasMore };
  }

  /** Per-account totals + net position (cached 30s). */
  async getLedgerSummary() {
    return this.cache.wrap('accounting:summary', 30, async () => {
      const grouped = await this.prisma.ledgerEntry.groupBy({
        by: ['account'],
        _sum: { debit: true, credit: true },
      });
      return grouped.map((g) => ({
        account: g.account,
        debit: g._sum.debit ?? 0,
        credit: g._sum.credit ?? 0,
        net: (g._sum.debit ?? 0) - (g._sum.credit ?? 0),
      }));
    });
  }

  // ─────────────────────────────────────────────────────────────
  // CASHFLOW — payments in vs expenses out, grouped per day
  // ─────────────────────────────────────────────────────────────

  async getCashflow(query: any) {
    const days = Math.min(Number(query?.days) || 30, 365);
    const from = new Date();
    from.setDate(from.getDate() - days);
    from.setHours(0, 0, 0, 0);

    const cacheKey = `accounting:cashflow:${days}`;
    return this.cache.wrap(cacheKey, 60, async () => {
      const [inflow, outflow] = await Promise.all([
        this.prisma.$queryRaw<Array<{ day: Date; total: number }>>`
          SELECT date_trunc('day', "paymentDate") AS day, COALESCE(SUM(amount), 0)::float AS total
          FROM "Payment"
          WHERE "paymentDate" >= ${from} AND "refundedAt" IS NULL
          GROUP BY 1 ORDER BY 1`,
        this.prisma.$queryRaw<Array<{ day: Date; total: number }>>`
          SELECT date_trunc('day', "expenseDate") AS day, COALESCE(SUM(amount), 0)::float AS total
          FROM "Expense"
          WHERE "expenseDate" >= ${from}
          GROUP BY 1 ORDER BY 1`,
      ]);

      const byDay = new Map<string, { date: string; inflow: number; outflow: number; net: number }>();
      const key = (d: Date) => new Date(d).toISOString().slice(0, 10);
      for (const r of inflow) {
        const k = key(r.day);
        byDay.set(k, { date: k, inflow: r.total, outflow: 0, net: r.total });
      }
      for (const r of outflow) {
        const k = key(r.day);
        const row = byDay.get(k) ?? { date: k, inflow: 0, outflow: 0, net: 0 };
        row.outflow = r.total;
        row.net = row.inflow - row.outflow;
        byDay.set(k, row);
      }
      const series = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
      const totals = series.reduce(
        (acc, r) => ({ inflow: acc.inflow + r.inflow, outflow: acc.outflow + r.outflow, net: acc.net + r.net }),
        { inflow: 0, outflow: 0, net: 0 },
      );
      return { days, series, totals };
    });
  }

  // ─────────────────────────────────────────────────────────────
  // EXPENSES
  // ─────────────────────────────────────────────────────────────

  async getExpenses(query: any) {
    const where: any = {};
    if (query?.category) where.category = query.category;
    if (query?.dateFrom || query?.dateTo) {
      where.expenseDate = {};
      if (query.dateFrom) where.expenseDate.gte = new Date(query.dateFrom);
      if (query.dateTo) where.expenseDate.lte = new Date(query.dateTo);
    }
    return this.prisma.expense.findMany({ where, orderBy: { expenseDate: 'desc' }, take: 500 });
  }

  async createExpense(data: any, userId?: number) {
    const amount = Number(data.amount);
    if (!amount || amount <= 0) throw new BadRequestException('Expense amount must be > 0');
    if (!data.category) throw new BadRequestException('Category is required');

    const expense = await this.prisma.expense.create({
      data: {
        category: String(data.category),
        amount,
        description: data.description || null,
        expenseDate: data.expenseDate ? new Date(data.expenseDate) : new Date(),
        createdBy: userId,
      },
    });
    await this.post([
      { account: 'EXPENSE', debit: amount, refType: 'EXPENSE', refId: expense.id, description: `${expense.category}`, createdBy: userId },
      { account: 'CASH', credit: amount, refType: 'EXPENSE', refId: expense.id, description: `${expense.category}`, createdBy: userId },
    ]);
    return expense;
  }

  async deleteExpense(id: number, userId?: number) {
    const expense = await this.prisma.expense.findUnique({ where: { id } });
    if (!expense) throw new NotFoundException('Expense not found');
    await this.prisma.expense.delete({ where: { id } });
    // reverse the posting (🔍 never delete ledger rows)
    await this.post([
      { account: 'CASH', debit: expense.amount, refType: 'EXPENSE', refId: id, description: `Reversal: ${expense.category}`, createdBy: userId },
      { account: 'EXPENSE', credit: expense.amount, refType: 'EXPENSE', refId: id, description: `Reversal: ${expense.category}`, createdBy: userId },
    ]);
    return { deleted: true };
  }

  // ─────────────────────────────────────────────────────────────
  // SUBSCRIBER BALANCE (wallet)
  // ─────────────────────────────────────────────────────────────

  async getBalances(query: any, actor?: Actor) {
    // Was unscoped — a dealer could list every subscriber balance in the
    // system, which is both a customer list and a debt ledger for the whole
    // network.
    const where: any = query?.nonZero === 'true' ? { balance: { not: 0 } } : {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.userId = { in: await this.scope.descendantIds(await this.scope.rootId(actor)) };
    }
    return this.prisma.subscriber.findMany({
      where,
      select: { id: true, fullName: true, username: true, phone: true, balance: true, status: true },
      orderBy: { balance: 'desc' },
      take: 500,
    });
  }

  async getBalanceHistory(subscriberId: number, actor?: Actor) {
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);
    return this.prisma.balanceTransaction.findMany({
      where: { subscriberId },
      orderBy: { id: 'desc' },
      take: 200,
    });
  }

  async topUpBalance(subscriberId: number, amount: number, notes?: string, userId?: number) {
    if (!amount || amount <= 0) throw new BadRequestException('Top-up amount must be > 0');
    const subscriber = await this.prisma.subscriber.findUnique({ where: { id: subscriberId } });
    if (!subscriber) throw new NotFoundException('Subscriber not found');

    const [updated] = await this.prisma.$transaction([
      this.prisma.subscriber.update({ where: { id: subscriberId }, data: { balance: { increment: amount } } }),
      this.prisma.balanceTransaction.create({
        data: {
          subscriberId,
          type: 'TOPUP',
          amount,
          balanceAfter: subscriber.balance + amount,
          notes: notes || null,
          createdBy: userId,
        },
      }),
    ]);
    await this.post([
      { account: 'CASH', debit: amount, refType: 'BALANCE', subscriberId, description: 'Balance top-up', createdBy: userId },
      { account: 'SUBSCRIBER_BALANCE', credit: amount, refType: 'BALANCE', subscriberId, description: 'Balance top-up', createdBy: userId },
    ]);
    return { subscriberId, balance: updated.balance };
  }

  /** Deduct wallet balance (used by auto-renewal). Records tx + ledger. */
  async deductBalance(subscriberId: number, amount: number, reference: string, type = 'RENEWAL', userId?: number) {
    const subscriber = await this.prisma.subscriber.findUnique({ where: { id: subscriberId } });
    if (!subscriber) throw new NotFoundException('Subscriber not found');
    if (subscriber.balance < amount) throw new BadRequestException('Insufficient balance');

    const [updated] = await this.prisma.$transaction([
      this.prisma.subscriber.update({ where: { id: subscriberId }, data: { balance: { decrement: amount } } }),
      this.prisma.balanceTransaction.create({
        data: {
          subscriberId,
          type,
          amount: -amount,
          balanceAfter: subscriber.balance - amount,
          reference,
          createdBy: userId,
        },
      }),
    ]);
    await this.post([
      { account: 'SUBSCRIBER_BALANCE', debit: amount, refType: 'BALANCE', subscriberId, description: reference, createdBy: userId },
      { account: 'REVENUE', credit: amount, refType: 'BALANCE', subscriberId, description: reference, createdBy: userId },
    ]);
    return { subscriberId, balance: updated.balance };
  }

  // ─────────────────────────────────────────────────────────────
  // INVOICE REVERSAL & PAYMENT REFUND (🔍 mandatory reasons)
  // ─────────────────────────────────────────────────────────────

  async reverseInvoice(invoiceId: number, reason: string, userId?: number) {
    if (!reason?.trim()) throw new BadRequestException('Reversal reason is required');
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId }, include: { payments: true } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status === 'CANCELLED') throw new BadRequestException('Invoice is already cancelled');
    const activePayments = invoice.payments.filter((p) => !p.refundedAt);
    if (activePayments.length > 0) {
      throw new BadRequestException('Invoice has payments — refund them before reversing the invoice');
    }

    const updated = await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'CANCELLED', reversedAt: new Date(), reversalReason: reason.trim(), reversedBy: userId, dueAmount: 0 },
    });
    await this.post([
      { account: 'REVENUE', debit: invoice.total, refType: 'REVERSAL', refId: invoiceId, subscriberId: invoice.subscriberId, description: `Reversal ${invoice.invoiceNo}: ${reason.trim()}`, createdBy: userId },
      { account: 'ACCOUNTS_RECEIVABLE', credit: invoice.total, refType: 'REVERSAL', refId: invoiceId, subscriberId: invoice.subscriberId, description: `Reversal ${invoice.invoiceNo}`, createdBy: userId },
    ]);
    await this.prisma.activityLog.create({
      data: { userId, action: 'REVERSE', entity: 'Invoice', entityId: invoiceId, details: reason.trim() },
    });
    return updated;
  }

  async refundPayment(paymentId: number, reason: string, toBalance = false, userId?: number) {
    if (!reason?.trim()) throw new BadRequestException('Refund reason is required');
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { invoice: true } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.refundedAt) throw new BadRequestException('Payment is already refunded');

    const invoice = payment.invoice;
    const newPaid = Math.max(invoice.paidAmount - payment.amount, 0);
    const newDue = invoice.total - newPaid;
    const newStatus = newPaid <= 0 ? 'UNPAID' : newPaid < invoice.total ? 'PARTIAL' : 'PAID';

    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: paymentId },
        data: { refundedAt: new Date(), refundReason: reason.trim(), refundedBy: userId },
      }),
      this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { paidAmount: newPaid, dueAmount: newDue, status: newStatus, paidDate: newStatus === 'PAID' ? invoice.paidDate : null },
      }),
    ]);

    if (toBalance) {
      /**
       * A refund TO WALLET needs a wallet to credit. If the subscriber has
       * since been deleted there is no wallet left, so refuse rather than
       * silently posting the refund nowhere — the operator has to hand this
       * one back as cash instead.
       */
      if (payment.subscriberId == null) {
        throw new BadRequestException(
          'This payment is no longer attached to a subscriber, so it cannot be refunded to their wallet. Refund it as cash instead.',
        );
      }
      // credit the wallet instead of handing back cash
      const sub = await this.prisma.subscriber.findUnique({ where: { id: payment.subscriberId } });
      await this.prisma.$transaction([
        this.prisma.subscriber.update({ where: { id: payment.subscriberId }, data: { balance: { increment: payment.amount } } }),
        this.prisma.balanceTransaction.create({
          data: {
            subscriberId: payment.subscriberId,
            type: 'REFUND',
            amount: payment.amount,
            balanceAfter: (sub?.balance ?? 0) + payment.amount,
            reference: payment.paymentNo,
            notes: reason.trim(),
            createdBy: userId,
          },
        }),
      ]);
      await this.post([
        { account: 'ACCOUNTS_RECEIVABLE', debit: payment.amount, refType: 'REFUND', refId: paymentId, subscriberId: payment.subscriberId, description: `Refund→balance ${payment.paymentNo}: ${reason.trim()}`, createdBy: userId },
        { account: 'SUBSCRIBER_BALANCE', credit: payment.amount, refType: 'REFUND', refId: paymentId, subscriberId: payment.subscriberId, description: `Refund→balance ${payment.paymentNo}`, createdBy: userId },
      ]);
    } else {
      await this.post([
        { account: 'ACCOUNTS_RECEIVABLE', debit: payment.amount, refType: 'REFUND', refId: paymentId, subscriberId: payment.subscriberId, description: `Refund ${payment.paymentNo}: ${reason.trim()}`, createdBy: userId },
        { account: 'CASH', credit: payment.amount, refType: 'REFUND', refId: paymentId, subscriberId: payment.subscriberId, description: `Refund ${payment.paymentNo}`, createdBy: userId },
      ]);
    }
    await this.prisma.activityLog.create({
      data: { userId, action: 'REFUND', entity: 'Payment', entityId: paymentId, details: reason.trim() },
    });
    return { refunded: true, invoiceStatus: newStatus };
  }

  // ─────────────────────────────────────────────────────────────
  // STANDARD POSTINGS used by other modules
  // ─────────────────────────────────────────────────────────────

  async postInvoiceCreated(invoice: { id: number; invoiceNo: string; total: number; subscriberId: number | null }, userId?: number) {
    await this.post([
      { account: 'ACCOUNTS_RECEIVABLE', debit: invoice.total, refType: 'INVOICE', refId: invoice.id, subscriberId: invoice.subscriberId, description: invoice.invoiceNo, createdBy: userId },
      { account: 'REVENUE', credit: invoice.total, refType: 'INVOICE', refId: invoice.id, subscriberId: invoice.subscriberId, description: invoice.invoiceNo, createdBy: userId },
    ]);
  }

  async postPaymentReceived(payment: { id: number; paymentNo: string; amount: number; subscriberId: number | null }, userId?: number) {
    await this.post([
      { account: 'CASH', debit: payment.amount, refType: 'PAYMENT', refId: payment.id, subscriberId: payment.subscriberId, description: payment.paymentNo, createdBy: userId },
      { account: 'ACCOUNTS_RECEIVABLE', credit: payment.amount, refType: 'PAYMENT', refId: payment.id, subscriberId: payment.subscriberId, description: payment.paymentNo, createdBy: userId },
    ]);
  }
}
