import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PlatformPlansService } from './platform-plans.service';
import { savePlan } from '../common/company-plan';

/**
 * Plans & Pricing: the platform's price list. A plan is assigned to a company
 * by copying its limits into company_plan — the table the panel enforces.
 */
const PLATFORM = { sub: 1, role: 'SUPER_ADMIN' } as never;
const COMPANY_ADMIN = { sub: 10, role: 'ADMIN' } as never;

function make() {
  const plans = new Map<number, Record<string, unknown>>([
    [
      1,
      {
        id: 1,
        name: 'Starter',
        price: 0,
        maxSubscribers: 300,
        maxNas: 2,
        maxAccounts: 5,
        isActive: true,
      },
    ],
    [
      2,
      {
        id: 2,
        name: 'Legacy',
        price: 0,
        maxSubscribers: 50,
        maxNas: 1,
        maxAccounts: 1,
        isActive: false,
      },
    ],
  ]);
  const companyPlans: Array<Record<string, unknown>> = [];
  const prisma = {
    platformPlan: {
      findMany: jest.fn(() => Promise.resolve([...plans.values()])),
      findUnique: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve(plans.get(where.id) ?? null),
      ),
      findFirst: jest.fn(({ where }: { where: { name: { equals: string } } }) =>
        Promise.resolve(
          [...plans.values()].find(
            (p) =>
              String(p.name).toLowerCase() === where.name.equals.toLowerCase(),
          ) ?? null,
        ),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 9, price: 0, ...data }),
      ),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: number };
          data: Record<string, unknown>;
        }) => Promise.resolve({ ...plans.get(where.id), ...data }),
      ),
      delete: jest.fn(() => Promise.resolve({})),
    },
    companyPlan: {
      groupBy: jest.fn(() =>
        Promise.resolve([{ planId: 1, _count: { _all: 2 } }]),
      ),
      count: jest.fn(({ where }: { where: { planId: number } }) =>
        Promise.resolve(where.planId === 1 ? 2 : 0),
      ),
      updateMany: jest.fn(() => Promise.resolve({ count: 2 })),
      upsert: jest.fn(({ create }: { create: Record<string, unknown> }) => {
        companyPlans.push(create);
        return Promise.resolve(create);
      }),
    },
    companyProfile: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      upsert: jest.fn(({ create }: { create: Record<string, unknown> }) =>
        Promise.resolve(create),
      ),
    },
    user: {
      findUnique: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve(
          where.id === 10
            ? {
                id: 10,
                name: 'Q-isp1',
                role: 'ADMIN',
                parent: { role: 'SUPER_ADMIN' },
              }
            : null,
        ),
      ),
    },
  };
  return {
    svc: new PlatformPlansService(prisma as never),
    prisma,
    companyPlans,
  };
}

describe('Plans & Pricing', () => {
  it('is refused to company accounts on every action', async () => {
    const { svc } = make();
    await expect(svc.list(COMPANY_ADMIN)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      svc.create(COMPANY_ADMIN, { name: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.update(COMPANY_ADMIN, 1, { price: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.remove(COMPANY_ADMIN, 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.applyToCompanies(COMPANY_ADMIN, 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.saveProfile(COMPANY_ADMIN, 10, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lists plans with how many companies are on each', async () => {
    const { svc } = make();
    const r = await svc.list(PLATFORM);
    expect(r.plans.find((p) => p.id === 1)?.companies).toBe(2);
    expect(r.features).toContain('accounting');
  });

  it('validates price, limits, period and features, and refuses duplicate names', async () => {
    const { svc } = make();
    await expect(svc.create(PLATFORM, { name: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      svc.create(PLATFORM, { name: 'Gold', price: -5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(PLATFORM, { name: 'Gold', maxNas: 1.5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(PLATFORM, { name: 'Gold', billingPeriod: 'WEEKLY' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(PLATFORM, { name: 'Gold', features: ['teleport'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(PLATFORM, { name: 'starter' }),
    ).rejects.toBeInstanceOf(ConflictException);
    const ok = await svc.create(PLATFORM, {
      name: 'Gold',
      price: '4999.999',
      currency: 'pkr',
      maxSubscribers: '',
      features: ['billing'],
    });
    expect(ok).toMatchObject({
      name: 'Gold',
      price: 5000,
      currency: 'PKR',
      maxSubscribers: null,
      features: ['billing'],
    });
  });

  it('will not delete a plan companies are on, and applies a plan explicitly', async () => {
    const { svc, prisma } = make();
    await expect(svc.remove(PLATFORM, 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(svc.remove(PLATFORM, 2)).resolves.toEqual({ deleted: true });
    await expect(svc.applyToCompanies(PLATFORM, 1)).resolves.toEqual({
      updated: 2,
    });
    expect(prisma.companyPlan.updateMany).toHaveBeenCalledWith({
      where: { planId: 1 },
      data: { maxSubscribers: 300, maxNas: 2, maxAccounts: 5 },
    });
  });

  it('cleans and validates company details', async () => {
    const { svc } = make();
    await expect(svc.saveProfile(PLATFORM, 99, {})).rejects.toThrow(
      'Company not found',
    );
    await expect(
      svc.saveProfile(PLATFORM, 10, { website: 'not a site' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.saveProfile(PLATFORM, 10, { contactPhone: 'call me' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const saved = await svc.saveProfile(PLATFORM, 10, {
      contactFirstName: ' Ali ',
      contactLastName: 'Khan',
      contactPhone: '+92 300 1234567',
      website: 'q-isp1.pk',
      addressLine1: 'Plot 4, Street 9',
      city: 'Islamabad',
      country: 'Pakistan',
      ignored: 'x',
    });
    expect(saved).toMatchObject({
      companyId: 10,
      contactFirstName: 'Ali',
      website: 'https://q-isp1.pk',
      city: 'Islamabad',
    });
    expect(saved).not.toHaveProperty('ignored');
  });
});

describe('assigning a plan to a company (savePlan)', () => {
  it("copies the plan's limits, records the plan, and lets an explicit value override", async () => {
    const { prisma, companyPlans } = make();
    await savePlan(prisma, 1, 10, { planId: 1 });
    expect(companyPlans[0]).toMatchObject({
      planId: 1,
      maxSubscribers: 300,
      maxNas: 2,
      maxAccounts: 5,
    });
    await savePlan(prisma, 1, 10, { planId: 1, maxNas: 4, maxAccounts: null });
    expect(companyPlans[1]).toMatchObject({
      planId: 1,
      maxSubscribers: 300,
      maxNas: 4,
      maxAccounts: null,
    });
  });

  it('refuses a switched-off or unknown plan, and leaves the plan alone when none is sent', async () => {
    const { prisma, companyPlans } = make();
    await expect(savePlan(prisma, 1, 10, { planId: 2 })).rejects.toThrow(
      /switched off/,
    );
    await expect(savePlan(prisma, 1, 10, { planId: 77 })).rejects.toThrow(
      /does not exist/,
    );
    await savePlan(prisma, 1, 10, { maxSubscribers: 10 });
    expect(companyPlans[0]).not.toHaveProperty('planId');
    expect(companyPlans[0]).toMatchObject({ maxSubscribers: 10, maxNas: null });
  });
});
