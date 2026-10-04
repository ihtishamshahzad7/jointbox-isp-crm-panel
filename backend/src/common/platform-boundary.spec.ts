import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { lastValueFrom, of } from 'rxjs';
import { buildMatrix } from '../security/authorization-matrix';
import {
  PlatformBoundaryInterceptor, PLATFORM_ROUTES, isPlatformRoute, routeTemplate,
} from './platform-boundary.interceptor';

/**
 * The platform account (SUPER_ADMIN) manages companies — it never sees or
 * creates a subscriber, router, invoice or payment. Ratchet over every route
 * in the codebase.
 */
const ROUTES = buildMatrix().map((r) => ({ ...r, template: r.routePath.replace(/^\/+/, '') }));
const allowed = ROUTES.filter((r) => isPlatformRoute(r.method, r.template));

describe('platform boundary: what the platform account can reach', () => {
  it('no business screen is open to it', () => {
    const business = [
      ['GET', 'subscribers'], ['POST', 'subscribers'], ['GET', 'subscribers/:id'],
      ['GET', 'nas'], ['POST', 'nas'], ['GET', 'packages'], ['POST', 'packages'],
      ['GET', 'invoices'], ['POST', 'payments'], ['GET', 'reports/revenue'],
      ['GET', 'users/stats'], ['GET', 'users/me/business'], ['GET', 'accounting/ledger'],
      ['POST', 'vouchers'], ['GET', 'tickets'], ['GET', 'telemetry/live-traffic'],
      ['POST', 'groups'], ['POST', 'organization/isps'], ['GET', 'logs/activity'],
      ['POST', 'throttle-policies/:id/subscribers'], ['GET', 'pricing/subscriber-discounts'],
    ];
    for (const [m, t] of business) expect([m, t, isPlatformRoute(m, t)]).toEqual([m, t, false]);
  });

  it('every allowed route is a platform route, never a business one', () => {
    const MAINTENANCE = new Set([
      'POST subscribers/repair-links', 'GET subscribers/test-radius-connection',
      'GET nas/debug/radius-sync', 'GET nas/diagnostics/accounting',
      'POST nas/tunnels/reconcile', 'POST nas/tunnels/refresh',
      'POST billing/run/:type', // the nightly jobs, run now — no customer is shown
    ]);
    const BUSINESS_PREFIX = /^(subscribers|nas|invoices|payments|vouchers|reports|telemetry|tickets\/(?!sla)|fiber|monitoring\/(?!diagnostics)|insights|segments|inventory|field-jobs|static-ips|ip-pools|prefixes|areas|outages|boost|billing|compliance|groups|notes|topology|analytics)/;
    const leaks = allowed
      .map((r) => `${r.method} ${r.template}`)
      .filter((k) => BUSINESS_PREFIX.test(k.split(' ')[1]) && !MAINTENANCE.has(k));
    expect(leaks).toEqual([]);
  });

  it('every allow-list entry matches a real route (no stale doors)', () => {
    const dead = PLATFORM_ROUTES.filter(([m, p]) =>
      !ROUTES.some((r) => (m === '*' || m === r.method) && isPlatformRoute(r.method, r.template) &&
        (p.endsWith('/*') ? r.template.startsWith(p.slice(0, -1)) : r.template === p)),
    ).map(([m, p]) => `${m} ${p}`);
    expect(dead).toEqual([]);
  });

  it('the platform account still has its own screens', () => {
    for (const [m, t] of [
      ['GET', 'users/companies'], ['POST', 'users'], ['PATCH', 'users/:id/toggle'],
      ['GET', 'licence/status'], ['POST', 'backup/run'], ['GET', 'console/info'],
      ['GET', 'communication/templates'], ['POST', 'packages/taxes'], ['POST', 'auth/impersonate/:userId'],
      ['GET', 'security/permissions'], ['GET', 'jobs'], ['GET', 'update/check'],
    ]) expect([m, t, isPlatformRoute(m, t)]).toEqual([m, t, true]);
  });
});

describe('PlatformBoundaryInterceptor', () => {
  class FakeCtl { list() {} companies() {} }
  Reflect.defineMetadata(PATH_METADATA, 'subscribers', FakeCtl);
  Reflect.defineMetadata(PATH_METADATA, '/', FakeCtl.prototype.list);
  class UsersCtl { companies() {} }
  Reflect.defineMetadata(PATH_METADATA, 'users', UsersCtl);
  Reflect.defineMetadata(PATH_METADATA, 'companies', UsersCtl.prototype.companies);

  const ctx = (cls: any, handler: any, user: any, method = 'GET') => ({
    getType: () => 'http',
    getClass: () => cls,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ method, user }) }),
  }) as any;
  const next = { handle: () => of('ok') };
  const i = new PlatformBoundaryInterceptor();

  it('refuses the platform account on a business route', () => {
    expect(() => i.intercept(ctx(FakeCtl, FakeCtl.prototype.list, { sub: 1, role: 'SUPER_ADMIN' }), next))
      .toThrow(ForbiddenException);
  });

  it('lets a company through, and the platform account into its own routes', async () => {
    await expect(lastValueFrom(i.intercept(ctx(FakeCtl, FakeCtl.prototype.list, { sub: 10, role: 'ADMIN' }), next))).resolves.toBe('ok');
    await expect(lastValueFrom(i.intercept(ctx(UsersCtl, UsersCtl.prototype.companies, { sub: 1, role: 'SUPER_ADMIN' }), next))).resolves.toBe('ok');
  });

  it('signed in AS a company (support), the platform owner works as that company', async () => {
    const asCompany = { sub: 10, role: 'ADMIN', imp: { by: 1, byRole: 'SUPER_ADMIN' } };
    await expect(lastValueFrom(i.intercept(ctx(FakeCtl, FakeCtl.prototype.list, asCompany), next))).resolves.toBe('ok');
  });

  it('unauthenticated routes are untouched', async () => {
    await expect(lastValueFrom(i.intercept(ctx(FakeCtl, FakeCtl.prototype.list, undefined), next))).resolves.toBe('ok');
  });

  it('builds route templates the way Nest registers them', () => {
    expect(routeTemplate('users', ':id/toggle')).toBe('users/:id/toggle');
    expect(routeTemplate('/', 'health')).toBe('health');
    expect(routeTemplate(['nas'], '/')).toBe('nas');
  });
});
