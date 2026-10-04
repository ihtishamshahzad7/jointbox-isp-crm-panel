import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Observable } from 'rxjs';

/**
 * THE PLATFORM ACCOUNT DOES NOT RUN A BUSINESS.
 *
 *   SUPER_ADMIN  — the platform: companies, licence, server, backups, defaults
 *   ADMIN        — an ISP company: subscribers, routers, packages, billing …
 *
 * A SUPER_ADMIN reaches only the routes listed below. Everything else — every
 * subscriber, router, invoice, payment, report — answers 403, so the platform
 * account can neither see a company's customers nor create any of its own.
 * To help a client, the platform owner signs in AS the company (Companies →
 * Sign in); that token carries the company's role and passes normally.
 *
 * An allow-list on purpose: a business module added later is closed to the
 * platform account by default instead of open by accident.
 * Ratchet: platform-boundary.spec.ts.
 */
export const PLATFORM_ROUTES: ReadonlyArray<readonly [string, string]> = [
  // ── signing in, own account, the panel itself ──
  ['*', 'auth/*'],
  ['GET', 'health'],
  ['GET', 'health/*'],
  ['GET', 'system/*'],
  ['GET', 'profile'],
  ['*', 'update/*'],
  ['GET', 'events'],
  ['GET', 'events/status'],
  ['*', 'ai/*'],
  ['GET', 'users/me/profile'],
  ['PATCH', 'users/me/profile'],
  ['POST', 'uploads'],
  ['GET', 'uploads/media-token'],
  ['GET', 'communication/feed'],
  ['GET', 'communication/latest'],
  ['GET', 'organization/currency'],

  // ── companies (the service narrows every one of these to company accounts) ──
  ['GET', 'users'],
  ['GET', 'users/companies'],
  ['POST', 'users'],
  ['GET', 'users/:id'],
  ['PUT', 'users/:id'],
  ['PATCH', 'users/:id/toggle'],
  ['DELETE', 'users/:id'],
  ['POST', 'users/:id/purge'],

  // ── the installation ──
  ['*', 'licence/*'],
  ['*', 'backup/*'],
  ['*', 'console/*'],
  ['*', 'radius-admin/*'],
  ['*', 'jobs'],
  ['*', 'jobs/*'],
  ['*', 'security/*'],
  // gateway credentials, not the payments taken through them
  ['*', 'payment-gateways/admin'],
  ['*', 'payment-gateways/admin/:id'],
  ['PATCH', 'payment-gateways/admin/:id/toggle'],
  ['GET', 'communication/status'],
  ['*', 'communication/alerts/*'],
  ['*', 'accounting/period-lock'],
  // the nightly billing jobs, run now for the whole installation
  ['POST', 'billing/run/:type'],
  ['PUT', 'organization/isps/:id/currency'],

  // ── defaults every company starts from (companies add their own) ──
  ['*', 'communication/templates'],
  ['*', 'communication/templates/:id'],
  ['*', 'packages/taxes'],
  ['*', 'packages/taxes/:id'],
  ['*', 'packages/policies'],
  ['*', 'packages/policies/:id'],
  ['*', 'packages/allocations'],
  ['*', 'packages/allocations/:id'],
  ['*', 'pricing/fees'],
  ['*', 'pricing/fees/options'],
  ['*', 'pricing/fees/:id'],
  ['*', 'throttle-policies'],
  ['*', 'throttle-policies/options'],
  ['*', 'throttle-policies/:id'],

  // ── server maintenance (acts on the installation, shows no customer) ──
  ['POST', 'subscribers/repair-links'],
  ['GET', 'subscribers/test-radius-connection'],
  ['GET', 'nas/debug/radius-sync'],
  ['GET', 'nas/diagnostics/accounting'],
  ['POST', 'nas/tunnels/reconcile'],
  ['POST', 'nas/tunnels/refresh'],
  ['POST', 'network/duplicate-sessions/sweep'],
  ['POST', 'tickets/sla/backfill'],
  ['POST', 'monitoring/diagnostics/*'],
  ['GET', 'logs/system'],
  ['GET', 'logs/radius/diagnostics'],
  ['POST', 'logs/radius/close-stale'],
];

const norm = (p: unknown): string => {
  const s = Array.isArray(p) ? String(p[0] ?? '') : String(p ?? '');
  return s.replace(/^\/+|\/+$/g, '');
};

/** 'users/:id/toggle' — the route TEMPLATE, never the concrete URL. */
export function routeTemplate(
  classPath: unknown,
  handlerPath: unknown,
): string {
  return [norm(classPath), norm(handlerPath)].filter(Boolean).join('/');
}

export function isPlatformRoute(method: string, template: string): boolean {
  const m = String(method || '').toUpperCase();
  const t = norm(template);
  return PLATFORM_ROUTES.some(([pm, pattern]) => {
    if (pm !== '*' && pm !== m) return false;
    if (pattern.endsWith('/*'))
      return (
        t.startsWith(pattern.slice(0, -1)) && t.length > pattern.length - 1
      );
    return t === pattern;
  });
}

export const PLATFORM_ACCOUNT_MESSAGE =
  'This is company business. The platform account manages companies only — open the company ' +
  '(Companies → Sign in) to work on its subscribers, routers and billing.';

@Injectable()
export class PlatformBoundaryInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    if (ctx.getType() !== 'http') return next.handle();
    const req: any = ctx.switchToHttp().getRequest();
    if (req?.user?.role !== 'SUPER_ADMIN') return next.handle();
    const template = routeTemplate(
      Reflect.getMetadata(PATH_METADATA, ctx.getClass()),
      Reflect.getMetadata(PATH_METADATA, ctx.getHandler()),
    );
    if (!isPlatformRoute(req.method, template)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PLATFORM_ACCOUNT',
        message: PLATFORM_ACCOUNT_MESSAGE,
      });
    }
    return next.handle();
  }
}
