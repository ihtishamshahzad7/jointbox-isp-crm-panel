import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { PermissionsGuard } from '../security/permissions.guard';
import { canRead } from '../common/permission-check';

/**
 * ADVANCED CRM — CUSTOMER STATEMENT AND RECEIPTS.
 *
 * Behaviour ported from the reference CRM (crm_customer_ledger.py,
 * crm_receipts.py); the money is Uplinko's own. Nothing here creates a second
 * set of books: the statement is READ from invoices and payments, and the
 * receipt is a frozen copy of a payment that already exists.
 *
 *   Statement — every invoice (debit) and payment (credit, net of refunds) for
 *   one customer, dated and in order, with an opening balance before `from`
 *   and a running balance. One section per currency; amounts in different
 *   currencies are never added together.
 *
 *   Receipt — issued on first print and frozen (INSERT … ON CONFLICT DO
 *   NOTHING, then read back), so two people printing at once get the same
 *   receipt and a reprint matches the paper the customer holds.
 */
export interface StatementEntry {
  date: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface StatementSection {
  currency: string;
  opening: number;
  debits: number;
  credits: number;
  closing: number;
  entries: StatementEntry[];
}

const MAX_ENTRIES = 2000;
const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

function parseDay(v: unknown, field: string): Date | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new BadRequestException(`${field} must be a date (YYYY-MM-DD).`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || day(d) !== s) throw new BadRequestException(`${field} is not a valid date.`);
  return d;
}

@Injectable()
export class CrmLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly perms: PermissionsGuard,
  ) {}

  private async need(actor: Actor, ...resources: string[]) {
    for (const r of resources) {
      if (!(await canRead(this.perms, actor, r))) throw new ForbiddenException(`Missing permission: ${r}.read`);
    }
  }

  async statement(actor: Actor, subscriberId: number, query: { from?: string; to?: string } = {}) {
    if (!Number.isInteger(subscriberId) || subscriberId <= 0) throw new NotFoundException('Customer not found');
    await this.need(actor, 'subscribers', 'invoices', 'payments');
    await this.scope.assertSubscriberVisible(actor, subscriberId);
    const from = parseDay(query.from, 'from');
    const toDay = parseDay(query.to, 'to');
    const to = toDay ? new Date(toDay.getTime() + 86_400_000) : null; // exclusive
    if (from && to && to <= from) throw new BadRequestException('The end date must be after the start date.');

    const sub = (await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, fullName: true, username: true, status: true },
    } as never)) as any;
    if (!sub) throw new NotFoundException('Customer not found');

    const invoices = (await this.prisma.invoice.findMany({
      where: { subscriberId, reversedAt: null, status: { notIn: ['CANCELLED', 'DRAFT'] }, ...(to ? { invoiceDate: { lt: to } } : {}) },
      select: { invoiceNo: true, invoiceDate: true, total: true, currency: true, notes: true },
      orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }],
    } as never)) as any[];
    const payments = (await this.prisma.payment.findMany({
      where: { subscriberId, ...(to ? { paymentDate: { lt: to } } : {}) },
      select: { paymentNo: true, paymentDate: true, amount: true, refundedAmount: true, currency: true, method: true, referenceNo: true },
      orderBy: [{ paymentDate: 'asc' }, { id: 'asc' }],
    } as never)) as any[];

    type Raw = { at: Date; currency: string; e: Omit<StatementEntry, 'balance'> };
    const raw: Raw[] = [];
    for (const i of invoices) {
      raw.push({
        at: new Date(i.invoiceDate),
        currency: i.currency,
        e: { date: day(i.invoiceDate), reference: i.invoiceNo, description: 'Invoice', debit: r2(i.total), credit: 0 },
      });
    }
    for (const p of payments) {
      const refunded = r2(p.refundedAmount);
      const net = r2(Number(p.amount) - refunded);
      raw.push({
        at: new Date(p.paymentDate),
        currency: p.currency,
        e: {
          date: day(p.paymentDate),
          reference: p.paymentNo,
          description:
            `Payment · ${String(p.method)}` +
            (p.referenceNo ? ` · ${String(p.referenceNo).slice(0, 60)}` : '') +
            (refunded ? ` (refunded ${refunded})` : ''),
          debit: 0,
          credit: net,
        },
      });
    }
    // Same day: charges before payments, then by reference — as the reference CRM orders them.
    raw.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.e.credit ? 1 : 0) - (b.e.credit ? 1 : 0) || a.e.reference.localeCompare(b.e.reference));

    const sections = new Map<string, StatementSection>();
    let truncated = false;
    for (const row of raw) {
      let s = sections.get(row.currency);
      if (!s) {
        s = { currency: row.currency, opening: 0, debits: 0, credits: 0, closing: 0, entries: [] };
        sections.set(row.currency, s);
      }
      const delta = r2(row.e.debit - row.e.credit);
      if (from && row.at < from) {
        s.opening = r2(s.opening + delta);
        s.closing = s.opening;
        continue;
      }
      s.closing = r2(s.closing + delta);
      s.debits = r2(s.debits + row.e.debit);
      s.credits = r2(s.credits + row.e.credit);
      if (s.entries.length < MAX_ENTRIES) s.entries.push({ ...row.e, balance: s.closing });
      else truncated = true;
    }
    return {
      customer: { id: sub.id, name: sub.fullName, username: sub.username, status: String(sub.status) },
      period: { from: from ? day(from) : null, to: toDay ? day(toDay) : null },
      sections: [...sections.values()],
      truncated,
    };
  }

  /** The receipt for one payment: issued (frozen) on first request, the same copy every time after. */
  async receipt(actor: Actor, paymentId: number) {
    if (!Number.isInteger(paymentId) || paymentId <= 0) throw new NotFoundException('Payment not found');
    await this.need(actor, 'payments');
    const existing = (await this.prisma.crmPaymentReceipt.findUnique({ where: { paymentId } } as never)) as any;
    if (existing) {
      await this.assertReceiptVisible(actor, existing.subscriberId);
      return { ...existing, reprint: true };
    }
    const p = (await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true, paymentNo: true, subscriberId: true, subscriberName: true, amount: true, currency: true,
        method: true, referenceNo: true, paymentDate: true,
        invoice: { select: { invoiceNo: true, total: true, dueAmount: true } },
        subscriber: { select: { fullName: true, username: true, package: { select: { name: true } } } },
        receivedByUser: { select: { name: true } },
      },
    } as never)) as any;
    if (!p) throw new NotFoundException('Payment not found');
    await this.assertReceiptVisible(actor, p.subscriberId);
    const data = {
      paymentId: p.id,
      receiptNo: String(p.paymentNo).slice(0, 40),
      subscriberId: p.subscriberId ?? null,
      customerName: String(p.subscriber?.fullName ?? p.subscriberName ?? '—').slice(0, 200),
      username: p.subscriber?.username ?? null,
      packageName: p.subscriber?.package?.name ?? null,
      amount: r2(p.amount),
      currency: p.currency,
      method: String(p.method).slice(0, 40),
      referenceNo: p.referenceNo ? String(p.referenceNo).slice(0, 120) : null,
      paymentDate: p.paymentDate,
      invoiceNo: p.invoice?.invoiceNo ?? null,
      invoiceTotal: p.invoice ? r2(p.invoice.total) : null,
      dueAfter: p.invoice ? r2(p.invoice.dueAmount) : null,
      receivedBy: p.receivedByUser?.name ?? null,
      issuedById: Number(actor?.sub ?? actor?.id) || null,
    };
    // Concurrent first prints: exactly one row wins, everyone reads that row.
    await this.prisma.crmPaymentReceipt.createMany({ data: [data], skipDuplicates: true } as never);
    const row = (await this.prisma.crmPaymentReceipt.findUnique({ where: { paymentId } } as never)) as any;
    return { ...row, reprint: false };
  }

  private async assertReceiptVisible(actor: Actor, subscriberId: number | null) {
    // A payment with no customer is company-level; only the platform sees those here.
    if (subscriberId == null) {
      if (!this.scope.isAdmin(actor?.role)) throw new NotFoundException('Payment not found');
      return;
    }
    await this.scope.assertSubscriberVisible(actor, subscriberId);
  }
}
