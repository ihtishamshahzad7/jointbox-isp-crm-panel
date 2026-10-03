import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ThrottlePoliciesService } from './throttle-policies.service';
import { ThrottlePoliciesController } from './throttle-policies.controller';

/**
 * THROTTLE POLICY TENANCY.
 *
 * A ThrottlePolicy has no owner — one row serves every company — so changing
 * one is a platform-owner operation. What hangs off a policy is tenant data:
 * a company may only bind it to ITS packages and subscribers, and only sees
 * its own bindings when reading a policy.
 *
 * ISP A (user 10) owns package 7 and subscriber 100; ISP B (user 20) owns
 * package 8 and subscriber 200.
 */
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const ISP_A = { sub: 10, role: 'ADMIN' };
const ISP_B = { sub: 20, role: 'ADMIN' };
const SUB_OWNER: Record<number, number> = { 100: 10, 200: 20 };
const PKG_OWNER: Record<number, number> = { 7: 10, 8: 20 };

function makeScope() {
  const isPlatformOwner = (a: any) => a?.role === 'SUPER_ADMIN';
  const assertViaSubscriber = async (a: any, id: any, what = 'Record') => {
    if (isPlatformOwner(a)) return;
    if (id == null || SUB_OWNER[Number(id)] !== a.sub) throw new NotFoundException(`${what} not found`);
  };
  return {
    isPlatformOwner,
    assertPlatformOwner: jest.fn((a: any) => {
      if (!isPlatformOwner(a)) throw new ForbiddenException('installation-wide');
    }),
    assertSubscriberVisible: jest.fn((a: any, id: number) => assertViaSubscriber(a, id, 'Subscriber')),
    assertPackage: jest.fn(async (a: any, id: number) => {
      if (isPlatformOwner(a)) return;
      if (PKG_OWNER[Number(id)] !== a.sub) throw new NotFoundException(`Package ${id} not found`);
    }),
    assertOwnerInScope: jest.fn(async (a: any, ownerId: any, what = 'Record') => {
      if (isPlatformOwner(a)) return;
      if (ownerId !== a.sub) throw new NotFoundException(`${what} not found`);
    }),
    packageWhere: jest.fn(async (a: any) => ({ ownerId: a.sub })),
    subscriberWhere: jest.fn(async (a: any) => ({ userId: { in: [a.sub] } })),
    // Company-owned config, as ScopeService implements it: each ADMIN here is
    // its own company root; NULL owner = platform default.
    configReadWhere: jest.fn(async (a: any) => (isPlatformOwner(a) ? {} : { OR: [{ ownerId: null }, { ownerId: a.sub }] })),
    configOwnerForCreate: jest.fn(async (a: any) => (isPlatformOwner(a) ? null : a.sub)),
    assertConfigWritable: jest.fn(async (a: any, row: any, what = 'Setting') => {
      if (!row) throw new NotFoundException(`${what} not found`);
      if (isPlatformOwner(a)) return;
      if (row.ownerId == null) throw new ForbiddenException(`${what} is a platform default`);
      if (row.ownerId !== a.sub) throw new NotFoundException(`${what} not found`);
    }),
    assertConfigReadable: jest.fn(async (a: any, row: any, what = 'Setting') => {
      if (!row) throw new NotFoundException(`${what} not found`);
      if (isPlatformOwner(a) || row.ownerId == null) return;
      if (row.ownerId !== a.sub) throw new NotFoundException(`${what} not found`);
    }),
  };
}

function make() {
  const prisma: any = {
    throttlePolicy: {
      findMany: jest.fn().mockResolvedValue([]),
      // 3 = a platform default; 9 = company B's own.
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === 9
          ? { id: 9, name: 'B night', ownerId: 20, packages: [], subscribers: [] }
          : { id: 3, name: 'Peak', ownerId: null, packages: [], subscribers: [] },
      ),
      create: jest.fn().mockResolvedValue({ id: 4 }),
      update: jest.fn().mockResolvedValue({ id: 3 }),
      delete: jest.fn().mockResolvedValue({ id: 3 }),
    },
    package: {
      findUnique: jest.fn(async ({ where }: any) => ({ ownerId: PKG_OWNER[where.id] ?? null })),
    },
    packageThrottlePolicy: {
      upsert: jest.fn().mockResolvedValue({ id: 1 }),
      delete: jest.fn().mockResolvedValue({ id: 1 }),
    },
    subscriberThrottle: {
      upsert: jest.fn().mockResolvedValue({ id: 1 }),
      delete: jest.fn().mockResolvedValue({ id: 1 }),
    },
  };
  const scope = makeScope();
  const svc = new ThrottlePoliciesService(prisma, scope as any);
  const ctl = new ThrottlePoliciesController(svc);
  return { prisma, scope, ctl };
}

describe('Throttle policy tenancy', () => {
  it('a company cannot edit or delete a platform default, nor another company\'s policy', async () => {
    const { ctl, prisma } = make();
    await expect(ctl.update('3', { name: 'y' }, { user: ISP_A })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.remove('3', { user: ISP_A })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.update('9', { name: 'y' }, { user: ISP_A })).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.get('9', { user: ISP_A })).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.attachToPackage('9', { packageId: 7 }, { user: ISP_A })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.throttlePolicy.update).not.toHaveBeenCalled();
    expect(prisma.throttlePolicy.delete).not.toHaveBeenCalled();
  });

  it('a company creates and edits its OWN policy; the platform owner makes defaults', async () => {
    const { ctl, prisma } = make();
    await ctl.create({ name: 'x', mode: 'PERCENT' }, { user: ISP_A });
    expect(prisma.throttlePolicy.create.mock.calls[0][0].data.ownerId).toBe(10);
    await ctl.update('9', { name: 'y' }, { user: ISP_B });
    expect(prisma.throttlePolicy.update).toHaveBeenCalled();
    await expect(ctl.create({ name: 'x', mode: 'PERCENT' }, { user: OWNER })).resolves.toEqual({ id: 4 });
    expect(prisma.throttlePolicy.create.mock.calls[1][0].data.ownerId).toBeNull();
  });

  it("cannot bind a policy to another company's subscriber", async () => {
    const { ctl, prisma } = make();
    await expect(ctl.attachToSubscriber('3', { subscriberId: 100 }, { user: ISP_B })).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.detachFromSubscriber('3', '100', { user: ISP_B })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.subscriberThrottle.upsert).not.toHaveBeenCalled();
    expect(prisma.subscriberThrottle.delete).not.toHaveBeenCalled();
  });

  it("cannot bind a policy to another company's package", async () => {
    const { ctl, prisma } = make();
    await expect(ctl.attachToPackage('3', { packageId: 7 }, { user: ISP_B })).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.detachFromPackage('3', '7', { user: ISP_B })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.packageThrottlePolicy.upsert).not.toHaveBeenCalled();
    expect(prisma.packageThrottlePolicy.delete).not.toHaveBeenCalled();
  });

  it('the owning company and the platform owner can bind', async () => {
    const a = make();
    await a.ctl.attachToSubscriber('3', { subscriberId: 100 }, { user: ISP_A });
    await a.ctl.attachToPackage('3', { packageId: 7 }, { user: ISP_A });
    expect(a.prisma.subscriberThrottle.upsert).toHaveBeenCalled();
    expect(a.prisma.packageThrottlePolicy.upsert).toHaveBeenCalled();

    const o = make();
    await o.ctl.attachToSubscriber('3', { subscriberId: 200 }, { user: OWNER });
    await o.ctl.detachFromPackage('3', '8', { user: OWNER });
    expect(o.prisma.subscriberThrottle.upsert).toHaveBeenCalled();
    expect(o.prisma.packageThrottlePolicy.delete).toHaveBeenCalled();
  });

  it("list counts and get bindings are narrowed to the caller's packages/subscribers", async () => {
    const { ctl, prisma } = make();
    await ctl.list({}, { user: ISP_A });
    expect(prisma.throttlePolicy.findMany.mock.calls[0][0].where.AND[0]).toEqual({ OR: [{ ownerId: null }, { ownerId: 10 }] });
    const count = prisma.throttlePolicy.findMany.mock.calls[0][0].include._count.select;
    expect(count.packages).toEqual({ where: { package: { ownerId: 10 } } });
    expect(count.subscribers).toEqual({ where: { subscriber: { userId: { in: [10] } } } });

    await ctl.get('3', { user: ISP_A });
    const inc = prisma.throttlePolicy.findUnique.mock.calls[0][0].include;
    expect(inc.packages.where).toEqual({ package: { ownerId: 10 } });
    expect(inc.subscribers.where).toEqual({ subscriber: { userId: { in: [10] } } });
  });

  it('the platform owner list and get are unchanged', async () => {
    const { ctl, prisma } = make();
    await ctl.list({}, { user: OWNER });
    expect(prisma.throttlePolicy.findMany.mock.calls[0][0].include._count.select).toEqual({ packages: true, subscribers: true });
    await ctl.get('3', { user: OWNER });
    const inc = prisma.throttlePolicy.findUnique.mock.calls[0][0].include;
    expect(inc.packages.where).toBeUndefined();
    expect(inc.subscribers.where).toBeUndefined();
  });
});
