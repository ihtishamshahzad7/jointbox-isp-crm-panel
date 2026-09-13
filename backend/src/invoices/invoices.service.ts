import { Injectable, ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { buildCursorPage, parseCursor } from '../common/pagination';
import { AccountingService } from '../accounting/accounting.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationService } from '../organization/organization.service';
import { ScopeService, Actor } from '../common/scope.service';
import { EventsService } from '../common/events.service';
import { renderInvoiceHtml } from './invoice-pdf-template';
import { CurrencyService } from '../common/currency.service';

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

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
   * Invoices this account may see.
   *
   * Was unscoped: two dealers under the same franchise could read each
   * other's invoices — customer names, amounts, what they charge. Sibling
   * accounts are competitors, and that is commercially sensitive.
   *
   * An invoice belongs to a subscriber, and a subscriber belongs to an
   * account, so the restriction goes through the subscriber's owner.
   */
  /**
   * WHY THIS NEEDED A BOUND
   * It had no `take` and no date filter, while pulling three relations
   * (`subscriber`, `items`, `payments`) onto every row. Invoices accumulate
   * forever — one per subscriber per month — so at 1M subscribers that is
   * ~12M parent rows a year, each fanned out by its items and payments, loaded
   * into the Node heap in one allocation. `max_memory_restart: 600M` then
   * kills the worker along with every other request it was serving. The same
   * shape as the revenue-report defect, on a route the invoices page calls on
   * every load.
   *
   * THE RETURN SHAPE IS DELIBERATELY UNCHANGED
   * `frontend/app/invoices/page.tsx` does `Array.isArray(data) ? data : ...`,
   * so returning a `{ items, nextCursor }` envelope here would silently empty
   * the page. A correctness fix that blanks the invoices screen is not an
   * improvement, so the array stays and gains a cap.
   *
   * This mirrors `SubscribersService.findAll` deliberately — cursor page when
   * `?limit=` is supplied, capped legacy array otherwise. A second convention
   * for the same problem is how the next person picks the wrong one.
   */
  async findAll(actor?: Actor, query?: any) {
    const where: any = {};
    // Delegated to ScopeService: the ISP branch must exclude the demo
    // sandbox too, and a rule restated here stops matching the rest of the app.
    {
      const _sub = await this.scope.subscriberWhere(actor);
      if (Object.keys(_sub).length) where.subscriber = _sub;
    }
    const include = { subscriber: true, items: true, payments: true };

    // Opt-in cursor pagination: index-driven, and never a COUNT(*).
    if (query?.limit !== undefined) {
      const { take, cursorArgs } = parseCursor(query);
      const rows = await this.prisma.invoice.findMany({
        where,
        include,
        orderBy: { id: 'desc' },
        take: take + 1,
        ...cursorArgs,
      });
      return buildCursorPage(rows, take);
    }

    const HARD_CAP = Number(process.env.INVOICE_LIST_CAP || 2000);
    const rows = await this.prisma.invoice.findMany({
      where,
      include,
      orderBy: { createdAt: 'desc' },
      take: HARD_CAP,
    });
    // Silent truncation is the real hazard here: the page would look complete
    // while simply missing older invoices. This is the one clue that explains
    // it to whoever eventually asks why.
    if (rows.length === HARD_CAP) {
      this.logger.warn(
        `Invoice list hit the ${HARD_CAP}-row cap. The client should paginate with ?limit= ` +
          `(raise INVOICE_LIST_CAP only as a stop-gap).`,
      );
    }
    return rows;
  }

  async findOne(id: number, actor?: Actor) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        subscriber: true,
        items: true,
        payments: true,
      },
    });
    // IDOR guard: a reseller must not read another tenant's invoice by guessing
    // its id. Non-owners get "not found" (don't reveal existence).
    if (inv && actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      if (inv.subscriber?.userId == null || !ids.includes(inv.subscriber.userId)) return null;
    }
    return inv;
  }

  async findBySubscriber(subscriberId: number) {
    return this.prisma.invoice.findMany({
      where: { subscriberId },
      include: {
        items: true,
        payments: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getStats(actor?: Actor) {
    /**
     * SCOPE THE TOTALS. These counts/sums were computed over EVERY invoice in
     * the system with no filter, so a reseller opening the invoices page saw the
     * whole ISP's billing volume — wrong numbers AND a cross-tenant leak. Scope
     * to the caller's own subtree, exactly like findAll() does.
     */
    const scope: any = {};
    // Delegated to ScopeService: the ISP branch must exclude the demo
    // sandbox too, and a rule restated here stops matching the rest of the app.
    {
      const _sub = await this.scope.subscriberWhere(actor);
      if (Object.keys(_sub).length) scope.subscriber = _sub;
    }
    const w = (extra: any = {}) => (Object.keys(scope).length ? { AND: [scope, extra] } : extra);

    const total   = await this.prisma.invoice.count({ where: w() });
    const unpaid  = await this.prisma.invoice.count({ where: w({ status: 'UNPAID' }) });
    const partial = await this.prisma.invoice.count({ where: w({ status: 'PARTIAL' }) });
    const paid    = await this.prisma.invoice.count({ where: w({ status: 'PAID' }) });
    const overdue = await this.prisma.invoice.count({ where: w({ status: 'OVERDUE' }) });

    /**
     * Money totals are grouped BY CURRENCY, in one query rather than three.
     *
     * Adding a 100 USD invoice to a 100 PKR one produces 200 of nothing. On a
     * single-currency deployment — which is every deployment until an operator
     * starts taking foreign payments — this returns exactly one group and the
     * headline figures are unchanged, so nothing about the existing screens
     * moves. The moment a second currency appears, `mixedCurrency` says so
     * instead of the panel quietly reporting a meaningless sum.
     */
    const grouped = await this.prisma.invoice.groupBy({
      by: ['currency'],
      _sum: { total: true, paidAmount: true, dueAmount: true },
      where: w(),
    });

    const currencies = grouped
      .map((g) => ({
        currency: g.currency || null,
        totalAmount: g._sum.total ?? 0,
        totalPaid: g._sum.paidAmount ?? 0,
        totalDue: g._sum.dueAmount ?? 0,
      }))
      .sort((a, b) => (b.totalAmount ?? 0) - (a.totalAmount ?? 0));

    /**
     * The scalar fields keep the existing API shape, and describe the LARGEST
     * currency by value — on a single-currency deployment, the only one.
     * Deliberately not a cross-currency sum: a labelled slice is honest and a
     * caller can see `mixedCurrency` and read `currencies`, whereas a summed
     * scalar is a number that looks authoritative and means nothing.
     */
    const head = currencies[0] ?? { currency: null, totalAmount: 0, totalPaid: 0, totalDue: 0 };

    return {
      total,
      unpaid,
      partial,
      paid,
      overdue,
      currency: head.currency,
      mixedCurrency: currencies.length > 1,
      currencies,
      totalAmount: head.totalAmount,
      totalPaid:   head.totalPaid,
      totalDue:    head.totalDue,
    };
  }

  /**
   * A5: INVOICE NUMBERS FROM A SEQUENCE, IN THE SAME FORMAT AS BEFORE.
   *
   * ── What was wrong ───────────────────────────────────────────────────────
   *     const count = await this.prisma.invoice.count();
   *     return `INV-${year}-${String(count + 1).padStart(5, '0')}`;
   *
   * Two problems in two lines. Concurrently, two callers both COUNT the same
   * table, both get 4,999, and both build `INV-2026-05000`; `invoiceNo` is
   * `@unique`, so the loser gets a constraint error in the middle of creating
   * an invoice — the customer sees a failed action rather than a duplicate,
   * which is the better of the two bad outcomes but still an outage under load.
   * And `COUNT(*)` on the Invoice table is a full scan that runs on EVERY
   * invoice creation, getting slower for the rest of the system's life.
   *
   * ── The format is deliberately unchanged ─────────────────────────────────
   * `INV-<year>-<5 digits>` is what customers already have on paper, in their
   * accounting systems and in their payment references. A sequence changes how
   * the number is ALLOCATED, not what it looks like.
   *
   * ── Why a sequence PER YEAR ──────────────────────────────────────────────
   * Because the year is part of the number. A single global sequence would
   * carry January's counter across the year boundary and produce
   * `INV-2027-05001` immediately after `INV-2026-05000`, which is legal but
   * breaks the "invoices in a year are numbered from 1" expectation the
   * current format sets. One sequence per year keeps the meaning intact.
   *
   * ── Why this does not touch the other three generators ───────────────────
   * There are four invoice-number formats in this codebase — `billing.service`
   * and `subscribers.service` use epoch-based schemes, `portal.service` uses an
   * `ACT-` prefix. They are already collision-resistant and their formats are
   * equally visible to customers. Consolidating them is a business decision
   * about what an invoice number should look like, not a correctness fix, and
   * it belongs in its own change. `npm run db:duplicate-charges` reports which
   * of the four actually appear in a given database.
   *
   * ── Restart safety ───────────────────────────────────────────────────────
   * A Postgres sequence is durable and survives restarts, deploys and crashes.
   * On first use in a year it is created starting from one past the highest
   * number already issued for that year, so an existing database continues its
   * own series rather than restarting at 1 and colliding.
   */
  async generateInvoiceNo(): Promise<string> {
    const year = new Date().getFullYear();
    const seq = `invoice_no_${year}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rows = await this.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT nextval('${seq}') AS n`,
        );
        return `INV-${year}-${String(Number(rows[0].n)).padStart(5, '0')}`;
      } catch (e: any) {
        // 42P01 = undefined_table, which is what Postgres returns for a
        // sequence that does not exist yet. Any other error is real.
        const missing = e?.code === '42P01' || /does not exist/i.test(String(e?.message || ''));
        if (!missing || attempt === 1) throw e;
        await this.ensureInvoiceSequence(year, seq);
      }
    }
    /* istanbul ignore next — the loop above either returns or throws. */
    throw new Error('Could not allocate an invoice number');
  }

  /**
   * Create this year's sequence, continuing from whatever has already been
   * issued.
   *
   * The MAX() scan runs ONCE per year rather than once per invoice.
   *
   * ── `IF NOT EXISTS` IS NOT ATOMIC, AND THIS IS THE PROOF ─────────────────
   * The obvious reading of `CREATE SEQUENCE IF NOT EXISTS` is that concurrent
   * callers are harmless: one creates, the other finds it there. PostgreSQL
   * does not promise that. The existence check and the creation are separate
   * steps, so two sessions can both pass the check and the loser fails with
   *
   *     23505  duplicate key value violates unique constraint
   *            "pg_class_relname_nsp_index"
   *
   * This was not theoretical. The first version of this method let that error
   * escape, and `invoice-number.integration.spec.ts` caught it on the very
   * first run — one of two concurrent callers got a number and the other got
   * a raw Postgres catalog error in the middle of creating an invoice.
   *
   * The loser's error means the sequence now EXISTS, which is the outcome this
   * method exists to produce. So it is swallowed, and the caller's retry of
   * `nextval` then succeeds — which is where the real serialisation belongs
   * anyway. A sequence is atomic; creating one is not.
   *
   * Only numbers matching this exact format are considered. The other three
   * generators produce longer, epoch-based numbers that would otherwise
   * suggest a starting point in the millions.
   */
  private async ensureInvoiceSequence(year: number, seq: string): Promise<void> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ max: number | null }>>(
        `SELECT MAX(SUBSTRING("invoiceNo" FROM 10)::int) AS max
           FROM "Invoice"
          WHERE "invoiceNo" ~ '^INV-${year}-[0-9]{5}$'`,
      );
      const start = Number(rows[0]?.max ?? 0) + 1;
      await this.prisma.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS ${seq} START WITH ${start}`);
    } catch (e: any) {
      // 23505 on a catalog index, or 42P07 (duplicate_table), both mean a
      // concurrent caller won the create. That is success for us.
      const raced =
        e?.code === '23505' ||
        e?.code === '42P07' ||
        /pg_class_relname_nsp_index|already exists/i.test(String(e?.message || ''));
      if (!raced) throw e;
    }
  }

  async create(data: any) {
    const invoiceNo = await this.generateInvoiceNo();
    const total     = data.amount + (data.tax || 0) - (data.discount || 0);

    const invoice = await this.prisma.invoice.create({
      data: {
        ...(await this.currency.invoiceStamp()),
        invoiceNo,
        subscriberId: data.subscriberId,
        amount:       data.amount,
        tax:          data.tax      || 0,
        discount:     data.discount || 0,
        total,
        paidAmount:   0,
        dueAmount:    total,
        dueDate:      new Date(data.dueDate),
        notes:        data.notes,
        status:       'UNPAID',
        items: {
          create: data.items || [],
        },
      },
      include: { items: true },
    });

    // Phase 1: double-entry posting (AR ↔ Revenue)
    await this.accounting.postInvoiceCreated(invoice);

    // Phase 2: invoice notification
    // subscriberId is nullable now — an invoice can outlive its subscriber.
    // No subscriber means nobody to notify, not an error.
    const subscriber = invoice.subscriberId
      ? await this.prisma.subscriber.findUnique({
          where: { id: invoice.subscriberId },
          include: { package: true, serviceSettings: true },
        })
      : null;
    void this.notifications.fireEvent('INVOICE_CREATED', subscriber, {
      amount: invoice.total,
      dueAmount: invoice.dueAmount,
      invoiceNo: invoice.invoiceNo,
    });
    return invoice;
  }

  /**
   * Generate printable HTML invoice page.
   * The user can print → Save as PDF from the browser.
   */
  async getInvoicePdf(id: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: { items: true, payments: true, subscriber: { include: { package: true } } },
    });
    if (!invoice) throw new Error('Invoice not found');

    return renderInvoiceHtml({
      invoiceNo: invoice.invoiceNo,
      invoiceDate: invoice.invoiceDate.toLocaleDateString(),
      dueDate: invoice.dueDate.toLocaleDateString(),
      status: invoice.status,
      subscriberName: invoice.subscriberName || invoice.subscriber?.fullName || 'Unknown',
      subscriberPhone: invoice.subscriber?.phone || '',
      subscriberEmail: invoice.subscriber?.email || '',
      subscriberAddress: invoice.subscriber?.address || undefined,
      packageName: invoice.subscriber?.package?.name || undefined,
      amount: invoice.amount,
      tax: invoice.tax,
      discount: invoice.discount,
      total: invoice.total,
      paidAmount: invoice.paidAmount,
      dueAmount: invoice.dueAmount,
      items: invoice.items.map((i) => ({
        description: i.description,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        total: i.total,
      })),
      payments: invoice.payments
        .filter((p) => !p.refundedAt)
        .map((p) => ({
          paymentNo: p.paymentNo,
          amount: p.amount,
          method: p.method,
          paymentDate: p.paymentDate.toLocaleDateString(),
        })),
    });
  }

  async recordPayment(invoiceId: number, data: any) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new Error('Invoice not found');

    // Same period-lock guard as the direct payment path — no backdating a
    // payment into a closed month through the invoice screen either.
    await this.accounting.assertPeriodOpen(data.paymentDate);

    // Duplicate guard: reject a payment matching a very recent one on this
    // invoice (same amount + method) unless the caller confirms with force.
    if (!data.force && data.amount != null) {
      const recent = await this.prisma.payment.findFirst({
        where: {
          invoiceId, amount: data.amount, method: data.method,
          refundedAt: null, createdAt: { gte: new Date(Date.now() - 90_000) },
        },
        orderBy: { createdAt: 'desc' }, select: { paymentNo: true, createdAt: true },
      });
      if (recent) {
        const secs = Math.round((Date.now() - new Date(recent.createdAt).getTime()) / 1000);
        throw new ConflictException(
          `A matching payment (${recent.paymentNo}) for the same amount was recorded ${secs}s ago on this invoice. ` +
          `If this is a genuine second payment, submit again to confirm.`,
        );
      }
    }

    const newPaidAmount = invoice.paidAmount + data.amount;
    const newDueAmount  = invoice.total - newPaidAmount;

    let status: 'UNPAID' | 'PARTIAL' | 'PAID' | 'OVERDUE' = 'PARTIAL';
    if (newPaidAmount >= invoice.total) status = 'PAID';

    const paymentNo = `PAY-${Date.now()}`;

    const payment = await this.prisma.payment.create({
      data: {
        ...(await this.currency.paymentStamp(data.amount, { invoiceCurrency: invoice.currency })),
        paymentNo,
        invoiceId,
        subscriberId: invoice.subscriberId,
        amount:       data.amount,
        method:       data.method,
        referenceNo:  data.referenceNo,
        notes:        data.notes,
        receivedBy:   data.receivedBy,
      },
    });

    // Phase 1: double-entry posting (Cash ↔ AR)
    await this.accounting.postPaymentReceived(payment, data.receivedBy);

    // Phase 4B: reseller commission chain
    void this.organization.distributeCommission(payment);

    // Phase 2: payment notification
    const paySubscriber = invoice.subscriberId
      ? await this.prisma.subscriber.findUnique({
          where: { id: invoice.subscriberId },
          include: { package: true, serviceSettings: true },
        })
      : null;
    void this.notifications.fireEvent('PAYMENT_RECEIVED', paySubscriber, {
      amount: data.amount,
      invoiceNo: invoice.invoiceNo,
    });
    this.events.broadcast('payment', {
      id: payment.id,
      amount: data.amount,
      method: data.method,
      invoiceNo: invoice.invoiceNo,
      subscriberName: paySubscriber?.fullName,
    });

    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        paidAmount: newPaidAmount,
        dueAmount:  newDueAmount,
        status,
        paidDate: status === 'PAID' ? new Date() : null,
      },
    });
  }
}
