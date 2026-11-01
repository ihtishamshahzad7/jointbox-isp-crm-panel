/**
 * D2 — wallet concurrency & financial integrity (service-level).
 *
 * The Prisma client is mocked with a stateful, snapshot/rollback `$transaction`
 * so these tests prove the SERVICE behaviour: atomic increment (not absolute
 * write), ledger+balance in one transaction, idempotent exactly-once, rollback
 * on ledger failure, and the non-negative guard. The DB-level concurrency
 * guarantee is proven separately against real Postgres (see
 * billing-ext-wallet.concurrency.int.ts).
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { BillingExtService } from './billing-ext.service';

function makePrisma() {
  const state = { balance: null as null | number, ledger: [] as any[] };
  const db = {
    subscriberBalance: {
      findUnique: async () => (state.balance == null ? null : { subscriberId: 1, balance: state.balance, reservedBalance: 0, currency: 'PKR' }),
      upsert: async ({ create, update }: any) => {
        if (state.balance == null) state.balance = create.balance;
        else state.balance = Math.round((state.balance + update.balance.increment) * 100) / 100;
        return { subscriberId: 1, balance: state.balance, reservedBalance: 0, currency: 'PKR' };
      },
      update: async ({ data }: any) => {
        state.balance = Math.round(((state.balance ?? 0) + data.balance.increment) * 100) / 100;
        return { subscriberId: 1, balance: state.balance, reservedBalance: 0, currency: 'PKR' };
      },
    },
    subscriberBalanceLedger: {
      findUnique: async ({ where }: any) => state.ledger.find((l) => l.idempotencyKey && l.idempotencyKey === where.idempotencyKey) ?? null,
      create: async ({ data }: any) => {
        if (data.idempotencyKey && state.ledger.some((l) => l.idempotencyKey === data.idempotencyKey)) {
          const e: any = new Error('unique'); e.code = 'P2002'; throw e;
        }
        state.ledger.push(data); return data;
      },
    },
  };
  const prisma = {
    subscriberBalance: db.subscriberBalance,
    subscriberBalanceLedger: db.subscriberBalanceLedger,
    // snapshot/restore models a real transaction's atomic rollback.
    $transaction: async (fn: any) => {
      const snap = { balance: state.balance, ledger: [...state.ledger] };
      try { return await fn(db); }
      catch (e) { state.balance = snap.balance; state.ledger = snap.ledger; throw e; }
    },
  };
  return { prisma, state };
}

function svcWith(prisma: any) {
  const scope = { assertSubscriberVisible: async () => undefined };
  return new BillingExtService(prisma as any, scope as any);
}

const ACTOR = { id: 1, email: 'a@b.c' };

describe('BillingExtService wallet (D2)', () => {
  it('applies top-ups with atomic increment and a matching ledger entry', async () => {
    const { prisma, state } = makePrisma();
    const svc = svcWith(prisma);
    await svc.topUp(1, { amount: 100 }, ACTOR);
    await svc.topUp(1, { amount: 50.5 }, ACTOR);
    expect(state.balance).toBe(150.5);
    expect(state.ledger).toHaveLength(2);
    expect(state.ledger[1].balanceAfter).toBe(150.5); // ledger matches balance
  });

  it('uses atomic increment, never an absolute balance write', async () => {
    const { prisma } = makePrisma();
    const upsertSpy = jest.spyOn(prisma.subscriberBalance, 'upsert');
    await svcWith(prisma).topUp(1, { amount: 10 }, ACTOR);
    const arg = upsertSpy.mock.calls[0][0] as any;
    expect(arg.update.balance).toEqual({ increment: 10 }); // atomic, not {balance: n}
  });

  it('is idempotent: a duplicate payment reference never applies twice', async () => {
    const { prisma, state } = makePrisma();
    const svc = svcWith(prisma);
    await svc.topUp(1, { amount: 200, reference: 'PAY-9' }, ACTOR);
    await svc.topUp(1, { amount: 200, reference: 'PAY-9' }, ACTOR); // retry/callback dup
    expect(state.balance).toBe(200);
    expect(state.ledger).toHaveLength(1);
  });

  it('rolls back the balance when the ledger write fails (same transaction)', async () => {
    const { prisma, state } = makePrisma();
    jest.spyOn(prisma.subscriberBalanceLedger, 'create').mockRejectedValueOnce(new Error('ledger down'));
    const svc = svcWith(prisma);
    await expect(svc.topUp(1, { amount: 100 }, ACTOR)).rejects.toThrow(/ledger down/);
    expect(state.balance).toBeNull(); // increment rolled back
    expect(state.ledger).toHaveLength(0);
  });

  it('rejects a concurrent duplicate at the unique key (P2002 → rollback)', async () => {
    const { prisma, state } = makePrisma();
    const svc = svcWith(prisma);
    await svc.topUp(1, { amount: 100, reference: 'PAY-1' }, ACTOR);
    // A racing duplicate that passed the fast-path, then loses the unique-index
    // race: create() throws P2002. The increment must roll back.
    const e: any = new Error('unique'); e.code = 'P2002';
    jest.spyOn(prisma.subscriberBalanceLedger, 'create').mockRejectedValueOnce(e);
    await expect(svc.topUp(1, { amount: 100, reference: 'PAY-2' }, ACTOR)).rejects.toThrow(/already processed/i);
    expect(state.balance).toBe(100); // racing op rolled back
  });

  it('enforces the non-negative rule for guarded deductions, atomically', async () => {
    const { prisma, state } = makePrisma();
    const svc = svcWith(prisma);
    await svc.topUp(1, { amount: 30 }, ACTOR);
    await expect(svc.adjust(1, { amount: -50, enforceBalance: true }, ACTOR)).rejects.toThrow(/Insufficient balance/i);
    expect(state.balance).toBe(30); // deduction rolled back
    // A deduction within balance succeeds.
    await svc.adjust(1, { amount: -20, enforceBalance: true }, ACTOR);
    expect(state.balance).toBe(10);
  });
});
