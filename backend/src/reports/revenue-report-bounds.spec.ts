import { BadRequestException } from '@nestjs/common';
import { ReportsService } from './reports.service';

/**
 * REVENUE REPORT — BOUNDS AND CORRECTNESS.
 *
 * THE ORIGINAL
 *   const payments = await this.prisma.payment.findMany({
 *     where,                       // date range OPTIONAL, no take
 *     include: { subscriber: true, invoice: true },
 *   });
 *   const total = payments.reduce(...)
 *
 * Called without a date range this loads every payment ever recorded, with two
 * relations joined onto each row, into the Node heap — then sums them in
 * JavaScript. At 1M subscribers with a year of history that is millions of
 * joined rows in one allocation, and `max_memory_restart: 600M` then kills the
 * worker along with every other request it was serving. It repeats on every
 * page reload.
 *
 * THE TRAP THIS FILE EXISTS TO GUARD
 * The obvious fix is to add `take`. That bounds the memory and silently breaks
 * the report: the total is then the sum of the first N payments, presented as
 * the total for the period. A confidently wrong financial number is worse than
 * a crash, because a crash gets noticed. So the tests below check the totals
 * come from SQL aggregates over the WHOLE range and are NOT derived from the
 * returned rows — that is the property a future "simplification" would drop.
 */
describe('ReportsService.getRevenueReport', () => {
  function makeService(opts: { count?: number; total?: number; rows?: number } = {}) {
    const count = opts.count ?? 3;
    const rowCount = opts.rows ?? Math.min(count, 3);

    const prisma: any = {
      payment: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: opts.total ?? 9_000 }, _count: count }),
        groupBy: jest.fn().mockResolvedValue([
          { method: 'CASH', _sum: { amount: 6_000 } },
          { method: 'JAZZCASH', _sum: { amount: 3_000 } },
        ]),
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: rowCount }, (_, i) => ({ id: i, amount: 1, method: 'CASH' })),
        ),
      },
    };
    const scope: any = { isAdmin: jest.fn().mockReturnValue(true) };
    return { svc: new ReportsService(prisma, scope), prisma };
  }

  // ───────────────────────────────────────────────────────────────
  // The bound
  // ───────────────────────────────────────────────────────────────
  it('never issues an unbounded findMany', async () => {
    const { svc, prisma } = makeService();
    await svc.getRevenueReport();

    const call = prisma.payment.findMany.mock.calls[0][0];
    expect(call.take).toBeGreaterThan(0);
    // And the date filter is present even though the caller supplied none.
    expect(call.where.paymentDate.gte).toBeInstanceOf(Date);
    expect(call.where.paymentDate.lte).toBeInstanceOf(Date);
  });

  it('applies a default window when no dates are given', async () => {
    // Existing integrations call this bare. They must keep working AND be
    // bounded, and be told which window they were given rather than guess.
    const { svc } = makeService();
    const r: any = await svc.getRevenueReport();

    const span = new Date(r.range.endDate).getTime() - new Date(r.range.startDate).getTime();
    expect(Math.round(span / 86_400_000)).toBe(30);
  });

  it('honours an explicit range', async () => {
    const { svc, prisma } = makeService();
    await svc.getRevenueReport('2026-01-01', '2026-01-31');
    const where = prisma.payment.findMany.mock.calls[0][0].where;
    expect(where.paymentDate.gte.toISOString()).toContain('2026-01-01');
    expect(where.paymentDate.lte.toISOString()).toContain('2026-01-31');
  });

  // ───────────────────────────────────────────────────────────────
  // The correctness half — this is the important part
  // ───────────────────────────────────────────────────────────────
  it('totals come from SQL, not from the returned rows', async () => {
    const { svc, prisma } = makeService();
    await svc.getRevenueReport();
    expect(prisma.payment.aggregate).toHaveBeenCalledTimes(1);
    expect(prisma.payment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['method'], _sum: { amount: true } }),
    );
  });

  it('THE TRAP: a truncated row list does not truncate the total', async () => {
    // 50,000 payments in range totalling 5,000,000, but only 1,000 rows come
    // back. Summing the rows would report 1,000 — a number that looks like a
    // real figure and is off by three orders of magnitude.
    const { svc } = makeService({ count: 50_000, total: 5_000_000, rows: 1_000 });
    const r: any = await svc.getRevenueReport();

    expect(r.total).toBe(5_000_000);
    expect(r.count).toBe(50_000);
    expect(r.payments.length).toBe(1_000);
    // And the caller is told, so nobody builds a UI on payments.length.
    expect(r.truncated).toBe(true);
    expect(r.returned).toBe(1_000);
  });

  it('does not claim truncation when everything fits', async () => {
    const { svc } = makeService({ count: 3, rows: 3 });
    const r: any = await svc.getRevenueReport();
    expect(r.truncated).toBe(false);
  });

  it('byMethod is a per-method SQL sum, keyed by method', async () => {
    const { svc } = makeService();
    const r: any = await svc.getRevenueReport();
    expect(r.byMethod).toEqual({ CASH: 6_000, JAZZCASH: 3_000 });
  });

  // ───────────────────────────────────────────────────────────────
  // Input handling
  // ───────────────────────────────────────────────────────────────
  it('rejects an unparseable date rather than querying on NaN', async () => {
    // `new Date('yesterday')` is Invalid Date, and Prisma would either throw
    // something opaque or match nothing at all and report zero revenue.
    const { svc } = makeService();
    await expect(svc.getRevenueReport('yesterday', '2026-01-31')).rejects.toThrow(BadRequestException);
  });

  it('rejects a reversed range', async () => {
    // Silently returns zero revenue otherwise, which reads as "no income this
    // month" rather than "you typed the dates backwards".
    const { svc } = makeService();
    await expect(svc.getRevenueReport('2026-03-01', '2026-01-01')).rejects.toThrow(BadRequestException);
  });

  it('keeps the caller scoped to their own subtree', async () => {
    // A reseller must not see the whole ISP's revenue. The bound must not have
    // cost the scoping filter.
    const prisma: any = {
      payment: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 }, _count: 0 }),
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const scope: any = {
      isAdmin: jest.fn().mockReturnValue(false),
      rootId: jest.fn().mockResolvedValue(5),
      descendantIds: jest.fn().mockResolvedValue([5, 6]),
    };
    const svc = new ReportsService(prisma, scope);
    await svc.getRevenueReport(undefined, undefined, { id: 5, role: 'RESELLER' } as any);

    const where = prisma.payment.findMany.mock.calls[0][0].where;
    expect(where.subscriber).toEqual({ userId: { in: [5, 6] } });
    // The aggregate must carry the same filter, or the headline total leaks
    // the whole ISP's revenue while the row list stays correctly scoped.
    expect(prisma.payment.aggregate.mock.calls[0][0].where.subscriber).toEqual({ userId: { in: [5, 6] } });
  });
});
