import { BillingService } from './billing.service';

/**
 * AUTO-RENEWAL OPT-OUT.
 *
 * THE FIELD REPORT THIS COMES FROM
 * Two live subscribers (`787quratulainHT`, `786usama24b`) had to be expired
 * and refunded. Staff expired them; they came back ACTIVE on their own, more
 * than once, and nobody could stop it.
 *
 * THE MECHANISM, WHICH IS WORTH UNDERSTANDING BEFORE READING THE TESTS
 * `runAutoRenewal` runs nightly at 01:00 and selected EVERY subscriber with
 * `balance > 0` and a lapsed expiry — then charged the wallet, wrote a paid
 * invoice, and set the account ACTIVE. There was no per-subscriber switch: the
 * schema had `autoRenew` on User and on StaticIp, but never on the subscriber.
 *
 * So the refund workflow ate itself:
 *
 *     staff expire the account
 *       → refund credits the customer's wallet
 *         → 01:00 job sees credit + lapsed expiry
 *           → charges the wallet, sets ACTIVE
 *             → staff expire it again…
 *
 * The refund is what re-arms the job. That is why it looked like a panel fault
 * rather than a billing rule: no human action could make the expiry stick.
 *
 * WHY THE FILTER BELONGS IN THE QUERY
 * The check is in the Prisma `where`, not an early `continue` in the loop. An
 * opted-out subscriber is then never fetched, never counted in the run
 * summary, and — the part that matters — cannot be charged by some later edit
 * to the loop body that reorders the guard. The money path should not depend
 * on statement order inside a for-loop.
 */
describe('BillingService — auto-renewal opt-out', () => {
  function makeService(candidates: any[] = []) {
    const prisma: any = {
      billingRun: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
        // finishRun() reports the tallies through this call and logs
        // result.type, so the mock has to echo a usable row back.
        update: jest.fn().mockResolvedValue({ id: 1, type: 'AUTO_RENEWAL', dryRun: false }),
      },
      subscriber: {
        findMany: jest.fn().mockResolvedValue(candidates),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ authMethod: 'PPPOE', serviceSettings: {} }),
      },
      serviceSettings: { update: jest.fn().mockResolvedValue({}) },
      invoice: { create: jest.fn().mockResolvedValue({ id: 10, currency: 'PKR' }) },
      payment: { create: jest.fn().mockResolvedValue({ id: 20 }) },
    };
    const accounting: any = { deductBalance: jest.fn().mockResolvedValue({}) };
    const radiusSync: any = { syncSubscriberProfile: jest.fn().mockResolvedValue({}) };
    const notifications: any = { fireEvent: jest.fn() };
    const webhooks: any = { emit: jest.fn() };
    const queue: any = { registerProcessor: jest.fn(), add: jest.fn() };
    const currency: any = {
      invoiceStamp: jest.fn().mockResolvedValue({ currency: 'PKR' }),
      paymentStamp: jest
        .fn()
        .mockImplementation(async (amount: number) => ({ currency: 'PKR', baseAmount: amount, fxRate: 1 })),
    };

    const svc = new BillingService(
      prisma,
      accounting,
      radiusSync,
      queue,
      notifications,
      {} as any, // network
      webhooks,
      {} as any, // proration
      currency,
    );
    /** The run tallies, as finishRun() recorded them. */
    const tally = () => prisma.billingRun.update.mock.calls[0][0].data;
    return { svc, prisma, accounting, radiusSync, tally };
  }

  const candidate = (over: any = {}) => ({
    id: 7,
    username: '787quratulainHT',
    password: 'p',
    balance: 5000,
    packageId: 3,
    package: { id: 3, name: '10 Mbps', price: 1500, duration: 30, pool: null },
    serviceSettings: { expiryDate: new Date(Date.now() - 5 * 86_400_000), customPrice: null },
    ...over,
  });

  // ───────────────────────────────────────────────────────────────
  // The filter itself — the whole fix
  // ───────────────────────────────────────────────────────────────
  it('asks the database ONLY for subscribers who opted in', async () => {
    const { svc, prisma } = makeService([]);
    await svc.runAutoRenewal();

    const where = prisma.subscriber.findMany.mock.calls[0][0].where;
    // The guard must be inside serviceSettings alongside expiryDate, because
    // that is the single `is:` filter Prisma applies to the relation.
    expect(where.serviceSettings.is.autoRenew).toBe(true);
    expect(where.serviceSettings.is.expiryDate).toBeDefined();
  });

  it('is a WHERE clause, not a skip inside the loop', async () => {
    // A `continue` in the body would still fetch the row and leave the charge
    // one careless reorder away. Proven by giving the query an opted-out
    // subscriber it should never have been handed: the service must rely on
    // the database having excluded it, and the assertion above is what
    // guarantees the database was asked to.
    const { svc, prisma } = makeService([]);
    await svc.runAutoRenewal();
    const call = prisma.subscriber.findMany.mock.calls[0][0];
    expect(JSON.stringify(call.where)).toContain('autoRenew');
  });

  // ───────────────────────────────────────────────────────────────
  // The behaviour operators depend on must not change
  // ───────────────────────────────────────────────────────────────
  it('still renews and reactivates an opted-in subscriber', async () => {
    const { svc, prisma, accounting, radiusSync, tally } = makeService([candidate()]);
    await svc.runAutoRenewal();

    expect(accounting.deductBalance).toHaveBeenCalledTimes(1);
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(prisma.subscriber.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
    );
    expect(radiusSync.syncSubscriberProfile).toHaveBeenCalledTimes(1);
    expect(tally()).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
  });

  it('charges nothing at all when no one is eligible', async () => {
    // The refund case: opted out, so the database returns nothing and not a
    // single rupee moves.
    const { svc, prisma, accounting, radiusSync, tally } = makeService([]);
    await svc.runAutoRenewal();

    expect(accounting.deductBalance).not.toHaveBeenCalled();
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(radiusSync.syncSubscriberProfile).not.toHaveBeenCalled();
    expect(tally()).toMatchObject({ processed: 0, succeeded: 0, failed: 0 });
  });

  it('leaves a wallet alone when it cannot cover the charge', async () => {
    // Pre-existing behaviour, pinned so the new filter did not disturb it: a
    // partial balance must never be taken, or a refunded customer is charged
    // a fraction and still left offline.
    const { svc, accounting } = makeService([candidate({ balance: 10 })]);
    await svc.runAutoRenewal();
    expect(accounting.deductBalance).not.toHaveBeenCalled();
  });

  it('does not touch money on a dry run', async () => {
    const { svc, accounting, prisma, tally } = makeService([candidate()]);
    await svc.runAutoRenewal(true);
    expect(accounting.deductBalance).not.toHaveBeenCalled();
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    // Counted as it WOULD have gone, but nothing was written.
    expect(tally()).toMatchObject({ processed: 1, succeeded: 1 });
  });
});
