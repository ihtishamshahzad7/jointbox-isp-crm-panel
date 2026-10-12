import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { PermissionsGuard } from '../security/permissions.guard';
import { AuditInterceptor } from './audit.interceptor';
import { assertCompanyCanAdd, invalidateCompanyPlan } from './company-plan';

/**
 * Controls that keep each account inside what it was given:
 *   • a block set on an account binds everyone under it;
 *   • a switched-in session cannot leave a way back in behind it;
 *   • the audit log names the record a change touched, and exports;
 *   • a company stays inside the caps the platform set for it.
 */

function ctx(req: any) {
  return { switchToHttp: () => ({ getRequest: () => req }), getType: () => 'http' } as unknown as ExecutionContext;
}

describe('blocks are inherited down the tree', () => {
  function guardWith(deniedOn: Record<number, string[]>) {
    const prisma: any = {
      // dealer 12 → franchise 11 → company 10 (platform excluded by the query)
      $queryRaw: jest.fn().mockResolvedValue([{ id: 12 }, { id: 11 }, { id: 10 }]),
      userPermission: {
        findMany: jest.fn(async ({ where }: any) =>
          (where.userId.in as number[]).flatMap((id) => (deniedOn[id] || []).map((permission) => ({ permission })))),
      },
      rolePermission: { findMany: jest.fn().mockResolvedValue([{ permission: '*' }]) },
    };
    const cache: any = { wrap: jest.fn(async (_k: string, _t: number, f: () => any) => f()) };
    return { guard: new PermissionsGuard(prisma, cache), prisma };
  }

  it('a block the company set on a franchise stops the franchise\'s dealer too', async () => {
    const { guard } = guardWith({ 11: ['subscribers.export'] });
    const req = { user: { sub: 12, role: 'SUB_RESELLER' }, method: 'GET', url: '/subscribers/export' };
    await expect(guard.canActivate(ctx(req))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a block the platform set on a company switches the feature off company-wide', async () => {
    const { guard } = guardWith({ 10: ['subscribers.import'] });
    const req = { user: { sub: 12, role: 'SUB_RESELLER' }, method: 'POST', url: '/subscribers/import' };
    await expect(guard.canActivate(ctx(req))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('with nothing blocked above, the action goes through', async () => {
    const { guard } = guardWith({});
    const req = { user: { sub: 12, role: 'SUB_RESELLER' }, method: 'GET', url: '/subscribers/export' };
    await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
  });
});

describe('a switched-in session leaves no way back in', () => {
  const refuse = (req: any) => () => PermissionsGuard.refuseLastingAccessWhileActingAs(req);
  const platformImp = { sub: 10, role: 'ADMIN', imp: { by: 1, byRole: 'SUPER_ADMIN' } };
  const parentImp = { sub: 11, role: 'RESELLER', imp: { by: 10, byRole: 'ADMIN' } };

  it('refuses API keys, passwords and wipes', () => {
    expect(refuse({ user: parentImp, method: 'POST', url: '/integrations/api-keys' })).toThrow(ForbiddenException);
    expect(refuse({ user: parentImp, method: 'PUT', url: '/users/12', body: { password: 'New#Pass123' } })).toThrow(ForbiddenException);
    expect(refuse({ user: parentImp, method: 'POST', url: '/users/12/purge' })).toThrow(ForbiddenException);
  });

  it('the platform cannot create logins inside a company; a parent acting as a franchise can add its dealer', () => {
    expect(refuse({ user: platformImp, method: 'POST', url: '/users', body: {} })).toThrow(ForbiddenException);
    expect(refuse({ user: parentImp, method: 'POST', url: '/users', body: {} })).not.toThrow();
  });

  it('ordinary work and edits without a password pass', () => {
    expect(refuse({ user: platformImp, method: 'PUT', url: '/users/12', body: { name: 'x' } })).not.toThrow();
    expect(refuse({ user: platformImp, method: 'POST', url: '/subscribers', body: {} })).not.toThrow();
  });
});

describe('the audit log names the record and records exports', () => {
  function run(req: any) {
    const create = jest.fn().mockResolvedValue({});
    const i = new AuditInterceptor({ activityLog: { create } } as any);
    return lastValueFrom(i.intercept(ctx(req), { handle: () => of('ok') } as any)).then(() => {
      return new Promise((r) => setImmediate(r)).then(() => create.mock.calls.map((c) => c[0].data));
    });
  }

  it('a delete carries the id of what was deleted', async () => {
    const rows: any = await run({
      method: 'DELETE', originalUrl: '/subscribers/42', route: { path: '/subscribers/:id' },
      params: { id: '42' }, user: { sub: 10 }, headers: {},
    });
    expect(rows[0]).toMatchObject({ userId: 10, entity: 'subscribers', entityId: 42 });
  });

  it('a customer-list download is logged as an EXPORT with its filters', async () => {
    const rows: any = await run({
      method: 'GET', originalUrl: '/subscribers/export?status=ACTIVE', route: { path: '/subscribers/export' },
      query: { status: 'ACTIVE' }, params: {}, user: { sub: 11 }, headers: {},
    });
    expect(rows[0]).toMatchObject({ userId: 11, action: 'EXPORT', entity: 'subscribers' });
    expect(rows[0].details).toContain('ACTIVE');
  });

  it('ordinary reads are still not logged', async () => {
    const rows: any = await run({ method: 'GET', originalUrl: '/subscribers?page=2', route: { path: '/subscribers' }, params: {}, user: { sub: 11 }, headers: {} });
    expect(rows).toEqual([]);
  });
});

describe('a company stays inside its plan', () => {
  const scope: any = { actorId: (a: any) => a.sub, companyRootId: jest.fn().mockResolvedValue(10) };
  function prismaWith(plan: any, used: { subscribers: number; nas: number; accounts: number }) {
    return {
      companyPlan: { findUnique: jest.fn().mockResolvedValue(plan) },
      $queryRaw: jest.fn().mockResolvedValue([used]),
    };
  }
  beforeEach(() => invalidateCompanyPlan());

  it('refuses the subscriber that would go past the cap, with a clear reason', async () => {
    const prisma = prismaWith({ companyId: 10, maxSubscribers: 2, maxNas: null, maxAccounts: null }, { subscribers: 2, nas: 0, accounts: 0 });
    await expect(assertCompanyCanAdd(prisma, scope, { sub: 11, role: 'RESELLER' } as any, 'subscribers'))
      .rejects.toMatchObject({ response: { code: 'COMPANY_LIMIT' } });
  });

  it('allows up to the cap, and an import that fits', async () => {
    const prisma = prismaWith({ companyId: 10, maxSubscribers: 5, maxNas: 1, maxAccounts: null }, { subscribers: 2, nas: 0, accounts: 9 });
    await expect(assertCompanyCanAdd(prisma, scope, { sub: 11 } as any, 'subscribers', 3)).resolves.toBeUndefined();
    invalidateCompanyPlan();
    await expect(assertCompanyCanAdd(prisma, scope, { sub: 11 } as any, 'subscribers', 4)).rejects.toBeInstanceOf(ForbiddenException);
    invalidateCompanyPlan();
    await expect(assertCompanyCanAdd(prisma, scope, { sub: 11 } as any, 'accounts')).resolves.toBeUndefined(); // no cap set
  });

  it('a company with no plan, and the platform account, are never limited', async () => {
    const none = prismaWith(null, { subscribers: 1e6, nas: 1e6, accounts: 1e6 });
    await expect(assertCompanyCanAdd(none, scope, { sub: 11 } as any, 'nas')).resolves.toBeUndefined();
    const platformScope: any = { actorId: () => 1, companyRootId: jest.fn().mockResolvedValue(null) };
    const capped = prismaWith({ companyId: 10, maxSubscribers: 0 }, { subscribers: 5, nas: 0, accounts: 0 });
    await expect(assertCompanyCanAdd(capped, platformScope, { sub: 1, role: 'SUPER_ADMIN' } as any, 'subscribers')).resolves.toBeUndefined();
  });
});
