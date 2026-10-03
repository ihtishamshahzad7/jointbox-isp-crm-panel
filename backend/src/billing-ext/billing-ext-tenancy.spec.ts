import { NotFoundException } from '@nestjs/common';
import { BillingExtService } from './billing-ext.service';
import { ScopeService } from '../common/scope.service';

/**
 * BILLING-EXT TENANCY — wallet, billing mode and pro-rata reads.
 *
 * Real ScopeService over a hand-rolled two-company tree:
 *
 *   1 SUPER_ADMIN (platform owner)
 *   ├─ 10 ADMIN  company A ── 11 RESELLER  (owns subscriber 100, package 5)
 *   └─ 20 ADMIN  company B ── 21 RESELLER  (owns subscriber 200, package 6)
 */
const USERS = [
  { id: 1, parentId: null as number | null },
  { id: 10, parentId: 1 },
  { id: 11, parentId: 10 },
  { id: 20, parentId: 1 },
  { id: 21, parentId: 20 },
];
const SUB_OWNER: Record<number, number> = { 100: 11, 200: 21 };
const PKG_OWNER: Record<number, number> = { 5: 10, 6: 20 };
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const ADMIN_B = { sub: 20, role: 'ADMIN' };

function treeQuery(strings: TemplateStringsArray, ...vals: any[]) {
  const id = Number(vals[0]);
  if (strings.join('?').includes('WITH RECURSIVE sub')) {
    const out = USERS.some((u) => u.id === id) ? [id] : [];
    for (let i = 0; i < out.length; i++) USERS.filter((u) => u.parentId === out[i]).forEach((u) => out.push(u.id));
    return out.map((x) => ({ id: x }));
  }
  return [];
}

function make() {
  const prisma: any = {
    $queryRaw: jest.fn(async (s: any, ...v: any[]) => treeQuery(s, ...v)),
    user: { findUnique: jest.fn() },
    subscriber: {
      findUnique: jest.fn(async ({ where }: any) =>
        SUB_OWNER[where.id] ? { id: where.id, userId: SUB_OWNER[where.id] } : null,
      ),
    },
    package: {
      // assertPackage: { AND: [{ id }, { OR: [{ ownerId: self }, …] }] }
      findFirst: jest.fn(async ({ where }: any) => {
        const id = where.AND[0].id;
        const self = where.AND[1].OR[0].ownerId;
        return PKG_OWNER[id] === self ? { id } : null;
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        PKG_OWNER[where.id] ? { id: where.id, price: 3000, duration: 30 } : null,
      ),
    },
    proRatedBilling: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) },
    subscriberBilling: { findUnique: jest.fn().mockResolvedValue(null) },
    subscriberBalance: { findUnique: jest.fn().mockResolvedValue(null) },
    subscriberBalanceLedger: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  };
  return { prisma, svc: new BillingExtService(prisma, new ScopeService(prisma)) };
}

describe('billing-ext tenancy', () => {
  it("(i) another company's ADMIN gets NotFound for a subscriber's wallet, ledger and billing mode", async () => {
    const { svc, prisma } = make();
    await expect(svc.getSubscriberBalance(100, ADMIN_B)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getSubscriberLedger(100, {}, ADMIN_B)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getSubscriberBilling(100, ADMIN_B)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.subscriberBalance.findUnique).not.toHaveBeenCalled();
    expect(prisma.subscriberBalanceLedger.findMany).not.toHaveBeenCalled();
    expect(prisma.subscriberBilling.findUnique).not.toHaveBeenCalled();
  });

  it("(i) another company's package cannot be read or quoted", async () => {
    const { svc } = make();
    await expect(svc.getProRatedForPackage(5, ADMIN_B)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.calculateProRated({ packageId: 5, activationDate: '2026-10-01' }, ADMIN_B),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a company reaches its own subscriber and package', async () => {
    const { svc } = make();
    await expect(svc.getSubscriberBalance(200, ADMIN_B)).resolves.toMatchObject({ subscriberId: 200 });
    await expect(svc.getProRatedForPackage(6, ADMIN_B)).resolves.toMatchObject({ packageId: 6 });
    await expect(
      svc.calculateProRated({ packageId: 6, activationDate: '2026-10-01' }, ADMIN_B),
    ).resolves.toMatchObject({ isActive: true });
  });

  it('(ii) the platform owner passes for any company', async () => {
    const { svc } = make();
    await expect(svc.getSubscriberLedger(100, {}, OWNER)).resolves.toMatchObject({ rows: [] });
    await expect(svc.getSubscriberBilling(100, OWNER)).resolves.toMatchObject({ subscriberId: 100 });
    await expect(svc.getProRatedForPackage(5, OWNER)).resolves.toMatchObject({ packageId: 5 });
  });

  it('(iii) the pro-rata list is filtered to packages the caller can see; unfiltered for the owner', async () => {
    const { svc, prisma } = make();
    await svc.listProRated({}, ADMIN_B);
    expect(prisma.proRatedBilling.findMany.mock.calls[0][0].where).toEqual({
      package: { OR: [{ ownerId: 20 }, { resellerPrices: { some: { userId: 20 } } }] },
    });

    await svc.listProRated({}, OWNER);
    expect(prisma.proRatedBilling.findMany.mock.calls[1][0].where).toBeUndefined();
  });
});
