import {
  BadRequestException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache.service';
import { ScopeService, Actor } from '../common/scope.service';
import { CurrencyService } from '../common/currency.service';

/** Round money to 2dp so partial-refund arithmetic never drifts on floats. */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

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
    private currency: CurrencyService,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // LEDGER — double-entry postings
  // ─────────────────────────────────────────────────────────────

  /** Post a balanced set of ledger lines. Throws if debits ≠ credits. */
  async post(lines: LedgerLine[], client: any = this.prisma) {
    const debits = lines.reduce((s, l) => s + (l.debit || 0), 0);
    const credits = lines.reduce((s, l) => s + (l.credit || 0), 0);
    if (Math.abs(debits - credits) > 0.005) {
      throw new BadRequestException(`Unbalanced ledger posting: debits ${debits} ≠ credits ${credits}`);
    }
    /**
     * Every line of a posting carries the currency it is denominated in.
     *
     * A trial balance that sums across currencies is not a smaller error than
     * a wrong number — it is a meaningless one. And amounts stored bare are
     * reinterpreted the moment somebody edits `Isp.currency`, which silently
     * rewrites the meaning of the entire ledger.
     *
     * Resolved once for the whole posting rather than per line: a single
     * balanced posting is by definition one transaction in one currency, and
     * per-line resolution could in principle straddle a currency change made
     * mid-posting, producing a set of lines that no longer balance.
     */
    const currency = await this.currency.billingCurrencyOrBlank();

    await client.ledgerEntry.createMany({
      data: lines.map((l) => ({
        account: l.account,
        currency,
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

  // ── Accounting-period lock (close-the-books) ─────────────────
  /** Current lock state — the date through which the books are closed. */
  async getPeriodLock() {
    const lock = await this.prisma.accountingLock.findUnique({ where: { id: 1 } });
    return { lockedThrough: lock?.lockedThrough ?? null, updatedAt: lock?.updatedAt ?? null };
  }

  /** Move the close-through date. ISP-only (enforced in the controller). */
  async setPeriodLock(lockedThrough: string | null, actorId?: number) {
    const value = lockedThrough ? new Date(lockedThrough) : null;
    const lock = await this.prisma.accountingLock.upsert({
      where: { id: 1 },
      update: { lockedThrough: value, updatedById: actorId ?? null },
      create: { id: 1, lockedThrough: value, updatedById: actorId ?? null },
    });
    await this.prisma.activityLog.create({
      data: { userId: actorId ?? null, action: 'SET_PERIOD_LOCK', entity: 'AccountingLock', entityId: 1,
        details: value ? `Books closed through ${value.toISOString().slice(0, 10)}` : 'Period lock cleared' },
    }).catch(() => null);
    return { lockedThrough: lock.lockedThrough };
  }

  /** Throw if `date` falls in a closed period. Call from any financial writer. */
  async assertPeriodOpen(date?: Date | string | null) {
    const d = date ? new Date(date) : new Date();
    const lock = await this.prisma.accountingLock.findUnique({ where: { id: 1 } });
    if (lock?.lockedThrough && d.getTime() <= new Date(lock.lockedThrough).getTime()) {
      throw new BadRequestException(
        `The accounting period through ${new Date(lock.lockedThrough).toLocaleDateString()} is closed. ` +
        `You cannot record or backdate a financial entry into it — use a current date or ask the ISP to reopen the period.`,
      );
    }
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
      /**
       * Grouped by CURRENCY as well as account.
       *
       * Summing debits across currencies does not produce a slightly wrong
       * trial balance — it produces a meaningless one, and worse, a balanced
       * ledger can appear unbalanced (or an unbalanced one appear fine)
       * purely because two currencies were added together. Every row here is
       * therefore denominated in exactly one currency, and a caller that
       * wants a single figure has to say which currency it means.
       */
      const grouped = await this.prisma.ledgerEntry.groupBy({
        by: ['account', 'currency'],
        _sum: { debit: true, credit: true },
      });
      return grouped.map((g) => ({
        account: g.account,
        currency: g.currency || null,
        debit: g._sum.debit ?? 0,
        credit: g._sum.credit ?? 0,
        net: (g._sum.debit ?? 0) - (g._sum.credit ?? 0),
      }));
    });
  }

  /**
   * Trial balance — the fundamental double-entry integrity check. Every posting
   * writes equal debits and credits, so across the WHOLE ledger total debits
   * must equal total credits. If they don't, a posting was written unbalanced
   * (a bug, a manual DB edit, a partial failure) and the books no longer add up.
   * Report-only; it names the drift so a human can find the cause.
   */
  async getTrialBalance() {
    return this.cache.wrap('accounting:trial-balance', 30, async () => {
      const rows = await this.getLedgerSummary();

      /**
       * A trial balance is PER CURRENCY, always.
       *
       * Debits and credits only offset each other within one currency. Summed
       * across currencies the totals are not merely imprecise — they can
       * report a genuinely broken ledger as balanced (a 100 USD error hidden
       * by a 100 PKR error in the other direction) or a perfectly sound one as
       * broken. Since a trial balance exists precisely to answer "do the books
       * balance", a cross-currency total answers the one question it is for
       * incorrectly.
       *
       * So the books balance only when EVERY currency balances on its own.
       */
      const byCurrency = new Map<string, { debit: number; credit: number }>();
      for (const r of rows) {
        const key = r.currency || 'UNSPECIFIED';
        const acc = byCurrency.get(key) || { debit: 0, credit: 0 };
        acc.debit += r.debit || 0;
        acc.credit += r.credit || 0;
        byCurrency.set(key, acc);
      }

      const currencies = [...byCurrency.entries()]
        .map(([currency, v]) => {
          const difference = round2(v.debit - v.credit);
          return {
            currency,
            totalDebit: round2(v.debit),
            totalCredit: round2(v.credit),
            difference,
            balanced: Math.abs(difference) < 0.005,
          };
        })
        .sort((a, b) => a.currency.localeCompare(b.currency));

      const balanced = currencies.every((c) => c.balanced);
      const mixedCurrency = currencies.length > 1;

      /**
       * The scalar totals are kept for the existing UI, but they now describe
       * ONE currency — the first, which on a single-currency deployment (all
       * of them, until an operator starts taking foreign payments) is simply
       * the only one. `mixedCurrency` is what tells a caller the headline
       * figure is a slice rather than the whole, so the number is never
       * silently passed off as a grand total.
       */
      const head = currencies[0] ?? { totalDebit: 0, totalCredit: 0, difference: 0, currency: null };
      const totalDebit = head.totalDebit;
      const totalCredit = head.totalCredit;
      const difference = head.difference;

      // Also flag any individual ledger row that is itself unbalanced — a single
      // entry that carries both a debit and a credit, or neither, is malformed.
      const malformed = await this.prisma.ledgerEntry.count({
        where: {
          OR: [
            { debit: { gt: 0 }, credit: { gt: 0 } },
            { debit: { lte: 0 }, credit: { lte: 0 } },
          ],
        },
      });

      const unbalanced = currencies.filter((c) => !c.balanced);

      return {
        balanced,
        mixedCurrency,
        currency: head.currency,
        currencies,
        totalDebit,
        totalCredit,
        difference,
        malformedEntries: malformed,
        accounts: rows.sort(
          (a, b) =>
            a.account.localeCompare(b.account) ||
            String(a.currency ?? '').localeCompare(String(b.currency ?? '')),
        ),
        checkedAt: new Date().toISOString(),
        message: balanced
          ? mixedCurrency
            ? `Books balance in each of ${currencies.length} currencies.`
            : 'Books balance — total debits equal total credits.'
          : unbalanced
              .map(
                (c) =>
                  `${c.currency} is out of balance by ${c.difference} (debits ${c.totalDebit} ≠ credits ${c.totalCredit}).`,
              )
              .join(' '),
      };
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
          WHERE "expenseDate" >= ${from} AND "status" = 'APPROVED'
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

  async createExpense(data: any, actor?: { sub?: number; role?: string }) {
    const amount = Number(data.amount);
    if (!amount || amount <= 0) throw new BadRequestException('Expense amount must be > 0');
    if (!data.category) throw new BadRequestException('Category is required');
    // No backdating an expense into a closed period.
    await this.assertPeriodOpen(data.expenseDate);
    const userId = actor?.sub;

    // Approval gate: a staff-raised expense above the threshold is held PENDING
    // and posts nothing until the ISP owner approves it. Owners always bypass.
    const { expenseApprovalThreshold } = await this.getFinanceSettings();
    const needsApproval =
      expenseApprovalThreshold > 0 && amount > expenseApprovalThreshold && !this.isOwner(actor?.role);

    const expense = await this.prisma.expense.create({
      data: {
        category: String(data.category),
        amount,
        description: data.description || null,
        expenseDate: data.expenseDate ? new Date(data.expenseDate) : new Date(),
        createdBy: userId,
        status: needsApproval ? 'PENDING' : 'APPROVED',
        ...(needsApproval ? {} : { approvedById: userId, approvedAt: new Date() }),
      } as any,
    });

    if (needsApproval) {
      await this.prisma.activityLog.create({
        data: { userId, action: 'EXPENSE_REQUEST', entity: 'Expense', entityId: expense.id,
          details: `Expense ${amount} (${expense.category}) awaiting approval (> ${expenseApprovalThreshold})` },
      }).catch(() => null);
      return { ...expense, pending: true, threshold: expenseApprovalThreshold };
    }

    await this.postExpenseEntries(expense, userId);
    return expense;
  }

  /** The Cash↔Expense posting, shared by direct create and approval. */
  private async postExpenseEntries(expense: { id: number; amount: number; category: string }, userId?: number) {
    await this.post([
      { account: 'EXPENSE', debit: expense.amount, refType: 'EXPENSE', refId: expense.id, description: `${expense.category}`, createdBy: userId },
      { account: 'CASH', credit: expense.amount, refType: 'EXPENSE', refId: expense.id, description: `${expense.category}`, createdBy: userId },
    ]);
  }

  /** Expenses waiting on ISP sign-off. */
  async listExpenseRequests(status = 'PENDING') {
    return this.prisma.expense.findMany({
      where: status === 'ALL' ? {} : { status } as any,
      orderBy: { createdAt: 'desc' }, take: 100,
    });
  }

  /** Approve a pending expense — this is where it hits the ledger. */
  async approveExpense(id: number, actorId?: number) {
    const e = await this.prisma.expense.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('Expense not found');
    if ((e as any).status !== 'PENDING') throw new BadRequestException(`Expense is already ${(e as any).status?.toLowerCase?.() ?? 'processed'}`);
    // Approval posts to the ledger — refuse if the expense's period has closed since it was raised.
    await this.assertPeriodOpen(e.expenseDate);
    await this.prisma.expense.update({ where: { id }, data: { status: 'APPROVED', approvedById: actorId ?? null, approvedAt: new Date() } as any });
    await this.postExpenseEntries(e, actorId);
    return { approved: true };
  }

  /** Reject a pending expense — nothing was posted, so just close it. */
  async rejectExpense(id: number, actorId?: number) {
    const e = await this.prisma.expense.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('Expense not found');
    if ((e as any).status !== 'PENDING') throw new BadRequestException(`Expense is already ${(e as any).status?.toLowerCase?.() ?? 'processed'}`);
    await this.prisma.expense.update({ where: { id }, data: { status: 'REJECTED', approvedById: actorId ?? null, approvedAt: new Date() } as any });
    return { rejected: true };
  }

  async deleteExpense(id: number, userId?: number) {
    const expense = await this.prisma.expense.findUnique({ where: { id } });
    if (!expense) throw new NotFoundException('Expense not found');
    // Deleting an approved expense posts a reversal — refuse if its period is closed.
    if (((expense as any).status ?? 'APPROVED') === 'APPROVED') await this.assertPeriodOpen(expense.expenseDate);
    const wasPosted = ((expense as any).status ?? 'APPROVED') === 'APPROVED';
    await this.prisma.expense.delete({ where: { id } });
    // Only reverse if it actually posted. A PENDING or REJECTED expense never
    // touched the ledger, so posting a reversal would invent phantom rows.
    if (wasPosted) {
      await this.post([
        { account: 'CASH', debit: expense.amount, refType: 'EXPENSE', refId: id, description: `Reversal: ${expense.category}`, createdBy: userId },
        { account: 'EXPENSE', credit: expense.amount, refType: 'EXPENSE', refId: id, description: `Reversal: ${expense.category}`, createdBy: userId },
      ]);
    }
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

  /**
   * Deduct wallet balance (used by BALANCE-mode renewal). Records tx + ledger.
   *
   * IDEMPOTENCY + RACE SAFETY: a double-fired BALANCE renewal used to deduct the
   * wallet twice, because the reference was a freshly-minted invoice number and
   * nothing checked for an existing row. Now:
   *
   *   1. `reference` must be DETERMINISTIC for a given logical charge (the caller
   *      passes the same activation key for a replayed request).
   *   2. The deduction first takes a `FOR UPDATE` row lock on the subscriber, so
   *      two concurrent deductions serialize; the loser re-checks and finds the
   *      winner's BalanceTransaction → `alreadyDeducted` → the caller aborts
   *      WITHOUT a second deduction and without losing money.
   *   3. `tx` lets the caller run this inside ITS transaction (activateRenewal),
   *      so a failed activation rolls the deduction back with everything else.
   */
  async deductBalance(
    subscriberId: number,
    amount: number,
    reference: string,
    type = 'RENEWAL',
    userId?: number,
    tx?: any,
  ) {
    const client: any = tx ?? this.prisma;

    // Serialize per-subscriber wallet spending; replay of the same charge is a no-op.
    if (client.$queryRaw) {
      await client.$queryRaw`SELECT id FROM "Subscriber" WHERE id = ${subscriberId} FOR UPDATE`;
    }
    const already = await client.balanceTransaction.findFirst({ where: { subscriberId, reference } });
    if (already) {
      return { subscriberId, balance: null as number | null, alreadyDeducted: true };
    }

    const subscriber = await client.subscriber.findUnique({ where: { id: subscriberId } });
    if (!subscriber) throw new NotFoundException('Subscriber not found');
    if (Number(subscriber.balance) < amount) throw new BadRequestException('Insufficient balance');

    const createEntry = () =>
      client.balanceTransaction.create({
        data: {
          subscriberId,
          type,
          amount: -amount,
          balanceAfter: Number(subscriber.balance) - amount,
          reference,
          createdBy: userId,
        },
      });

    let updated;
    if (tx) {
      // Inside the caller's transaction — both writes are atomic with it.
      updated = await tx.subscriber.update({
        where: { id: subscriberId },
        data: { balance: { decrement: amount } },
      });
      await createEntry();
    } else {
      [updated] = await this.prisma.$transaction([
        this.prisma.subscriber.update({ where: { id: subscriberId }, data: { balance: { decrement: amount } } }),
        this.prisma.balanceTransaction.create({
          data: {
            subscriberId,
            type,
            amount: -amount,
            balanceAfter: Number(subscriber.balance) - amount,
            reference,
            createdBy: userId,
          },
        }),
      ]);
    }

    await this.post([
      { account: 'SUBSCRIBER_BALANCE', debit: amount, refType: 'BALANCE', subscriberId, description: reference, createdBy: userId },
      { account: 'REVENUE', credit: amount, refType: 'BALANCE', subscriberId, description: reference, createdBy: userId },
    ], client);
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
    // Can't reverse an invoice whose accounting period is closed.
    await this.assertPeriodOpen(invoice.invoiceDate);
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

  async refundPayment(paymentId: number, reason: string, toBalance = false, userId?: number, amount?: number) {
    if (!reason?.trim()) throw new BadRequestException('Refund reason is required');
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { invoice: true } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.refundedAt) throw new BadRequestException('Payment is already fully refunded');

    // Can't refund into a closed accounting period (books already locked).
    await this.assertPeriodOpen(payment.paymentDate);

    // Partial-refund support: default to the full remaining amount. A caller
    // may refund any slice up to what's left un-refunded on this payment.
    const alreadyRefunded = (payment as any).refundedAmount || 0;
    const remaining = round2(payment.amount - alreadyRefunded);
    const refundAmt = amount == null ? remaining : round2(amount);
    if (refundAmt <= 0) throw new BadRequestException('Refund amount must be greater than zero');
    if (refundAmt > remaining + 0.005) {
      throw new BadRequestException(
        `Refund of ${refundAmt} exceeds the ${remaining} still refundable on payment ${payment.paymentNo}.`,
      );
    }
    const fullyRefunded = round2(alreadyRefunded + refundAmt) >= round2(payment.amount) - 0.005;

    const invoice = payment.invoice;
    const newPaid = Math.max(round2(invoice.paidAmount - refundAmt), 0);
    const newDue = round2(invoice.total - newPaid);
    const newStatus = newPaid <= 0 ? 'UNPAID' : newPaid < invoice.total ? 'PARTIAL' : 'PAID';

    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          refundedAmount: round2(alreadyRefunded + refundAmt),
          refundReason: reason.trim(),
          refundedBy: userId,
          ...(fullyRefunded ? { refundedAt: new Date() } : {}),
        } as any,
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
        this.prisma.subscriber.update({ where: { id: payment.subscriberId }, data: { balance: { increment: refundAmt } } }),
        this.prisma.balanceTransaction.create({
          data: {
            subscriberId: payment.subscriberId,
            type: 'REFUND',
            amount: refundAmt,
            balanceAfter: (sub?.balance ?? 0) + refundAmt,
            reference: payment.paymentNo,
            notes: reason.trim(),
            createdBy: userId,
          },
        }),
      ]);
      await this.post([
        { account: 'ACCOUNTS_RECEIVABLE', debit: refundAmt, refType: 'REFUND', refId: paymentId, subscriberId: payment.subscriberId, description: `Refund→balance ${payment.paymentNo}: ${reason.trim()}`, createdBy: userId },
        { account: 'SUBSCRIBER_BALANCE', credit: refundAmt, refType: 'REFUND', refId: paymentId, subscriberId: payment.subscriberId, description: `Refund→balance ${payment.paymentNo}`, createdBy: userId },
      ]);
    } else {
      await this.post([
        { account: 'ACCOUNTS_RECEIVABLE', debit: refundAmt, refType: 'REFUND', refId: paymentId, subscriberId: payment.subscriberId, description: `Refund ${payment.paymentNo}: ${reason.trim()}`, createdBy: userId },
        { account: 'CASH', credit: refundAmt, refType: 'REFUND', refId: paymentId, subscriberId: payment.subscriberId, description: `Refund ${payment.paymentNo}`, createdBy: userId },
      ]);
    }
    // Reverse the reseller COMMISSION that cascaded up the chain on this payment
    // — a refund gives the customer's money back, so the commission earned on it
    // must be clawed back too. Offsetting entries, idempotent, never edits the
    // originals. Best-effort so it can't block the refund itself.
    try {
      const payRef = payment.paymentNo || `PAY#${paymentId}`;
      // Prorate the clawback to the slice being refunded, and key idempotency to
      // the cumulative refunded total so each partial refund claws back once.
      const fraction = payment.amount > 0 ? refundAmt / payment.amount : 1;
      const revRef = `REV#${payRef}#${round2(alreadyRefunded + refundAmt)}`;
      const already = await this.prisma.userBalanceTransaction.findFirst({ where: { reference: revRef }, select: { id: true } });
      if (!already) {
        const commRows = await this.prisma.userBalanceTransaction.findMany({ where: { reference: payRef, type: 'COMMISSION' } });
        for (const cr of commRows) {
          const signed = round2(Number(cr.amount || 0) * fraction);
          if (!signed) continue;
          const u = await this.prisma.user.update({ where: { id: cr.userId }, data: { balance: { increment: -signed } }, select: { balance: true } });
          await this.prisma.userBalanceTransaction.create({
            data: { userId: cr.userId, type: 'ADJUSTMENT', amount: -signed, balanceAfter: u.balance, reference: revRef, notes: `Commission clawed back on refund of ${round2(refundAmt)} on ${payRef}`, createdBy: userId ?? null } as any,
          });
        }
      }
    } catch { /* commission reversal is best-effort */ }

    await this.prisma.activityLog.create({
      data: { userId, action: 'REFUND', entity: 'Payment', entityId: paymentId,
        details: `${fullyRefunded ? 'Full' : 'Partial'} refund ${round2(refundAmt)}${toBalance ? '→wallet' : ''}: ${reason.trim()}` },
    });
    return { refunded: true, invoiceStatus: newStatus, amount: round2(refundAmt), fullyRefunded, remaining: round2(remaining - refundAmt) };
  }

  // ── Refund approval workflow (large refunds need ISP sign-off) ─────────────
  private isOwner(role?: string) {
    return role === 'SUPER_ADMIN' || role === 'ADMIN';
  }

  /** Current finance policy (creates the singleton on first read). */
  async getFinanceSettings() {
    const s = await this.prisma.financeSettings.findUnique({ where: { id: 1 } });
    return {
      refundApprovalThreshold: s?.refundApprovalThreshold ?? 0,
      expenseApprovalThreshold: (s as any)?.expenseApprovalThreshold ?? 0,
      updatedAt: s?.updatedAt ?? null,
    };
  }

  /** Set the finance approval thresholds. ISP owner only (enforced in controller). */
  async setFinanceSettings(body: { refundApprovalThreshold?: number; expenseApprovalThreshold?: number }, actorId?: number) {
    const cur = await this.getFinanceSettings();
    const refund = Math.max(0, Number(body.refundApprovalThreshold ?? cur.refundApprovalThreshold) || 0);
    const expense = Math.max(0, Number(body.expenseApprovalThreshold ?? cur.expenseApprovalThreshold) || 0);
    await this.prisma.financeSettings.upsert({
      where: { id: 1 },
      update: { refundApprovalThreshold: refund, expenseApprovalThreshold: expense, updatedById: actorId ?? null } as any,
      create: { id: 1, refundApprovalThreshold: refund, expenseApprovalThreshold: expense, updatedById: actorId ?? null } as any,
    });
    return { refundApprovalThreshold: refund, expenseApprovalThreshold: expense };
  }

  /**
   * Entry point the controller calls. Decides whether the refund can post now
   * or must wait for ISP approval. Owners always bypass. A threshold of 0 means
   * the gate is off. Returns either the refund result or a pending request.
   */
  async requestRefund(
    paymentId: number,
    body: { reason: string; toBalance?: boolean; amount?: number },
    actor?: { sub?: number; role?: string; name?: string },
  ) {
    const reason = (body?.reason || '').trim();
    if (!reason) throw new BadRequestException('Refund reason is required');
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.refundedAt) throw new BadRequestException('Payment is already fully refunded');

    const already = (payment as any).refundedAmount || 0;
    const remaining = round2(payment.amount - already);
    const refundAmt = body.amount == null ? remaining : round2(body.amount);

    const { refundApprovalThreshold } = await this.getFinanceSettings();
    const needsApproval =
      refundApprovalThreshold > 0 && refundAmt > refundApprovalThreshold && !this.isOwner(actor?.role);

    if (!needsApproval) {
      return this.refundPayment(paymentId, reason, body.toBalance === true, actor?.sub, body.amount);
    }

    // Over threshold and requester isn't the owner — queue it, post nothing.
    const req = await this.prisma.refundRequest.create({
      data: {
        paymentId, amount: refundAmt, toBalance: body.toBalance === true, reason,
        requestedById: actor?.sub ?? null, requestedByName: actor?.name ?? null,
      },
    });
    await this.prisma.activityLog.create({
      data: { userId: actor?.sub ?? null, action: 'REFUND_REQUEST', entity: 'Payment', entityId: paymentId,
        details: `Refund ${refundAmt} on ${payment.paymentNo} awaiting approval (> ${refundApprovalThreshold})` },
    }).catch(() => null);
    return { pending: true, requestId: req.id, amount: refundAmt, threshold: refundApprovalThreshold };
  }

  /** Counts for the approval badge — how much is waiting on the ISP owner. */
  async getPendingApprovals() {
    const [refunds, expenses] = await Promise.all([
      this.prisma.refundRequest.count({ where: { status: 'PENDING' } }),
      this.prisma.expense.count({ where: { status: 'PENDING' } as any }),
    ]);
    return { refunds, expenses, total: refunds + expenses };
  }

  /** Pending refund requests for the approval queue. ISP owner only. */
  async listRefundRequests(status = 'PENDING') {
    const rows = await this.prisma.refundRequest.findMany({
      where: status === 'ALL' ? {} : { status },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
    const payIds = [...new Set(rows.map((r) => r.paymentId))];
    const pays = await this.prisma.payment.findMany({ where: { id: { in: payIds } }, select: { id: true, paymentNo: true, subscriberName: true } });
    const byId = new Map(pays.map((p) => [p.id, p]));
    return rows.map((r) => ({ ...r, paymentNo: byId.get(r.paymentId)?.paymentNo ?? null, subscriberName: byId.get(r.paymentId)?.subscriberName ?? null }));
  }

  /** Approve a queued refund — this is where the money actually moves. */
  async approveRefundRequest(requestId: number, actorId?: number, note?: string) {
    const rr = await this.prisma.refundRequest.findUnique({ where: { id: requestId } });
    if (!rr) throw new NotFoundException('Refund request not found');
    if (rr.status !== 'PENDING') throw new BadRequestException(`Request is already ${rr.status.toLowerCase()}`);
    const result = await this.refundPayment(rr.paymentId, rr.reason, rr.toBalance, actorId, rr.amount);
    await this.prisma.refundRequest.update({
      where: { id: requestId },
      data: { status: 'APPROVED', decidedById: actorId ?? null, decidedAt: new Date(), decisionNote: note ?? null },
    });
    return { approved: true, ...result };
  }

  /** Reject a queued refund — nothing was ever posted, so just close it. */
  async rejectRefundRequest(requestId: number, actorId?: number, note?: string) {
    const rr = await this.prisma.refundRequest.findUnique({ where: { id: requestId } });
    if (!rr) throw new NotFoundException('Refund request not found');
    if (rr.status !== 'PENDING') throw new BadRequestException(`Request is already ${rr.status.toLowerCase()}`);
    await this.prisma.refundRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', decidedById: actorId ?? null, decidedAt: new Date(), decisionNote: note ?? null },
    });
    return { rejected: true };
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
