import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SecurityService } from './security.service';
import { SecurityController } from './security.controller';
import { ScopeService } from '../common/scope.service';

/**
 * Tenancy of the security module.
 *
 * RolePermission has no owner column — one permission set per ROLE serves
 * every company on the installation — so changing it is a platform-owner
 * operation. Login sessions belong to users, so listing or killing one is
 * limited to the caller's own subtree.
 *
 * The real ScopeService runs here; only the user tree (descendantIds) and
 * Prisma are stubbed.
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

function makePrisma() {
  return {
    rolePermission: {
      deleteMany: jest.fn().mockReturnValue('del'),
      createMany: jest.fn().mockReturnValue('create'),
      findMany: jest.fn().mockResolvedValue([]),
    },
    userPermission: {
      deleteMany: jest.fn().mockReturnValue('del'),
      createMany: jest.fn().mockReturnValue('create'),
    },
    sessionLog: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ userId: 11 }), // a session of company A's dealer
      update: jest.fn().mockResolvedValue({}),
    },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockResolvedValue([]),
  } as any;
}

function make() {
  const prisma = makePrisma();
  const cache = { del: jest.fn().mockResolvedValue(undefined) } as any;
  const scope = makeScope();
  const svc = new SecurityService(prisma, cache, scope);
  return { prisma, cache, scope, svc, ctl: new SecurityController(svc) };
}

describe('security: role permissions are installation-wide', () => {
  it('refuses a company ADMIN changing a role, and writes nothing', async () => {
    const { prisma, ctl } = make();
    await expect(
      Promise.resolve().then(() => ctl.setRole('reseller', { permissions: ['subscribers.read'] }, { user: COMPANY_A })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a company ADMIN applying a preset', async () => {
    const { prisma, ctl } = make();
    await expect(
      Promise.resolve().then(() => ctl.applyPreset('reseller', { user: COMPANY_B })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('lets the platform owner change a role as before', async () => {
    const { prisma, cache, ctl } = make();
    const out = await ctl.setRole('reseller', { permissions: ['subscribers.read'] }, { user: OWNER });
    expect(out).toEqual({ role: 'RESELLER', permissions: ['subscribers.read'], unrestricted: false });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(cache.del).toHaveBeenCalledWith('rbac:RESELLER');
  });

  it('lets the platform owner apply a preset', async () => {
    const { prisma, ctl } = make();
    await ctl.applyPreset('reseller', { user: OWNER });
    expect(prisma.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { role: 'RESELLER' } });
  });

  it('keeps the catalog readable by any operator', async () => {
    const { ctl } = make();
    expect(ctl.meta({ user: COMPANY_A }).roles).toContain('RESELLER');
    expect(Array.isArray(ctl.permCatalog({ user: COMPANY_A }))).toBe(true);
    await expect(ctl.matrix({ user: COMPANY_A })).resolves.toBeDefined();
  });
});

describe('security: sessions are scoped to the caller\'s subtree', () => {
  it('lists only sessions of the company\'s own accounts', async () => {
    const { prisma, ctl } = make();
    await ctl.sessions({ user: COMPANY_A });
    const where = prisma.sessionLog.findMany.mock.calls[0][0].where;
    expect(where.userId).toEqual({ in: [10, 11] });
    expect(where.isActive).toBe(true);
  });

  it('lists every session for the platform owner', async () => {
    const { prisma, ctl } = make();
    await ctl.sessions({ user: OWNER });
    const where = prisma.sessionLog.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('userId');
  });

  it('answers "not found" when another company kills a session it does not own', async () => {
    const { prisma, ctl } = make();
    await expect(ctl.kill('sess-of-11', { user: COMPANY_B })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.sessionLog.update).not.toHaveBeenCalled();
  });

  it('lets the owning company and the platform owner kill it', async () => {
    const a = make();
    await expect(a.ctl.kill('sess-of-11', { user: COMPANY_A })).resolves.toEqual({ killed: true });
    const o = make();
    await expect(o.ctl.kill('sess-of-11', { user: OWNER })).resolves.toEqual({ killed: true });
    expect(o.prisma.sessionLog.findUnique).not.toHaveBeenCalled(); // owner path unchanged
  });
});

describe('security: delegated child permissions', () => {
  it('refuses an account clearing the denials its parent set on it', async () => {
    const { prisma, svc } = make();
    await expect(svc.setChildPermissions(COMPANY_A, 10, [])).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('still lets a parent set its child\'s permissions', async () => {
    const { prisma, svc } = make();
    await expect(svc.setChildPermissions(COMPANY_A, 11, ['subscribers.delete'])).resolves.toEqual({
      userId: 11,
      denied: ['subscribers.delete'],
    });
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
