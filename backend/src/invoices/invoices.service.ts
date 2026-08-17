import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccountingService } from '../accounting/accounting.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationService } from '../organization/organization.service';
import { ScopeService, Actor } from '../common/scope.service';
import { EventsService } from '../common/events.service';
import { renderInvoiceHtml } from './invoice-pdf-template';

@Injectable()
export class InvoicesService {
  constructor(
    private prisma: PrismaService,
    private accounting: AccountingService,
    private notifications: NotificationsService,
    private organization: OrganizationService,
    private scope: ScopeService,
    private events: EventsService,
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
  async findAll(actor?: Actor) {
    const where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.subscriber = { userId: { in: ids } };
    }
    return this.prisma.invoice.findMany({
      where,
      include: {
        subscriber: true,
        items: true,
        payments: true,
      },
      orderBy: { createdAt: 'desc' },
    });
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
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      scope.subscriber = { userId: { in: ids.length ? ids : [-1] } };
    }
    const w = (extra: any = {}) => (Object.keys(scope).length ? { AND: [scope, extra] } : extra);

    const total   = await this.prisma.invoice.count({ where: w() });
    const unpaid  = await this.prisma.invoice.count({ where: w({ status: 'UNPAID' }) });
    const partial = await this.prisma.invoice.count({ where: w({ status: 'PARTIAL' }) });
    const paid    = await this.prisma.invoice.count({ where: w({ status: 'PAID' }) });
    const overdue = await this.prisma.invoice.count({ where: w({ status: 'OVERDUE' }) });

    const totalAmount = await this.prisma.invoice.aggregate({ _sum: { total: true }, where: w() });
    const totalPaid   = await this.prisma.invoice.aggregate({ _sum: { paidAmount: true }, where: w() });
    const totalDue    = await this.prisma.invoice.aggregate({ _sum: { dueAmount: true }, where: w() });

    return {
      total,
      unpaid,
      partial,
      paid,
      overdue,
      totalAmount:  totalAmount._sum.total      ?? 0,
      totalPaid:    totalPaid._sum.paidAmount    ?? 0,
      totalDue:     totalDue._sum.dueAmount      ?? 0,
    };
  }

  async generateInvoiceNo() {
    const year  = new Date().getFullYear();
    const count = await this.prisma.invoice.count();
    return `INV-${year}-${String(count + 1).padStart(5, '0')}`;
  }

  async create(data: any) {
    const invoiceNo = await this.generateInvoiceNo();
    const total     = data.amount + (data.tax || 0) - (data.discount || 0);

    const invoice = await this.prisma.invoice.create({
      data: {
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
