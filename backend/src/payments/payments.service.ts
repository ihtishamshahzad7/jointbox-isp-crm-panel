import { Logger, Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentMethod } from '@prisma/client';
import { AccountingService } from '../accounting/accounting.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationService } from '../organization/organization.service';
import { ScopeService, Actor } from '../common/scope.service';
import { EventsService } from '../common/events.service';
import { CurrencyService } from '../common/currency.service';

@Injectable()
export class PaymentsService {
  /**
   * These ledger posts are fire-and-forget: an adjustment or reversal must not
   * fail because the double-entry write did, so the promise is caught. But the
   * catch called `this.logger?.warn?.()` on a logger that was never declared —
   * optional chaining, so no crash, and no record either. A ledger post
   * silently failing on a money operation is precisely the event that must
   * leave a trace, because the books and the payment then disagree and nothing
   * says when it started.
   */
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private prisma: PrismaService,
    private accounting: AccountingService,
    private notifications: NotificationsService,
    private organization: OrganizationService,
    private scope: ScopeService,
    private events: EventsService,
    private currency: CurrencyService,
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
    // Delegated to ScopeService: the ISP branch must exclude the demo
    // sandbox too, and a rule restated here stops matching the rest of the app.
    {
      const _sub = await this.scope.subscriberWhere(actor);
      if (Object.keys(_sub).length) where.subscriber = _sub;
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
    // Delegated to ScopeService: the ISP branch must exclude the demo
    // sandbox too, and a rule restated here stops matching the rest of the app.
    {
      const _sub = await this.scope.subscriberWhere(actor);
      if (Object.keys(_sub).length) where.subscriber = _sub;
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

  async getStats(actor?: any) {
    // Scope to the caller's subtree (same as findAll) — an unscoped total leaked
    // the whole ISP's collections to every reseller.
    const scope: any = {};
    // Delegated to ScopeService: the ISP branch must exclude the demo
    // sandbox too, and a rule restated here stops matching the rest of the app.
    {
      const _sub = await this.scope.subscriberWhere(actor);
      if (Object.keys(_sub).length) scope.subscriber = _sub;
    }
    const w = (extra: any = {}) => (Object.keys(scope).length ? { AND: [scope, extra] } : extra);
    const [total, totalAmount, cashCount, bankCount, onlineCount, chequeCount] = await Promise.all([
      this.prisma.payment.count({ where: w() }),
      this.prisma.payment.aggregate({ _sum: { amount: true }, where: w() }),
      this.prisma.payment.count({ where: w({ method: PaymentMethod.CASH }) }),
      this.prisma.payment.count({ where: w({ method: PaymentMethod.BANK_TRANSFER }) }),
      this.prisma.payment.count({ where: w({ method: PaymentMethod.ONLINE }) }),
      this.prisma.payment.count({ where: w({ method: PaymentMethod.CHEQUE }) }),
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

  async findOne(id: number, actor?: any) {
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
    // IDOR guard — a reseller can't read another tenant's payment by id.
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      if (payment.subscriber?.userId == null || !ids.includes(payment.subscriber.userId)) {
        throw new NotFoundException(`Payment with ID ${id} not found`);
      }
    }
    return payment;
  }

  /**
   * A payment belongs to its subscriber, so the subscriber decides who may
   * touch it. Answered as the same "not found" findOne() gives, so a probe
   * cannot tell "no such payment" from "another company's payment".
   */
  private async assertPaymentVisible(actor: Actor, payment: { id: number; subscriberId: number | null }) {
    try {
      await this.scope.assertViaSubscriber(actor, payment.subscriberId, 'Payment');
    } catch (e) {
      if (e instanceof NotFoundException) throw new NotFoundException(`Payment with ID ${payment.id} not found`);
      throw e;
    }
  }

  /**
   * Money may only be recorded against the caller's own customer and the
   * caller's own invoice. Checked before anything is written; the platform
   * owner is unrestricted.
   */
  private async assertPaymentTarget(actor: Actor, data: any) {
    if (this.scope.isPlatformOwner(actor)) return;
    if (data?.invoiceId != null) {
      const inv = await this.prisma.invoice.findUnique({
        where: { id: Number(data.invoiceId) },
        select: { subscriberId: true },
      });
      await this.scope.assertViaSubscriber(actor, inv?.subscriberId, 'Invoice');
      // The invoice's own subscriber has just been checked; a body that names
      // no subscriber is paying that one.
      if (data.subscriberId == null) return;
    }
    await this.scope.assertViaSubscriber(actor, data?.subscriberId, 'Subscriber');
  }

  /**
   * Money in must be a positive amount, against an invoice that can still take
   * it, for that invoice's own customer. Found on a running panel: a -500 or 0
   * "payment" was accepted (un-paying an invoice and posting negative cash —
   * that is what a refund is for), a payment for one customer could settle
   * another customer's invoice, and a paid invoice kept taking money until its
   * due amount went negative.
   */
  private async assertPayable(data: any): Promise<{ currency: string | null } | null> {
    const amount = Number(data?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Enter an amount greater than zero. To give money back, refund the payment instead.');
    }
    // Every payment settles an invoice (Payment.invoiceId is required); money
    // with no invoice behind it is a balance top-up.
    if (data?.invoiceId == null || data.invoiceId === '') {
      throw new BadRequestException("Pick the invoice this payment is for. To keep money on the customer's account, top up their balance instead.");
    }
    const inv = await this.prisma.invoice.findUnique({
      where: { id: Number(data.invoiceId) },
      select: { subscriberId: true, status: true, dueAmount: true, total: true, paidAmount: true, currency: true, invoiceNo: true },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (data.subscriberId != null && inv.subscriberId != null && Number(data.subscriberId) !== inv.subscriberId) {
      throw new BadRequestException(`Invoice ${inv.invoiceNo} belongs to a different customer. Pick that customer, or leave the invoice empty.`);
    }
    if (inv.status === 'CANCELLED') throw new BadRequestException(`Invoice ${inv.invoiceNo} is cancelled and cannot take a payment.`);
    const due = Math.max(Number(inv.total) - Number(inv.paidAmount || 0), 0);
    if (inv.status === 'PAID' || due <= 0) {
      throw new BadRequestException(`Invoice ${inv.invoiceNo} is already paid. Add the money to the customer's balance instead (Accounting → Balances → Top up).`);
    }
    if (amount > due + 0.5) {
      throw new BadRequestException(
        `Invoice ${inv.invoiceNo} has ${Math.round(due)} due. Record ${Math.round(due)} against it and add the rest to the customer's balance (Accounting → Balances → Top up).`,
      );
    }
    return { currency: inv.currency ?? null };
  }

  /**
   * WHO RECEIVED THE MONEY is the signed-in caller — or, when the caller is
   * recording cash a colleague collected, an account inside the caller's own
   * tree. It used to be whatever the request body said, so collections could
   * be booked against any user on the installation (and appear in another
   * company's collections-by-staff report).
   */
  private async receivedByFor(actor: Actor | undefined, requested: any): Promise<number | undefined> {
    if (!actor) return requested != null && requested !== '' ? Number(requested) : undefined;
    if (requested != null && requested !== '') {
      await this.scope.assertUser(actor, Number(requested));
      return Number(requested);
    }
    return this.scope.actorId(actor);
  }

  async create(data: any, actor?: Actor) {
    if (actor) await this.assertPaymentTarget(actor, data);
    await this.assertPayable(data);

    // Refuse a payment dated into a closed accounting period (no backdating).
    await this.accounting.assertPeriodOpen(data.paymentDate, {
      subscriberId: data.subscriberId != null ? Number(data.subscriberId) : null,
    });

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

    /**
     * The invoice decides the currency this payment is measured against.
     *
     * `paymentStamp` needs it to know whether any conversion happened at all:
     * money that arrived in the invoice's own currency is recorded at a rate
     * of exactly 1, with no multiplication, which is what keeps ordinary cash
     * payments free of rounding.
     */
    const targetInvoice = data.invoiceId
      ? await this.prisma.invoice.findUnique({
          where: { id: data.invoiceId },
          select: { currency: true },
        })
      : null;

    const paymentNo = data.paymentNo || `PAY-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const receivedBy = await this.receivedByFor(actor, data.receivedBy);
    const payment = await this.prisma.payment.create({
      data: {
        ...(await this.currency.paymentStamp(data.amount, { invoiceCurrency: targetInvoice?.currency })),
        paymentNo,
        invoiceId: data.invoiceId,
        subscriberId: data.subscriberId,
        amount: data.amount,
        method: data.method || PaymentMethod.CASH,
        referenceNo: data.referenceNo,
        notes: data.notes,
        receivedBy,
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
    await this.accounting.postPaymentReceived(payment, receivedBy);

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
      ownerUserId: (subscriber as any)?.userId ?? null,
    });
    return payment;
  }

  async update(id: number, data: any, actor?: Actor) {
    const existing = await this.prisma.payment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Payment with ID ${id} not found`);
    if (actor) {
      await this.assertPaymentVisible(actor, existing);
      // The subscriber is not editable here today, but a body that names one
      // must never be a way to point this money at another company's customer.
      if (data?.subscriberId != null && Number(data.subscriberId) !== existing.subscriberId) {
        await this.scope.assertViaSubscriber(actor, data.subscriberId, 'Subscriber');
      }
    }

    const updateData: any = {};
    if (data.amount !== undefined) updateData.amount = data.amount;
    if (data.method !== undefined) updateData.method = data.method;
    if (data.referenceNo !== undefined) updateData.referenceNo = data.referenceNo;
    if (data.notes !== undefined) updateData.notes = data.notes;
    if (data.paymentDate !== undefined) updateData.paymentDate = new Date(data.paymentDate);

    const updated = await this.prisma.payment.update({
      where: { id }, data: updateData,
      include: {
        invoice: { select: { invoiceNo: true } },
        subscriber: { select: { fullName: true, phone: true } },
        receivedByUser: { select: { name: true } },
      },
    });

    // If the AMOUNT changed, the invoice paid/due/status AND the ledger must be
    // brought back in step — otherwise editing a payment silently desynced the
    // books from the money. Apply the delta on both.
    const delta = data.amount !== undefined ? Number(data.amount) - existing.amount : 0;
    if (delta !== 0) {
      if (existing.invoiceId) {
        const inv = await this.prisma.invoice.findUnique({ where: { id: existing.invoiceId } });
        if (inv) {
          const newPaid = Math.max(0, inv.paidAmount + delta);
          const newDue = Math.max(inv.total - newPaid, 0);
          const status = newPaid >= inv.total ? 'PAID' : newPaid > 0 ? 'PARTIAL' : 'UNPAID';
          await this.prisma.invoice.update({
            where: { id: inv.id },
            data: { paidAmount: newPaid, dueAmount: newDue, status, paidDate: status === 'PAID' ? (inv.paidDate ?? new Date()) : null },
          });
        }
      }
      // Ledger adjustment for the delta (same sides as a receipt; a negative
      // delta naturally reverses them).
      const amt = Math.abs(delta);
      const inc = delta > 0;
      await this.accounting.post([
        { account: 'CASH', [inc ? 'debit' : 'credit']: amt, refType: 'PAYMENT_ADJUSTMENT', refId: id, subscriberId: existing.subscriberId, description: `Adjust ${existing.paymentNo}` },
        { account: 'ACCOUNTS_RECEIVABLE', [inc ? 'credit' : 'debit']: amt, refType: 'PAYMENT_ADJUSTMENT', refId: id, subscriberId: existing.subscriberId, description: `Adjust ${existing.paymentNo}` },
      ] as any).catch((e: any) => this.logger?.warn?.(`Payment adjust ledger post failed: ${e?.message || e}`));
    }
    return updated;
  }

  async remove(id: number, actor?: Actor) {
    const payment = await this.prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new NotFoundException(`Payment with ID ${id} not found`);
    if (actor) await this.assertPaymentVisible(actor, payment);

    // Removing a payment must UNDO its effects, not just drop the row:
    //   1) the invoice it paid must go back to PARTIAL/UNPAID,
    //   2) the double-entry ledger must be reversed (Cash ↓, AR ↑),
    // otherwise the invoice stays falsely PAID and the books stay overstated.
    if (payment.invoiceId) {
      const inv = await this.prisma.invoice.findUnique({ where: { id: payment.invoiceId } });
      if (inv) {
        const newPaid = Math.max(0, inv.paidAmount - payment.amount);
        const newDue = Math.max(inv.total - newPaid, 0);
        const status = newPaid >= inv.total ? 'PAID' : newPaid > 0 ? 'PARTIAL' : 'UNPAID';
        await this.prisma.invoice.update({
          where: { id: inv.id },
          data: { paidAmount: newPaid, dueAmount: newDue, status, paidDate: status === 'PAID' ? inv.paidDate : null },
        });
      }
    }
    // Inverse of postPaymentReceived (CASH debit / AR credit).
    await this.accounting.post([
      { account: 'CASH', credit: payment.amount, refType: 'PAYMENT_REVERSAL', refId: payment.id, subscriberId: payment.subscriberId, description: `Reversal of ${payment.paymentNo}` },
      { account: 'ACCOUNTS_RECEIVABLE', debit: payment.amount, refType: 'PAYMENT_REVERSAL', refId: payment.id, subscriberId: payment.subscriberId, description: `Reversal of ${payment.paymentNo}` },
    ] as any).catch((e: any) => this.logger?.warn?.(`Payment reversal ledger post failed: ${e?.message || e}`));

    return this.prisma.payment.delete({ where: { id } });
  }
}