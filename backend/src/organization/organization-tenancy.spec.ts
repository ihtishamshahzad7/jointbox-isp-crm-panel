import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrganizationService } from './organization.service';
import { OrganizationController } from './organization.controller';
import { ScopeService } from '../common/scope.service';

/**
 * Tenancy of ISPs and branches — each company owns its own.
 *
 * Isp.ownerId is the company (its top account). The company's administrator
 * creates, edits, deletes and assigns; another company gets "not found"; a
 * franchise inside the company cannot change them; a row from before
 * ownership (ownerId NULL) is visible where the company's accounts use it but
 * not editable. The real ScopeService runs; only the tree and Prisma are stubbed.
 *
 *   ISP 1 → company A (10), branch 5 · ISP 2 → company B (20) · ISP 3 → legacy
 */
const COMPANY_A = { sub: 10, role: 'ADMIN' };
const A_FRANCHISE = { sub: 11, role: 'RESELLER' };
const COMPANY_B = { sub: 20, role: 'ADMIN' };

const TREE: Record<number, number[]> = { 10: [10, 11], 20: [20, 21] };
const COMPANY: Record<number, number> = { 10: 10, 11: 10, 20: 20, 21: 20 };
const ISPS: Record<number, { ownerId: number | null }> = { 1: { ownerId: 10 }, 2: { ownerId: 20 }, 3: { ownerId: null } };

function makeScope() {
  const scope = new ScopeService({} as any);
  jest.spyOn(scope, 'descendantIds').mockImplementation(async (id: number) => TREE[id] ?? [id]);
  jest.spyOn(scope, 'companyRootId').mockImplementation(async (id: number) => COMPANY[id] ?? null);
  jest.spyOn(scope, 'visibleSubscriberIds').mockImplementation(async (a: any) => (COMPANY[a?.sub] === 10 ? [900, 901] : [950]));
  return scope;
}

function makePrisma(branchOfUsers: Array<{ branchId: number }> = [{ branchId: 5 }]) {
  return {
    isp: {
      findMany: jest.fn().mockResolvedValue([{ id: 1, name: 'ISP' }]),
      findUnique: jest.fn(async ({ where }: any) => (ISPS[where.id] ? { ownerId: ISPS[where.id].ownerId } : null)),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 9 }),
      update: jest.fn().mockResolvedValue({ id: 1 }),
      delete: jest.fn().mockResolvedValue({ id: 1 }),
    },
    branch: {
      findMany: jest.fn().mockResolvedValue([{ id: 5 }]),
      findUnique: jest.fn(async ({ where }: any) => (where.id === 5 ? { id: 5, ispId: 1 } : where.id === 7 ? { id: 7, ispId: 3 } : null)),
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
      findMany: jest.fn().mockResolvedValue([{ id: 900 }, { id: 901 }]),
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

const noWrites = (prisma: any) => {
  for (const model of ['isp', 'branch', 'user', 'subscriber']) {
    for (const fn of ['create', 'update', 'delete', 'updateMany']) {
      if (prisma[model][fn]) expect(prisma[model][fn]).not.toHaveBeenCalled();
    }
  }
};

describe("organization: a company's ISPs and branches are its own", () => {
  const writesOnA: Array<[string, (ctl: OrganizationController, req: any) => any]> = [
    ['update ISP', (c, r) => c.updateIsp('1', { name: 'Renamed' }, r)],
    ['delete ISP', (c, r) => c.deleteIsp('1', r)],
    ['create branch', (c, r) => c.createBranch({ name: 'B', ispId: 1 }, r)],
    ['update branch', (c, r) => c.updateBranch('5', { name: 'B2' }, r)],
    ['delete branch', (c, r) => c.deleteBranch('5', r)],
    ['assign to branch', (c, r) => c.assign('5', { subscriberIds: [900], userIds: [21] }, r)],
  ];

  it.each(writesOnA)("another company cannot %s of company A — not found", async (_n, call) => {
    const { prisma, ctl } = make();
    await expect(Promise.resolve().then(() => call(ctl, { user: COMPANY_B }))).rejects.toBeInstanceOf(NotFoundException);
    noWrites(prisma);
  });

  it.each(writesOnA)("a franchise inside the company cannot %s", async (_n, call) => {
    const { prisma, ctl } = make();
    await expect(Promise.resolve().then(() => call(ctl, { user: A_FRANCHISE }))).rejects.toBeInstanceOf(ForbiddenException);
    noWrites(prisma);
  });

  it('a legacy ISP with no owner cannot be changed by a company', async () => {
    const { prisma, ctl } = make();
    await expect(ctl.updateIsp('3', { name: 'Mine now' }, { user: COMPANY_A })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.assign('7', { subscriberIds: [900] }, { user: COMPANY_A })).rejects.toBeInstanceOf(ForbiddenException);
    noWrites(prisma);
  });

  it('a new ISP belongs to the company that created it; names are per company', async () => {
    const { prisma, ctl } = make();
    await ctl.createIsp({ name: ' New ISP ' }, { user: COMPANY_A });
    expect(prisma.isp.findFirst.mock.calls[0][0].where).toEqual({ ownerId: 10, name: 'New ISP' });
    expect(prisma.isp.create).toHaveBeenCalledWith({ data: { ownerId: 10, name: 'New ISP', logoUrl: null } });
  });

  it('the owning company administrator assigns its own customers and accounts only', async () => {
    const { prisma, ctl } = make();
    await ctl.assign('5', { subscriberIds: [900, 901, 999], userIds: [11, 21] }, { user: COMPANY_A });
    expect(prisma.subscriber.updateMany.mock.calls[0][0].where).toEqual({ id: { in: [900, 901] } });
    expect(prisma.user.updateMany.mock.calls[0][0].where).toEqual({ id: { in: [11] } });
  });
});

describe('organization: ISP and branch lists are scoped', () => {
  it("shows a company its own branches plus legacy branches its accounts are in, with scoped counts", async () => {
    const { prisma, ctl } = make();
    await ctl.branches({ user: COMPANY_A });
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ id: { in: [10, 11] }, branchId: { not: null } });
    const args = prisma.branch.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ OR: [{ isp: { ownerId: 10 } }, { id: { in: [5] } }] });
    expect(args.include._count.select.subscribers).toEqual({ where: { userId: { in: [10, 11] } } });
    expect(args.include._count.select.users).toEqual({ where: { id: { in: [10, 11] } } });
  });

  it('shows a company its own ISPs plus those of its branches', async () => {
    const { prisma, ctl } = make();
    await ctl.isps({ user: COMPANY_B });
    expect(prisma.user.findMany.mock.calls[0][0].where.id).toEqual({ in: [20, 21] });
    expect(prisma.isp.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ ownerId: 20 }, { branches: { some: { id: { in: [5] } } } }],
    });
  });

  it('never shows an account with no company anything', async () => {
    const { prisma, ctl } = make(makePrisma([]));
    await expect(ctl.isps({ user: { sub: 99, role: 'RESELLER' } })).resolves.toEqual([]);
    await expect(ctl.branches({ user: { sub: 99, role: 'RESELLER' } }, '1')).resolves.toEqual([]);
    expect(prisma.isp.findMany).not.toHaveBeenCalled();
    expect(prisma.branch.findMany).not.toHaveBeenCalled();
  });
});
