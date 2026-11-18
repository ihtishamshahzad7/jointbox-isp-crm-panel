import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { PermissionsGuard } from '../security/permissions.guard';
import { canRead } from '../common/permission-check';
import { build, Period, thisMonth } from '../ai/crm-query/period';

/**
 * ADVANCED CRM — REPORTS.
 *
 * The reference CRM's report list (web/reports.js) mapped onto Uplinko. The
 * ones Uplinko already has are NOT duplicated — revenue, subscribers,
 * tickets, aged debt (defaulters), package-wise, collections analytics,
 * reseller performance (Reports) and P&L / trial balance (Accounting).
 * Added here, over the caller's own records only:
 *
 *   staff-collection        who received how much (Staff Collection)
 *   daily-sales             per day: invoiced, collected, new connections (Daily Sales)
 *   transactions            collections by payment method (Transaction Wise)
 *   stock-transfers         warehouse moves (Stock Transfer)
 *   inventory-reconciliation stock counts: expected / found / missing (Inventory Reconciliation)
 *   equipment               issued / recovered / lost, at cost
 *   terminations            per month: how many and the monthly revenue lost
 *   tat-compliance          resolved on time vs late, by category
 *
 * Days are calendar days in the company's time zone (AI_TIMEZONE). Money is
 * never added across currencies. Every report is read-only and needs read
 * access to the screen its data comes from.
 */
export const REPORTS = {
  'staff-collection': 'payments',
  'daily-sales': 'payments',
  transactions: 'payments',
  'stock-transfers': 'inventory',
  'inventory-reconciliation': 'inventory',
  equipment: 'inventory',
  terminations: 'subscribers',
  'tat-compliance': 'tickets',
} as const;
export type ReportName = keyof typeof REPORTS;

const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class CrmReportsService {
  readonly timeZone = process.env.AI_TIMEZONE || 'Asia/Karachi';

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly perms: PermissionsGuard,
  ) {}

  list() {
    return Object.keys(REPORTS);
  }

  period(q: { from?: string; to?: string }): Period {
    if (!q.from && !q.to) return thisMonth(this.timeZone);
    const from = String(q.from ?? '');
    const to = String(q.to ?? from);
    const real = (d: string) => DAY.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
    if (!real(from) || !real(to)) throw new BadRequestException('from and to must be real dates (YYYY-MM-DD).');
    if (to < from) throw new BadRequestException('The end date must be after the start date.');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw new BadRequestException('Use a range of up to 366 days.');
    return build(from, to, this.timeZone);
  }

  async run(actor: Actor, name: string, q: { from?: string; to?: string }) {
    if (!(name in REPORTS)) throw new BadRequestException(`Unknown report. Choose one of: ${this.list().join(', ')}.`);
    const resource = REPORTS[name as ReportName];
    if (!(await canRead(this.perms, actor, resource))) throw new ForbiddenException(`Missing permission: ${resource}.read`);
    const p = this.period(q);
    // Accounts in the caller's tree; null = no narrowing (platform only).
    const ids = await this.scope.visibleUserIds(actor);
    const head = { report: name, from: p.from, to: p.to, timeZone: this.timeZone };
    switch (name as ReportName) {
      case 'staff-collection':
        return { ...head, rows: await this.staffCollection(ids, p) };
      case 'daily-sales':
        return { ...head, rows: await this.dailySales(ids, p) };
      case 'transactions':
        return { ...head, rows: await this.transactions(ids, p) };
      case 'stock-transfers':
        return { ...head, rows: await this.stockTransfers(ids, p) };
      case 'inventory-reconciliation':
        return { ...head, rows: await this.reconciliation(ids, p) };
      case 'equipment':
        return { ...head, rows: await this.equipment(ids, p) };
      case 'terminations':
        return { ...head, rows: await this.terminations(ids, p) };
      case 'tat-compliance':
        return { ...head, rows: await this.tat(ids, p) };
    }
  }

  // Every query takes `ids` as ONE array parameter: `(ids IS NULL OR … = ANY(ids))`.

  private async staffCollection(ids: number[] | null, p: Period) {
    const rows = (await this.prisma.$queryRaw`
      SELECT p."receivedBy" AS "userId", u.name AS name, p.currency,
             COUNT(*)::int AS payments,
             SUM(p.amount - COALESCE(p."refundedAmount", 0))::float AS collected
      FROM "Payment" p
      JOIN "Subscriber" s ON s.id = p."subscriberId"
      LEFT JOIN "User" u ON u.id = p."receivedBy"
      WHERE p."paymentDate" >= ${p.start} AND p."paymentDate" < ${p.end}
        AND (${ids}::int[] IS NULL OR s."userId" = ANY(${ids}::int[]))
      GROUP BY p."receivedBy", u.name, p.currency
      ORDER BY collected DESC`) as any[];
    return rows.map((r) => ({ userId: r.userId, name: r.name ?? 'Not recorded', currency: r.currency, payments: r.payments, collected: r2(r.collected) }));
  }

  private async dailySales(ids: number[] | null, p: Period) {
    const tz = this.timeZone;
    const [inv, pay, subs] = await Promise.all([
      this.prisma.$queryRaw`
        SELECT ((i."invoiceDate" AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date::text AS day, i.currency,
               COUNT(*)::int AS invoices, SUM(i.total)::float AS invoiced
        FROM "Invoice" i JOIN "Subscriber" s ON s.id = i."subscriberId"
        WHERE i."invoiceDate" >= ${p.start} AND i."invoiceDate" < ${p.end}
          AND i."reversedAt" IS NULL AND i.status::text NOT IN ('CANCELLED', 'DRAFT')
          AND (${ids}::int[] IS NULL OR s."userId" = ANY(${ids}::int[]))
        GROUP BY 1, 2` as Promise<any[]>,
      this.prisma.$queryRaw`
        SELECT ((p."paymentDate" AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date::text AS day, p.currency,
               COUNT(*)::int AS payments, SUM(p.amount - COALESCE(p."refundedAmount", 0))::float AS collected
        FROM "Payment" p JOIN "Subscriber" s ON s.id = p."subscriberId"
        WHERE p."paymentDate" >= ${p.start} AND p."paymentDate" < ${p.end}
          AND (${ids}::int[] IS NULL OR s."userId" = ANY(${ids}::int[]))
        GROUP BY 1, 2` as Promise<any[]>,
      this.prisma.$queryRaw`
        SELECT ((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date::text AS day, COUNT(*)::int AS "newConnections"
        FROM "Subscriber" s
        WHERE s."createdAt" >= ${p.start} AND s."createdAt" < ${p.end}
          AND (${ids}::int[] IS NULL OR s."userId" = ANY(${ids}::int[]))
        GROUP BY 1` as Promise<any[]>,
    ]);
    const out = new Map<string, any>();
    const row = (day: string, currency: string | null) => {
      const k = `${day}|${currency ?? ''}`;
      if (!out.has(k)) out.set(k, { day, currency, invoices: 0, invoiced: 0, payments: 0, collected: 0, newConnections: 0 });
      return out.get(k);
    };
    for (const r of inv) Object.assign(row(r.day, r.currency), { invoices: r.invoices, invoiced: r2(r.invoiced) });
    for (const r of pay) Object.assign(row(r.day, r.currency), { payments: r.payments, collected: r2(r.collected) });
    // New connections have no currency: put them on the day's first row (or a row of their own).
    for (const r of subs) {
      const same = [...out.values()].find((x) => x.day === r.day);
      (same ?? row(r.day, null)).newConnections = r.newConnections;
    }
    return [...out.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : String(a.currency).localeCompare(String(b.currency))));
  }

  private async transactions(ids: number[] | null, p: Period) {
    const rows = (await this.prisma.$queryRaw`
      SELECT p.method::text AS method, p.currency, COUNT(*)::int AS payments,
             SUM(p.amount)::float AS gross, SUM(COALESCE(p."refundedAmount", 0))::float AS refunded
      FROM "Payment" p JOIN "Subscriber" s ON s.id = p."subscriberId"
      WHERE p."paymentDate" >= ${p.start} AND p."paymentDate" < ${p.end}
        AND (${ids}::int[] IS NULL OR s."userId" = ANY(${ids}::int[]))
      GROUP BY 1, 2 ORDER BY gross DESC`) as any[];
    return rows.map((r) => ({ method: r.method, currency: r.currency, payments: r.payments, gross: r2(r.gross), refunded: r2(r.refunded), net: r2(r.gross - r.refunded) }));
  }

  private async stockTransfers(ids: number[] | null, p: Period) {
    const rows = (await this.prisma.$queryRaw`
      SELECT m.id, m."createdAt" AS at, i."serialNumber" AS serial, i.type::text AS type, m.notes, u.name AS "by"
      FROM "InventoryMovement" m
      JOIN "InventoryItem" i ON i.id = m."itemId"
      LEFT JOIN "User" u ON u.id = m."byUserId"
      WHERE m."createdAt" >= ${p.start} AND m."createdAt" < ${p.end}
        AND m.notes LIKE 'Warehouse transfer:%'
        AND (${ids}::int[] IS NULL OR i."ownerId" = ANY(${ids}::int[]))
      ORDER BY m."createdAt" DESC
      LIMIT 5000`) as any[];
    return rows.map((r) => ({ ...r, notes: String(r.notes).replace(/^Warehouse transfer:\s*/, '') }));
  }

  private async reconciliation(ids: number[] | null, p: Period) {
    const rows = (await this.prisma.$queryRaw`
      SELECT t.id, w.name AS warehouse, t.status, t."createdAt" AS "openedAt", t."closedAt",
             COUNT(l.*) FILTER (WHERE l.expected)::int AS expected,
             COUNT(l.*) FILTER (WHERE l.expected AND l."scannedAt" IS NOT NULL)::int AS found,
             COUNT(l.*) FILTER (WHERE l.expected AND l."scannedAt" IS NULL)::int AS missing,
             COUNT(l.*) FILTER (WHERE NOT l.expected)::int AS unexpected
      FROM "crm_stocktake" t
      JOIN "crm_warehouse" w ON w.id = t."warehouseId"
      LEFT JOIN "crm_stocktake_line" l ON l."stocktakeId" = t.id
      WHERE t."createdAt" >= ${p.start} AND t."createdAt" < ${p.end}
        AND (${ids}::int[] IS NULL OR t."ownerId" = ANY(${ids}::int[]))
      GROUP BY t.id, w.name ORDER BY t."createdAt" DESC`) as any[];
    return rows;
  }

  private async equipment(ids: number[] | null, p: Period) {
    const rows = (await this.prisma.$queryRaw`
      SELECT i.type::text AS type,
             COUNT(*) FILTER (WHERE x."issuedAt" >= ${p.start} AND x."issuedAt" < ${p.end})::int AS issued,
             COUNT(*) FILTER (WHERE x.status = 'RECOVERED' AND x."recoveredAt" >= ${p.start} AND x."recoveredAt" < ${p.end})::int AS recovered,
             COUNT(*) FILTER (WHERE x.status = 'LOST' AND x."recoveredAt" >= ${p.start} AND x."recoveredAt" < ${p.end})::int AS lost,
             COALESCE(SUM(i."purchasePrice") FILTER (WHERE x.status = 'LOST' AND x."recoveredAt" >= ${p.start} AND x."recoveredAt" < ${p.end}), 0)::float AS "lostValue",
             COUNT(*) FILTER (WHERE x.status = 'ISSUED')::int AS "outNow",
             COALESCE(SUM(i."purchasePrice") FILTER (WHERE x.status = 'ISSUED'), 0)::float AS "outNowValue",
             COALESCE(SUM(x.charge) FILTER (WHERE x."issuedAt" >= ${p.start} AND x."issuedAt" < ${p.end}), 0)::float AS charged
      FROM "crm_stock_issue" x
      JOIN "InventoryItem" i ON i.id = x."itemId"
      WHERE (${ids}::int[] IS NULL OR i."ownerId" = ANY(${ids}::int[]))
      GROUP BY 1 ORDER BY 1`) as any[];
    return rows.map((r) => ({ ...r, lostValue: r2(r.lostValue), outNowValue: r2(r.outNowValue), charged: r2(r.charged) }));
  }

  private async terminations(ids: number[] | null, p: Period) {
    const tz = this.timeZone;
    const rows = (await this.prisma.$queryRaw`
      SELECT to_char((t."terminatedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM') AS month,
             COUNT(*)::int AS terminated,
             SUM(t."monthlyRevenueLoss")::float AS "monthlyRevenueLost",
             COUNT(*) FILTER (WHERE t.status = 'RECOVERY_PENDING')::int AS "recoveryPending"
      FROM "crm_termination" t JOIN "Subscriber" s ON s.id = t."subscriberId"
      WHERE t."terminatedAt" >= ${p.start} AND t."terminatedAt" < ${p.end}
        AND (${ids}::int[] IS NULL OR s."userId" = ANY(${ids}::int[]))
      GROUP BY 1 ORDER BY 1`) as any[];
    return rows.map((r) => ({ ...r, monthlyRevenueLost: r2(r.monthlyRevenueLost) }));
  }

  private async tat(ids: number[] | null, p: Period) {
    const rows = (await this.prisma.$queryRaw`
      SELECT t.category::text AS category, COUNT(*)::int AS resolved,
             COUNT(*) FILTER (WHERE t."resolutionDueAt" IS NOT NULL AND t."resolvedAt" <= t."resolutionDueAt")::int AS "onTime",
             COUNT(*) FILTER (WHERE t."resolutionDueAt" IS NOT NULL AND t."resolvedAt" > t."resolutionDueAt")::int AS late,
             ROUND(AVG(EXTRACT(EPOCH FROM (t."resolvedAt" - t."createdAt")) / 3600)::numeric, 1)::float AS "avgHours"
      FROM "Ticket" t JOIN "Subscriber" s ON s.id = t."subscriberId"
      WHERE t."resolvedAt" >= ${p.start} AND t."resolvedAt" < ${p.end}
        AND (${ids}::int[] IS NULL OR s."userId" = ANY(${ids}::int[]))
      GROUP BY 1 ORDER BY 1`) as any[];
    return rows.map((r) => ({ ...r, onTimePct: r.onTime + r.late ? Math.round((r.onTime / (r.onTime + r.late)) * 1000) / 10 : null }));
  }
}
