import * as fs from 'fs';
import * as path from 'path';
import { HttpException } from '@nestjs/common';
import {
  LicenceGuard,
  isExempt,
  normalisePath,
  LICENCE_EXEMPT_PREFIXES,
  LICENCE_EXEMPT_FRAGMENTS,
} from './licence.guard';
import type { LicenceService, LicenceState } from './licence.service';

/**
 * WHAT THESE TESTS ARE PROTECTING
 *
 * A licensing bug that blocks a RADIUS sync endpoint does not look like an
 * outage. It looks like nothing at all, until a week later when an ISP's
 * radcheck table has silently drifted out of step with the panel and nobody
 * can explain why a customer who was upgraded is still on the old speed.
 *
 * So the tests below are not "does the guard work" — they are "can the guard
 * ever touch the network", and the answer has to stay no.
 */

function ctxFor(method: string, url: string): any {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method, url, originalUrl: url }) }),
  };
}

function guardIn(state: LicenceState): LicenceGuard {
  const svc = {
    state,
    banner: { level: 'error', message: 'not licensed' },
  } as unknown as LicenceService;
  return new LicenceGuard(svc);
}

const ALL_STATES: LicenceState[] = [
  'ACTIVE',
  'GRACE',
  'EXPIRED',
  'HARDWARE_MISMATCH',
  'INVALID',
  'UNLICENSED',
  'TAMPERED',
  'UNAVAILABLE',
];

const BLOCKED_STATES: LicenceState[] = ['EXPIRED', 'HARDWARE_MISMATCH', 'INVALID', 'TAMPERED'];
const ALLOWED_STATES: LicenceState[] = ['ACTIVE', 'GRACE', 'UNLICENSED', 'UNAVAILABLE'];

beforeEach(() => {
  delete process.env.JBX_LICENCE_ENFORCE;
});

// ───────────────────────────────────────────────────────────────────────────
// The network must never be touched
// ───────────────────────────────────────────────────────────────────────────

describe('RADIUS and network paths are never blocked', () => {
  /**
   * Taken from the real controllers. If one of these ever starts throwing,
   * an ISP's RADIUS estate silently stops tracking the panel.
   */
  const RADIUS_ROUTES: Array<[string, string]> = [
    // CoA / Disconnect — network.controller.ts
    ['POST', '/network/disconnect/ali%40isp'],
    ['POST', '/network/disconnect/all'],
    ['POST', '/network/duplicate-sessions/sweep'],
    ['POST', '/network/bandwidth/1234'],
    ['GET', '/network/nas/7/test-coa'],
    ['GET', '/network/live'],
    ['GET', '/network/live/stats'],

    // Subscriber → RADIUS sync — subscribers.controller.ts
    ['POST', '/subscribers/1234/sync-profile'],
    ['POST', '/subscribers/sync-all-to-radius/queue'],
    ['POST', '/subscribers/sync-missing-to-radius/queue'],
    ['POST', '/subscribers/1234/sync-to-radius'],
    ['POST', '/subscribers/bulk-sync-to-radius'],
    ['POST', '/subscribers/1234/fix-radius-password'],

    // FreeRADIUS process and config control — radius-admin.controller.ts
    ['POST', '/radius-admin/control'],
    ['POST', '/radius-admin/module/toggle'],
    ['POST', '/radius-admin/file'],
  ];

  it.each(RADIUS_ROUTES)('%s %s is exempt', (_method, url) => {
    expect(isExempt(url)).toBe(true);
  });

  it.each(ALL_STATES)('every RADIUS route passes in state %s', (state) => {
    const guard = guardIn(state);
    for (const [method, url] of RADIUS_ROUTES) {
      expect(() => guard.canActivate(ctxFor(method, url))).not.toThrow();
    }
  });
});

describe('unauthenticated public surfaces are never blocked', () => {
  const PUBLIC_ROUTES: Array<[string, string]> = [
    ['POST', '/public/hotspot/redeem'],
    ['POST', '/public/hotspot/login'],
    ['GET', '/public/status'],
    ['POST', '/portal/login'],
    ['POST', '/portal/pay'],
    ['POST', '/gateway/callback/easypaisa'],
    ['POST', '/gateway/webhook/stripe'],
    ['POST', '/auth/login'],
    ['POST', '/auth/refresh'],
    ['GET', '/health/live'],
    ['GET', '/health/ready'],
  ];

  it.each(ALL_STATES)('every public route passes in state %s', (state) => {
    const guard = guardIn(state);
    for (const [method, url] of PUBLIC_ROUTES) {
      expect(() => guard.canActivate(ctxFor(method, url))).not.toThrow();
    }
  });
});

describe('the operator can always fix their own licence', () => {
  it.each(ALL_STATES)('licence and setup routes pass in state %s', (state) => {
    const guard = guardIn(state);
    for (const url of ['/licence/status', '/licence/refresh', '/setup/wizard']) {
      expect(() => guard.canActivate(ctxFor('POST', url))).not.toThrow();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The ratchet: catch RADIUS routes added in future
// ───────────────────────────────────────────────────────────────────────────

describe('future RADIUS routes cannot slip past the exempt list', () => {
  /**
   * Scans the real controllers for route decorators whose path looks like it
   * touches RADIUS, and asserts each one is exempt.
   *
   * This is the test that matters in six months, when somebody adds
   * `@Post(':id/resync-radius')` and has never read licence.guard.ts. Without
   * it, that endpoint quietly starts returning 402 on expired installs and the
   * symptom appears somewhere else entirely.
   */
  const SRC = path.join(__dirname, '..');

  const controllerFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.controller.ts')) out.push(p);
      }
    };
    walk(SRC);
    return out;
  };

  /** Suspicious if the route path mentions any of these. */
  const NETWORK_WORDS = /(radius|radacct|radcheck|coa|disconnect|bandwidth|live-session)/i;

  it('every route whose path mentions RADIUS is exempt', () => {
    const offenders: string[] = [];

    for (const file of controllerFiles()) {
      const src = fs.readFileSync(file, 'utf8');

      // The controller's base path, e.g. @Controller('subscribers')
      const base = /@Controller\(\s*['"`]([^'"`]*)['"`]/.exec(src)?.[1] ?? '';

      // Every method route: @Post('x'), @Get('a/b'), @Patch(), ...
      const re = /@(Get|Post|Put|Patch|Delete)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const method = m[1].toUpperCase();
        const sub = m[2] ?? '';
        if (method === 'GET') continue; // reads always pass

        const full = [base, sub].filter(Boolean).join('/');
        if (!NETWORK_WORDS.test(full)) continue;

        // Replace :params with a plausible value, as a real request would.
        const concrete = full.replace(/:[A-Za-z0-9_]+/g, '1234');
        if (!isExempt(concrete)) {
          offenders.push(`${method} /${concrete}   (${path.relative(SRC, file)})`);
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        'These RADIUS-touching routes are NOT on the licence guard exempt list.\n' +
          'Blocking them would silently desync an ISP\'s RADIUS tables.\n' +
          'Add a prefix or fragment to licence.guard.ts:\n\n  ' +
          offenders.join('\n  ') +
          '\n',
      );
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Normal enforcement
// ───────────────────────────────────────────────────────────────────────────

describe('reads are always allowed', () => {
  const READS = ['/subscribers', '/invoices', '/payments/123', '/reports/revenue', '/nas'];

  it.each(ALL_STATES)('GET passes in state %s', (state) => {
    const guard = guardIn(state);
    for (const url of READS) {
      expect(() => guard.canActivate(ctxFor('GET', url))).not.toThrow();
      expect(() => guard.canActivate(ctxFor('HEAD', url))).not.toThrow();
    }
  });

  it('an unlicensed operator can still see their data to work out what to pay', () => {
    const guard = guardIn('EXPIRED');
    expect(guard.canActivate(ctxFor('GET', '/subscribers'))).toBe(true);
    expect(guard.canActivate(ctxFor('GET', '/invoices'))).toBe(true);
  });
});

describe('writes are blocked only in a definitely-unlicensed state', () => {
  const WRITES: Array<[string, string]> = [
    ['POST', '/subscribers'],
    ['PATCH', '/subscribers/1234'],
    ['DELETE', '/subscribers/1234'],
    ['POST', '/invoices'],
    ['POST', '/packages'],
    ['PUT', '/areas/1'],
  ];

  it.each(BLOCKED_STATES)('state %s blocks writes', (state) => {
    const guard = guardIn(state);
    for (const [method, url] of WRITES) {
      expect(() => guard.canActivate(ctxFor(method, url))).toThrow(HttpException);
    }
  });

  it.each(ALLOWED_STATES)('state %s allows writes', (state) => {
    const guard = guardIn(state);
    for (const [method, url] of WRITES) {
      expect(() => guard.canActivate(ctxFor(method, url))).not.toThrow();
    }
  });

  it('GRACE does not punish a customer waiting on a renewal', () => {
    const guard = guardIn('GRACE');
    expect(guard.canActivate(ctxFor('POST', '/subscribers'))).toBe(true);
  });

  it('an unreachable agent FAILS OPEN', () => {
    // If our own agent crashes or was never installed, the ISP keeps working.
    // A licensing system that takes a customer down because of our bug is
    // worse than one that lets an unlicensed panel keep writing.
    const guard = guardIn('UNAVAILABLE');
    expect(guard.canActivate(ctxFor('POST', '/subscribers'))).toBe(true);
    expect(guard.canActivate(ctxFor('DELETE', '/subscribers/1'))).toBe(true);
  });
});

describe('the refusal is actionable', () => {
  it('uses 402 so the frontend can tell it apart from auth failures', () => {
    const guard = guardIn('EXPIRED');
    try {
      guard.canActivate(ctxFor('POST', '/subscribers'));
      throw new Error('expected a refusal');
    } catch (e) {
      const err = e as HttpException;
      expect(err.getStatus()).toBe(402);
      const body = err.getResponse() as any;
      expect(body.error).toBe('LICENCE_REQUIRED');
      expect(body.state).toBe('EXPIRED');
      // The operator must be told their subscribers are fine.
      expect(String(body.detail).toLowerCase()).toContain('authentication');
    }
  });
});

describe('the kill switch', () => {
  it('JBX_LICENCE_ENFORCE=false disables everything', () => {
    process.env.JBX_LICENCE_ENFORCE = 'false';
    const guard = guardIn('EXPIRED');
    expect(guard.canActivate(ctxFor('POST', '/subscribers'))).toBe(true);
    expect(guard.canActivate(ctxFor('DELETE', '/anything'))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Path handling
// ───────────────────────────────────────────────────────────────────────────

describe('path normalisation', () => {
  it('strips query strings, slashes and case', () => {
    expect(normalisePath('/Subscribers/?page=2')).toBe('subscribers');
    expect(normalisePath('///network/live///')).toBe('network/live');
    expect(normalisePath('')).toBe('');
  });

  it('a prefix matches only on a path boundary', () => {
    // 'auth' must not exempt 'authorisation-rules'
    expect(isExempt('auth')).toBe(true);
    expect(isExempt('auth/login')).toBe(true);
    expect(isExempt('authorisation-rules')).toBe(false);
    // 'portal' must not exempt 'portals-admin'
    expect(isExempt('portal/pay')).toBe(true);
    expect(isExempt('portals-admin/create')).toBe(false);
  });

  it('ordinary panel routes are not exempt', () => {
    for (const p of ['subscribers', 'invoices', 'packages', 'users', 'tickets']) {
      expect(isExempt(p)).toBe(false);
    }
  });

  it('the exempt lists have no empty entries', () => {
    // An empty string would exempt literally everything.
    for (const e of [...LICENCE_EXEMPT_PREFIXES, ...LICENCE_EXEMPT_FRAGMENTS]) {
      expect(e.length).toBeGreaterThan(0);
      expect(e).toBe(e.toLowerCase());
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The integration API must not be a way round the licence
// ───────────────────────────────────────────────────────────────────────────

describe('the public API is not a licensing bypass', () => {
  /**
   * /api/v1 is API-key authenticated machine traffic. Its CoA routes are
   * exempt because they drive the network — but its ordinary write routes
   * create the same records the panel does, so they must be blocked on the
   * same terms. Otherwise "use the API instead" is the documented workaround
   * for an expired licence.
   */
  const MUST_BLOCK: Array<[string, string]> = [
    ['POST', '/api/v1/subscribers'],
    ['PUT', '/api/v1/subscribers/1234'],
    ['DELETE', '/api/v1/subscribers/1234'],
    ['POST', '/api/v1/invoices'],
    ['POST', '/api/v1/invoices/1/payment'],
    ['POST', '/api/v1/billing/run/monthly'],
  ];

  it.each(MUST_BLOCK)('%s %s is blocked when expired', (method, url) => {
    expect(isExempt(url)).toBe(false);
    const guard = guardIn('EXPIRED');
    expect(() => guard.canActivate(ctxFor(method, url))).toThrow(HttpException);
  });

  const MUST_PASS: Array<[string, string]> = [
    ['POST', '/api/v1/subscribers/1234/disconnect'],
    ['POST', '/api/v1/subscribers/1234/bandwidth'],
    ['POST', '/api/v1/subscribers/1234/throttle'],
    ['DELETE', '/api/v1/subscribers/1234/throttle'],
  ];

  it.each(MUST_PASS)('%s %s still drives the network when expired', (method, url) => {
    const guard = guardIn('EXPIRED');
    expect(() => guard.canActivate(ctxFor(method, url))).not.toThrow();
  });
});

describe('the RADIUS fragment does not over-exempt', () => {
  it('ordinary writes containing no network word are still blocked', () => {
    const guard = guardIn('EXPIRED');
    for (const url of [
      '/subscribers',
      '/subscribers/1234',
      '/invoices',
      '/packages',
      '/users',
      '/tickets/1/reply',
      '/vouchers/batch',
    ]) {
      expect(() => guard.canActivate(ctxFor('POST', url))).toThrow(HttpException);
    }
  });
});
