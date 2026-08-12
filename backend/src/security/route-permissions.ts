/**
 * Route → granular-permission map.
 *
 * The PermissionsGuard checks a per-user DENY list, but only ever computed the
 * COARSE key ("subscribers.write"). So a parent who unticked a specific action
 * ("subscribers.massDelete", "users.manageBalance") had it saved and ignored —
 * the guard was checking the wrong key. This table maps the actual endpoints to
 * the catalog's granular keys, so the guard enforces exactly what was granted.
 *
 * Match order: first entry whose method matches and whose regex matches the
 * path wins. Keep the specific routes (bulk-delete) ABOVE the generic ones
 * (:id) so the specific key is chosen.
 *
 * Only WRITE-ish routes need entries; reads are covered by the coarse
 * "<resource>.read" the guard already computes. An unmapped write falls back to
 * the coarse "<resource>.write" as before, so nothing is left unguarded — this
 * only ADDS granularity.
 */

export interface RoutePerm {
  method: string;         // POST | PUT | PATCH | DELETE
  test: RegExp;           // matches the pathname (no query, leading slash)
  key: string;            // catalog permission key
}

export const ROUTE_PERMISSIONS: RoutePerm[] = [
  // ── Subscribers ──────────────────────────────────────────────────────────
  { method: 'DELETE', test: /^\/subscribers\/bulk-delete\b/,           key: 'subscribers.massDelete' },
  { method: 'PATCH',  test: /^\/subscribers\/bulk-service-settings\b/, key: 'subscribers.massSettings' },
  { method: 'POST',   test: /^\/subscribers\/import(\/|$)/,            key: 'subscribers.import' },
  { method: 'POST',   test: /^\/subscribers\/export(\/|$)/,            key: 'subscribers.export' },
  { method: 'POST',   test: /^\/subscribers\/bulk-transfer\b/,        key: 'users.transfer' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/transfer\b/,         key: 'users.transfer' },
  { method: 'POST',   test: /^\/subscribers\/activate-renewal\b/,      key: 'subscribers.activation' },
  { method: 'POST',   test: /^\/subscribers\/renew\/credit(s)?\b/,     key: 'subscribers.activation' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/deactivate\b/,       key: 'subscribers.disconnect' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/grace\b/,            key: 'subscribers.gracePeriod' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/fix-radius-password\b/, key: 'subscribers.changePassword' },
  { method: 'DELETE', test: /^\/subscribers\/\d+(\/)?$/,               key: 'subscribers.delete' },
  { method: 'POST',   test: /^\/subscribers(\/)?$/,                    key: 'subscribers.write' },

  // ── Downline user accounts ───────────────────────────────────────────────
  { method: 'DELETE', test: /^\/users\/\d+(\/)?$/,                     key: 'users.delete' },

  // ── Money: pricing, wallet top-ups, reversals ────────────────────────────
  { method: 'PUT',    test: /^\/organization\/pricing\b/,             key: 'packages.manageProfit' },
  { method: 'POST',   test: /^\/organization\/pricing\/reverse\b/,     key: 'subscribers.revertInvoice' },
  { method: 'POST',   test: /^\/organization\/wallet\/reverse-topup\b/,key: 'subscribers.manageBalance' },

  // ── Invoices & payments ──────────────────────────────────────────────────
  { method: 'POST',   test: /^\/invoices\/\d+\/payment\b/,            key: 'payments.record' },
  { method: 'POST',   test: /^\/payments(\/)?$/,                       key: 'payments.record' },
  { method: 'DELETE', test: /^\/payments\/\d+(\/)?$/,                  key: 'invoices.massDelete' },

  // ── Network actions ──────────────────────────────────────────────────────
  { method: 'POST',   test: /^\/network\/.*disconnect\b/,             key: 'network.disconnect' },
];

/** The granular permission key an endpoint needs, or null to use the coarse one. */
export function permissionForRoute(method: string, path: string): string | null {
  const m = (method || '').toUpperCase();
  for (const r of ROUTE_PERMISSIONS) {
    if (r.method === m && r.test.test(path)) return r.key;
  }
  return null;
}
