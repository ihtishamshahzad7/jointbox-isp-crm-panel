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
  { method: 'POST',   test: /^\/subscribers\/bulk-transfer\b/,          key: 'users.transferSubscribers' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/transfer\b/,           key: 'users.transferSubscribers' },
  { method: 'POST',   test: /^\/subscribers\/activate-renewal\b/,        key: 'subscribers.activation' },
  { method: 'POST',   test: /^\/subscribers\/(bulk-action|group-action)\b/, key: 'subscribers.massActivation' },
  { method: 'POST',   test: /^\/subscribers\/renew\/credit(s)?\b/,       key: 'subscribers.activation' },
  { method: 'POST',   test: /^\/subscribers\/renew\/quote\b/,            key: 'subscribers.activation' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/package-change\b/,      key: 'subscribers.changePackage' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/deactivate\b/,         key: 'subscribers.disconnect' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/grace\b/,              key: 'subscribers.gracePeriod' },
  { method: 'PATCH',  test: /^\/subscribers\/\d+\/hold\b/,               key: 'subscribers.disableNet' },
  { method: 'PATCH',  test: /^\/subscribers\/\d+\/unhold\b/,             key: 'subscribers.enableNet' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/fix-radius-password\b/,key: 'subscribers.changePassword' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/sync-profile\b/,       key: 'subscribers.radiusAttributes' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/sync-to-radius\b/,     key: 'subscribers.radiusAttributes' },
  { method: 'POST',   test: /^\/subscribers\/(bulk-)?sync-.*radius/,     key: 'subscribers.radiusAttributes' },
  { method: 'DELETE', test: /^\/subscribers\/radius\//,                  key: 'subscribers.radiusAttributes' },
  { method: 'POST',   test: /^\/subscribers\/\d+\/sync-profile\b/,       key: 'subscribers.radiusAttributes' },
  { method: 'POST',   test: /^\/subscribers\/repair-links\b/,            key: 'subscribers.radiusAttributes' },
  { method: 'DELETE', test: /^\/subscribers\/\d+(\/)?$/,                 key: 'subscribers.delete' },
  { method: 'PUT',    test: /^\/subscribers\/\d+(\/)?$/,                 key: 'subscribers.write' },
  { method: 'POST',   test: /^\/subscribers(\/)?$/,                      key: 'subscribers.write' },

  // Bootstrap: imports the whole panel from an existing network.
  { method: 'POST',   test: /^\/subscribers\/import-panel\b/,            key: 'subscribers.import' },
  { method: 'POST',   test: /^\/subscribers\/export\/panel\b/,           key: 'subscribers.export' },

  // Boost (temporary speed) and service settings are subscriber edits.
  { method: 'POST',   test: /^\/boost\/apply\b/,                         key: 'boost.apply' },
  { method: 'POST',   test: /^\/boost\/\d+\/revert\b/,                   key: 'boost.revert' },
  { method: 'POST',   test: /^\/service-settings\//,                     key: 'subscribers.write' },

  // Notes / documents on a record.
  { method: 'POST',   test: /^\/notes(\/)?$/,                            key: 'notes.add' },
  { method: 'PUT',    test: /^\/notes\//,                                key: 'notes.edit' },
  { method: 'DELETE', test: /^\/notes\//,                                key: 'notes.delete' },

  // ── DOWNLINE USER ACCOUNTS ────────────────────────────────────────────────
  { method: 'DELETE', test: /^\/users\/\d+(\/)?$/,                      key: 'users.delete' },
  { method: 'POST',   test: /^\/users\/\d+\/purge\b/,                   key: 'users.delete' },
  { method: 'PATCH',  test: /^\/users\/\d+\/toggle\b/,                  key: 'users.write' },
  { method: 'POST',   test: /^\/users\/\d+\/.*balance/i,                 key: 'users.topup' },
  { method: 'PUT',    test: /^\/users\/\d+\/packages\/\d+$/,            key: 'packages.assign' },
  { method: 'PUT',    test: /^\/users\/\d+(\/)?$/,                      key: 'users.write' },
  { method: 'POST',   test: /^\/users(\/)?$/,                           key: 'users.write' },
  { method: 'POST',   test: /^\/auth\/impersonate/,                     key: 'users.switchProfile' },

  // Roles.
  { method: 'POST',   test: /^\/security\/roles?\b/,                    key: 'roles.add' },
  { method: 'DELETE', test: /^\/security\/roles?\//,                    key: 'roles.delete' },
  { method: 'PUT',    test: /^\/security\/permissions\//,               key: 'roles.edit' },
  { method: 'PUT',    test: /^\/security\/child-permissions\//,         key: 'roles.edit' },

  // ── MONEY: pricing, wallet, reversals ─────────────────────────────────────
  { method: 'PUT',    test: /^\/organization\/pricing\b/,              key: 'packages.manageProfit' },
  { method: 'DELETE', test: /^\/organization\/pricing\//,               key: 'packages.manageProfit' },
  { method: 'PUT',    test: /^\/organization\/franchise-pricing\b/,     key: 'packages.manageProfit' },
  { method: 'DELETE', test: /^\/organization\/franchise-pricing\//,     key: 'packages.manageProfit' },
  { method: 'POST',   test: /^\/organization\/pricing\/(reverse|settle|assign-bulk)\b/, key: 'packages.manageProfit' },
  { method: 'POST',   test: /^\/organization\/pricing\/reverse\b/,      key: 'subscribers.revertInvoice' },
  // Funding a child's wallet IS "Add / manage balance (child account)" = users.topup.
  // (Was users.moveBalance, so unticking "Add / manage balance" did nothing.)
  { method: 'POST',   test: /^\/organization\/resellers\/\d+\/wallet\b/,key: 'users.topup' },
  { method: 'POST',   test: /^\/organization\/wallet\/reverse-topup\b/, key: 'users.topup' },
  { method: 'PUT',    test: /^\/organization\/resellers\/\d+\/(credit-limit|price-permission|topup-permission|nas-permission|commission)\b/, key: 'organization.limits' },

  // ISP structure (franchise/branch admin) — ISP-only floor in the guard.
  { method: 'POST',   test: /^\/organization\/(isps|branches)(\/)?$/,   key: 'organization.isps' },
  { method: 'PUT',    test: /^\/organization\/branches\//,              key: 'organization.branches' },
  { method: 'DELETE', test: /^\/organization\/branches\//,              key: 'organization.branches' },
  { method: 'PUT',    test: /^\/organization\/isps\//,                  key: 'organization.isps' },
  { method: 'DELETE', test: /^\/organization\/isps\//,                  key: 'organization.isps' },

  // ── INVOICES & PAYMENTS ───────────────────────────────────────────────────
  { method: 'POST',   test: /^\/invoices\/\d+\/payment\b/,             key: 'payments.write' },
  { method: 'POST',   test: /^\/invoices(\/)?$/,                        key: 'invoices.write' },
  { method: 'DELETE', test: /^\/invoices\//,                            key: 'invoices.massDelete' },
  { method: 'POST',   test: /^\/payments(\/)?$/,                        key: 'payments.write' },
  { method: 'DELETE', test: /^\/payments\//,                            key: 'payments.write' },

  // ── ACCOUNTING / BILLING ENGINE ───────────────────────────────────────────
  { method: 'POST',   test: /^\/accounting\/expenses(\/)?$/,            key: 'cashflow.add' },
  { method: 'POST',   test: /^\/accounting\/expense-requests\/\d+\/(approve|reject)\b/, key: 'accounting.approvals' },
  { method: 'POST',   test: /^\/accounting\/refund-requests\/\d+\/(approve|reject)\b/, key: 'accounting.approvals' },
  { method: 'DELETE', test: /^\/accounting\/expenses\/\d+$/,            key: 'cashflow.delete' },
  { method: 'POST',   test: /^\/accounting\/invoices\/\d+\/reverse\b/,  key: 'accounting.reverse' },
  { method: 'POST',   test: /^\/accounting\/payments\/\d+\/refund\b/,   key: 'accounting.refund' },
  { method: 'POST',   test: /^\/accounting\/balances\/\d+\/topup\b/,    key: 'subscribers.manageBalance' },
  { method: 'PUT',    test: /^\/accounting\/(period-lock|finance-settings)\b/, key: 'accounting.settings' },
  { method: 'POST',   test: /^\/billing\/run\//,                        key: 'billing.run' },
  { method: 'PUT',    test: /^\/billing-ext\/pro-rata\//,               key: 'billing.proRata' },
  { method: 'POST',   test: /^\/billing-ext\/pro-rata\/calculate\b/,    key: 'billing.proRata' },
  { method: 'PUT',    test: /^\/billing-ext\/subscriber-billing\//,     key: 'billing.subscriberSettings' },
  { method: 'POST',   test: /^\/billing-ext\/subscriber-balance\/\d+\/(topup|adjust)\b/, key: 'billing.subscriberBalance' },
  { method: 'POST',   test: /^\/billing-ext\/invoices\/\d+\/reverse\b/, key: 'billing.reverse' },

  // ── NAS / ROUTERS ─────────────────────────────────────────────────────────
  { method: 'DELETE', test: /^\/nas\/\d+(\/)?$/,                        key: 'nas.delete' },
  { method: 'GET',    test: /^\/nas\/\d+\/(sync|reachability|ping|quick-check)\b/, key: 'nas.sync' },
  { method: 'POST',   test: /^\/nas\/assign-bulk\b/,                    key: 'nas.share' },
  { method: 'POST',   test: /^\/nas\/\d+\/assign\/\d+$/,                key: 'nas.share' },
  { method: 'DELETE', test: /^\/nas\/\d+\/assign\/\d+$/,                key: 'nas.share' },
  { method: 'POST',   test: /^\/nas\/import\b/,                         key: 'nas.write' },
  // create / edit / toggle fall back to the coarse nas.write.

  // ── TELEMETRY / SNMP ──────────────────────────────────────────────────────
  // Probing a device and discovering its interfaces are actions, not reads —
  // they make the server talk to the router, so they need the write key.
  { method: 'POST',   test: /^\/telemetry\/nas\/\d+\/snmp-test\b/,      key: 'telemetry.write' },
  { method: 'GET',    test: /^\/telemetry\/nas\/\d+\/discover-interfaces\b/, key: 'telemetry.write' },

  // ── NETWORK ───────────────────────────────────────────────────────────────
  { method: 'POST',   test: /^\/network\/bandwidth\//,                 key: 'subscribers.changeBandwidth' },
  { method: 'POST',   test: /^\/network\/mac\//,                       key: 'network.mac' },
  { method: 'DELETE', test: /^\/network\/mac\//,                       key: 'network.mac' },
  { method: 'POST',   test: /^\/network\/disconnect\//,                key: 'network.disconnect' },
  { method: 'POST',   test: /^\/network\/.*disconnect\b/,              key: 'network.disconnect' },
  { method: 'POST',   test: /^\/network\/bandwidth\/\d+$/,             key: 'subscribers.changeBandwidth' },
  { method: 'POST',   test: /^\/network\/mac\//,                       key: 'network.mac' },
  { method: 'DELETE', test: /^\/network\/mac\//,                       key: 'network.mac' },
  { method: 'POST',   test: /^\/network\/duplicate-sessions\/sweep\b/, key: 'network.disconnect' },

  // ── IP POOLS ──────────────────────────────────────────────────────────────
  { method: 'POST',   test: /^\/ip-pools\/sync\/apply\b/,              key: 'ip-pools.sync' },
  { method: 'POST',   test: /^\/ip-pools\/import\b/,                   key: 'ip-pools.import' },
  { method: 'POST',   test: /^\/ip-pools\/\d+\/share\/\d+$/,           key: 'ip-pools.share' },
  { method: 'DELETE', test: /^\/ip-pools\/\d+\/share\/\d+$/,           key: 'ip-pools.share' },
  { method: 'PUT',    test: /^\/ip-pools\/\d+$/,                       key: 'ip-pools.write' },
  { method: 'DELETE', test: /^\/ip-pools\/\d+$/,                       key: 'ip-pools.delete' },

  // ── STATIC IPs ────────────────────────────────────────────────────────────
  { method: 'POST',   test: /^\/static-ips\/(subscriber\/\d+|range)\b/, key: 'static-ips.write' },
  { method: 'PATCH',  test: /^\/static-ips\/\d+\/(assign|release)\b/,  key: 'static-ips.write' },
  { method: 'PUT',    test: /^\/static-ips\/\d+$/,                     key: 'static-ips.write' },
  { method: 'DELETE', test: /^\/static-ips\/\d+$/,                     key: 'static-ips.delete' },

  // ── COMPLIANCE / KYC / FUP ────────────────────────────────────────────────
  { method: 'POST',   test: /^\/compliance\/kyc\/\d+\/cnic\b/,         key: 'compliance.updateKyc' },
  { method: 'POST',   test: /^\/compliance\/kyc\/users\/\d+\/cnic\b/,  key: 'compliance.updateKyc' },
  { method: 'PATCH',  test: /^\/compliance\/kyc\/\d+\/verify\b/,       key: 'compliance.verifyKyc' },
  { method: 'PATCH',  test: /^\/compliance\/kyc\/users\/\d+\/verify\b/,key: 'compliance.verifyKyc' },
  { method: 'PATCH',  test: /^\/compliance\/fup\/\d+\/release\b/,      key: 'compliance.fup' },
  { method: 'POST',   test: /^\/compliance\/fup\/\d+\/extend\b/,       key: 'compliance.fup' },

  // ── FIBER ─────────────────────────────────────────────────────────────────
  { method: 'POST',   test: /^\/fiber\/olts(\/)?$/,                    key: 'fiber.write' },
  { method: 'PUT',    test: /^\/fiber\/olts\/\d+$/,                    key: 'fiber.write' },
  { method: 'DELETE', test: /^\/fiber\/olts\/\d+$/,                    key: 'fiber.write' },
  { method: 'POST',   test: /^\/fiber\/ports(\/)?$/,                   key: 'fiber.write' },
  { method: 'PUT',    test: /^\/fiber\/ports\/\d+$/,                   key: 'fiber.write' },
  { method: 'DELETE', test: /^\/fiber\/ports\/\d+$/,                   key: 'fiber.write' },
  { method: 'POST',   test: /^\/fiber\/onus\/\d+\/(assign|unassign)\b/,key: 'fiber.onusAssign' },
  { method: 'PUT',    test: /^\/fiber\/onus\/\d+$/,                    key: 'fiber.write' },
  { method: 'DELETE', test: /^\/fiber\/onus\/\d+$/,                    key: 'fiber.write' },
  { method: 'PUT',    test: /^\/fiber\/subscribers\/\d+$/,             key: 'fiber.write' },

  // ── FIELD JOBS ────────────────────────────────────────────────────────────
  { method: 'POST',   test: /^\/field-jobs\/from-ticket\//,            key: 'field-jobs.write' },
  { method: 'PUT',    test: /^\/field-jobs\/\d+$/,                     key: 'field-jobs.write' },
  { method: 'PATCH',  test: /^\/field-jobs\/\d+\/(assign|start|complete|cancel)\b/, key: 'field-jobs.write' },
  { method: 'DELETE', test: /^\/field-jobs\/\d+$/,                     key: 'field-jobs.delete' },

  // ── GROUPS (access / sharing) ─────────────────────────────────────────────
  { method: 'POST',   test: /^\/groups\/\d+\/members(\/)?$/,           key: 'groups.write' },
  { method: 'PUT',    test: /^\/groups\/\d+\/members\//,               key: 'groups.write' },
  { method: 'DELETE', test: /^\/groups\/\d+\/members\//,               key: 'groups.write' },
  { method: 'POST',   test: /^\/groups\/\d+\/(nas|packages)(\/)?$/,    key: 'groups.write' },
  { method: 'DELETE', test: /^\/groups\/\d+\/(nas|packages)\//,        key: 'groups.write' },
  { method: 'PUT',    test: /^\/groups\/\d+$/,                         key: 'groups.write' },
  { method: 'DELETE', test: /^\/groups\/\d+$/,                         key: 'groups.write' },
  { method: 'POST',   test: /^\/groups(\/)?$/,                         key: 'groups.write' },

  // ── INTEGRATIONS / WEBHOOKS / API KEYS ───────────────────────────────────
  { method: 'POST',   test: /^\/integrations\/webhooks(\/)?$/,         key: 'integrations.webhooks' },
  { method: 'PUT',    test: /^\/integrations\/webhooks\//,             key: 'integrations.webhooks' },
  { method: 'DELETE', test: /^\/integrations\/webhooks\//,             key: 'integrations.webhooks' },
  { method: 'POST',   test: /^\/integrations\/api-keys(\/)?$/,         key: 'integrations.apiKeys' },
  { method: 'DELETE', test: /^\/integrations\/api-keys\//,             key: 'integrations.apiKeys' },

  // ── INVENTORY ─────────────────────────────────────────────────────────────
  { method: 'POST',   test: /^\/inventory\/bulk\b/,                    key: 'inventory.write' },
  { method: 'PUT',    test: /^\/inventory\/\d+$/,                      key: 'inventory.write' },
  { method: 'PATCH',  test: /^\/inventory\/\d+\/(assign|install|return)\b/, key: 'inventory.assign' },
  { method: 'DELETE', test: /^\/inventory\/\d+$/,                      key: 'inventory.delete' },

  // ── OUTAGES ───────────────────────────────────────────────────────────────
  { method: 'PATCH',  test: /^\/outages\/\d+\/(classify|close)\b/,     key: 'outages.write' },
  { method: 'POST',   test: /^\/outages\/\d+\/notify\b/,               key: 'outages.notify' },
  { method: 'POST',   test: /^\/outages\/schedules(\/)?$/,             key: 'outages.write' },
  { method: 'PUT',    test: /^\/outages\/schedules\//,                 key: 'outages.write' },
  { method: 'DELETE', test: /^\/outages\/schedules\//,                 key: 'outages.write' },

  // ── PAYMENT GATEWAYS ──────────────────────────────────────────────────────
  { method: 'POST',   test: /^\/payment-gateways\/admin(\/)?$/,        key: 'payment-gateways.write' },
  { method: 'PUT',    test: /^\/payment-gateways\/admin\//,            key: 'payment-gateways.write' },
  { method: 'PATCH',  test: /^\/payment-gateways\/admin\//,            key: 'payment-gateways.write' },
  { method: 'DELETE', test: /^\/payment-gateways\/admin\//,            key: 'payment-gateways.write' },

  // ── PRICING / FEES / DISCOUNTS ────────────────────────────────────────────
  { method: 'POST',   test: /^\/pricing\/fees(\/)?$/,                  key: 'pricing.fees' },
  { method: 'PUT',    test: /^\/pricing\/fees\//,                      key: 'pricing.fees' },
  { method: 'DELETE', test: /^\/pricing\/fees\//,                      key: 'pricing.fees' },
  { method: 'POST',   test: /^\/pricing\/subscriber-discounts(\/)?$/,  key: 'pricing.discounts' },
  { method: 'PUT',    test: /^\/pricing\/subscriber-discounts\//,      key: 'pricing.discounts' },
  { method: 'DELETE', test: /^\/pricing\/subscriber-discounts\//,      key: 'pricing.discounts' },

  // ── THROTTLE POLICIES ─────────────────────────────────────────────────────
  { method: 'PUT',    test: /^\/throttle-policies\/\d+(\/)?$/,         key: 'throttle-policies.write' },
  { method: 'DELETE', test: /^\/throttle-policies\/\d+(\/)?$/,         key: 'throttle-policies.write' },
  { method: 'POST',   test: /^\/throttle-policies\/\d+\/packages(\/)?$/, key: 'throttle-policies.write' },
  { method: 'DELETE', test: /^\/throttle-policies\/\d+\/packages\//,   key: 'throttle-policies.write' },
  { method: 'POST',   test: /^\/throttle-policies\/\d+\/subscribers(\/)?$/, key: 'throttle-policies.write' },
  { method: 'DELETE', test: /^\/throttle-policies\/\d+\/subscribers\//,key: 'throttle-policies.write' },

  // ── TICKETS / COMPLAINTS ──────────────────────────────────────────────────
  { method: 'PUT',    test: /^\/tickets\/\d+(\/)?$/,                   key: 'tickets.write' },
  { method: 'POST',   test: /^\/tickets\/\d+\/message\b/,              key: 'tickets.write' },
  { method: 'DELETE', test: /^\/tickets\/\d+(\/)?$/,                   key: 'tickets.delete' },
  { method: 'GET',    test: /^\/tickets\/sla\/report\b/,               key: 'tickets.sla' },
  { method: 'POST',   test: /^\/tickets\/sla\/backfill\b/,             key: 'tickets.sla' },

  // ── TOPOLOGY ──────────────────────────────────────────────────────────────
  { method: 'POST',   test: /^\/topology\/(mac|parse|detect)\b/,       key: 'topology.write' },

  // ── VOUCHERS ──────────────────────────────────────────────────────────────
  { method: 'POST',   test: /^\/vouchers\/bulk\b/,                     key: 'vouchers.create' },
  { method: 'POST',   test: /^\/vouchers\/redeem\b/,                   key: 'vouchers.redeem' },
  { method: 'DELETE', test: /^\/vouchers\/\d+$/,                       key: 'vouchers.delete' },

  // ── COMMUNICATION / NOTIFICATIONS ─────────────────────────────────────────
  { method: 'POST',   test: /^\/communication\/send\b/,                key: 'communication.send' },
  { method: 'POST',   test: /^\/communication\/templates(\/)?$/,       key: 'communication.templates' },
  { method: 'PUT',    test: /^\/communication\/templates\//,           key: 'communication.templates' },
  { method: 'DELETE', test: /^\/communication\/templates\//,           key: 'communication.templates' },
  { method: 'POST',   test: /^\/communication\/alerts\//,              key: 'communication.alerts' },

  // ── GATEWAY (payment gateways used on the panel side) ─────────────────────
  { method: 'POST',   test: /^\/gateway\/initiate\//,                  key: 'gateway.initiate' },
  { method: 'GET',    test: /^\/gateway\/reconcile\b/,                 key: 'gateway.reconcile' },
  { method: 'POST',   test: /^\/gateway\/sandbox\/confirm\//,          key: 'gateway.initiate' },

  // ── JOBS (background) ─────────────────────────────────────────────────────
  { method: 'POST',   test: /^\/jobs\//,                               key: 'jobs.write' },

  // ── AREAS ─────────────────────────────────────────────────────────────────
  { method: 'POST',   test: /^\/areas(\/)?$/,                          key: 'areas.write' },
  { method: 'PUT',    test: /^\/areas\//,                              key: 'areas.write' },
  { method: 'PATCH',  test: /^\/areas\/\d+\/toggle\b/,                 key: 'areas.write' },
  { method: 'DELETE', test: /^\/areas\//,                              key: 'areas.write' },

  // ── REPORTS (granular read gates) ─────────────────────────────────────────
  { method: 'GET',    test: /^\/reports\/(analytics\/revenue|analytics\/growth|analytics\/packages|analytics|revenue|reseller-performance)\b/, key: 'reports.sales' },
  { method: 'GET',    test: /^\/reports\/analytics\/collections\b/,    key: 'reports.payment' },
  { method: 'GET',    test: /^\/reports\/subscribers\b/,               key: 'reports.subscriberCounter' },
  { method: 'GET',    test: /^\/reports\/aged-debt\b/,                 key: 'reports.accountingCounter' },
  { method: 'GET',    test: /^\/reports\/tickets\b/,                   key: 'tickets.sla' },
  { method: 'GET',    test: /^\/reports\/dashboard\b/,                 key: 'reports.sales' },

  // ── LOGS (granular read gates) ────────────────────────────────────────────
  { method: 'GET',    test: /^\/logs\/(activity|timeline)\b/,          key: 'logs.activity' },
  { method: 'GET',    test: /^\/logs\/login\b/,                        key: 'logs.login' },
  { method: 'GET',    test: /^\/logs\/sessions\b/,                     key: 'logs.session' },
  { method: 'GET',    test: /^\/logs\/(radius-auth|radius\/diagnostics)\b/, key: 'logs.coa' },
  { method: 'GET',    test: /^\/logs\/(network|router\/|system|failed-activations)\b/, key: 'logs.activity' },
];

/** The granular permission key an endpoint needs, or null to use the coarse one. */
export function permissionForRoute(method: string, path: string): string | null {
  const m = (method || '').toUpperCase();
  for (const r of ROUTE_PERMISSIONS) {
    if (r.method === m && r.test.test(path)) return r.key;
  }
  return null;
}