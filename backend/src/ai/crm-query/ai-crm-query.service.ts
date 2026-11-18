import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ScopeService, Actor } from '../../common/scope.service';
import { PermissionsGuard } from '../../security/permissions.guard';
import { canRead } from '../../common/permission-check';
import { detectLanguage, Lang, normalize, PHRASES, sectionTitle } from './language';
import { parsePeriod, Period, PeriodError, thisMonth } from './period';

/**
 * THE CRM ASSISTANT'S DATA ANSWERS — read-only, tenant-scoped, deterministic.
 *
 * Behaviour ported from the reference assistant (ai-engine/…/crm_assistant_
 * queries.py); data, tenancy and permissions are Uplinko's own:
 *
 *   • every query goes through ScopeService — a company sees its own tree,
 *     a franchise its own subtree, exactly as the matching list screens do;
 *   • every section is checked against the caller's permission matrix by the
 *     SAME PermissionsGuard that protects that section's screen (a role that
 *     cannot open Payments gets no collection totals here either);
 *   • nothing is written, no SQL is generated from the question, and the
 *     fields returned are a fixed allow-list — never passwords, CNIC numbers,
 *     documents, phone numbers, addresses or bank details;
 *   • totals are computed over ALL matching rows; at most 20 rows are listed.
 *
 * Numbers come from the database, not from a model, so they can be shown as
 * KPI tiles as-is.
 */
export type Section = 'Sales' | 'Collections' | 'Invoices' | 'Customers' | 'Tickets' | 'Inventory' | 'Expenses';

export interface Tile {
  key: string;
  label: string;
  value: number;
  kind: 'count' | 'money';
  currency?: string;
}

export interface CrmAnswer {
  ok: boolean;
  section: Section | 'Protected details';
  language: Lang;
  period: { from: string; to: string; defaulted: boolean } | null;
  matching: number;
  tiles: Tile[];
  records: Array<Record<string, string | number | null>>;
  error?: string;
  text: string;
}

const MAX_ROWS = 20;
const PROTECTED = /password|secret|api.?key|token|bank account|\biban\b|\bcnic\b|national id|salary|salaries/;
const HOW_TO = /\bhow (do|to|can|does)\b|\bwhat is\b|\bexplain\b|\bprocess\b|\bwhere (is|can|do)\b/;

/** Which screen's permission each section borrows. */
const RESOURCE: Record<Section, string> = {
  Sales: 'invoices',
  Collections: 'payments',
  Invoices: 'invoices',
  Customers: 'subscribers',
  Tickets: 'tickets',
  Inventory: 'inventory',
  Expenses: 'accounting',
};

const LABELS: Record<string, Record<Lang, string>> = {
  collected: { en: 'Collected', ur: 'وصول شدہ رقم', roman: 'Wasool shuda raqam' },
  refunded: { en: 'Refunded', ur: 'واپس کی گئی رقم', roman: 'Wapas ki gayi raqam' },
  payments: { en: 'Payments', ur: 'ادائیگیاں', roman: 'Adaigiyan' },
  invoiced: { en: 'Invoiced', ur: 'بل شدہ رقم', roman: 'Bill shuda raqam' },
  invoices: { en: 'Invoices', ur: 'انوائس', roman: 'Invoices' },
  due: { en: 'Outstanding', ur: 'بقایا رقم', roman: 'Baqaya raqam' },
  unpaid: { en: 'Unpaid / partial / overdue', ur: 'غیر ادا شدہ', roman: 'Ghair ada shuda' },
  new_customers: { en: 'New connections', ur: 'نئے کنکشن', roman: 'Naye connections' },
  total: { en: 'Total', ur: 'کل', roman: 'Kul' },
  active: { en: 'Active', ur: 'فعال', roman: 'Active' },
  expired: { en: 'Expired', ur: 'میعاد ختم', roman: 'Expired' },
  inactive: { en: 'Inactive', ur: 'غیر فعال', roman: 'Inactive' },
  suspended: { en: 'Suspended', ur: 'معطل', roman: 'Suspended' },
  open: { en: 'Open', ur: 'کھلے', roman: 'Open' },
  in_progress: { en: 'In progress', ur: 'جاری', roman: 'Jari' },
  escalated: { en: 'Escalated', ur: 'آگے بھیجے گئے', roman: 'Escalated' },
  sla_breached: { en: 'SLA breached', ur: 'وقت سے تجاوز', roman: 'SLA breach' },
  resolved: { en: 'Resolved', ur: 'حل شدہ', roman: 'Hal shuda' },
  in_stock: { en: 'In stock', ur: 'اسٹاک میں', roman: 'Stock mein' },
  assigned: { en: 'Issued to resellers', ur: 'جاری شدہ', roman: 'Jari shuda' },
  installed: { en: 'Installed', ur: 'نصب شدہ', roman: 'Nasb shuda' },
  faulty: { en: 'Faulty', ur: 'خراب', roman: 'Kharab' },
  spent: { en: 'Spent', ur: 'خرچ', roman: 'Kharch' },
  expenses: { en: 'Expense entries', ur: 'اخراجات', roman: 'Akhrajat' },
};

const label = (key: string, lang: Lang) => LABELS[key]?.[lang] ?? LABELS[key]?.en ?? key.replace(/_/g, ' ');
const money = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

@Injectable()
export class AiCrmQueryService {
  private readonly logger = new Logger(AiCrmQueryService.name);
  readonly timeZone = process.env.AI_TIMEZONE || 'Asia/Karachi';

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly perms: PermissionsGuard,
  ) {}

  /** Which section a question is about, or null to leave it to the help search. */
  intent(question: string): Section | 'protected' | null {
    const q = normalize(question);
    if (PROTECTED.test(q)) return 'protected';
    if (HOW_TO.test(q)) return null;
    if (/\bsales?\b|\brevenue\b/.test(q)) return 'Sales';
    if (/\bcollections?\b|\bpayments?\b|\breceived\b|\breceipts?\b/.test(q)) return 'Collections';
    if (/customer balance|\bdues?\b|\bunpaid\b|\boutstanding\b|\boverdue\b|\binvoices?\b|\bbills?\b/.test(q)) return 'Invoices';
    if (/\bexpenses?\b|\bspent\b|\bspending\b/.test(q)) return 'Expenses';
    if (/low stock|\binventory\b|\bstock\b|\bonus?\b|\brouters? in stock\b|\bdevices?\b/.test(q)) return 'Inventory';
    if (/\btickets?\b|\bcomplaints?\b|\bissues?\b/.test(q)) return 'Tickets';
    if (/\bcustomers?\b|\bsubscribers?\b|\bconnections?\b|\busers? (online|active)\b/.test(q)) return 'Customers';
    return null;
  }

  /** Answer a question from the caller's own CRM data, or null when it is not a data question. */
  async ask(actor: Actor, question: string, now = new Date()): Promise<CrmAnswer | null> {
    const lang = detectLanguage(question);
    const which = this.intent(question);
    if (!which) return null;
    if (which === 'protected') {
      return this.refuse('Protected details', lang, PHRASES.protected[lang]);
    }
    if (!(await this.may(actor, RESOURCE[which]))) {
      return this.refuse(which, lang, PHRASES.refused[lang]);
    }
    let period: Period | null;
    try {
      period = parsePeriod(question, this.timeZone, now);
    } catch (e) {
      if (e instanceof PeriodError) return this.refuse(which, lang, e.message);
      throw e;
    }
    const answer = await this.run(which, actor, question, period, lang, now);
    answer.text = this.render(answer);
    return answer;
  }

  // ── permission ────────────────────────────────────────────────────────────

  /**
   * Ask the real PermissionsGuard whether this caller may READ the screen the
   * section belongs to. Same deny-chain, role matrix and auditor floor; no
   * second copy of the rules to drift out of step.
   */
  may(actor: Actor, resource: string): Promise<boolean> {
    return canRead(this.perms, actor, resource);
  }

  // ── sections ──────────────────────────────────────────────────────────────

  private async run(
    section: Section,
    actor: Actor,
    question: string,
    asked: Period | null,
    lang: Lang,
    now: Date,
  ): Promise<CrmAnswer> {
    const moneySection = section === 'Sales' || section === 'Collections' || section === 'Expenses';
    const period = asked ?? (moneySection ? thisMonth(this.timeZone, now) : null);
    const base: CrmAnswer = {
      ok: true,
      section,
      language: lang,
      period: period ? { from: period.from, to: period.to, defaulted: !asked } : null,
      matching: 0,
      tiles: [],
      records: [],
      text: '',
    };
    switch (section) {
      case 'Collections':
        return this.collections(base, actor, period!, lang);
      case 'Sales':
        return this.sales(base, actor, period!, lang);
      case 'Invoices':
        return this.invoices(base, actor, period, lang);
      case 'Expenses':
        return this.expenses(base, actor, period!, lang);
      case 'Inventory':
        return this.inventory(base, actor, question, lang);
      case 'Tickets':
        return this.tickets(base, actor, period, lang);
      case 'Customers':
        return this.customers(base, actor, question, period, lang);
    }
  }

  private within(field: string, p: Period | null) {
    return p ? { [field]: { gte: p.start, lt: p.end } } : {};
  }

  private async subscriberScope(actor: Actor) {
    return this.scope.subscriberWhere(actor);
  }

  private async collections(a: CrmAnswer, actor: Actor, p: Period, lang: Lang) {
    const where = { AND: [{ subscriber: await this.subscriberScope(actor) }, this.within('paymentDate', p)] };
    const groups = (await this.prisma.payment.groupBy({
      by: ['currency'],
      where,
      _sum: { amount: true, refundedAmount: true },
      _count: { _all: true },
    } as never)) as unknown as Array<{ currency: string; _sum: { amount: number | null; refundedAmount: number | null }; _count: { _all: number } }>;
    for (const g of groups) {
      a.matching += g._count._all;
      a.tiles.push({ key: 'collected', label: label('collected', lang), value: money((g._sum.amount ?? 0) - (g._sum.refundedAmount ?? 0)), kind: 'money', currency: g.currency });
      if (g._sum.refundedAmount) a.tiles.push({ key: 'refunded', label: label('refunded', lang), value: money(g._sum.refundedAmount), kind: 'money', currency: g.currency });
    }
    a.tiles.push({ key: 'payments', label: label('payments', lang), value: a.matching, kind: 'count' });
    const rows = await this.prisma.payment.findMany({
      where,
      orderBy: { paymentDate: 'desc' },
      take: MAX_ROWS,
      select: { paymentNo: true, subscriberName: true, amount: true, currency: true, method: true, paymentDate: true },
    } as never);
    a.records = (rows as any[]).map((r) => ({
      payment: r.paymentNo,
      customer: r.subscriberName ?? null,
      amount: money(r.amount),
      currency: r.currency,
      method: String(r.method),
      date: new Date(r.paymentDate).toISOString().slice(0, 10),
    }));
    return a;
  }

  private async sales(a: CrmAnswer, actor: Actor, p: Period, lang: Lang) {
    const sub = await this.subscriberScope(actor);
    const invWhere = { AND: [{ subscriber: sub }, this.within('invoiceDate', p), { status: { not: 'CANCELLED' } }, { reversedAt: null }] };
    const groups = (await this.prisma.invoice.groupBy({
      by: ['currency'],
      where: invWhere,
      _sum: { total: true },
      _count: { _all: true },
    } as never)) as unknown as Array<{ currency: string; _sum: { total: number | null }; _count: { _all: number } }>;
    let invoices = 0;
    for (const g of groups) {
      invoices += g._count._all;
      a.tiles.push({ key: 'invoiced', label: label('invoiced', lang), value: money(g._sum.total), kind: 'money', currency: g.currency });
    }
    const newCustomers = await this.prisma.subscriber.count({ where: { AND: [sub, this.within('createdAt', p)] } } as never);
    a.tiles.push({ key: 'invoices', label: label('invoices', lang), value: invoices, kind: 'count' });
    a.tiles.push({ key: 'new_customers', label: label('new_customers', lang), value: newCustomers, kind: 'count' });
    a.matching = invoices;
    return a;
  }

  private async invoices(a: CrmAnswer, actor: Actor, p: Period | null, lang: Lang) {
    const open = { status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } };
    const where = { AND: [{ subscriber: await this.subscriberScope(actor) }, open, { reversedAt: null }, this.within('invoiceDate', p)] };
    const groups = (await this.prisma.invoice.groupBy({
      by: ['currency'],
      where,
      _sum: { dueAmount: true },
      _count: { _all: true },
    } as never)) as unknown as Array<{ currency: string; _sum: { dueAmount: number | null }; _count: { _all: number } }>;
    for (const g of groups) {
      a.matching += g._count._all;
      a.tiles.push({ key: 'due', label: label('due', lang), value: money(g._sum.dueAmount), kind: 'money', currency: g.currency });
    }
    a.tiles.push({ key: 'unpaid', label: label('unpaid', lang), value: a.matching, kind: 'count' });
    const rows = await this.prisma.invoice.findMany({
      where,
      orderBy: [{ dueAmount: 'desc' }, { id: 'desc' }],
      take: MAX_ROWS,
      select: { invoiceNo: true, subscriberName: true, total: true, dueAmount: true, currency: true, status: true, dueDate: true },
    } as never);
    a.records = (rows as any[]).map((r) => ({
      invoice: r.invoiceNo,
      customer: r.subscriberName ?? null,
      total: money(r.total),
      due: money(r.dueAmount),
      currency: r.currency,
      status: String(r.status),
      due_date: new Date(r.dueDate).toISOString().slice(0, 10),
    }));
    return a;
  }

  private async expenses(a: CrmAnswer, actor: Actor, p: Period, lang: Lang) {
    const ids = await this.scope.visibleUserIds(actor);
    const where = { AND: [ids ? { createdBy: { in: ids } } : {}, this.within('expenseDate', p)] };
    const agg = (await this.prisma.expense.aggregate({ where, _sum: { amount: true }, _count: { _all: true } } as never)) as any;
    a.matching = agg._count?._all ?? 0;
    a.tiles.push({ key: 'spent', label: label('spent', lang), value: money(agg._sum?.amount), kind: 'money' });
    a.tiles.push({ key: 'expenses', label: label('expenses', lang), value: a.matching, kind: 'count' });
    const byCat = (await this.prisma.expense.groupBy({
      by: ['category'],
      where,
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: MAX_ROWS,
    } as never)) as unknown as Array<{ category: string; _sum: { amount: number | null } }>;
    a.records = byCat.map((r) => ({ category: r.category, amount: money(r._sum.amount) }));
    return a;
  }

  private async inventory(a: CrmAnswer, actor: Actor, question: string, lang: Lang) {
    const ids = await this.scope.visibleUserIds(actor);
    const where = ids ? { ownerId: { in: ids } } : {};
    const byStatus = (await this.prisma.inventoryItem.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    } as never)) as unknown as Array<{ status: string; _count: { _all: number } }>;
    const count = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
    a.matching = byStatus.reduce((n, r) => n + r._count._all, 0);
    for (const s of ['IN_STOCK', 'ASSIGNED', 'INSTALLED', 'FAULTY']) {
      a.tiles.push({ key: s.toLowerCase(), label: label(s.toLowerCase(), lang), value: count(s), kind: 'count' });
    }
    // Per device type, what is left on the shelf — the "low stock" view.
    const byType = (await this.prisma.inventoryItem.groupBy({
      by: ['type'],
      where: { AND: [where, { status: 'IN_STOCK' }] },
      _count: { _all: true },
      orderBy: { _count: { type: 'asc' } },
      take: MAX_ROWS,
    } as never)) as unknown as Array<{ type: string; _count: { _all: number } }>;
    a.records = byType.map((r) => ({ type: String(r.type), in_stock: r._count._all }));
    if (/low stock/.test(normalize(question))) a.records = a.records.slice(0, 5);
    return a;
  }

  private async tickets(a: CrmAnswer, actor: Actor, p: Period | null, lang: Lang) {
    const where = { AND: [{ subscriber: await this.subscriberScope(actor) }, this.within('createdAt', p)] };
    const byStatus = (await this.prisma.ticket.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    } as never)) as unknown as Array<{ status: string; _count: { _all: number } }>;
    const count = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
    a.matching = byStatus.reduce((n, r) => n + r._count._all, 0);
    for (const s of ['OPEN', 'IN_PROGRESS', 'ESCALATED', 'RESOLVED']) {
      a.tiles.push({ key: s.toLowerCase(), label: label(s.toLowerCase(), lang), value: count(s), kind: 'count' });
    }
    const breached = await this.prisma.ticket.count({
      where: { AND: [where, { slaBreached: true }, { status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] } }] },
    } as never);
    a.tiles.push({ key: 'sla_breached', label: label('sla_breached', lang), value: breached, kind: 'count' });
    const rows = await this.prisma.ticket.findMany({
      where: { AND: [where, { status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] } }] },
      orderBy: [{ slaBreached: 'desc' }, { createdAt: 'asc' }],
      take: MAX_ROWS,
      select: { ticketNo: true, subject: true, priority: true, status: true, category: true, createdAt: true },
    } as never);
    a.records = (rows as any[]).map((r) => ({
      ticket: r.ticketNo,
      subject: String(r.subject).slice(0, 80),
      category: String(r.category),
      priority: String(r.priority),
      status: String(r.status),
      opened: new Date(r.createdAt).toISOString().slice(0, 10),
    }));
    return a;
  }

  /** A name or username the question looks up, e.g. "customer ali khan" → "ali khan". */
  searchTerm(question: string): string | null {
    const m = String(question).match(/\b(?:customer|subscriber|user)\s+(?:named\s+|called\s+)?["']?([\p{L}\p{N}._@-]+(?:\s+[\p{L}\p{N}._@-]+)?)["']?/iu);
    if (!m) return null;
    const STOP = /^(list|count|total|today|yesterday|this|last|active|expired|inactive|suspended|balance|balances|new|count|summary|report|status|kitne|kitni|ki|ka|ke)\b/i;
    const term = m[1].trim();
    if (STOP.test(term) || term.length < 3) return null;
    return term.slice(0, 60);
  }

  private async customers(a: CrmAnswer, actor: Actor, question: string, p: Period | null, lang: Lang) {
    const sub = await this.subscriberScope(actor);
    const term = this.searchTerm(question);
    if (term) {
      const where = {
        AND: [
          sub,
          { OR: [{ username: { equals: term, mode: 'insensitive' } }, { fullName: { contains: term, mode: 'insensitive' } }] },
        ],
      };
      a.matching = await this.prisma.subscriber.count({ where } as never);
      // Identity and status only — the reference assistant's rule: at most a
      // handful of matched people, never their contact details or documents.
      const rows = await this.prisma.subscriber.findMany({
        where,
        take: 5,
        orderBy: { id: 'asc' },
        select: { id: true, username: true, fullName: true, status: true, balance: true, package: { select: { name: true } } },
      } as never);
      a.records = (rows as any[]).map((r) => ({
        id: r.id,
        username: r.username,
        name: r.fullName,
        status: String(r.status),
        package: r.package?.name ?? null,
        balance: money(r.balance),
      }));
      return a;
    }
    const where = { AND: [sub, this.within('createdAt', p)] };
    const byStatus = (await this.prisma.subscriber.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    } as never)) as unknown as Array<{ status: string; _count: { _all: number } }>;
    const count = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
    a.matching = byStatus.reduce((n, r) => n + r._count._all, 0);
    a.tiles.push({ key: p ? 'new_customers' : 'total', label: label(p ? 'new_customers' : 'total', lang), value: a.matching, kind: 'count' });
    for (const s of ['ACTIVE', 'EXPIRED', 'SUSPENDED', 'INACTIVE']) {
      a.tiles.push({ key: s.toLowerCase(), label: label(s.toLowerCase(), lang), value: count(s), kind: 'count' });
    }
    return a;
  }

  // ── output ────────────────────────────────────────────────────────────────

  private refuse(section: CrmAnswer['section'], lang: Lang, error: string): CrmAnswer {
    return { ok: false, section, language: lang, period: null, matching: 0, tiles: [], records: [], error, text: error };
  }

  render(a: CrmAnswer): string {
    if (a.error) return a.error;
    const lang = a.language;
    const lines: string[] = [];
    lines.push(`${sectionTitle(a.section, lang)}: ${a.matching} ${PHRASES.records[lang]}`);
    if (a.period) {
      const range = a.period.from === a.period.to ? a.period.from : `${a.period.from} – ${a.period.to}`;
      lines.push(`${PHRASES.period[lang]}: ${range}${a.period.defaulted && lang === 'en' ? ' (this month — name a period to change it)' : ''}`);
    }
    for (const t of a.tiles) {
      const v = t.kind === 'money' ? `${t.currency ?? ''} ${t.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`.trim() : t.value.toLocaleString('en-US');
      lines.push(`${t.label}: ${v}`);
    }
    for (const r of a.records) {
      lines.push(
        Object.entries(r)
          .filter(([, v]) => v !== null && v !== undefined && v !== '')
          .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
          .join(' | '),
      );
    }
    if (!a.matching) lines.push(PHRASES.none[lang]);
    lines.push(PHRASES.scoped[lang]);
    return lines.join('\n');
  }
}
