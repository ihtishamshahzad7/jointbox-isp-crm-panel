import { RenewalService } from './renewal.service';

/**
 * Billing-period regression tests — RenewalService.quote().
 *
 * These lock in WHEN a customer's paid period starts and ends, which decides
 * both what they are charged and when they go offline. Two rules must hold:
 *
 *   1. FIRST ACTIVATION bills from TODAY. A subscriber created on the 1st but
 *      activated on the 6th runs 6th → 6th next month. Billing from the
 *      creation date would give away days; billing from a stale placeholder
 *      expiry would cut them off early.
 *   2. RENEWAL of a still-active customer EXTENDS from their current expiry, so
 *      days they already paid for are never lost.
 *
 * Prisma is mocked — these assert our date/price arithmetic, not the database.
 */
describe('RenewalService.quote (billing period)', () => {
  const DAY = 86_400_000;

  /** Build the service with a subscriber whose status/expiry we control. */
  function makeService(sub: any) {
    const prisma: any = {
      subscriber: { findUnique: jest.fn().mockResolvedValue(sub) },
      package: { findUnique: jest.fn().mockResolvedValue(sub.package) },
      resellerPackagePrice: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    return new RenewalService(prisma, {} as any, {} as any, {} as any);
  }

  const pkg = { id: 3, name: '4MB', price: 400, duration: 30 };

  it('bills a FIRST activation from today, not from a placeholder expiry', async () => {
    // Created earlier with a placeholder expiry still in the future.
    const placeholder = new Date(Date.now() + 20 * DAY);
    const svc = makeService({
      id: 1, status: 'INACTIVE', userId: 5, sellPrice: null, balance: 0,
      package: pkg, serviceSettings: { expiryDate: placeholder },
    });

    const q: any = await svc.quote(1, { mode: 'FULL' });

    // New expiry must be ~1 month from NOW — not from the placeholder.
    const fromNow = (new Date(q.newExpiry).getTime() - Date.now()) / DAY;
    expect(fromNow).toBeGreaterThan(26);
    expect(fromNow).toBeLessThan(33);
    // And clearly NOT the placeholder + a month (~50 days out).
    expect(fromNow).toBeLessThan(40);
  });

  it('EXTENDS an active customer from their current expiry (paid days kept)', async () => {
    const expiry = new Date(Date.now() + 10 * DAY); // 10 paid days remaining
    const svc = makeService({
      id: 2, status: 'ACTIVE', userId: 5, sellPrice: null, balance: 0,
      package: pkg, serviceSettings: { expiryDate: expiry },
    });

    const q: any = await svc.quote(2, { mode: 'FULL' });

    // 10 remaining days + ~30 new days ≈ 40 days out.
    const fromNow = (new Date(q.newExpiry).getTime() - Date.now()) / DAY;
    expect(fromNow).toBeGreaterThan(36);
    expect(fromNow).toBeLessThan(44);
  });

  it('treats an EXPIRED customer as a fresh start (never bills the past)', async () => {
    const expiry = new Date(Date.now() - 15 * DAY); // lapsed a fortnight ago
    const svc = makeService({
      id: 3, status: 'EXPIRED', userId: 5, sellPrice: null, balance: 0,
      package: pkg, serviceSettings: { expiryDate: expiry },
    });

    const q: any = await svc.quote(3, { mode: 'FULL' });

    // Must run forward from today, not from the old expiry (which would give
    // the customer a period that is already half over).
    const fromNow = (new Date(q.newExpiry).getTime() - Date.now()) / DAY;
    expect(fromNow).toBeGreaterThan(26);
  });

  it('charges the full package price for a full period', async () => {
    const svc = makeService({
      id: 4, status: 'INACTIVE', userId: 5, sellPrice: null, balance: 0,
      package: pkg, serviceSettings: { expiryDate: null },
    });

    const q: any = await svc.quote(4, { mode: 'FULL' });

    expect(q.amount).toBe(400);
    expect(q.total).toBe(400);
  });

  it('prices a partial renewal pro-rata, not at the full month price', async () => {
    const svc = makeService({
      id: 5, status: 'ACTIVE', userId: 5, sellPrice: null, balance: 0,
      package: pkg, serviceSettings: { expiryDate: new Date(Date.now() + DAY) },
    });

    const q: any = await svc.quote(5, { mode: 'DAYS', days: 5 });

    // 400 / 30 days ≈ 13.33/day → 5 days ≈ 67, NOT 400.
    expect(q.days).toBe(5);
    expect(q.amount).toBeGreaterThan(50);
    expect(q.amount).toBeLessThan(90);
    expect(q.amount).toBeLessThan(400);
  });

  it("uses the subscriber's own agreed price over the package list price", async () => {
    const svc = makeService({
      id: 6, status: 'INACTIVE', userId: 5, sellPrice: 250, balance: 0,
      package: pkg, serviceSettings: { expiryDate: null },
    });

    const q: any = await svc.quote(6, { mode: 'FULL' });

    // The customer agreed 250 — billing 400 would overcharge them.
    expect(q.amount).toBe(250);
  });

  it('adds an extra fee on top of the package amount', async () => {
    const svc = makeService({
      id: 7, status: 'INACTIVE', userId: 5, sellPrice: null, balance: 0,
      package: pkg, serviceSettings: { expiryDate: null },
    });

    const q: any = await svc.quote(7, { mode: 'FULL', extraFee: 100 });

    expect(q.extraFee).toBe(100);
    expect(q.total).toBe(500); // 400 + 100
  });
});
