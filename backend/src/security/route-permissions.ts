/**
 * Route → granular-permission map.
 *
 * The PermissionsGuard checks a per-user DENY list, but on its own only knows
 * the COARSE key ("subscribers.write"). A parent who unticks a specific action
 * ("subscribers.changeUsername", "users.manageBalance") saves that exact key —
 * so without this table the guard was looking for the wrong key and the tick
 * did nothing. This maps the real endpoints to the catalog's granular keys so
 * every one of them is enforced.
 *
 * Match order matters: the FIRST entry whose method + path regex matches wins,
 * so specific routes (bulk-delete, :id/grace) must sit ABOVE generic ones
 * (:id, the bare resource). An unmapped write still falls back to the coarse
 * "<resource>.write", so nothing is ever LESS guarded than before.
 */

export interface RoutePerm {
  method: string;
  test: RegExp;
  key: string;
}

export const ROUTE_PERMISSIONS: RoutePerm[] = [
  // ── SUBSCRIBERS — every granular action a parent can grant/deny ───────────
  { method: 'DELETE', test: /^\/subscribers\/bulk-delete\b/,             key: 'subscribers.massDelete' },
  { method: 'PATCH',  test: /^\/subscribers\/bulk-service-settings\b/,   key: 'subscribers.massSettings' },
  { method: 'POST',   test: /^\/subscribers\/import(\/|$)/,              key: 'subscribers.import' },
  { method: 'POST',   test: /^\/subscribers\/export(\/|$)/,              key: 'subscribers.export' },
  { method: 'POST',   test: /^\/subscribers\/bulk-transfer\b/,          key: 'users.transfer' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/transfer\b/,           key: 'users.transfer' },
  { method: 'POST',   test: /^\/subscribers\/activate-renewal\b/,        key: 'subscribers.activation' },
  { method: 'POST',   test: /^\/subscribers\/renew\/credit(s)?\b/,       key: 'subscribers.activation' },
  { method: 'POST',   test: /^\/subscribers\/renew\/quote\b/,            key: 'subscribers.activation' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/deactivate\b/,         key: 'subscribers.disconnect' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/grace\b/,              key: 'subscribers.gracePeriod' },
  { method: 'PATCH',  test: /^\/subscribers\/\d+\/hold\b/,               key: 'subscribers.disableNet' },
  { method: 'PATCH',  test: /^\/subscribers\/\d+\/unhold\b/,             key: 'subscribers.enableNet' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/fix-radius-password\b/,key: 'subscribers.changePassword' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/sync-profile\b/,       key: 'subscribers.radiusAttributes' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/sync-to-radius\b/,     key: 'subscribers.radiusAttributes' },
  { method: 'POST',   test: /^\/subscribers\/(bulk-)?sync-.*radius/,     key: 'subscribers.radiusAttributes' },
  { method: 'DELETE', test: /^\/subscribers\/radius\//,                  key: 'subscribers.radiusAttributes' },
  { method: 'DELETE', test: /^\/subscribers\/\d+(\/)?$/,                 key: 'subscribers.delete' },
  { method: 'PUT',    test: /^\/subscribers\/\d+(\/)?$/,                 key: 'subscribers.write' },
  { method: 'POST',   test: /^\/subscribers(\/)?$/,                      key: 'subscribers.write' },

  // Boost (temporary speed) and service settings are subscriber edits.
  { method: 'POST',   test: /^\/boost\//,                               key: 'subscribers.write' },
  { method: 'POST',   test: /^\/service-settings\//,                    key: 'subscribers.write' },

  // Notes / documents on a record.
  { method: 'POST',   test: /^\/notes(\/)?$/,                           key: 'subscribers.addNote' },
  { method: 'PUT',    test: /^\/notes\//,                               key: 'subscribers.addNote' },
  { method: 'DELETE', test: /^\/notes\//,                               key: 'subscribers.addNote' },

  // ── DOWNLINE USER ACCOUNTS ────────────────────────────────────────────────
  { method: 'DELETE', test: /^\/users\/\d+(\/)?$/,                      key: 'users.delete' },
  { method: 'POST',   test: /^\/users\/\d+\/.*balance/i,                 key: 'users.manageBalance' },
  { method: 'PUT',    test: /^\/users\/\d+(\/)?$/,                      key: 'users.write' },
  { method: 'POST',   test: /^\/users(\/)?$/,                           key: 'users.write' },
  { method: 'POST',   test: /^\/auth\/impersonate/,                     key: 'users.switchProfile' },

  // Roles.
  { method: 'POST',   test: /^\/security\/roles?\b/,                    key: 'roles.add' },
  { method: 'DELETE', test: /^\/security\/roles?\//,                    key: 'roles.delete' },

  // ── MONEY: pricing, wallet, reversals ─────────────────────────────────────
  { method: 'PUT',    test: /^\/organization\/pricing\b/,              key: 'packages.manageProfit' },
  { method: 'DELETE', test: /^\/organization\/pricing\//,               key: 'packages.manageProfit' },
  { method: 'PUT',    test: /^\/organization\/franchise-pricing\b/,     key: 'packages.manageProfit' },
  { method: 'POST',   test: /^\/organization\/pricing\/reverse\b/,      key: 'subscribers.revertInvoice' },
  { method: 'POST',   test: /^\/organization\/resellers\/\d+\/wallet\b/,key: 'users.manageBalance' },
  { method: 'POST',   test: /^\/organization\/wallet\/reverse-topup\b/, key: 'users.manageBalance' },

  // ── INVOICES & PAYMENTS ───────────────────────────────────────────────────
  { method: 'POST',   test: /^\/invoices\/\d+\/payment\b/,             key: 'payments.record' },
  { method: 'POST',   test: /^\/invoices(\/)?$/,                        key: 'invoices.add' },
  { method: 'DELETE', test: /^\/invoices\//,                            key: 'invoices.massDelete' },
  { method: 'POST',   test: /^\/payments(\/)?$/,                        key: 'payments.record' },
  { method: 'DELETE', test: /^\/payments\//,                            key: 'invoices.massDelete' },

  // ── NETWORK ───────────────────────────────────────────────────────────────
  { method: 'POST',   test: /^\/network\/.*disconnect\b/,              key: 'network.disconnect' },

  // ── AREAS ─────────────────────────────────────────────────────────────────
  { method: 'POST',   test: /^\/areas(\/)?$/,                          key: 'areas.manage' },
  { method: 'PUT',    test: /^\/areas\//,                              key: 'areas.manage' },
  { method: 'DELETE', test: /^\/areas\//,                              key: 'areas.manage' },
];

/** The granular permission key an endpoint needs, or null to use the coarse one. */
export function permissionForRoute(method: string, path: string): string | null {
  const m = (method || '').toUpperCase();
  for (const r of ROUTE_PERMISSIONS) {
    if (r.method === m && r.test.test(path)) return r.key;
  }
  return null;
}
