import { Prisma } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { AccountingService } from './accounting.service';
import { ScopeService } from '../common/scope.service';

/**
 * ACCOUNTING TENANCY — the installation-wide aggregates.
 *
 * Cashflow, expenses, the ledger summary and the trial balance each read one
 * table shared by every company on the box. These tests run the REAL
 * ScopeService over a hand-rolled two-company tree and check that a company
 * ADMIN's query is narrowed to its own subtree, that the platform owner's is
 * exactly what it was, and that the 30–60s report cache is keyed per company
 * (otherwise one company's cached figures are served to the next caller).
 *
 *   1 SUPER_ADMIN (platform owner)
 *   ├─ 10 ADMIN  company A ── 11 RESELLER  (owns subscriber 100)
 *   └─ 20 ADMIN  company B ── 21 RESELLER  (owns subscriber 200)
 */
const USERS = [
  { id: 1, parentId: null as number | null },
  { id: 10, parentId: 1 },
  { id: 11, parentId: 10 },
  { id: 20, parentId: 1 },
  { id: 21, parentId: 20 },
];
const SUB_OWNER: Record<number, number> = { 100: 11, 200: 21 };
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const ADMIN_B = { sub: 20, role: 'ADMIN' };

/** ScopeService's two recursive CTEs, answered from USERS. */
function treeQuery(strings: TemplateStringsArray, ...vals: any[]) {
  const q = strings.join('?');
  const id = Number(vals[0]);
  if (q.includes('WITH RECURSIVE sub')) {
    const out = USERS.some((u) => u.id === id) ? [id] : [];
    for (let i = 0; i < out.length; i++) USERS.filter((u) => u.parentId === out[i]).forEach((u) => out.push(u.id));
    return out.map((x) => ({ id: x }));
  }
  return [];
}

function make() {
  const prisma: any = {
    $queryRaw: jest.fn(async (first: any, ...vals: any[]) =>
      Array.isArray(first) && (first as any).raw ? treeQuery(first as any, ...vals) : [],
    ),
    ledgerEntry: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    expense: { findMany: jest.fn().mockResolvedValue([]) },
    subscriber: {
      findUnique: jest.fn(async ({ where }: any) =>
        SUB_OWNER[where.id] ? { id: where.id, userId: SUB_OWNER[where.id] } : null,
      ),
    },
    balanceTransaction: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn() },
  };
  const cache: any = { wrap: jest.fn((_k: string, _t: number, fn: any) => fn()), delPrefix: jest.fn() };
  const scope = new ScopeService(prisma);
  const svc = new AccountingService(prisma, cache, scope, {} as any);
  return { svc, prisma, cache };
}

/** A Prisma.sql fragment (the class itself is not exported at runtime). */
const isSql = (v: any): v is Prisma.Sql => !!v && typeof v === 'object' && Array.isArray(v.values) && typeof v.sql === 'string';

/** Prisma.Sql report queries the service sent (as opposed to the tree CTEs). */
const reportQueries = (prisma: any): Prisma.Sql[] =>
  prisma.$queryRaw.mock.calls.map((c: any[]) => c[0]).filter(isSql);

describe('accounting tenancy', () => {
  it("(i) a company ADMIN's ledger summary is narrowed to its own subtree, never the other company's", async () => {
    const { svc, prisma, cache } = make();
    await svc.getLedgerSummary(ADMIN_B);

    expect(prisma.ledgerEntry.groupBy).not.toHaveBeenCalled();
    const [q] = reportQueries(prisma);
    expect(q.sql).toMatch(/FROM "LedgerEntry"/);
    expect(q.sql).toMatch(/"createdBy" = ANY/);
    expect(q.values).toContainEqual([20, 21]);
    // Company A's accounts appear nowhere in B's query.
    expect(JSON.stringify(q.values)).not.toMatch(/\b1[01]\b/);
    expect(cache.wrap.mock.calls[0][0]).toBe('accounting:summary:t20');
  });

  it('(i) the existing balance-history guard still refuses another company\'s subscriber', async () => {
    const { svc } = make();
    await expect(svc.getBalanceHistory(100, ADMIN_B)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('(ii) the platform owner gets the unchanged whole-installation summary and trial balance', async () => {
    const { svc, prisma, cache } = make();
    await svc.getTrialBalance(OWNER);
    expect(prisma.ledgerEntry.groupBy).toHaveBeenCalledWith(
      expect.not.objectContaining({ where: expect.anything() }),
    );
    expect(prisma.ledgerEntry.count).toHaveBeenCalled();
    expect(reportQueries(prisma)).toHaveLength(0);
    expect(cache.wrap.mock.calls.map((c: any[]) => c[0])).toEqual(['accounting:trial-balance', 'accounting:summary']);
  });

  it("(ii) a company's trial balance is cached and counted per company", async () => {
    const { svc, prisma, cache } = make();
    const tb = await svc.getTrialBalance(ADMIN_B);
    expect(tb.balanced).toBe(true);
    expect(prisma.ledgerEntry.count).not.toHaveBeenCalled();
    const qs = reportQueries(prisma);
    expect(qs).toHaveLength(2); // grouped totals + malformed count, both scoped
    for (const q of qs) expect(q.values).toContainEqual([20, 21]);
    expect(cache.wrap.mock.calls[0][0]).toBe('accounting:trial-balance:t20');
  });

  it('(iii) expenses list passes a createdBy-in-subtree where for a company, none for the owner', async () => {
    const { svc, prisma } = make();
    await svc.getExpenses({ category: 'FUEL' }, ADMIN_B);
    expect(prisma.expense.findMany.mock.calls[0][0].where).toEqual({
      createdBy: { in: [20, 21] },
      category: 'FUEL',
    });

    await svc.getExpenses({ category: 'FUEL' }, OWNER);
    expect(prisma.expense.findMany.mock.calls[1][0].where).toEqual({ category: 'FUEL' });
  });

  it('(iii) cashflow scopes payments by subscriber owner and expenses by creator, with a per-company cache key', async () => {
    const { svc, prisma, cache } = make();
    await svc.getCashflow({ days: 7 }, ADMIN_B);
    expect(cache.wrap.mock.calls[0][0]).toBe('accounting:cashflow:7:t20');

    const calls = prisma.$queryRaw.mock.calls.filter((c: any[]) => /FROM "(Payment|Expense)"/.test(String(c[0]?.join?.('?'))));
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const frag = c.find(isSql) as Prisma.Sql;
      expect(frag.values).toContainEqual([20, 21]);
    }

    const owner = make();
    await owner.svc.getCashflow({ days: 7 }, OWNER);
    expect(owner.cache.wrap.mock.calls[0][0]).toBe('accounting:cashflow:7');
    const ownerCalls = owner.prisma.$queryRaw.mock.calls.filter((c: any[]) => /FROM "(Payment|Expense)"/.test(String(c[0]?.join?.('?'))));
    for (const c of ownerCalls) {
      const frag = c.find(isSql) as Prisma.Sql;
      expect(frag.sql).toBe(''); // Prisma.empty — the old unscoped query
    }
  });

  it('an internal call with no actor keeps the old unscoped path', async () => {
    const { svc, prisma } = make();
    await svc.getLedgerSummary();
    await svc.getExpenses({});
    expect(prisma.ledgerEntry.groupBy).toHaveBeenCalled();
    expect(prisma.expense.findMany.mock.calls[0][0].where).toEqual({});
  });
});

describe('accounting money-moving routes are scoped to the company', () => {
  const { NotFoundException } = jest.requireActual('@nestjs/common');
  function withRows() {
    const m = make();
    m.prisma.expense.findUnique = jest.fn(async ({ where }: any) =>
      ({ 1: { createdBy: 11 }, 2: { createdBy: 21 } } as any)[where.id] ?? null,
    );
    m.prisma.payment = {
      findUnique: jest.fn(async ({ where }: any) => ({ 5: { subscriberId: 100 } } as any)[where.id] ?? null),
    };
    m.prisma.invoice = {
      findUnique: jest.fn(async ({ where }: any) => ({ 6: { subscriberId: 100 } } as any)[where.id] ?? null),
    };
    m.prisma.refundRequest = {
      findUnique: jest.fn(async ({ where }: any) => ({ 9: { requestedById: 11, paymentId: 5 } } as any)[where.id] ?? null),
    };
    return m;
  }

  it("another company cannot touch company A's expense, payment, invoice or refund request", async () => {
    const { svc } = withRows();
    await expect(svc.assertExpenseInScope(ADMIN_B as any, 1)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.assertPaymentInScope(ADMIN_B as any, 5)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.assertInvoiceInScope(ADMIN_B as any, 6)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.assertRefundRequestInScope(ADMIN_B as any, 9)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.assertSubscriberInScope(ADMIN_B as any, 100)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('company B can act on its own expense, and the platform owner on anything', async () => {
    const { svc } = withRows();
    await expect(svc.assertExpenseInScope(ADMIN_B as any, 2)).resolves.toBeUndefined();
    await expect(svc.assertExpenseInScope(OWNER as any, 1)).resolves.toBeUndefined();
    await expect(svc.assertPaymentInScope(OWNER as any, 5)).resolves.toBeUndefined();
  });

  it('the expense approval queue is narrowed to the company', async () => {
    const { svc, prisma } = withRows();
    await svc.listExpenseRequests('PENDING', ADMIN_B as any);
    expect(prisma.expense.findMany.mock.calls[0][0].where.createdBy).toEqual({ in: [20, 21] });
  });
});
