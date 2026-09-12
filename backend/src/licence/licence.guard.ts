import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { LicenceService, licensingDisabled } from './licence.service';

/**
 * LICENCE ENFORCEMENT
 *
 * Registered globally (see licence.module.ts) and deliberately narrow: it
 * blocks only MUTATING requests, only in a definitely-unlicensed state, and
 * only on routes that are not on the exempt list below.
 *
 * ── WHY SO NARROW ────────────────────────────────────────────────────────
 * FreeRADIUS reads `radcheck`/`radreply`/`radacct` straight from Postgres and
 * never calls this HTTP API, so no guard here can break subscriber
 * authentication. But it CAN break the things that keep those tables correct —
 * profile sync, bulk sync, CoA, disconnect, bandwidth changes. Blocking those
 * does not produce an error the operator sees; it produces a RADIUS estate
 * that silently drifts out of step with the panel, which is worse than an
 * outage because nobody notices for days.
 *
 * So every RADIUS-touching path is exempt, permanently, in every licence
 * state. An expired licence makes the panel read-only. It does not touch the
 * network.
 *
 * ── FAIL OPEN ────────────────────────────────────────────────────────────
 * If the agent is not installed, not running, or unreachable, `state` is
 * UNAVAILABLE and `writable` is true, so nothing is blocked. A licensing
 * system that takes an ISP offline because our own service crashed is worse
 * than one that occasionally lets an unlicensed panel keep writing.
 * PermissionsGuard already fails open the same way.
 */

/**
 * Route prefixes that are NEVER blocked, whatever the licence says.
 * Matched against the path with the leading slash stripped, case-insensitively.
 *
 * Do not prune this list to tidy it up. Each entry is here because blocking it
 * would either desync RADIUS, break an unauthenticated public surface, or lock
 * the operator out of fixing their own licence.
 */
export const LICENCE_EXEMPT_PREFIXES: readonly string[] = [
  // ── RADIUS: session control (CoA / Disconnect, RFC 3576/5176) ──────────
  'network/disconnect',
  'network/duplicate-sessions',
  'network/bandwidth',
  'network/live',
  'network/nas',
  'radius-admin',

  // ── RADIUS: keeping radcheck/radreply in step with the panel ───────────
  // Paths under /subscribers that push to RADIUS. Checked as substrings too
  // (see isExempt) because these sit after a subscriber id.
  'subscribers/sync-all-to-radius',
  'subscribers/sync-missing-to-radius',
  'subscribers/bulk-sync-to-radius',

  // ── Unauthenticated public surfaces ────────────────────────────────────
  'public/hotspot',
  'public/status',
  'portal',
  'gateway',
  'auth',
  'health',

  // ── The operator must always be able to see and fix their licence ──────
  'licence',
  'license',
  'setup',

  // ── Reading is always allowed; these are POSTs that only read ──────────
  'reports',
  'analytics',
  'insights',
];

/**
 * Path FRAGMENTS that exempt a route wherever they appear. These cover the
 * per-subscriber RADIUS actions that sit after an id, e.g.
 * `subscribers/1234/sync-to-radius`.
 */
export const LICENCE_EXEMPT_FRAGMENTS: readonly string[] = [
  // Anything named for RADIUS touches RADIUS. Broad on purpose: the cost of
  // wrongly exempting a route is an unlicensed panel keeping one extra
  // ability; the cost of wrongly blocking one is an ISP's radcheck table
  // drifting out of step with the panel, unnoticed, for days.
  'radius',

  // Live session control (CoA / Disconnect). These appear both under
  // /network and under the API-key integration surface /api/v1, e.g.
  // `api/v1/subscribers/:id/bandwidth` calls CoaService.changeBandwidth.
  'disconnect',
  'bandwidth',
  'throttle',
  'test-coa',

  'sync-profile',
];

/** Methods that never change anything. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * States in which writes are refused. Anything not listed — including
 * UNAVAILABLE and GRACE — is allowed to write.
 */
const BLOCKING_STATES = new Set(['EXPIRED', 'HARDWARE_MISMATCH', 'INVALID', 'TAMPERED']);

export function normalisePath(url: string): string {
  const p = (url || '').split('?')[0];
  return p.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
}

export function isExempt(path: string): boolean {
  const p = normalisePath(path);
  if (p === '') return true;

  for (const prefix of LICENCE_EXEMPT_PREFIXES) {
    if (p === prefix || p.startsWith(prefix + '/')) return true;
  }
  for (const frag of LICENCE_EXEMPT_FRAGMENTS) {
    if (p.includes(frag)) return true;
  }
  return false;
}

@Injectable()
export class LicenceGuard implements CanActivate {
  constructor(private readonly licence: LicenceService) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (licensingDisabled()) return true;

    // Only HTTP. Never interfere with anything else the app might run.
    if (ctx.getType() !== 'http') return true;

    const req = ctx.switchToHttp().getRequest();
    const method = String(req?.method || 'GET').toUpperCase();

    // Reads are always allowed. An unlicensed operator must still be able to
    // see their subscribers, run reports, and work out what to pay.
    if (READ_METHODS.has(method)) return true;

    const path = normalisePath(req?.originalUrl || req?.url || '');
    if (isExempt(path)) return true;

    const state = this.licence.state;
    if (!BLOCKING_STATES.has(state)) return true;

    // 402 Payment Required: unambiguous, and distinct from 401/403 so the
    // frontend can show a licence dialog rather than bouncing to login.
    throw new HttpException(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'LICENCE_REQUIRED',
        state,
        message: this.licence.banner.message || 'This panel is not licensed.',
        detail:
          'The panel is read-only until the licence is renewed. Subscriber ' +
          'authentication, accounting and bandwidth control are unaffected.',
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
