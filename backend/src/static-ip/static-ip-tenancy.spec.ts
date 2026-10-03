import { NotFoundException } from '@nestjs/common';
import { StaticIpService } from './static-ip.service';
import { StaticIpController } from './static-ip.controller';

/**
 * STATIC IP TENANCY — new register entries.
 *
 * An address is only routable on the NAS that owns its subnet, so a company
 * may only load addresses onto a router it can see, and the rows it loads are
 * stamped as its own. ISP A (user 10) has NAS 1; ISP B (user 20) has NAS 2.
 */
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const ISP_A = { sub: 10, role: 'ADMIN' };
const ISP_B = { sub: 20, role: 'ADMIN' };
const NAS_OWNER: Record<number, number> = { 1: 10, 2: 20 };

function makeScope() {
  const isPlatformOwner = (a: any) => a?.role === 'SUPER_ADMIN';
  return {
    isAdmin: (r: string) => r === 'SUPER_ADMIN',
    isPlatformOwner,
    actorId: (a: any) => Number(a?.sub),
    rootId: jest.fn(async (a: any) => Number(a?.sub)),
    descendantIds: jest.fn(async (id: number) => [id]),
    ancestorIds: jest.fn(async (id: number) => [id, 1]),
    nasWhere: jest.fn(async (a: any) => ({ ownerId: a.sub })),
    assertNas: jest.fn(async (a: any, nasId: number) => {
      if (isPlatformOwner(a)) return;
      if (NAS_OWNER[Number(nasId)] !== a.sub) throw new NotFoundException(`NAS ${nasId} not found`);
    }),
    assertOwnerInScope: jest.fn(async (a: any, ownerId: any, what = 'Record') => {
      if (isPlatformOwner(a)) return;
      if (Number(ownerId) !== a.sub) throw new NotFoundException(`${what} not found`);
    }),
  };
}

function make() {
  const prisma: any = {
    // The platform owner (1) is filtered out of the company's free pool.
    user: { findMany: jest.fn(async ({ where }: any) => where.id.in.filter((i: number) => i !== 1).map((id: number) => ({ id }))) },
    staticIp: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
    },
  };
  const scope = makeScope();
  const svc = new StaticIpService(prisma, scope as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  const ctl = new StaticIpController(svc);
  return { prisma, scope, ctl, svc };
}

describe('Static IP tenancy', () => {
  it("another company's ADMIN cannot add an address on a NAS it cannot see", async () => {
    const { ctl, prisma } = make();
    await expect(ctl.create({ ipAddress: '203.0.113.5', nasId: 1 }, { user: ISP_B })).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      ctl.createRange({ startIp: '203.0.113.10', endIp: '203.0.113.12', nasId: 1 }, { user: ISP_B }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.staticIp.create).not.toHaveBeenCalled();
  });

  it('cannot stamp the rows onto an account outside its subtree', async () => {
    const { ctl, prisma } = make();
    await expect(ctl.create({ ipAddress: '203.0.113.5', nasId: 2, ownerId: 10 }, { user: ISP_B })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.staticIp.create).not.toHaveBeenCalled();
  });

  it('a company adding on its own NAS gets the rows stamped as its own', async () => {
    const { ctl, prisma } = make();
    await ctl.create({ ipAddress: '203.0.113.5', nasId: 1 }, { user: ISP_A });
    expect(prisma.staticIp.create.mock.calls[0][0].data).toMatchObject({ nasId: 1, ownerId: 10 });

    await ctl.createRange({ startIp: '203.0.113.10', endIp: '203.0.113.11', nasId: 1 }, { user: ISP_A });
    const rows = prisma.staticIp.create.mock.calls.slice(1).map((c: any) => c[0].data);
    expect(rows).toHaveLength(2);
    rows.forEach((d: any) => expect(d).toMatchObject({ nasId: 1, ownerId: 10 }));
  });

  it('the platform owner can add on any NAS, without an implicit owner stamp', async () => {
    const { ctl, prisma } = make();
    await ctl.create({ ipAddress: '203.0.113.5', nasId: 2 }, { user: OWNER });
    const data = prisma.staticIp.create.mock.calls[0][0].data;
    expect(data.nasId).toBe(2);
    expect(data.ownerId).toBeUndefined();
  });

  it("the list is limited to the caller's own customers plus free addresses", async () => {
    const { ctl, prisma } = make();
    await ctl.findAll({}, { user: ISP_A });
    const where = prisma.staticIp.findMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({
      OR: [
        { subscriber: { userId: { in: [10] } } },
        {
          status: 'AVAILABLE',
          OR: [{ ownerId: { in: [10] } }, { AND: [{ ownerId: null }, { nas: { ownerId: 10 } }] }],
        },
      ],
    });
  });

  it("another company's free address is not found, not editable and not assignable", async () => {
    const { svc, prisma } = make() as any;
    const row = { id: 5, ipAddress: '203.0.113.9', subscriberId: null, status: 'AVAILABLE', ownerId: 20, history: [] };
    prisma.staticIp.findUnique = jest.fn(async () => row);
    prisma.staticIp.findFirst = jest.fn(async () => null); // outside A's free pool
    await expect(svc.findOne(5, ISP_A)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove(5, ISP_A)).rejects.toBeInstanceOf(NotFoundException);
  });
});
