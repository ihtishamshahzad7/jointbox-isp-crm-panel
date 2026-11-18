import { ForbiddenException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  actorFeatures,
  actorHasFeature,
  companyFeatures,
  GATED_FEATURES,
  parseFeatureList,
  PLAN_FEATURES,
} from './features';
import { invalidateCompanyPlan, savePlan } from './company-plan';
import { FeatureGuard, REQUIRED_FEATURE } from './feature.guard';

const scopeFor = (companyByUser: Record<number, number | null>) => ({
  isAdmin: (role?: string) => role === 'SUPER_ADMIN',
  actorId: (a: any) => Number(a?.sub ?? a?.id),
  companyRootId: jest.fn(async (id: number) => companyByUser[id] ?? null),
});

const prismaWith = (rows: Record<number, any>) => ({
  companyPlan: { findUnique: jest.fn(async ({ where }: any) => rows[where.companyId] ?? null) },
});

beforeEach(() => invalidateCompanyPlan());

describe('feature list', () => {
  it('includes both separately sold products, and only they are gated', () => {
    expect(PLAN_FEATURES).toEqual(expect.arrayContaining(['ai-assistant', 'crm-advanced', 'billing']));
    expect([...GATED_FEATURES]).toEqual(['ai-assistant', 'crm-advanced']);
  });
  it('parseFeatureList de-duplicates and rejects unknown names', () => {
    expect(parseFeatureList(['ai-assistant', 'ai-assistant', 'billing'])).toEqual(['ai-assistant', 'billing']);
    expect(() => parseFeatureList(['ai-assistant', 'root-shell'])).toThrow('Unknown feature: root-shell');
    expect(() => parseFeatureList('ai-assistant')).toThrow('must be a list');
  });
});

describe('companyFeatures (fail closed)', () => {
  it('reads company_plan.features', async () => {
    const p = prismaWith({ 7: { companyId: 7, features: ['ai-assistant'] } });
    expect([...(await companyFeatures(p, 7))]).toEqual(['ai-assistant']);
  });
  it('no plan row → nothing', async () => {
    expect((await companyFeatures(prismaWith({}), 7)).size).toBe(0);
  });
  it('a read error → nothing (never "everything")', async () => {
    const p = { companyPlan: { findUnique: jest.fn().mockRejectedValue(new Error('relation does not exist')) } };
    expect((await companyFeatures(p, 7)).size).toBe(0);
  });
  it('no table at all → nothing', async () => {
    expect((await companyFeatures({}, 7)).size).toBe(0);
  });
});

describe('actorHasFeature', () => {
  const prisma = prismaWith({ 10: { companyId: 10, features: ['ai-assistant'] }, 20: { companyId: 20, features: ['crm-advanced', 'billing'] } });
  const scope = scopeFor({ 11: 10, 12: 10, 21: 20, 99: null });

  it('a company holding the feature, and its staff/franchises, may use it', async () => {
    expect(await actorHasFeature(prisma, scope, { sub: 11, role: 'ADMIN' }, 'ai-assistant')).toBe(true);
    expect(await actorHasFeature(prisma, scope, { sub: 12, role: 'STAFF' }, 'ai-assistant')).toBe(true);
  });
  it('the two products are independent', async () => {
    expect(await actorHasFeature(prisma, scope, { sub: 11, role: 'ADMIN' }, 'crm-advanced')).toBe(false);
    expect(await actorHasFeature(prisma, scope, { sub: 21, role: 'ADMIN' }, 'crm-advanced')).toBe(true);
    expect(await actorHasFeature(prisma, scope, { sub: 21, role: 'ADMIN' }, 'ai-assistant')).toBe(false);
  });
  it('an account with no company holds nothing; no actor holds nothing', async () => {
    expect(await actorHasFeature(prisma, scope, { sub: 99, role: 'ADMIN' }, 'ai-assistant')).toBe(false);
    expect(await actorHasFeature(prisma, scope, undefined, 'ai-assistant')).toBe(false);
  });
  it('a scope failure refuses rather than allows', async () => {
    const bad = { ...scope, companyRootId: jest.fn().mockRejectedValue(new Error('db down')) };
    expect(await actorHasFeature(prisma, bad, { sub: 11, role: 'ADMIN' }, 'ai-assistant')).toBe(false);
  });
  it('the platform account is never refused', async () => {
    expect(await actorHasFeature(prisma, scope, { sub: 1, role: 'SUPER_ADMIN' }, 'crm-advanced')).toBe(true);
  });
  it('actorFeatures lists only the gated features held', async () => {
    expect(await actorFeatures(prisma, scope, { sub: 21, role: 'ADMIN' })).toEqual(['crm-advanced']);
  });
});

describe('FeatureGuard (backend enforcement)', () => {
  const prisma = prismaWith({ 10: { companyId: 10, features: ['ai-assistant'] } });
  const scope = scopeFor({ 11: 10, 31: 30 });
  const ctx = (user: any, feature?: string) => {
    const handler = () => undefined;
    if (feature) Reflect.defineMetadata(REQUIRED_FEATURE, feature, handler);
    return {
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  };
  const guard = new FeatureGuard(new Reflector(), prisma as any, scope as any);

  it('passes a route without a feature requirement', async () => {
    await expect(guard.canActivate(ctx({ sub: 31, role: 'ADMIN' }))).resolves.toBe(true);
  });
  it('passes an entitled company', async () => {
    await expect(guard.canActivate(ctx({ sub: 11, role: 'ADMIN' }, 'ai-assistant'))).resolves.toBe(true);
  });
  it('refuses a company without it, with a machine-readable code', async () => {
    const p = guard.canActivate(ctx({ sub: 31, role: 'ADMIN' }, 'ai-assistant'));
    await expect(p).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx({ sub: 31, role: 'ADMIN' }, 'ai-assistant'))).rejects.toMatchObject({
      response: { code: 'FEATURE_NOT_ENABLED', feature: 'ai-assistant' },
    });
  });
});

describe('savePlan copies entitlements like the caps', () => {
  const tier = { id: 3, name: 'Pro', isActive: true, maxSubscribers: 500, maxNas: 5, maxAccounts: 20, features: ['billing', 'ai-assistant'] };
  const mk = () => ({
    user: { findUnique: jest.fn().mockResolvedValue({ id: 10, name: 'Acme', role: 'ADMIN', parent: { role: 'SUPER_ADMIN' } }) },
    platformPlan: { findUnique: jest.fn().mockResolvedValue(tier) },
    companyPlan: {
      findUnique: jest.fn(async () => current),
      upsert: jest.fn(async (a: any) => ({ companyId: 10, ...a.update })),
    },
  });
  let current: any = null;
  beforeEach(() => { current = null; });
  it('assigning a plan copies its features', async () => {
    const prisma = mk();
    await savePlan(prisma, 1, 10, { planId: 3 });
    expect(prisma.companyPlan.upsert.mock.calls[0][0].update.features).toEqual(['billing', 'ai-assistant']);
  });
  it('an explicit list wins over the plan, and is validated', async () => {
    const prisma = mk();
    await savePlan(prisma, 1, 10, { planId: 3, features: ['crm-advanced'] });
    expect(prisma.companyPlan.upsert.mock.calls[0][0].update.features).toEqual(['crm-advanced']);
    await expect(savePlan(mk(), 1, 10, { features: ['everything'] })).rejects.toThrow('Unknown feature');
  });
  it('re-saving on the SAME plan keeps per-company add-on switches', async () => {
    current = { planId: 3 };
    const prisma = mk();
    await savePlan(prisma, 1, 10, { planId: 3, maxNas: 9 });
    expect('features' in prisma.companyPlan.upsert.mock.calls[0][0].update).toBe(false);
  });
  it('saving caps alone leaves the features untouched', async () => {
    const prisma = mk();
    await savePlan(prisma, 1, 10, { maxNas: 3 });
    expect('features' in prisma.companyPlan.upsert.mock.calls[0][0].update).toBe(false);
  });
});
