import { NotFoundException } from '@nestjs/common';
import { IpPoolService } from './ip-pool.service';
import { IpPoolController } from './ip-pool.controller';

/**
 * IP POOL TENANCY.
 *
 * findOne must not show another company's pool; the router-comparison tools
 * (sync/check, sync/apply, verify) must only compare the caller's routers
 * against the caller's pools. ISP A (user 10) owns pool 5; ISP B (user 20)
 * owns pool 6.
 */
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const ISP_A = { sub: 10, role: 'ADMIN' };
const ISP_B = { sub: 20, role: 'ADMIN' };
const POOLS = [
  { id: 5, name: 'a-pool', network: '10.1.0.2-10.1.0.254', ownerId: 10, nasId: 1 },
  { id: 6, name: 'b-pool', network: '10.2.0.2-10.2.0.254', ownerId: 20, nasId: 2 },
];

function makeScope() {
  const isPlatformOwner = (a: any) => a?.role === 'SUPER_ADMIN';
  return {
    isAdmin: (r: string) => r === 'SUPER_ADMIN',
    isPlatformOwner,
    actorId: (a: any) => Number(a?.sub),
    poolWhere: jest.fn(async (a: any) => ({ ownerId: { in: [a.sub] } })),
    nasWhere: jest.fn(async (a: any) => ({ ownerId: a.sub })),
  };
}

function make() {
  const prisma: any = {
    ipPool: {
      findFirst: jest.fn(async ({ where }: any) => {
        const [idPart, scopePart] = where.AND ?? [where, null];
        const p = POOLS.find((x) => x.id === idPart.id);
        if (!p) return null;
        if (scopePart && !scopePart.ownerId.in.includes(p.ownerId)) return null;
        return { id: p.id };
      }),
      findUnique: jest.fn(async ({ where }: any) => POOLS.find((x) => x.id === where.id) ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    nas: {
      findMany: jest.fn().mockResolvedValue([
        { id: 1, nasname: 'a-core', nasIp: '10.0.0.1', apiUsername: 'u', apiPassword: 'p', apiPort: 8728 },
      ]),
    },
  };
  const mikrotik: any = {
    getIpPools: jest.fn().mockResolvedValue([{ name: 'new-pool', ranges: '10.9.0.2-10.9.0.254' }]),
  };
  const scope = makeScope();
  const svc = new IpPoolService(prisma, mikrotik, scope as any);
  const ctl = new IpPoolController(svc);
  return { prisma, mikrotik, scope, ctl };
}

describe('IP pool tenancy', () => {
  it("another company's ADMIN gets not-found for a pool it cannot see", async () => {
    const { ctl, prisma } = make();
    await expect(ctl.findOne('5', { user: ISP_B })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.ipPool.findUnique).not.toHaveBeenCalled();
  });

  it('the owning company and the platform owner can read it', async () => {
    const a = make();
    await expect(a.ctl.findOne('5', { user: ISP_A })).resolves.toMatchObject({ id: 5 });
    const o = make();
    await expect(o.ctl.findOne('6', { user: OWNER })).resolves.toMatchObject({ id: 6 });
    expect(o.prisma.ipPool.findFirst).not.toHaveBeenCalled();
  });

  it("sync/check only reads the caller's routers and compares the caller's pools", async () => {
    const { ctl, prisma } = make();
    await ctl.checkPoolSync({ user: ISP_A });
    const nasWhere = prisma.nas.findMany.mock.calls[0][0].where;
    expect(nasWhere.AND).toContainEqual({ ownerId: 10 });
    expect(prisma.ipPool.findMany).toHaveBeenCalledWith({ where: { ownerId: { in: [10] } } });
    expect(prisma.ipPool.create).not.toHaveBeenCalled();
  });

  it("sync/apply imports a router's pool as the caller's own", async () => {
    const { ctl, prisma } = make();
    await ctl.applyPoolSync({ user: ISP_A });
    expect(prisma.ipPool.create.mock.calls[0][0].data).toMatchObject({ name: 'new-pool', nasId: 1, ownerId: 10 });
  });

  it('verify is scoped for a company and unchanged for the platform owner', async () => {
    const a = make();
    await a.ctl.verify({ user: ISP_A });
    expect(a.prisma.ipPool.findMany.mock.calls[0][0].where).toEqual({ ownerId: { in: [10] } });
    expect(a.prisma.nas.findMany.mock.calls[0][0].where.AND).toContainEqual({ ownerId: 10 });

    const o = make();
    await o.ctl.verify({ user: OWNER });
    expect(o.prisma.ipPool.findMany.mock.calls[0][0].where).toBeUndefined();
    expect(o.prisma.nas.findMany.mock.calls[0][0].where).toEqual({
      isActive: true, nasIp: { not: null }, apiUsername: { not: null },
    });
  });
});
