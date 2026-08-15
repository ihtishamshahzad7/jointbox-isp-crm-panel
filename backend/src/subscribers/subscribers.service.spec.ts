import { ConflictException, ForbiddenException } from '@nestjs/common';
import { SubscribersService } from './subscribers.service';

/**
 * Money-path regression tests — activateRenewal().
 *
 * The customer contract is: an activation charges the package price EXACTLY
 * once, a repeated attempt must error with "already activated / this package at
 * this price", a renewal charges only as a new period, and a migration is an
 * explicit, separately-accounted act. These tests pin the double-charge guards.
 */
describe('SubscribersService.activateRenewal', () => {
  let service: SubscribersService;

  function makeMocks(overrides: any = {}) {
    const prisma: any = {
      subscriber: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      package: { findUnique: jest.fn() },
      serviceSettings: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
      invoice: { create: jest.fn(), update: jest.fn().mockResolvedValue({}), findFirst: jest.fn() },
      payment: { create: jest.fn() },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
      userBalanceTransaction: { findFirst: jest.fn() },
      ledgerEntry: { createMany: jest.fn() },
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
      ...overrides.prisma,
    };

    const radiusSync: any = {
      syncSubscriberProfile: jest.fn().mockResolvedValue({ synced: true }),
      removeSubscriberFromRadius: jest.fn().mockResolvedValue(undefined),
    };
    const accounting: any = {
      deductBalance: jest.fn(),
      postInvoiceCreated: jest.fn().mockResolvedValue(undefined),
      postPaymentReceived: jest.fn().mockResolvedValue(undefined),
    };
    const notifications: any = { fireEvent: jest.fn().mockResolvedValue(undefined) };
    const pricing: any = {
      activationCost: jest.fn().mockResolvedValue(300),
      settleActivation: jest.fn(),
    };
    const renewal: any = { quote: jest.fn() };

    service = new SubscribersService(
      prisma,
      radiusSync,
      {} as any,      // cache
      {} as any,      // queue
      accounting,
      notifications,
      {} as any,      // scope
      pricing,
      {} as any,      // invoices
      {} as any,      // security
      renewal,
      {} as any,      // mikrotik
    );
    return { prisma, radiusSync, accounting, notifications, pricing, renewal };
  }

  /** A subscriber record that also satisfies syncToRadius' include shape. */
  const activeShape = (extra: any = {}) => ({
    id: 42,
    status: 'INACTIVE',
    username: 'demo',
    fullName: 'Demo User',
    userId: 9,
    packageId: null,
    password: 'secret',
    sellPrice: 100,
    package: { pool: null },
    serviceSettings: { expiryDate: null },
    ...extra,
  });

  const pkg = { id: 1, name: 'Business 4M', price: 400, duration: 30 };

  const quote = {
    total: 400,
    amount: 400,
    days: 30,
    newExpiry: new Date('2026-09-13T00:00:00Z'),
  };

  it('blocks a second activation when the subscriber is already active — with the package and price in the error', async () => {
    const { prisma, pricing } = makeMocks();
    prisma.subscriber.findUnique.mockResolvedValue(activeShape({ status: 'ACTIVE', packageId: 1 }));
    prisma.package.findUnique.mockResolvedValue(pkg);

    const err: any = await service.activateRenewal({ subscriberId: 42, packageId: 1, actorId: 7 })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain('already activated');
    expect(err.message).toContain('Business 4M'); // the package it was assigned
    expect(err.message).toContain('100');         // at THIS price (sellPrice)
    // Nothing was created, nothing was charged, no state moved.
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(pricing.settleActivation).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a double-clicked first activation: deterministic key, no invoice, no charge, friendly error', async () => {
    const { prisma, pricing, renewal } = makeMocks();
    prisma.subscriber.findUnique.mockResolvedValue(activeShape());
    prisma.package.findUnique.mockResolvedValue(pkg);
    renewal.quote.mockResolvedValue(quote);
    // The first request already charged this exact (package, expiry-day) period.
    pricing.settleActivation.mockResolvedValue({
      settled: false,
      alreadySettled: true,
      settledAt: new Date(), // moments ago → a live duplicate, not a crash
    });

    const err: any = await service.activateRenewal({ subscriberId: 42, packageId: 1, actorId: 7 })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain('already activated');
    expect(err.message).toContain('Business 4M');
    expect(err.message).toContain('400');
    // The replay never reached the invoice or payment — it died at the charge gate.
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    // And it never marked the subscriber ACTIVE.
    const activeWrites = prisma.subscriber.update.mock.calls.filter((c: any) => c[0]?.data?.status === 'ACTIVE');
    expect(activeWrites).toHaveLength(0);
  });

  it('charges ONCE on a normal activation — with a deterministic settlement key', async () => {
    const { prisma, pricing, renewal, accounting } = makeMocks();
    prisma.subscriber.findUnique.mockResolvedValue(activeShape());
    prisma.package.findUnique.mockResolvedValue(pkg);
    renewal.quote.mockResolvedValue(quote);
    pricing.settleActivation.mockResolvedValue({ settled: true });
    prisma.invoice.create.mockResolvedValue({ id: 5, invoiceNo: 'INV-1', total: 400 });
    prisma.payment.create.mockResolvedValue({ id: 9, paymentNo: 'PAY-1', amount: 400 });

    const res: any = await service.activateRenewal({ subscriberId: 42, packageId: 1, actorId: 7, mode: 'FULL' });

    // The settlement key is derived ONLY from what the customer gets (package +
    // expiry day) — never from a fresh invoice id, which would let a replay
    // slip through as a "different" charge.
    const settleCall = pricing.settleActivation.mock.calls[0];
    expect(settleCall[0]).toBe(42);
    expect(settleCall[1].event).toBe('ACT:1:2026-09-13');
    // The settlement runs INSIDE the caller's transaction (tx passed as 3rd arg).
    expect(settleCall[2]).toBe(prisma);

    // Exactly one invoice + one payment, both created.
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);

    // FULL mode takes no wallet money.
    expect(accounting.deductBalance).not.toHaveBeenCalled();

    // The record is locked ACTIVE only AFTER the money committed.
    const activeWrites = prisma.subscriber.update.mock.calls.filter((c: any) => c[0]?.data?.status === 'ACTIVE');
    expect(activeWrites).toHaveLength(1);

    // Ledger posted once, invoice marked paid.
    expect(accounting.postInvoiceCreated).toHaveBeenCalledTimes(1);
    expect(accounting.postPaymentReceived).toHaveBeenCalledTimes(1);
    const paidWrite = prisma.invoice.update.mock.calls.find((c: any) => c[0]?.data?.status === 'PAID');
    expect(paidWrite).toBeTruthy();

    expect(res).toMatchObject({ subscriberId: 42, totalAmount: 400, invoiceId: 5, recovered: false });
  });

  it('BALANCE mode: refuses a second wallet deduction for the same period', async () => {
    const { prisma, pricing, renewal, accounting } = makeMocks();
    prisma.subscriber.findUnique.mockResolvedValue(activeShape());
    prisma.package.findUnique.mockResolvedValue(pkg);
    renewal.quote.mockResolvedValue(quote);
    pricing.settleActivation.mockResolvedValue({ settled: true });
    // The wallet was already charged for this exact activation.
    accounting.deductBalance.mockResolvedValue({ subscriberId: 42, balance: null, alreadyDeducted: true });

    const err: any = await service.activateRenewal({ subscriberId: 42, packageId: 1, actorId: 7, mode: 'BALANCE' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain('already charged');
    expect(prisma.payment.create).not.toHaveBeenCalled();
    // The deduction ran once (against the same deterministic key as the settlement).
    expect(accounting.deductBalance).toHaveBeenCalledTimes(1);
    expect(accounting.deductBalance.mock.calls[0][2]).toBe('ACT:1:2026-09-13');
  });

  it('refuses a replayed activation carrying the same idempotency key (double-clicked renew)', async () => {
    const { prisma, pricing, renewal } = makeMocks();
    prisma.subscriber.findUnique.mockResolvedValue(activeShape());
    prisma.package.findUnique.mockResolvedValue(pkg);
    renewal.quote.mockResolvedValue(quote);
    pricing.settleActivation.mockResolvedValue({ settled: true });
    prisma.invoice.create.mockResolvedValue({ id: 5, invoiceNo: 'INV-1', total: 400 });
    prisma.payment.create.mockResolvedValue({ id: 9, paymentNo: 'PAY-1' });

    // First click of the dialog succeeds and charges once.
    const res: any = await service.activateRenewal({
      subscriberId: 42, packageId: 1, actorId: 7, idempotencyKey: 'click-1',
    });
    expect(res.totalAmount).toBe(400);

    // The SECOND click of the SAME dialog carries the SAME key: the idempotency
    // gate (invoice with that key already exists) refuses before ANY money moves.
    prisma.invoice.findFirst.mockResolvedValue({ id: 5 });
    const err: any = await service.activateRenewal({
      subscriberId: 42, packageId: 1, actorId: 7, idempotencyKey: 'click-1',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain('already activated');
    expect(pricing.settleActivation).toHaveBeenCalledTimes(1); // only the first click charged
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);     // only one payment ever
  });

  it('lets a NEW dialog (fresh key) charge as its own renewal', async () => {
    const { prisma, pricing, renewal } = makeMocks();
    prisma.subscriber.findUnique.mockResolvedValue(activeShape());
    prisma.package.findUnique.mockResolvedValue(pkg);
    renewal.quote.mockResolvedValue(quote);
    pricing.settleActivation.mockResolvedValue({ settled: true });
    prisma.invoice.create.mockResolvedValue({ id: 5, invoiceNo: 'INV-1', total: 400 });
    prisma.payment.create.mockResolvedValue({ id: 9, paymentNo: 'PAY-1' });

    await service.activateRenewal({ subscriberId: 42, packageId: 1, actorId: 7, idempotencyKey: 'click-1' });
    // A new dialog is a deliberate new purchase — different key → charged again.
    await service.activateRenewal({ subscriberId: 42, packageId: 1, actorId: 7, idempotencyKey: 'click-2' });

    expect(pricing.settleActivation).toHaveBeenCalledTimes(2);
    expect(prisma.payment.create).toHaveBeenCalledTimes(2);
  });

  it('empty reseller wallet: activation is blocked, never ACTIVE, never charged', async () => {
    const { prisma, pricing, renewal } = makeMocks();
    prisma.subscriber.findUnique.mockResolvedValue(activeShape());
    prisma.package.findUnique.mockResolvedValue(pkg);
    renewal.quote.mockResolvedValue(quote);
    pricing.settleActivation.mockRejectedValue(new ForbiddenException('Not enough balance. Dealer A has 100 but this activation costs 400.'));

    const err: any = await service.activateRenewal({ subscriberId: 42, packageId: 1, actorId: 7, mode: 'FULL' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toContain('not charged');
    const activeWrites = prisma.subscriber.update.mock.calls.filter((c: any) => c[0]?.data?.status === 'ACTIVE');
    expect(activeWrites).toHaveLength(0);
    // Nothing was invoiced or paid.
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });
});
