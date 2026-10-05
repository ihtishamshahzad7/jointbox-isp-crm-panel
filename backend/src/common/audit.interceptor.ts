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
/**
 * What of a request body may go into the audit log. Only top-level keys named
 * like secrets were removed, so bodies shaped { key: 'WHATSAPP_TOKEN', value:
 * '…' } or { kind, value, extra } (alert channels, settings) were stored in
 * plain text — readable by anyone who can read the log. Nested objects are
 * walked, and setting-shaped values are masked.
 */
const SECRET_KEY = /pass|secret|token|pin\b|otp|code|key|value|extra|webhook|credential|community|apikey|salt|private|auth/i;
export function redactForAudit(body: any, depth = 0): any {
  if (body == null || typeof body !== 'object') return body;
  if (depth > 3) return '[…]';
  if (Array.isArray(body)) return body.slice(0, 20).map((v) => redactForAudit(v, depth + 1));
  const out: any = {};
  for (const [k, v] of Object.entries(body)) {
    if (SECRET_KEY.test(k)) { out[k] = '[redacted]'; continue; }
    if (typeof v === 'string' && /^(https?:\/\/[^\s]*@|[A-Za-z0-9_\-]{32,}$)/.test(v)) { out[k] = '[redacted]'; continue; }
    out[k] = typeof v === 'object' ? redactForAudit(v, depth + 1) : v;
  }
  return out;
}

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
    // req.ip honours `trust proxy`; the left-most X-Forwarded-For entry is
    // whatever the client chose to write.
    const ip = String(req.ip || req.socket?.remoteAddress || '') || null;
    const userAgent = req.headers['user-agent'] || null;

    // short, safe detail from body (no passwords/secrets)
    let detail: string | undefined;
    try {
      if (req.body && typeof req.body === 'object') {
        detail = JSON.stringify(redactForAudit(req.body)).slice(0, 300);
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
