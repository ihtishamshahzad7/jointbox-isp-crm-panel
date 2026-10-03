import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../common/scope.service';
import { GroupsService } from './groups.service';

/**
 * ACCESS GROUPS — each company owns its own. Its administrator creates and
 * edits them; members must be its own accounts and only its own routers /
 * packages can be bound. Another company's group is "not found"; a group from
 * before ownership (ownerId NULL) is readable but not editable by a company.
 *
 *   company A = ADMIN 10 (downline 11) — owns group 5
 *   company B = ADMIN 20 (downline 21) — owns group 6
 *   group 7 has no owner (legacy)
 */
const A = { sub: 10, role: 'ADMIN' };
const A_DEALER = { sub: 11, role: 'RESELLER' };
const B = { sub: 20, role: 'ADMIN' };
const TREE: Record<number, number[]> = { 10: [10, 11], 20: [20, 21] };
const COMPANY: Record<number, number> = { 10: 10, 11: 10, 20: 20, 21: 20 };
const GROUPS: Record<number, { ownerId: number | null }> = { 5: { ownerId: 10 }, 6: { ownerId: 20 }, 7: { ownerId: null } };

function makeService() {
  const scope = new ScopeService({} as any);
  jest.spyOn(scope, 'rootId').mockImplementation(async (a: any) => Number(a?.sub ?? a?.id));
  jest.spyOn(scope, 'descendantIds').mockImplementation(async (id: number) => TREE[id] ?? [id]);
  jest.spyOn(scope, 'ancestorIds').mockImplementation(async (id: number) => [id]);
  jest.spyOn(scope, 'companyRootId').mockImplementation(async (id: number) => COMPANY[id] ?? null);
  const assertNas = jest.spyOn(scope, 'assertNas').mockImplementation(async (_a: any, nasId: number) => {
    if (nasId !== 100) throw new NotFoundException('NAS not found');
  });
  const assertPackage = jest.spyOn(scope, 'assertPackage').mockImplementation(async () => undefined);

  const prisma: any = {
    accessGroup: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        const g = GROUPS[where.id];
        if (!g) return null;
        return select ? { ownerId: g.ownerId } : { id: where.id, ...g, members: [], nasResources: [], pkgResources: [] };
      }),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => ({ id: 99, ...data })),
    },
    accessGroupMember: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async () => ({})),
      update: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
    },
    accessGroupNas: { findMany: jest.fn(async () => []), upsert: jest.fn(async () => ({})), delete: jest.fn(async () => ({})) },
    accessGroupPackage: { findMany: jest.fn(async () => []), upsert: jest.fn(async () => ({})), delete: jest.fn(async () => ({})) },
  };
  return { svc: new GroupsService(prisma, scope), prisma, assertNas, assertPackage };
}

describe('GroupsService — each company owns its groups', () => {
  it("another company cannot touch A's group — it does not exist for them", async () => {
    const { svc, prisma } = makeService();
    for (const call of [
      () => svc.updateMember(5, 11, { propagate: true }, B),
      () => svc.removeMember(5, 11, B),
      () => svc.bindNas(5, { nasId: 100 }, B),
      () => svc.unbindNas(5, 100, B),
      () => svc.bindPackage(5, { packageId: 3 }, B),
      () => svc.unbindPackage(5, 3, B),
      () => svc.updateGroup(5, { name: 'x' }, B),
      () => svc.removeGroup(5, B),
      () => svc.getGroup(5, B),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(prisma.accessGroupMember.update).not.toHaveBeenCalled();
    expect(prisma.accessGroupNas.upsert).not.toHaveBeenCalled();
  });

  it('the owning company administrator manages its own group', async () => {
    const { svc, prisma, assertNas, assertPackage } = makeService();
    await svc.addMember(5, { userId: 11 }, A);
    await svc.bindNas(5, { nasId: 100 }, A);
    await svc.bindPackage(5, { packageId: 3 }, A);
    await svc.unbindPackage(5, 3, A);
    expect(prisma.accessGroupMember.upsert).toHaveBeenCalled();
    expect(assertNas).toHaveBeenCalledWith(A, 100);
    expect(assertPackage).toHaveBeenCalledWith(A, 3);
    expect(prisma.accessGroupPackage.delete).toHaveBeenCalled();
  });

  it("members and routers must be the company's own", async () => {
    const { svc, prisma } = makeService();
    await expect(svc.addMember(5, { userId: 21 }, A)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.bindNas(5, { nasId: 200 }, A)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.accessGroupMember.upsert).not.toHaveBeenCalled();
    expect(prisma.accessGroupNas.upsert).not.toHaveBeenCalled();
  });

  it("a franchise cannot change its company's groups", async () => {
    const { svc } = makeService();
    await expect(svc.createGroup({ name: 'VIP' }, A_DEALER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.bindNas(5, { nasId: 100 }, A_DEALER)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a legacy group with no owner is read-only to a company', async () => {
    const { svc } = makeService();
    await expect(svc.getGroup(7, A)).resolves.toMatchObject({ id: 7 });
    await expect(svc.updateGroup(7, { name: 'x' }, A)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a new group belongs to the company that created it; names are per company', async () => {
    const { svc, prisma } = makeService();
    await svc.createGroup({ name: 'VIP' }, A);
    expect(prisma.accessGroup.findFirst.mock.calls[0][0].where).toEqual({ ownerId: 10, name: 'VIP' });
    expect(prisma.accessGroup.create.mock.calls[0][0].data.ownerId).toBe(10);
  });

  it("lists show only the caller's company groups (plus legacy ones)", async () => {
    const { svc, prisma } = makeService();
    await svc.listGroups({}, B);
    expect(prisma.accessGroup.findMany.mock.calls[0][0].where.AND[0]).toEqual({ OR: [{ ownerId: null }, { ownerId: 20 }] });
    await svc.listOptions(B);
    expect(JSON.stringify(prisma.accessGroup.findMany.mock.calls[1][0].where)).toContain('"ownerId":20');
  });

  it("a company's own group read shows only its accounts, routers and packages", async () => {
    const { svc, prisma } = makeService();
    await svc.getGroup(6, B);
    const call = prisma.accessGroup.findUnique.mock.calls.find((c: any[]) => c[0].include);
    const inc = call[0].include;
    expect(inc.members.where).toEqual({ user: { is: { id: { in: [20, 21] } } } });
    expect(JSON.stringify(inc.nasResources.where)).toContain('"ownerId":20');
    expect(JSON.stringify(inc.pkgResources.where)).toContain('"ownerId":20');
  });
});
