import { ForbiddenException } from '@nestjs/common';
import { ScopeService } from '../common/scope.service';
import { GroupsService } from './groups.service';

/**
 * ACCESS GROUPS — one set for the whole installation, with members from any
 * company. Changing a group is therefore a platform-owner act; reading one is
 * allowed, but its members / NAS / packages are cut down to what the caller
 * can already see.
 *
 *   company A = ADMIN 10 (downline 11)
 *   company B = ADMIN 20 (downline 21)
 */
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const A = { sub: 10, role: 'ADMIN' };
const B = { sub: 20, role: 'ADMIN' };
const TREE: Record<number, number[]> = { 1: [1], 10: [10, 11], 20: [20, 21] };

function makeService() {
  const scope = new ScopeService({} as any);
  jest.spyOn(scope, 'rootId').mockImplementation(async (a: any) => Number(a?.sub ?? a?.id));
  jest.spyOn(scope, 'descendantIds').mockImplementation(async (id: number) => TREE[id] ?? [id]);
  jest.spyOn(scope, 'ancestorIds').mockImplementation(async (id: number) => [id]);

  const prisma: any = {
    accessGroup: { findUnique: jest.fn(async () => ({ id: 5, members: [], nasResources: [], pkgResources: [] })) },
    accessGroupMember: {
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
    },
    accessGroupNas: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
    },
    accessGroupPackage: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
    },
  };
  return { svc: new GroupsService(prisma, scope), prisma };
}

describe('GroupsService — tenancy', () => {
  it('a company admin cannot change membership or bindings', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.updateMember(5, 21, { propagate: true }, A)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.removeMember(5, 21, A)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.bindNas(5, { nasId: 200 }, A)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.unbindNas(5, 200, A)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.bindPackage(5, { packageId: 3 }, A)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.unbindPackage(5, 3, A)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.accessGroupMember.update).not.toHaveBeenCalled();
    expect(prisma.accessGroupMember.delete).not.toHaveBeenCalled();
    expect(prisma.accessGroupNas.upsert).not.toHaveBeenCalled();
    expect(prisma.accessGroupNas.delete).not.toHaveBeenCalled();
    expect(prisma.accessGroupPackage.upsert).not.toHaveBeenCalled();
    expect(prisma.accessGroupPackage.delete).not.toHaveBeenCalled();
  });

  it('the platform owner can', async () => {
    const { svc, prisma } = makeService();
    await svc.updateMember(5, 21, { propagate: true }, OWNER);
    await svc.removeMember(5, 21, OWNER);
    await svc.bindNas(5, { nasId: 200 }, OWNER);
    await svc.unbindNas(5, 200, OWNER);
    await svc.bindPackage(5, { packageId: 3 }, OWNER);
    await svc.unbindPackage(5, 3, OWNER);
    expect(prisma.accessGroupMember.update).toHaveBeenCalled();
    expect(prisma.accessGroupNas.upsert).toHaveBeenCalled();
    expect(prisma.accessGroupPackage.delete).toHaveBeenCalled();
  });

  it('a group read by company B shows only B\'s accounts, routers and packages', async () => {
    const { svc, prisma } = makeService();
    await svc.getGroup(5, B);
    const inc = prisma.accessGroup.findUnique.mock.calls[0][0].include;
    expect(inc.members.where).toEqual({ user: { is: { id: { in: [20, 21] } } } });
    expect(JSON.stringify(inc.nasResources.where)).toContain('"ownerId":20');
    expect(JSON.stringify(inc.pkgResources.where)).toContain('"ownerId":20');

    await svc.listMembers(5, B);
    expect(prisma.accessGroupMember.findMany.mock.calls[0][0].where).toEqual({
      AND: [{ groupId: 5 }, { user: { is: { id: { in: [20, 21] } } } }],
    });
    await svc.listNasInGroup(5, B);
    expect(prisma.accessGroupNas.findMany.mock.calls[0][0].where.AND[0]).toEqual({ groupId: 5 });
    await svc.listPackagesInGroup(5, B);
    expect(prisma.accessGroupPackage.findMany.mock.calls[0][0].where.AND[0]).toEqual({ groupId: 5 });
  });

  it('the platform owner reads the group unfiltered', async () => {
    const { svc, prisma } = makeService();
    await svc.getGroup(5, OWNER);
    const inc = prisma.accessGroup.findUnique.mock.calls[0][0].include;
    expect(inc.members.where).toBeUndefined();
    expect(inc.nasResources.where).toBeUndefined();
    expect(inc.pkgResources.where).toBeUndefined();
    await svc.listMembers(5, OWNER);
    expect(prisma.accessGroupMember.findMany.mock.calls[0][0].where).toEqual({ groupId: 5 });
  });
});
