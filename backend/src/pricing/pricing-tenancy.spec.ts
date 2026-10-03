import { NotFoundException } from '@nestjs/common';
import { PricingService } from './pricing.service';
import { ScopeService } from '../common/scope.service';

/**
 * PRICING TENANCY — fee catalogue (shared) and subscriber discounts (per subscriber).
 *
 * Real ScopeService over a hand-rolled two-company tree:
 *
 *   1 SUPER_ADMIN (platform owner)
 *   ├─ 10 ADMIN  company A ── 11 RESELLER  (subscriber 100, discount 7)
 *   └─ 20 ADMIN  company B ── 21 RESELLER  (subscriber 200, discount 8)
 */
const USERS = [
  { id: 1, parentId: null as number | null },
  { id: 10, parentId: 1 },
  { id: 11, parentId: 10 },
  { id: 20, parentId: 1 },
  { id: 21, parentId: 20 },
];
const SUB_OWNER: Record<number, number> = { 100: 11, 200: 21 };
const DISCOUNT_SUB: Record<number, number> = { 7: 100, 8: 200 };
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const ADMIN_B = { sub: 20, role: 'ADMIN' };

/** A Prisma.sql fragment (the class itself is not exported at runtime). */
const isSql = (v: any) => !!v && typeof v === 'object' && Array.isArray(v.values) && typeof v.sql === 'string';

function make() {
  const prisma: any = {
    $queryRaw: jest.fn(async (first: any, ...vals: any[]) => {
      if (isSql(first)) {
        // The discount-id join: answer it from the fixtures for the owners given.
        const owners: number[] = first.values[0];
        return Object.entries(DISCOUNT_SUB)
          .filter(([, sub]) => owners.includes(SUB_OWNER[sub]))
          .map(([id]) => ({ id: Number(id) }));
      }
      const id = Number(vals[0]);
      if ((first as string[]).join('?').includes('WITH RECURSIVE sub')) {
        const out = USERS.some((u) => u.id === id) ? [id] : [];
        for (let i = 0; i < out.length; i++) USERS.filter((u) => u.parentId === out[i]).forEach((u) => out.push(u.id));
        return out.map((x) => ({ id: x }));
      }
      return [];
    }),
    user: { findUnique: jest.fn() },
    subscriber: {
      findUnique: jest.fn(async ({ where }: any) =>
        SUB_OWNER[where.id] ? { id: where.id, userId: SUB_OWNER[where.id] } : null,
      ),
    },
    subscriberDiscount: {
      findUnique: jest.fn(async ({ where }: any) =>
        DISCOUNT_SUB[where.id] ? { id: where.id, subscriberId: DISCOUNT_SUB[where.id], type: 'PERCENT', value: 10 } : null,
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    extraFee: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, name: 'Install', packages: [] })),
    },
  };
  return { prisma, svc: new PricingService(prisma, new ScopeService(prisma)) };
}

describe('pricing tenancy', () => {
  it("(i) another company's ADMIN gets the same NotFound for its discount as for a missing one", async () => {
    const { svc } = make();
    await expect(svc.getDiscount(7, ADMIN_B)).rejects.toThrow(new NotFoundException('Discount 7 not found'));
    await expect(svc.getDiscount(999, ADMIN_B)).rejects.toThrow(new NotFoundException('Discount 999 not found'));
    await expect(svc.getDiscount(8, ADMIN_B)).resolves.toMatchObject({ id: 8 });
  });

  it('(ii) the platform owner passes for any company', async () => {
    const { svc, prisma } = make();
    await expect(svc.getDiscount(7, OWNER)).resolves.toMatchObject({ id: 7 });
    await svc.listDiscounts({}, OWNER);
    expect(prisma.subscriberDiscount.findMany.mock.calls[0][0].where).toEqual({});
    await svc.getFee(1, OWNER);
    expect(prisma.extraFee.findUnique.mock.calls[0][0].include.packages.where).toBeUndefined();
  });

  it("(iii) the discount list is narrowed to the caller's subscribers' discounts", async () => {
    const { svc, prisma } = make();
    await svc.listDiscounts({ isActive: 'true' }, ADMIN_B);
    const sqlCall = prisma.$queryRaw.mock.calls.map((c: any[]) => c[0]).find(isSql);
    expect(sqlCall.sql).toMatch(/JOIN "Subscriber"/);
    expect(sqlCall.values).toEqual([[20, 21]]);
    expect(prisma.subscriberDiscount.findMany.mock.calls[0][0].where).toEqual({ isActive: true, id: { in: [8] } });
  });

  it("(iii) the shared fee catalogue only reveals the caller's own packages attached to a fee", async () => {
    const { svc, prisma } = make();
    const scoped = { package: { OR: [{ ownerId: 20 }, { resellerPrices: { some: { userId: 20 } } }] } };
    await svc.getFee(1, ADMIN_B);
    expect(prisma.extraFee.findUnique.mock.calls[0][0].include.packages.where).toEqual(scoped);
    await svc.listFees({}, ADMIN_B);
    expect(prisma.extraFee.findMany.mock.calls[0][0].include._count.select.packages).toEqual({ where: scoped });
  });
});
