import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { JobsController } from '../jobs/jobs.controller';
import { BillingExtService } from '../billing-ext/billing-ext.service';
import { CurrencyService } from './currency.service';
import { ensureInstallationCurrency } from './platform-account';
import { ScopeService } from './scope.service';
import { IntegrityService } from '../subscribers/integrity.service';

/**
 * What belongs to the platform account and what belongs to a company.
 *
 *  • Work that acts on EVERY company at once (the job queue and its
 *    reconcile) is the platform's; a company cannot start or read it.
 *  • A company's writes stay inside its own customers and packages.
 *  • The billing currency is the platform's setting, never decided by
 *    whichever company created the first ISP brand.
 */
const SA = { sub: 1, role: 'SUPER_ADMIN' };
const COMPANY_A = { sub: 10, role: 'ADMIN' };
const TREE: Record<number, number[]> = { 10: [10, 11], 20: [20, 21] };

function scopeWith(prisma: any) {
  const scope = new ScopeService(prisma);
  jest.spyOn(scope, 'descendantIds').mockImplementation(async (id: number) => TREE[id] ?? [id]);
  return scope;
}

describe('background jobs are the platform account\'s', () => {
  const jobs = {
    registeredTypes: jest.fn().mockReturnValue(['integrity.reconcile']),
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({}),
    enqueue: jest.fn().mockResolvedValue({ id: 1 }),
  } as any;
  const ctl = new JobsController(jobs);

  it('refuses a company on every route and starts nothing', () => {
    const req = { user: COMPANY_A };
    expect(() => ctl.types(req)).toThrow(ForbiddenException);
    expect(() => ctl.list('ALL', '10', req)).toThrow(ForbiddenException);
    expect(() => ctl.get('1', req)).toThrow(ForbiddenException);
    expect(() => ctl.enqueue({ type: 'integrity.reconcile' }, req)).toThrow(ForbiddenException);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('lets the platform account run the reconcile', async () => {
    await expect(ctl.enqueue({ type: 'integrity.reconcile' }, { user: SA })).resolves.toEqual({ id: 1 });
  });

  it('stores a reconcile result as numbers — no names, usernames or money totals', () => {
    const out = IntegrityService.platformSummary({
      trialBalance: { balanced: true, currencies: [{ currency: 'PKR', totalDebit: 9e6, totalCredit: 9e6, difference: 0, balanced: true }] },
      wallets: { driftCount: 1, accounts: [{ userId: 11, name: 'Dealer Eleven', balance: 500 }] },
      radius: { drift: 2, cut: 2, accounts: [{ username: 'alice', fullName: 'Alice A' }] },
      radiusHeal: { missing: 1, healed: 1 },
      radiusPurge: { found: 3, purged: 3 },
      sessions: { routers: 4, skipped: 0, closed: 5, details: [{ nas: 'Core-Router-A', ghosts: 5 }] },
    });
    const text = JSON.stringify(out);
    for (const secret of ['Dealer Eleven', 'alice', 'Alice A', 'Core-Router-A', '9000000']) expect(text).not.toContain(secret);
    expect(out).toMatchObject({ walletDrift: 1, inactiveCut: 2, credentialsRestored: 1, ghostSessionsClosed: 5 });
    expect(out.books).toEqual({ balanced: true, currencies: [{ currency: 'PKR', balanced: true, difference: 0 }] });
  });
});

describe('billing extensions stay inside the caller\'s company', () => {
  function make() {
    const prisma: any = {
      subscriber: { findUnique: jest.fn().mockResolvedValue({ id: 99, userId: 21 }) }, // company B's customer
      package: { findUnique: jest.fn().mockResolvedValue({ id: 5, ownerId: 20 }) },     // company B's package
      invoice: { findUnique: jest.fn().mockResolvedValue({ id: 7, subscriberId: 99, status: 'PAID', paidAmount: 100, payments: [], items: [] }) },
      invoiceReversal: { findUnique: jest.fn().mockResolvedValue(null) },
      subscriberBilling: { upsert: jest.fn() },
      proRatedBilling: { upsert: jest.fn() },
      $transaction: jest.fn(),
    };
    return { prisma, svc: new BillingExtService(prisma, scopeWith(prisma)) };
  }

  it('will not top up, adjust or re-bill another company\'s subscriber', async () => {
    const { prisma, svc } = make();
    await expect(svc.topUp(99, { amount: 500 }, COMPANY_A)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.adjust(99, { amount: -500 }, COMPANY_A)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.upsertSubscriberBilling(99, { creditLimit: 1e6 }, COMPANY_A)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.subscriberBilling.upsert).not.toHaveBeenCalled();
  });

  it('will not change another company\'s package fees', async () => {
    const { prisma, svc } = make();
    await expect(svc.upsertProRatedForPackage(5, { setupFee: 0 }, COMPANY_A)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.proRatedBilling.upsert).not.toHaveBeenCalled();
  });

  it('will not reverse another company\'s invoice — and says nothing about it', async () => {
    const { prisma, svc } = make();
    await expect(svc.reverseInvoice(7, { mode: 'FULL', reason: 'x' }, COMPANY_A)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.invoiceReversal.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('the billing currency is the platform\'s', () => {
  const OLD = process.env.GATEWAY_CURRENCY;
  beforeAll(() => { delete process.env.GATEWAY_CURRENCY; });
  afterAll(() => { if (OLD !== undefined) process.env.GATEWAY_CURRENCY = OLD; });

  it('reads the platform row before any company\'s ISP brand', async () => {
    const findFirst = jest.fn(async (args: any) => (args?.where?.ownerId === null ? { currency: 'INR' } : { currency: 'USD' }));
    const svc = new CurrencyService({ isp: { findFirst } } as any);
    await expect(svc.billingCurrency()).resolves.toBe('INR');
  });

  it('pins the current currency to a platform row once, copying it', async () => {
    const create = jest.fn().mockResolvedValue({});
    const findFirst = jest.fn(async (args: any) => (args?.where?.ownerId === null ? null : { currency: 'BDT', currencySymbol: '৳' }));
    const log = { warn: jest.fn() };
    await expect(ensureInstallationCurrency({ isp: { findFirst, create } }, log)).resolves.toBe(true);
    expect(create).toHaveBeenCalledWith({ data: { ownerId: null, name: 'Installation', currency: 'BDT', currencySymbol: '৳' } });
  });

  it('leaves a brand-new server (no ISP row) and an already pinned one alone', async () => {
    const create = jest.fn();
    const log = { warn: jest.fn() };
    await ensureInstallationCurrency({ isp: { findFirst: jest.fn().mockResolvedValue(null), create } }, log);
    await ensureInstallationCurrency({ isp: { findFirst: jest.fn().mockResolvedValue({ id: 1 }), create } }, log);
    expect(create).not.toHaveBeenCalled();
  });
});
