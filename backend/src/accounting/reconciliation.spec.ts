import { ForbiddenException } from '@nestjs/common';
import { AccountingService } from './accounting.service';
import { AccountingController } from './accounting.controller';

/**
 * The reconciliation report compares what must agree: invoice paidAmount vs
 * payments net of refunds, and each wallet vs its latest ledger entry. It is
 * read-only and scoped to the caller's own business.
 */
function make() {
  const scope = {
    subscriberWhere: jest.fn(() => Promise.resolve({ userId: { in: [20] } })),
    userWhere: jest.fn(() => Promise.resolve({ id: { in: [20] } })),
  };
  const writes = jest.fn();
  const prisma = {
    invoice: {
      findMany: jest.fn(() =>
        Promise.resolve([
          {
            id: 1,
            invoiceNo: 'INV-1',
            paidAmount: 1000,
            total: 1000,
            subscriberId: 5,
          }, // agrees
          {
            id: 2,
            invoiceNo: 'INV-2',
            paidAmount: 500,
            total: 1000,
            subscriberId: 5,
          }, // lost update
          {
            id: 3,
            invoiceNo: 'INV-3',
            paidAmount: 300,
            total: 300,
            subscriberId: 5,
          }, // wallet-settled
        ]),
      ),
      update: writes,
    },
    payment: {
      groupBy: jest.fn(() =>
        Promise.resolve([
          { invoiceId: 1, _sum: { amount: 1200, refundedAmount: 200 } },
          { invoiceId: 2, _sum: { amount: 1000, refundedAmount: 0 } },
        ]),
      ),
    },
    subscriber: {
      findMany: jest.fn(() =>
        Promise.resolve([
          { id: 5, balance: 50 },
          { id: 6, balance: 10 },
        ]),
      ),
    },
    user: {
      findMany: jest.fn(() => Promise.resolve([{ id: 20, balance: 900 }])),
    },
    $queryRaw: jest.fn((sql: TemplateStringsArray) =>
      Promise.resolve(
        sql.join('').includes('"UserBalanceTransaction"')
          ? [{ ownerId: 20, balanceAfter: 900 }]
          : [
              { ownerId: 5, balanceAfter: 80 },
              { ownerId: 6, balanceAfter: 10 },
            ],
      ),
    ),
  };
  const svc = new AccountingService(
    prisma as never,
    {} as never,
    scope as never,
    {} as never,
  );
  return { svc, prisma, scope, writes };
}

describe('money reconciliation report', () => {
  it('lists exactly the records that disagree', async () => {
    const { svc } = make();
    const r = await svc.reconciliation({ sub: 20, role: 'ADMIN' });
    expect(r.ok).toBe(false);
    expect(r.invoiceMismatches.map((m) => m.invoiceNo)).toEqual([
      'INV-2',
      'INV-3',
    ]);
    expect(r.invoiceMismatches[1].hint).toMatch(/no Payment rows/);
    expect(r.subscriberWalletMismatches).toEqual([
      { id: 5, balance: 50, ledgerBalanceAfter: 80 },
    ]);
    expect(r.resellerWalletMismatches).toEqual([]);
  });

  it("reads only the caller's own business and writes nothing", async () => {
    const { svc, prisma, scope, writes } = make();
    await svc.reconciliation({ sub: 20, role: 'ADMIN' });
    expect(scope.subscriberWhere).toHaveBeenCalled();
    type Call = [{ where: Record<string, unknown> }];
    const whereOf = (fn: jest.Mock) => (fn.mock.calls as Call[])[0][0].where;
    expect(whereOf(prisma.invoice.findMany).subscriber).toEqual({
      userId: { in: [20] },
    });
    expect(whereOf(prisma.subscriber.findMany)).toEqual({
      userId: { in: [20] },
    });
    expect(whereOf(prisma.user.findMany)).toEqual({ id: { in: [20] } });
    expect(writes).not.toHaveBeenCalled();
  });

  it('is refused to anyone below the business owner', () => {
    const ctrl = new AccountingController({ reconciliation: jest.fn() } as any);
    for (const role of ['RESELLER', 'SALES', 'AUDITOR']) {
      expect(() =>
        ctrl.getReconciliation('90', { user: { sub: 9, role } }),
      ).toThrow(ForbiddenException);
    }
  });
});
