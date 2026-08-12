import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { PrismaService } from '../prisma/prisma.service';
import { permissionForRoute } from '../security/route-permissions';

/**
 * Global audit trail (Phase 0 "unified audit" — now automatic).
 * Writes an ActivityLog row for every mutating request (POST/PUT/PATCH/DELETE)
 * with the acting user, action, entity (first URL segment), entity id, IP and
 * a short detail. Zero per-controller code — every module is covered.
 *
 * Skipped: GET requests, auth login/verify (login logs handle those), and the
 * logs endpoints themselves (so reading logs doesn't spam logs).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private prisma: PrismaService) {}

  private readonly skipPrefixes = ['auth', 'logs', 'insights', 'gateway/callback', 'gateway/sandbox', 'portal/login'];

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const method: string = req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next.handle();

    const path: string = (req.route?.path || req.url || '').split('?')[0].replace(/^\/+/, '');
    if (this.skipPrefixes.some((p) => path.startsWith(p))) return next.handle();

    const segments = path.split('/').filter(Boolean);
    const entity = segments[0] || 'unknown';
    // id = first numeric path segment, if any
    const idSeg = segments.find((s) => /^\d+$/.test(s));
    const entityId = idSeg ? Number(idSeg) : undefined;
    // Name the SPECIFIC critical action when we know it (subscribers.disconnect,
    // users.topup, users.transferSubscribers…), so the audit trail reads as the
    // exact click a permission controls — not just a generic CREATE/UPDATE.
    const granular = permissionForRoute(method, '/' + path);
    const action = granular
      ? granular.toUpperCase()
      : ({ POST: 'CREATE', PUT: 'UPDATE', PATCH: 'UPDATE', DELETE: 'DELETE' }[method] || method);
    const userId = req.user?.sub ?? req.user?.id;
    // Record impersonation: when someone is "acting as" a child, the audit must
    // show who really did it, not just the account it was done under.
    const imp = req.user?.imp;
    const traceId = req.traceId || null;
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0] || null;
    const userAgent = req.headers['user-agent'] || null;

    // short, safe detail from body (no passwords/secrets)
    let detail: string | undefined;
    try {
      if (req.body && typeof req.body === 'object') {
        const clone: any = { ...req.body };
        for (const k of Object.keys(clone)) {
          if (/pass|secret|token|pin|otp|code/i.test(k)) delete clone[k];
        }
        detail = JSON.stringify(clone).slice(0, 300);
      }
    } catch {
      /* ignore */
    }
    // Prefix the detail with who really acted (impersonation) and the exact
    // permission the click needed, so the log line is self-explanatory.
    const prefix =
      (imp ? `[acting as, by ${imp.byName || imp.by} (${imp.byRole || '?'})] ` : '') +
      (granular ? `perm=${granular} ` : '') +
      `${method} /${path}`;
    detail = detail ? `${prefix} · ${detail}` : prefix;

    return next.handle().pipe(
      tap({
        next: () => this.write(userId, action, entity, entityId, detail, traceId, ip, userAgent),
        // still record failed mutations (useful for security review)
        error: () => this.write(userId, `${action}_FAILED`, entity, entityId, detail, traceId, ip, userAgent),
      }),
    );
  }

  private write(
    userId: number | undefined,
    action: string,
    entity: string,
    entityId: number | undefined,
    details: string | undefined,
    traceId: string | null,
    ipAddress: string | null,
    userAgent: string | null,
  ) {
    // fire-and-forget; never block or fail the request because of logging
    this.prisma.activityLog
      .create({ data: { userId, action, entity, entityId, details, traceId, ipAddress, userAgent } })
      .catch(() => undefined);
  }
}
