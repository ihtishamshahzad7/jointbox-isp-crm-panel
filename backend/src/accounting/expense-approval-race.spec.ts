import { BadRequestException } from '@nestjs/common';
import { AccountingService } from './accounting.service';

/**
 * Two approvers at once must not post an expense to the ledger twice, and a
 * reject must not overwrite an approval. The status change is conditional
 * (WHERE status = 'PENDING') and the posting is in the same transaction.
 */
function make(claimCounts: number[]) {
  const posted: any[] = [];
  const tx: any = {
    expense: { updateMany: jest.fn(async () => ({ count: claimCounts.shift() ?? 0 })) },
    ledgerEntry: { createMany: jest.fn(async ({ data }: any) => { posted.push(...data); return { count: data.length }; }) },
  };
  const prisma: any = {
    expense: {
      findUnique: jest.fn(async () => ({ id: 4, status: 'PENDING', amount: 900, category: 'FUEL', expenseDate: new Date(), createdBy: 21 })),
      updateMany: jest.fn(async () => ({ count: claimCounts.shift() ?? 0 })),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const svc = new AccountingService(prisma, { delPrefix: async () => undefined } as any, {} as any, { billingCurrencyOrBlank: async () => 'PKR' } as any);
  (svc as any).assertPeriodOpen = jest.fn(async () => undefined);
  return { svc, prisma, tx, posted };
}

describe('expense approval is decided once', () => {
  it('the winner claims PENDING→APPROVED and posts inside the same transaction', async () => {
    const t = make([1]);
    await t.svc.approveExpense(4, 1);
    expect(t.tx.expense.updateMany.mock.calls[0][0].where).toEqual({ id: 4, status: 'PENDING' });
    expect(t.posted).toHaveLength(2); // one balanced debit/credit pair
  });
  it('a concurrent second approval loses and posts nothing', async () => {
    const t = make([0]);
    await expect(t.svc.approveExpense(4, 2)).rejects.toBeInstanceOf(BadRequestException);
    expect(t.posted).toHaveLength(0);
  });
  it('a reject that lost the race to an approval does not overwrite it', async () => {
    const t = make([0]);
    await expect(t.svc.rejectExpense(4, 2)).rejects.toThrow('already processed');
    expect(t.prisma.expense.updateMany.mock.calls[0][0].where).toEqual({ id: 4, status: 'PENDING' });
  });
});
