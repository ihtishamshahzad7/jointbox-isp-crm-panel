import * as path from 'path';
import { buildMatrix, Route } from './authorization-matrix';

/**
 * "MATHEMATICALLY PROVE TENANT ISOLATION."
 *
 * This is the half of that request a machine can settle on its own, without a
 * database: no route may be STRUCTURALLY incapable of knowing who is calling
 * it, and no route may become reachable without authentication by accident.
 * See `authorization-matrix.ts` for why that is the right property to check
 * and — just as important — what it does not prove.
 *
 * WHAT IT MEASURED ON THE TREE IT WAS WRITTEN AGAINST, recorded so the
 * numbers below are not mistaken for a clean bill of health:
 *
 *   723 routes across 59 controllers.
 *   330 of them never receive the caller's identity.
 *   Of those, 9 are BULK writes and 21 are DELETEs.
 *
 * Verification-phase Priority 2 fixed the parser's blind spot (a parameter
 * type annotation like `@Body() body: { ids: number[] }` used to hide any
 * trailing `@Req()`), so the same tree now reads as:
 *
 *   723 routes, 59 controllers — 474 actor-aware, 249 not.
 *   0 unscoped BULK writes (all nine routes from the original list now pass
 *   the actor, or are fixed in this phase).
 *   19 unscoped DELETEs (two were fixed while passing actors around).
 *
 * None of that proves the actor is USED correctly — the behavioural tenant-
 * isolation suite is the other half. This file stops the numbers GROWING and
 * turns a previously unknown number into one checked on every commit.
 */

const SRC = path.join(__dirname, '..');

/**
 * ROUTES THAT LEGITIMATELY HAVE NO CALLER.
 *
 * Every entry needs a reason, written out. A route earns a place here by
 * being genuinely tenant-free — the same bytes for everyone, or identity
 * carried in the payload itself — not by being inconvenient to fix.
 */
const NO_ACTOR_BY_DESIGN: Record<string, string> = {
  'AppController.health': 'Liveness probe. Constant for every caller.',
  'AppController.live': 'Same.',
  'AppController.ready': 'Same.',
  'PortalController.login': 'The customer portal has its own identity system.',
  'PortalController.register': 'Pre-authentication by definition.',
};

/**
 * THE PUBLIC ATTACK SURFACE.
 *
 * This codebase has no `@Public()` decorator, so "unguarded" and "deliberately
 * public" are indistinguishable in the source — which is exactly how the
 * `/events` SSE stream stayed anonymous for months behind an imported but
 * unapplied guard. Until a decorator exists, this list is the marker: every
 * route on it is public ON PURPOSE, and anything unguarded that is NOT on it
 * fails the test below.
 *
 * Read it as the answer to "what can a stranger with the URL reach?" — and
 * they are the ones an ISP would expect: payment callbacks the gateway itself
 * invokes, the customer portal's own front door, the health probes, and the
 * sandbox.
 *
 * Each still has obligations NOT discharged by being listed here: the gateway
 * webhooks must verify their provider signature, and the portal routes must
 * rate-limit.
 */
const PUBLIC_SURFACE: Record<string, string> = {
  'GET /health': 'Load-balancer probe.',
  'GET /health/live': 'Liveness probe.',
  'GET /health/ready': 'Readiness probe.',
  'GET /demo/public': 'The public sandbox landing data.',
  'POST /demo/create': 'Creates a sandbox account for a visitor. Must stay rate-limited and capped.',
  'GET /portal/packages': 'The price list a prospective customer browses.',
  'POST /portal/login': 'The customer portal front door.',
  'POST /portal/register': 'Customer self-signup.',
  'GET /payment-gateways/portal/active': 'Which payment methods a customer may choose.',
  'GET /payment-gateways/portal/transaction/:reference': 'Payment status by opaque reference.',
  'POST /payment-gateways/portal/checkout': 'Starts a customer payment.',
  'POST /payment-gateways/portal/webhook/:provider': 'Provider-invoked. Signature verified in the handler.',
  'GET /gateway/callback/bkash': 'Provider redirects the customer here.',
  'GET /gateway/callback/easypaisa': 'Provider redirect.',
  'POST /gateway/callback/easypaisa': 'Provider callback.',
  'GET /gateway/callback/jazzcash': 'Provider redirect.',
  'POST /gateway/callback/jazzcash': 'Provider callback.',
  'GET /gateway/callback/paypal': 'Provider redirect.',
  'GET /gateway/callback/paystack': 'Provider redirect.',
  'GET /gateway/callback/razorpay': 'Provider redirect (cancel).',
  'POST /gateway/callback/razorpay': 'Provider callback.',
  'GET /gateway/callback/sslcommerz': 'Provider redirect.',
  'POST /gateway/callback/sslcommerz': 'Provider callback.',
  'GET /gateway/callback/stripe': 'Provider redirect.',
  'POST /gateway/webhook/stripe': 'Provider-invoked. Signature verified in the handler.',
  'POST /gateway/webhook/razorpay': 'Provider-invoked. Signature verified in the handler.',
  'POST /gateway/webhook/paystack': 'Provider-invoked. Signature verified in the handler.',
  'GET /gateway/jazzcash/form/:key': 'Auto-submitting redirect form, keyed by an opaque token.',
  'GET /gateway/razorpay/form/:key': 'Same.',
  'GET /gateway/sandbox/checkout/:key': 'Test-mode checkout page.',
  'POST /gateway/sandbox/confirm/:key': 'Test-mode confirmation.',
};

describe('security: the authorization matrix', () => {
  const matrix = buildMatrix(SRC);
  const key = (r: Route) => `${r.controller}.${r.handler}`;
  const route = (r: Route) => `${r.method} ${r.routePath}`;

  it('the parser actually found the API', () => {
    // A matrix that silently parsed nothing would pass every test below.
    // This is the assertion that keeps the suite honest.
    expect(matrix.length).toBeGreaterThan(600);
    expect(new Set(matrix.map((r) => r.controller)).size).toBeGreaterThan(40);
    expect(matrix.filter((r) => r.actorAware).length).toBeGreaterThan(300);
    expect(matrix.filter((r) => r.handler === '?')).toEqual([]);
  });

  /**
   * THE RATCHET.
   *
   * Frozen at the count measured when this suite was written. A pull request
   * that adds a route with no actor fails here and has to either pass one
   * down or write a reason into NO_ACTOR_BY_DESIGN — which puts a human
   * decision in the diff, where review can see it.
   *
   * When the count goes DOWN, lower this number in the same commit. That is
   * the whole mechanism: it is a high-water mark, not a target.
   */
  const BASELINE = Number(process.env.AUTHZ_BASELINE ?? '325');

  it('no NEW route is structurally unable to identify its caller', () => {
    const offenders = matrix
      .filter((r) => !r.actorAware && !NO_ACTOR_BY_DESIGN[key(r)] && !PUBLIC_SURFACE[route(r)])
      .map((r) => `${route(r)}  (${key(r)})  - ${r.file}`)
      .sort();

    if (offenders.length > BASELINE) {
      throw new Error(
        `Routes with no access to the caller's identity: ${offenders.length} (baseline ${BASELINE}).\n` +
          `A handler that never receives req.user cannot check ownership, so every id it is\n` +
          `given is acted on for whoever asks. Pass the actor down, or add an entry to\n` +
          `NO_ACTOR_BY_DESIGN with the reason it is genuinely tenant-free.\n\n` +
          offenders.join('\n'),
      );
    }
    expect(offenders.length).toBeLessThanOrEqual(BASELINE);
  });

  /**
   * BULK ROUTES GET NO GRACE PERIOD.
   *
   * A single-object route with a missing check leaks one object to an attacker
   * who already knows its id. A bulk route takes an ARRAY of ids and no actor:
   * one call rewrites arbitrary rows across every tenant on the box, and the
   * audit log records it as a legitimate action by the caller. The blast
   * radius is different in kind, so these are listed individually rather than
   * counted — the list is the remediation queue.
   *
   * The queue is EMPTY as of verification-phase Priority 2: all nine routes
   * listed in the first audit now pass the actor into a service that scopes
   * each id (bulkCreate, assignBulk, assignPricingBulk, bulkTransfer,
   * bulkDelete, bulkAction) or were fixed in this phase (bulkServiceSettings,
   * bulkSyncToRadius, queueSyncAll — plus the queueSyncMissing and
   * sync{syncAll,syncMissing}ToRadius siblings the regex cannot name). The
   * exact-match test below is what keeps the queue empty: a new bulk route
   * that forgets its actor fails here.
   *
   * Cross a line off when the route starts taking an actor. Never add one.
   */
  const BULK_OFFENDERS: string[] = [];

  it('the unscoped bulk routes are exactly the known ones, and no more', () => {
    const bulk = matrix
      .filter((r) => /bulk|mass|batch|all$/i.test(r.handler) && !r.actorAware)
      .map((r) => `${route(r)} (${key(r)})`)
      .sort();
    expect(bulk).toEqual([...BULK_OFFENDERS].sort());
  });

  /**
   * DESTRUCTIVE ROUTES, LIKEWISE.
   *
   * DELETE with an id and no actor is the textbook IDOR: decrement the id,
   * delete someone else's row.
   */
  it('the number of unscoped DELETE routes never grows', () => {
    const DELETE_BASELINE = Number(process.env.AUTHZ_DELETE_BASELINE ?? '21');
    const deletes = matrix
      .filter((r) => r.method === 'DELETE' && !r.actorAware && !NO_ACTOR_BY_DESIGN[key(r)])
      .map((r) => `${r.routePath} (${key(r)})`)
      .sort();
    expect(deletes.length).toBeLessThanOrEqual(DELETE_BASELINE);
  });

  /**
   * AUTHENTICATION IS SEPARATE FROM SCOPING, AND ALSO REQUIRED.
   *
   * This is the test that would have caught `/events`. It is absolute, not
   * ratcheted: an unguarded route is either on the reviewed public list or it
   * is a bug, and there is no number of them that is acceptable-for-now.
   */
  it('every unguarded route is on the reviewed public list', () => {
    const naked = matrix
      .filter((r) => r.guards.length === 0 && !PUBLIC_SURFACE[route(r)])
      .map((r) => `${route(r)} (${key(r)}) - ${r.file}`)
      .sort();
    expect(naked).toEqual([]);
  });

  /**
   * And the list must not rot in the other direction: a route that is deleted,
   * renamed or later guarded should be struck off, or the list slowly becomes
   * a place where a genuinely public route can hide.
   */
  it('the public list has no stale entries', () => {
    const live = new Set(matrix.filter((r) => r.guards.length === 0).map(route));
    expect(Object.keys(PUBLIC_SURFACE).filter((k) => !live.has(k))).toEqual([]);
  });
});
