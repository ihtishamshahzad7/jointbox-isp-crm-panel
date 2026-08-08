import { ForbiddenException } from '@nestjs/common';
import { ResellerPricingService } from './reseller-pricing.service';

/**
 * Money-path regression tests — settleActivation().
 *
 * This is the single most expensive function in the product: it moves real
 * money out of a reseller's wallet when a customer is activated. Three
 * guarantees must never regress, because each one silently costs someone money
 * if it breaks:
 *
 *   1. IDEMPOTENCY — the same activation is never charged twice (a retry or a
 *      double-clicked Save must not take the money again).
 *   2. PREPAID ENFORCEMENT IS ON BY DEFAULT — an empty wallet cannot activate;
 *      opting out has to be the explicit act.
 *   3. THE BALANCE CHECK IS ATOMIC — it runs as a conditional UPDATE inside the
 *      transaction, so two concurrent activations cannot both pass the check
 *      and overdraw the account.
 *
 * Prisma is mocked: these assert OUR logic, not the database's.
 */
describe('ResellerPricingService.settleActivation (money path)', () => {
  /** Build a Prisma test double whose $transaction runs the callback inline. */
  function makePrisma(overrides: any = {}) {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ balance: 5000, creditLimit: 0, name: 'Dealer A' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }), // balance condition passed
        update: jest.fn().mockResolvedValue({ balance: 4600 }),
      },
      userBalanceTransaction: { create: jest.fn().mockResolvedValue({ id: 1 }) },
      ...overrides.tx,
    };
    const prisma: any = {
      userBalanceTransaction: {
        findFirst: jest.fn().mockResolvedValue(null), // not settled before
        create: jest.fn(),
        ...overrides.userBalanceTransaction,
      },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
      _tx: tx,
    };
    return prisma;
  }

  /** A quote with one activator paying 400 — the shape settleActivation expects. */
  const quote = {
    movements: [{ userId: 7, delta: -400, note: '4MB package', userName: 'Dealer A' }],
  };

  function makeService(prisma: any, q: any = quote) {
    const svc = new ResellerPricingService(prisma, {} as any);
    jest.spyOn(svc as any, 'quote').mockResolvedValue(q);
    return svc;
  }

  it('charges the activator once on a first activation', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);

    await svc.settleActivation(101, { byUserId: 9 });

    // The deduction is a conditional updateMany (atomic check + debit).
    expect(prisma._tx.user.updateMany).toHaveBeenCalledTimes(1);
    const call = prisma._tx.user.updateMany.mock.calls[0][0];
    expect(call.where.id).toBe(7);
    expect(call.data.balance.decrement).toBe(400);
    // …and it is recorded in the ledger.
    expect(prisma._tx.userBalanceTransaction.create).toHaveBeenCalled();
  });

  it('REFUSES to charge twice for the same activation (idempotency)', async () => {
    const prisma = makePrisma({
      userBalanceTransaction: {
        // A settlement with this reference already exists.
        findFirst: jest.fn().mockResolvedValue({ id: 55, createdAt: new Date() }),
      },
    });
    const svc = makeService(prisma);

    const res: any = await svc.settleActivation(101, {});

    expect(res.alreadySettled).toBe(true);
    expect(res.settled).toBe(false);
    // Crucially: no money moved.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma._tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('treats a renewal as a separate, legitimate charge (event scopes the key)', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);

    await svc.settleActivation(101, { event: 'RENEWAL-2026-08' });

    const ref = prisma.userBalanceTransaction.findFirst.mock.calls[0][0].where.reference;
    expect(ref).toBe('SUB#101:RENEWAL-2026-08');
    expect(ref).not.toBe('SUB#101'); // must not collide with the first activation
  });

  it('BLOCKS activation when the wallet cannot cover it (prepaid enforced by default)', async () => {
    const prisma = makePrisma({
      tx: {
        user: {
          findUnique: jest.fn().mockResolvedValue({ balance: 100, creditLimit: 0, name: 'Dealer A' }),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }), // condition failed
          update: jest.fn(),
        },
        userBalanceTransaction: { create: jest.fn() },
      },
    });
    const svc = makeService(prisma);

    // No `enforce` passed — enforcement must still apply.
    await expect(svc.settleActivation(101, {})).rejects.toBeInstanceOf(ForbiddenException);
    // No ledger entry was written for a charge that never succeeded.
    expect(prisma._tx.userBalanceTransaction.create).not.toHaveBeenCalled();
  });

  it('allows spending into an approved credit limit (overdraft threshold)', async () => {
    const prisma = makePrisma({
      tx: {
        user: {
          // 100 in the wallet, but a 1,000 credit limit → 400 is affordable.
          findUnique: jest.fn().mockResolvedValue({ balance: 100, creditLimit: 1000, name: 'Dealer A' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue({ balance: -300 }),
        },
        userBalanceTransaction: { create: jest.fn().mockResolvedValue({ id: 2 }) },
      },
    });
    const svc = makeService(prisma);

    await svc.settleActivation(101, {});

    // Threshold = need - creditLimit = 400 - 1000 = -600, so a balance of 100 passes.
    const where = prisma._tx.user.updateMany.mock.calls[0][0].where;
    expect(where.balance.gte).toBe(-600);
  });

  it('performs the balance check INSIDE the transaction, not before it', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);

    await svc.settleActivation(101, {});

    // The conditional debit must be issued on the transaction client (tx),
    // never on the root prisma client — that is what makes it race-safe.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma._tx.user.updateMany).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is no reseller owner or package to bill', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, null); // quote() returns null

    const res: any = await svc.settleActivation(101, {});

    expect(res.settled).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
