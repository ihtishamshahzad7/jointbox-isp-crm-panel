import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { NasController } from './nas.controller';
import { NasService } from './nas.service';
import { TunnelController } from './tunnel.controller';
import { ScopeService } from '../common/scope.service';

/**
 * NAS TENANCY — the router diagnostics routes and the tunnel maintenance ops.
 *
 *   • GET /nas/:id/{reachability,ping,sync,quick-check,sessions} log into the
 *     router, ping it or read its sessions, using the credentials on the row.
 *     They took no caller, so any company could drive another company's router
 *     by id. They now assertNas() first (404 when out of scope).
 *   • GET /nas/:id/sessions also drops sessions of subscribers the caller does
 *     not own — a shared router carries more than one account's customers.
 *   • GET /nas/debug/radius-sync and /nas/diagnostics/accounting read every
 *     company's routers / accounting: platform owner only.
 *   • POST /nas/tunnels/{reconcile,refresh} rewrite the server's WireGuard
 *     interface for every company: platform owner only.
 */
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const ISP_A = { sub: 10, role: 'ADMIN' }; // owns NAS 100
const ISP_B = { sub: 20, role: 'ADMIN' }; // owns NAS 200
const NAS_OWNER: Record<number, number> = { 100: 10, 200: 20 };

function makeScope() {
  const real = new ScopeService({} as any); // the pure platform-owner checks
  return {
    isAdmin: (r?: string) => r === 'SUPER_ADMIN',
    isPlatformOwner: (a: any) => real.isPlatformOwner(a),
    assertPlatformOwner: (a: any) => real.assertPlatformOwner(a),
    assertNas: jest.fn(async (a: any, id: number) => {
      if (a?.role === 'SUPER_ADMIN') return;
      if (NAS_OWNER[id] !== a?.sub) throw new NotFoundException(`NAS ${id} not found`);
    }),
    subscriberWhere: jest.fn(async (a: any) => ({ userId: { in: [a.sub] } })),
  };
}

describe('NAS tenancy — per-router diagnostics', () => {
  const routes = [
    ['checkReachability', 'checkReachability'],
    ['ping', 'ping'],
    ['syncDetails', 'syncDetails'],
    ['quickCheck', 'quickCheck'],
    ['getActiveSessions', 'getActiveSessions'],
  ] as const;

  function make() {
    const svc: any = Object.fromEntries(routes.map(([, m]) => [m, jest.fn().mockResolvedValue('ok')]));
    svc.debugRadiusSync = jest.fn().mockResolvedValue('dump');
    svc.accountingHealth = jest.fn().mockResolvedValue('health');
    const scope = makeScope();
    return { svc, scope, ctl: new NasController(svc as any, scope as any) };
  }

  it.each(routes)('%s: another company gets NotFound and the router is never touched', async (route, method) => {
    const { svc, ctl } = make();
    await expect((ctl as any)[route]('100', { user: ISP_B })).rejects.toThrow(NotFoundException);
    expect(svc[method]).not.toHaveBeenCalled();
  });

  it.each(routes)('%s: the owning company and the platform owner pass', async (route, method) => {
    const { svc, ctl } = make();
    await expect((ctl as any)[route]('100', { user: ISP_A })).resolves.toBe('ok');
    await expect((ctl as any)[route]('200', { user: OWNER })).resolves.toBe('ok');
    expect(svc[method]).toHaveBeenCalledTimes(2);
  });

  it('sessions hands the caller down so the service can filter by subscriber', async () => {
    const { svc, ctl } = make();
    await ctl.getActiveSessions('100', { user: ISP_A });
    expect(svc.getActiveSessions).toHaveBeenCalledWith(100, ISP_A);
  });

  it('installation diagnostics are the platform owner\'s alone', async () => {
    const { svc, ctl } = make();
    expect(() => ctl.debugRadiusSync({ user: ISP_A })).toThrow(ForbiddenException);
    expect(() => ctl.accountingHealth({ user: ISP_A })).toThrow(ForbiddenException);
    expect(svc.debugRadiusSync).not.toHaveBeenCalled();
    expect(svc.accountingHealth).not.toHaveBeenCalled();
    await expect(ctl.debugRadiusSync({ user: OWNER })).resolves.toBe('dump');
    await expect(ctl.accountingHealth({ user: OWNER })).resolves.toBe('health');
  });
});

describe('NAS tenancy — session list on a shared router', () => {
  const rows = [
    { username: 'mine', nasipaddress: '10.0.0.1' },
    { username: 'theirs', nasipaddress: '10.0.0.1' },
    { username: 'orphan', nasipaddress: '10.0.0.1' },
  ];

  function make() {
    const prisma: any = {
      // No API credentials, so the radacct path is taken (no router call).
      nas: { findUnique: jest.fn().mockResolvedValue({ id: 100, nasIp: '10.0.0.1', apiUsername: null }) },
      subscriber: { findMany: jest.fn().mockResolvedValue([{ username: 'mine' }]) },
    };
    const radiusSync: any = { getActiveSessions: jest.fn().mockResolvedValue(rows) };
    const scope = makeScope();
    const svc = new NasService(prisma, {} as any, radiusSync, scope as any, {} as any, {} as any);
    return { prisma, scope, svc };
  }

  it('a company sees only its own subscribers\' sessions, through a scoped where', async () => {
    const { prisma, scope, svc } = make();
    const out = await svc.getActiveSessions(100, ISP_A);
    expect(out.map((r: any) => r.username)).toEqual(['mine']);
    expect(scope.subscriberWhere).toHaveBeenCalledWith(ISP_A);
    const where = prisma.subscriber.findMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({ userId: { in: [10] } });
    expect(where.AND).toContainEqual({ username: { in: ['mine', 'theirs', 'orphan'] } });
  });

  it('the platform owner and internal callers keep the full list', async () => {
    const { prisma, svc } = make();
    expect(await svc.getActiveSessions(100, OWNER)).toHaveLength(3);
    expect(await svc.getActiveSessions(100)).toHaveLength(3);
    expect(prisma.subscriber.findMany).not.toHaveBeenCalled();
  });
});

describe('NAS tenancy — tunnel maintenance', () => {
  function make() {
    const tunnels: any = {
      reconcile: jest.fn().mockResolvedValue({ applied: 2, failed: 0, errors: [] }),
      refreshStatus: jest.fn().mockResolvedValue({ checked: 2, up: 1 }),
    };
    return { tunnels, ctl: new TunnelController(tunnels, {} as any, makeScope() as any) };
  }

  it('a company admin cannot reconcile or refresh the server\'s WireGuard interface', () => {
    const { tunnels, ctl } = make();
    expect(() => ctl.reconcile({ user: ISP_A })).toThrow(ForbiddenException);
    expect(() => ctl.refresh({ user: ISP_A })).toThrow(ForbiddenException);
    expect(tunnels.reconcile).not.toHaveBeenCalled();
    expect(tunnels.refreshStatus).not.toHaveBeenCalled();
  });

  it('the platform owner can', async () => {
    const { tunnels, ctl } = make();
    await expect(ctl.reconcile({ user: OWNER })).resolves.toMatchObject({ applied: 2 });
    await expect(ctl.refresh({ user: OWNER })).resolves.toMatchObject({ up: 1 });
    expect(tunnels.reconcile).toHaveBeenCalled();
  });
});
