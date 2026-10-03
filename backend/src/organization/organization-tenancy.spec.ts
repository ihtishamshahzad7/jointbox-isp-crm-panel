import { ForbiddenException } from '@nestjs/common';
import { OrganizationService } from './organization.service';
import { OrganizationController } from './organization.controller';
import { ScopeService } from '../common/scope.service';

/**
 * Tenancy of ISPs and branches.
 *
 * Isp and Branch have no owner column — every row is installation-level — so
 * creating, editing, deleting and assigning are platform-owner operations,
 * and the lists show a company only the branches its own accounts sit in.
 *
 * The real ScopeService runs; only the user tree and Prisma are stubbed.
 */
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const COMPANY_A = { sub: 10, role: 'ADMIN' };
const COMPANY_B = { sub: 20, role: 'ADMIN' };

const TREE: Record<number, number[]> = { 1: [1, 10, 11, 20, 21], 10: [10, 11], 20: [20, 21] };

function makeScope() {
  const scope = new ScopeService({} as any);
  jest.spyOn(scope, 'descendantIds').mockImplementation(async (id: number) => TREE[id] ?? [id]);
  return scope;
}

function makePrisma(branchOfUsers: Array<{ branchId: number }> = [{ branchId: 5 }]) {
  return {
    isp: {
      findMany: jest.fn().mockResolvedValue([{ id: 1, name: 'ISP' }]),
      create: jest.fn().mockResolvedValue({ id: 2 }),
      update: jest.fn().mockResolvedValue({ id: 1 }),
      delete: jest.fn().mockResolvedValue({ id: 1 }),
    },
    branch: {
      findMany: jest.fn().mockResolvedValue([{ id: 5 }]),
      findUnique: jest.fn().mockResolvedValue({ id: 5, ispId: 1 }),
      create: jest.fn().mockResolvedValue({ id: 6 }),
      update: jest.fn().mockResolvedValue({ id: 5 }),
      delete: jest.fn().mockResolvedValue({ id: 5 }),
      count: jest.fn().mockResolvedValue(0),
    },
    user: {
      findMany: jest.fn().mockResolvedValue(branchOfUsers),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    subscriber: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
  } as any;
}

function make(prisma = makePrisma()) {
  const scope = makeScope();
  const org = new OrganizationService(prisma, {} as any, scope, {} as any);
  const ctl = new OrganizationController(org, {} as any, scope);
  return { prisma, org, ctl };
}

describe('organization: ISP and branch writes are installation-wide', () => {
  const writes: Array<[string, (ctl: OrganizationController, req: any) => any]> = [
    ['create ISP', (c, r) => c.createIsp({ name: 'Rival' }, r)],
    ['update ISP', (c, r) => c.updateIsp('1', { name: 'Renamed' }, r)],
    ['delete ISP', (c, r) => c.deleteIsp('1', r)],
    ['create branch', (c, r) => c.createBranch({ name: 'B', ispId: 1 }, r)],
    ['update branch', (c, r) => c.updateBranch('5', { name: 'B2' }, r)],
    ['delete branch', (c, r) => c.deleteBranch('5', r)],
    ['assign to branch', (c, r) => c.assign('5', { subscriberIds: [900], userIds: [21] }, r)],
  ];

  it.each(writes)('refuses a company ADMIN: %s', async (_name, call) => {
    const { prisma, ctl } = make();
    await expect(Promise.resolve().then(() => call(ctl, { user: COMPANY_A }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    for (const model of ['isp', 'branch', 'user', 'subscriber']) {
      for (const fn of ['create', 'update', 'delete', 'updateMany']) {
        if (prisma[model][fn]) expect(prisma[model][fn]).not.toHaveBeenCalled();
      }
    }
  });

  it('lets the platform owner create an ISP', async () => {
    const { prisma, ctl } = make();
    await ctl.createIsp({ name: ' New ISP ' }, { user: OWNER });
    expect(prisma.isp.create).toHaveBeenCalledWith({ data: { name: 'New ISP', logoUrl: null } });
  });

  it('lets the platform owner assign exactly the ids it asked for', async () => {
    const { prisma, ctl } = make();
    const out = await ctl.assign('5', { subscriberIds: [900, 901], userIds: [21] }, { user: OWNER });
    expect(prisma.subscriber.updateMany).toHaveBeenCalledWith({ where: { id: { in: [900, 901] } }, data: { branchId: 5 } });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: { in: [21] } }, data: { branchId: 5 } });
    expect(out).toEqual({ subscribers: 2, users: 1 });
  });
});

describe('organization: ISP and branch lists are scoped', () => {
  it('shows a company only the branches its own accounts are in, with scoped counts', async () => {
    const { prisma, ctl } = make();
    await ctl.branches({ user: COMPANY_A });
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ id: { in: [10, 11] }, branchId: { not: null } });
    const args = prisma.branch.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ id: { in: [5] } });
    expect(args.include._count.select.subscribers).toEqual({ where: { userId: { in: [10, 11] } } });
    expect(args.include._count.select.users).toEqual({ where: { id: { in: [10, 11] } } });
  });

  it('shows a company only the ISPs of those branches', async () => {
    const { prisma, ctl } = make();
    await ctl.isps({ user: COMPANY_B });
    expect(prisma.user.findMany.mock.calls[0][0].where.id).toEqual({ in: [20, 21] });
    expect(prisma.isp.findMany.mock.calls[0][0].where).toEqual({ branches: { some: { id: { in: [5] } } } });
  });

  it('shows nothing to a company none of whose accounts is in a branch', async () => {
    const { prisma, ctl } = make(makePrisma([]));
    await expect(ctl.isps({ user: COMPANY_A })).resolves.toEqual([]);
    await expect(ctl.branches({ user: COMPANY_A }, '1')).resolves.toEqual([]);
    expect(prisma.isp.findMany).not.toHaveBeenCalled();
    expect(prisma.branch.findMany).not.toHaveBeenCalled();
  });

  it('shows the platform owner everything, exactly as before', async () => {
    const { prisma, ctl } = make();
    await ctl.isps({ user: OWNER });
    await ctl.branches({ user: OWNER }, '3');
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.isp.findMany.mock.calls[0][0]).toEqual({
      include: { _count: { select: { branches: true } } },
      orderBy: { id: 'asc' },
    });
    expect(prisma.branch.findMany.mock.calls[0][0].where).toEqual({ ispId: 3 });
  });
});
