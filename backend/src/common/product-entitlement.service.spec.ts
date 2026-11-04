import { ForbiddenException } from '@nestjs/common';
import { ProductEntitlementService } from './product-entitlement.service';

const PLATFORM = { sub: 1, role: 'SUPER_ADMIN' };
const COMPANY_USER = { sub: 10, role: 'ADMIN' };

function make() {
  const global = new Map<string, boolean>([
    ['ai-assistant', true],
    ['crm-advanced', false],
  ]);
  const companyPlan: {
    planId: number;
    features: string[];
    expiresAt: Date | null;
    aiAssistantMonthlyRequestLimit: number | null;
    aiAssistantMonthlyTokenLimit: number | null;
  } = {
    planId: 7,
    features: ['ai-assistant'],
    expiresAt: null,
    aiAssistantMonthlyRequestLimit: 50,
    aiAssistantMonthlyTokenLimit: 10000,
  };
  const prisma = {
    productFeature: {
      findMany: jest.fn(() =>
        Promise.resolve(
          [...global].map(([key, enabled]) => ({ key, enabled })),
        ),
      ),
      findUnique: jest.fn(({ where }: { where: { key: string } }) =>
        Promise.resolve(
          global.has(where.key) ? { enabled: global.get(where.key) } : null,
        ),
      ),
      upsert: jest.fn(
        ({
          where,
          update,
          create,
        }: {
          where: { key: string };
          update: { enabled: boolean };
          create: { enabled: boolean };
        }) => {
          const enabled = update?.enabled ?? create.enabled;
          global.set(where.key, enabled);
          return Promise.resolve({ key: where.key, enabled });
        },
      ),
    },
    companyPlan: {
      findUnique: jest.fn(() => Promise.resolve(companyPlan)),
    },
  };
  const scope = {
    actorId: jest.fn((actor: { sub: number }) => actor.sub),
    companyRootId: jest.fn((id: number) =>
      Promise.resolve(id === 10 ? 10 : 20),
    ),
  };
  const service = new ProductEntitlementService(
    prisma as never,
    scope as never,
  );
  return { service, prisma, scope, global, companyPlan };
}

describe('ProductEntitlementService', () => {
  it('keeps global feature switches independently controlled', async () => {
    const { service } = make();
    await expect(service.listGlobal(PLATFORM)).resolves.toEqual([
      { key: 'ai-assistant', enabled: true },
      { key: 'crm-advanced', enabled: false },
    ]);
    await expect(
      service.setGlobal(PLATFORM, 'crm-advanced', true),
    ).resolves.toMatchObject({
      key: 'crm-advanced',
      enabled: true,
    });
  });

  it('requires the global switch, company plan entitlement, and non-expired plan', async () => {
    const { service, global, companyPlan } = make();
    await expect(
      service.assertEnabled(COMPANY_USER, 'ai-assistant'),
    ).resolves.toMatchObject({
      enabled: true,
      companyId: 10,
    });
    await expect(
      service.assertEnabled(COMPANY_USER, 'crm-advanced'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    global.set('ai-assistant', false);
    await expect(
      service.assertEnabled(COMPANY_USER, 'ai-assistant'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    global.set('ai-assistant', true);
    companyPlan.features = [];
    await expect(
      service.assertEnabled(COMPANY_USER, 'ai-assistant'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    companyPlan.features = ['ai-assistant'];
    companyPlan.expiresAt = new Date(Date.now() - 1000);
    await expect(
      service.assertEnabled(COMPANY_USER, 'ai-assistant'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rechecks the independent global and company feature state in a transaction', async () => {
    const { service, global, companyPlan } = make();
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ companyId: 10 }])
        .mockResolvedValueOnce([{ enabled: true }]),
      companyPlan: {
        findUnique: jest.fn(() => Promise.resolve(companyPlan)),
      },
    };

    await expect(
      service.assertEnabledForTransaction(tx as never, 10, 'ai-assistant'),
    ).resolves.toBeUndefined();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);

    global.set('ai-assistant', false);
    tx.$queryRaw.mockReset();
    tx.$queryRaw
      .mockResolvedValueOnce([{ companyId: 10 }])
      .mockResolvedValueOnce([{ enabled: false }]);
    await expect(
      service.assertEnabledForTransaction(tx as never, 10, 'ai-assistant'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not let a platform principal use company entitlements', async () => {
    const { service } = make();
    await expect(
      service.assertEnabled(PLATFORM, 'ai-assistant'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not allow company accounts to edit global switches', async () => {
    const { service } = make();
    await expect(
      service.setGlobal(COMPANY_USER, 'ai-assistant', false),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
