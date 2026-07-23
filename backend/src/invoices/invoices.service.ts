import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccountingService } from '../accounting/accounting.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationService } from '../organization/organization.service';
import { ScopeService, Actor } from '../common/scope.service';

@Injectable()
export class InvoicesService {
  constructor(
    private prisma: PrismaService,
    private accounting: AccountingService,
    private notifications: NotificationsService,
    private organization: OrganizationService,
    private scope: ScopeService,
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

  async findOne(id: number) {
    return this.prisma.invoice.findUnique({
      where: { id },
      include: {
        subscriber: true,
        items: true,
        payments: true,
      },
    });
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

  async getStats() {
    const total   = await this.prisma.invoice.count();
    const unpaid  = await this.prisma.invoice.count({ where: { status: 'UNPAID' } });
    const partial = await this.prisma.invoice.count({ where: { status: 'PARTIAL' } });
    const paid    = await this.prisma.invoice.count({ where: { status: 'PAID' } });
    const overdue = await this.prisma.invoice.count({ where: { status: 'OVERDUE' } });

    const totalAmount = await this.prisma.invoice.aggregate({ _sum: { total: true } });
    const totalPaid   = await this.prisma.invoice.aggregate({ _sum: { paidAmount: true } });
    const totalDue    = await this.prisma.invoice.aggregate({ _sum: { dueAmount: true } });

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

  async recordPayment(invoiceId: number, data: any) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new Error('Invoice not found');

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
