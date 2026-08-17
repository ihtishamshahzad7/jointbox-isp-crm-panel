import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache.service';
import { ScopeService, Actor } from '../common/scope.service';
import { generateSecret, otpauthUrl, verifyTotp } from './totp';

const RESOURCES = [
  'subscribers', 'packages', 'invoices', 'payments', 'accounting', 'billing',
  'billing-ext', 'cashflow', 'communication', 'gateway', 'vouchers', 'tickets',
  'nas', 'ip-pools', 'static-ips', 'areas', 'users', 'logs', 'reports',
  'service-settings', 'security', 'network', 'boost', 'compliance', 'fiber',
  'field-jobs', 'groups', 'insights', 'segments', 'analytics', 'integrations',
  'inventory', 'jobs', 'outages', 'payment-gateways', 'pricing', 'telemetry',
  'throttle-policies', 'topology', 'uploads', 'organization', 'notes',
];
const ROLES = ['ADMIN', 'SALES', 'RESELLER', 'SUB_RESELLER', 'RETAILER'];

/**
 * Catalog a parent uses to control a child: feature rows with toggleable actions.
 * Full Zal-Pro-style set, expanded to cover every module in the panel.
 * Untick a key to DENY that capability for the child.
 *
 * The `key`s here are also what route-permissions.ts maps real endpoints to, so
 * an unticked option actually blocks the route (not just the UI button).
 */
const PERMISSION_CATALOG = [
  { resource: 'subscribers', label: 'Subscriber Profile', actions: [
    { key: 'subscribers.read', label: 'View' },
    { key: 'subscribers.write', label: 'Add / Edit' },
    { key: 'subscribers.delete', label: 'Delete' },
    { key: 'subscribers.import', label: 'Import' },
    { key: 'subscribers.export', label: 'Export' },
    { key: 'subscribers.changePassword', label: 'Change password' },
    { key: 'subscribers.changeUsername', label: 'Change username (⚠ irreversible)' },
    { key: 'subscribers.togglePassword', label: 'Toggle password' },
    { key: 'subscribers.changePackage', label: 'Change / migrate package' },
    { key: 'subscribers.activation', label: 'Activate / Renew' },
    { key: 'subscribers.massActivation', label: 'Mass activation' },
    { key: 'subscribers.customExpiry', label: 'Custom expiry date' },
    { key: 'subscribers.expirationDate', label: 'Change expiration date' },
    { key: 'subscribers.gracePeriod', label: 'Set grace period' },
    { key: 'subscribers.manageBalance', label: 'Add / withdraw balance' },
    { key: 'subscribers.massPayment', label: 'Mass payment' },
    { key: 'subscribers.massDelete', label: 'Mass delete' },
    { key: 'subscribers.massSettings', label: 'Mass service settings' },
    { key: 'subscribers.disconnect', label: 'Disconnect from internet' },
    { key: 'subscribers.changeBandwidth', label: 'Change / extend bandwidth (CoA)' },
    { key: 'subscribers.discount', label: 'Set discount' },
    { key: 'subscribers.addNote', label: 'Add note' },
    { key: 'subscribers.addDocument', label: 'Add document' },
    { key: 'subscribers.radiusAttributes', label: 'View / add RADIUS attributes' },
    { key: 'subscribers.resetMac', label: 'Reset MAC address' },
    { key: 'subscribers.loginLink', label: 'View login link' },
    { key: 'subscribers.revertInvoice', label: 'Revert last invoice' },
    { key: 'subscribers.enableNet', label: 'Enable net' },
    { key: 'subscribers.disableNet', label: 'Disable net' },
  ]},
  { resource: 'users', label: 'User Profile (downline)', actions: [
    { key: 'users.read', label: 'View' },
    { key: 'users.write', label: 'Add / Edit' },
    { key: 'users.delete', label: 'Delete' },
    { key: 'users.export', label: 'Export' },
    { key: 'users.changePassword', label: 'Change password' },
    { key: 'users.changeRole', label: 'Change role' },
    { key: 'users.topup', label: 'Add / manage balance (child account)' },
    { key: 'users.moveBalance', label: 'Move balance between accounts' },
    { key: 'users.transferSubscribers', label: 'Transfer / move subscribers' },
    { key: 'users.accountingLimit', label: 'Set accounting/balance limit' },
    { key: 'users.macLock', label: 'Set MAC lock' },
    { key: 'users.ipLock', label: 'Set IP lock' },
    { key: 'users.subscriberLimit', label: 'Set subscriber limit' },
    { key: 'users.resellerLimit', label: 'Set reseller limit' },
    { key: 'users.switchProfile', label: 'Switch profile (act as)' },
    { key: 'users.apiAccess', label: 'API access' },
  ]},
  { resource: 'roles', label: 'User Role & Permissions', actions: [
    { key: 'roles.add', label: 'Add role' },
    { key: 'roles.edit', label: 'Edit role' },
    { key: 'roles.delete', label: 'Delete role' },
    { key: 'roles.copy', label: 'Copy role' },
    { key: 'roles.resellerStaff', label: 'Create own staff' },
  ]},
  { resource: 'packages', label: 'User Packages', actions: [
    { key: 'packages.read', label: 'View' },
    { key: 'packages.assign', label: 'Assign / manage' },
    { key: 'packages.manageProfit', label: 'Manage own package profit' },
    { key: 'packages.delete', label: 'Delete' },
  ]},
  { resource: 'invoices', label: 'Manage Invoices', actions: [
    { key: 'invoices.read', label: 'View' },
    { key: 'invoices.write', label: 'Add' },
    { key: 'invoices.massStatus', label: 'Mass status change' },
    { key: 'invoices.massDelete', label: 'Mass delete' },
    { key: 'invoices.reverse', label: 'Reverse invoice' },
    { key: 'invoices.markPaid', label: 'Mark as paid (bulk)' },
    { key: 'invoices.export', label: 'Export' },
  ]},
  { resource: 'payments', label: 'Payments & Ledger', actions: [
    { key: 'payments.read', label: 'View receipt' },
    { key: 'payments.write', label: 'Record payment' },
    { key: 'payments.refund', label: 'Refund a payment' },
    { key: 'payments.export', label: 'Export' },
    { key: 'ledger.read', label: 'View ledger' },
    { key: 'ledger.export', label: 'Export ledger' },
  ]},
  { resource: 'cashflow', label: 'Cashflow', actions: [
    { key: 'cashflow.read', label: 'View' },
    { key: 'cashflow.add', label: 'Add' },
    { key: 'cashflow.edit', label: 'Edit' },
    { key: 'cashflow.delete', label: 'Delete' },
    { key: 'cashflow.export', label: 'Export' },
    { key: 'cashflow.category', label: 'Manage categories' },
  ]},
  { resource: 'accounting', label: 'Accounting', actions: [
    { key: 'accounting.read', label: 'View ledger / trial balance' },
    { key: 'accounting.export', label: 'Export' },
    { key: 'accounting.approvals', label: 'Approve / reject expenses & refunds' },
    { key: 'accounting.reverse', label: 'Reverse invoice (accounting)' },
    { key: 'accounting.refund', label: 'Refund payment (accounting)' },
    { key: 'accounting.settings', label: 'Finance settings / period lock' },
  ]},
  { resource: 'billing', label: 'Billing Engine', actions: [
    { key: 'billing.read', label: 'View billing runs' },
    { key: 'billing.run', label: 'Run billing cycle' },
    { key: 'billing.proRata', label: 'Configure pro-rata rules' },
    { key: 'billing.subscriberSettings', label: 'Per-subscriber billing settings' },
    { key: 'billing.subscriberBalance', label: 'Topup / adjust subscriber balance' },
    { key: 'billing.reverse', label: 'Reverse billing/balance change' },
  ]},
  { resource: 'areas', label: 'Areas', actions: [
    { key: 'areas.read', label: 'View' },
    { key: 'areas.write', label: 'Manage' },
  ]},
  { resource: 'nas', label: 'NAS / Routers', actions: [
    { key: 'nas.read', label: 'View NAS devices' },
    { key: 'nas.write', label: 'Add / edit NAS' },
    { key: 'nas.delete', label: 'Delete NAS' },
    { key: 'nas.sync', label: 'Sync / test NAS connection' },
    { key: 'nas.share', label: 'Share / assign NAS to child' },
  ]},
  { resource: 'ip-pools', label: 'IP Pools', actions: [
    { key: 'ip-pools.read', label: 'View pools' },
    { key: 'ip-pools.write', label: 'Add / edit pool' },
    { key: 'ip-pools.delete', label: 'Delete pool' },
    { key: 'ip-pools.import', label: 'Import pools' },
    { key: 'ip-pools.sync', label: 'Sync with router' },
    { key: 'ip-pools.share', label: 'Share pool with child' },
  ]},
  { resource: 'static-ips', label: 'Static IPs', actions: [
    { key: 'static-ips.read', label: 'View static IPs' },
    { key: 'static-ips.write', label: 'Add / assign / release' },
    { key: 'static-ips.delete', label: 'Delete' },
  ]},
  { resource: 'monitoring', label: 'Network Monitoring', actions: [
    { key: 'monitoring.read', label: 'View monitoring' },
    { key: 'monitoring.write', label: 'Add / edit / delete monitors' },
  ]},
  { resource: 'network', label: 'Network', actions: [
    { key: 'network.read', label: 'View live network' },
    { key: 'network.disconnect', label: 'Disconnect users' },
    { key: 'network.mac', label: 'Bind / unbind MAC' },
    { key: 'network.liveGraph', label: 'View live graph' },
    { key: 'network.interfaceGraph', label: 'View NAS interface graph' },
  ]},
  { resource: 'boost', label: 'Boost (temporary speed)', actions: [
    { key: 'boost.read', label: 'View active boosts' },
    { key: 'boost.apply', label: 'Apply speed boost' },
    { key: 'boost.revert', label: 'Revert / remove boost' },
  ]},
  { resource: 'compliance', label: 'KYC & Data Usage (FUP)', actions: [
    { key: 'compliance.read', label: 'View KYC / FUP' },
    { key: 'compliance.updateKyc', label: 'Update subscriber CNIC / KYC' },
    { key: 'compliance.verifyKyc', label: 'Verify / approve KYC' },
    { key: 'compliance.fup', label: 'Release / extend FUP quota' },
  ]},
  { resource: 'fiber', label: 'Fiber (OLT / ONU)', actions: [
    { key: 'fiber.read', label: 'View OLTs, ports, ONUs' },
    { key: 'fiber.write', label: 'Manage OLTs / ports' },
    { key: 'fiber.onusAssign', label: 'Assign / unassign ONUs' },
  ]},
  { resource: 'field-jobs', label: 'Field Jobs', actions: [
    { key: 'field-jobs.read', label: 'View jobs' },
    { key: 'field-jobs.write', label: 'Create / assign / complete' },
    { key: 'field-jobs.delete', label: 'Delete' },
  ]},
  { resource: 'groups', label: 'Access Groups (sharing)', actions: [
    { key: 'groups.read', label: 'View groups' },
    { key: 'groups.write', label: 'Manage groups / members' },
  ]},
  { resource: 'insights', label: 'Insights & Analytics', actions: [
    { key: 'insights.read', label: 'View insights / segments' },
    { key: 'analytics.read', label: 'View analytics' },
    { key: 'segments.read', label: 'View segmentation' },
    { key: 'insights.export', label: 'Export insights' },
  ]},
  { resource: 'integrations', label: 'Integrations (Webhooks / API)', actions: [
    { key: 'integrations.read', label: 'View integrations' },
    { key: 'integrations.webhooks', label: 'Manage webhooks' },
    { key: 'integrations.apiKeys', label: 'Manage API keys' },
  ]},
  { resource: 'inventory', label: 'Inventory', actions: [
    { key: 'inventory.read', label: 'View stock' },
    { key: 'inventory.write', label: 'Add / edit stock' },
    { key: 'inventory.assign', label: 'Assign / install / return' },
    { key: 'inventory.delete', label: 'Delete' },
  ]},
  { resource: 'jobs', label: 'Background Jobs', actions: [
    { key: 'jobs.read', label: 'View jobs' },
    { key: 'jobs.write', label: 'Manage jobs' },
  ]},
  { resource: 'outages', label: 'Outages & Maintenance', actions: [
    { key: 'outages.read', label: 'View status' },
    { key: 'outages.write', label: 'Classify / close / schedule' },
    { key: 'outages.notify', label: 'Notify subscribers' },
  ]},
  { resource: 'payment-gateways', label: 'Payment Gateways', actions: [
    { key: 'payment-gateways.read', label: 'View gateway settings' },
    { key: 'payment-gateways.write', label: 'Configure gateways' },
  ]},
  { resource: 'pricing', label: 'Pricing & Fees', actions: [
    { key: 'pricing.read', label: 'View fees / discounts' },
    { key: 'pricing.fees', label: 'Manage fees' },
    { key: 'pricing.discounts', label: 'Manage subscriber discounts' },
  ]},
  { resource: 'telemetry', label: 'Telemetry / NOC', actions: [
    { key: 'telemetry.read', label: 'View telemetry' },
  ]},
  { resource: 'throttle-policies', label: 'Throttle Policies', actions: [
    { key: 'throttle-policies.read', label: 'View policies' },
    { key: 'throttle-policies.write', label: 'Manage / apply policies' },
  ]},
  { resource: 'tickets', label: 'Tickets / Complaints', actions: [
    { key: 'tickets.read', label: 'View tickets' },
    { key: 'tickets.write', label: 'Reply / update' },
    { key: 'tickets.delete', label: 'Delete' },
    { key: 'tickets.sla', label: 'SLA report / backfill' },
  ]},
  { resource: 'topology', label: 'Topology', actions: [
    { key: 'topology.read', label: 'View topology' },
    { key: 'topology.write', label: 'Run MAC / parse / detect' },
  ]},
  { resource: 'vouchers', label: 'Vouchers', actions: [
    { key: 'vouchers.read', label: 'View vouchers' },
    { key: 'vouchers.create', label: 'Create vouchers' },
    { key: 'vouchers.redeem', label: 'Redeem voucher' },
    { key: 'vouchers.delete', label: 'Delete' },
  ]},
  { resource: 'organization', label: 'Organization (ISP level)', actions: [
    { key: 'organization.read', label: 'View resellers / ISPs / branches' },
    { key: 'organization.isps', label: 'Manage ISPs' },
    { key: 'organization.branches', label: 'Manage branches' },
    { key: 'organization.wallet', label: 'Wallet top-up / withdrawal' },
    { key: 'organization.limits', label: 'Set credit limits / commission' },
  ]},
  { resource: 'notes', label: 'Notes & Documents', actions: [
    { key: 'notes.view', label: 'View notes' },
    { key: 'notes.edit', label: 'Edit notes' },
    { key: 'notes.delete', label: 'Delete notes' },
    { key: 'notes.add', label: 'Add note' },
    { key: 'documents.add', label: 'Add document' },
    { key: 'documents.edit', label: 'Edit document' },
    { key: 'documents.delete', label: 'Delete document' },
    { key: 'documents.export', label: 'Export documents' },
  ]},
  { resource: 'communication', label: 'Communication & Notifications', actions: [
    { key: 'communication.read', label: 'View feed / messages' },
    { key: 'communication.send', label: 'Send messages (SMS / email)' },
    { key: 'communication.templates', label: 'Manage templates' },
    { key: 'communication.alerts', label: 'Alert configuration' },
  ]},
  { resource: 'gateway', label: 'Payment Gateway', actions: [
    { key: 'gateway.read', label: 'View transactions' },
    { key: 'gateway.initiate', label: 'Initiate payments' },
    { key: 'gateway.reconcile', label: 'Reconcile gateway' },
  ]},
  { resource: 'myprofile', label: 'My Profile', actions: [
    { key: 'myprofile.edit', label: 'Edit' },
    { key: 'myprofile.changePhoto', label: 'Change photo' },
    { key: 'myprofile.changePassword', label: 'Change password' },
    { key: 'myprofile.balanceTopup', label: 'Topup balance via gateway' },
  ]},
  { resource: 'logs', label: 'Logs', actions: [
    { key: 'logs.activity', label: 'Activity logs' },
    { key: 'logs.login', label: 'Login logs' },
    { key: 'logs.session', label: 'Session logs' },
    { key: 'logs.coa', label: 'CoA requests' },
    { key: 'logs.pgw', label: 'PGW transactions' },
    { key: 'logs.export', label: 'Export logs' },
  ]},
  { resource: 'reports', label: 'Reports & Statistics', actions: [
    { key: 'reports.sales', label: 'Sales reports' },
    { key: 'reports.payment', label: 'Payment reports' },
    { key: 'reports.bandwidth', label: 'Bandwidth usage' },
    { key: 'reports.subscriberCounter', label: 'Subscriber counter' },
    { key: 'reports.accountingCounter', label: 'Accounting counter' },
    { key: 'reports.predictions', label: 'Predictions' },
  ]},
];

export const ALL_CATALOG_KEYS = PERMISSION_CATALOG.flatMap((g) => g.actions.map((a) => a.key));

/**
 * One-click "recommended" presets — what each tier in a real ISP business is
 * normally trusted with. Load them into the Roles matrix and they become the
 * starting set; tighten from there per account.
 *
 * Keys are matrix keys (`<resource>.read|write`) plus granular keys where the
 * guard needs them (permissions.guard.ts resolves granular keys per route).
 */
const PERMISSION_PRESETS: Record<string, string[]> = {
  // ISP staff: full operations across the business, still restricted from
  // platform-level configuration (security, settings, package catalogue write).
  SALES: [
    'subscribers.read', 'subscribers.write', 'subscribers.import', 'subscribers.export',
    'subscribers.changePassword', 'subscribers.changePackage', 'subscribers.activation',
    'subscribers.customExpiry', 'subscribers.gracePeriod', 'subscribers.disconnect',
    'subscribers.changeBandwidth', 'subscribers.manageBalance', 'subscribers.enableNet',
    'subscribers.disableNet', 'subscribers.addNote', 'subscribers.addDocument',
    'invoices.read', 'invoices.write', 'payments.read', 'payments.write',
    'ledger.read', 'cashflow.read', 'accounting.read', 'billing.read',
    'areas.read', 'nas.read', 'nas.sync', 'network.read', 'network.disconnect',
    'ip-pools.read', 'static-ips.read', 'reports.sales', 'reports.payment',
    'tickets.read', 'tickets.write', 'vouchers.read', 'vouchers.redeem',
    'groups.read', 'insights.read', 'analytics.read', 'logs.activity',
    'users.read', 'packages.read', 'communication.read',
  ],
  // Franchise: everything a dealer can do, plus managing their downline,
  // their own pricing/profit, NAS and pools, and wallet operations.
  RESELLER: [
    'subscribers.read', 'subscribers.write', 'subscribers.import', 'subscribers.export',
    'subscribers.changePassword', 'subscribers.changeUsername', 'subscribers.changePackage',
    'subscribers.activation', 'subscribers.massActivation', 'subscribers.customExpiry',
    'subscribers.expirationDate', 'subscribers.gracePeriod', 'subscribers.disconnect',
    'subscribers.changeBandwidth', 'subscribers.manageBalance', 'subscribers.massPayment',
    'subscribers.massSettings', 'subscribers.discount', 'subscribers.addNote',
    'subscribers.addDocument', 'subscribers.radiusAttributes', 'subscribers.resetMac',
    'subscribers.loginLink', 'subscribers.revertInvoice', 'subscribers.enableNet',
    'subscribers.disableNet',
    'users.read', 'users.write', 'users.export', 'users.changePassword',
    'users.changeRole', 'users.topup', 'users.moveBalance', 'users.transferSubscribers',
    'users.accountingLimit', 'users.subscriberLimit', 'users.resellerLimit',
    'users.macLock', 'users.ipLock', 'users.switchProfile',
    'roles.resellerStaff',
    'packages.read', 'packages.assign', 'packages.manageProfit',
    'invoices.read', 'invoices.write', 'invoices.reverse', 'invoices.export',
    'payments.read', 'payments.write', 'payments.refund', 'payments.export',
    'ledger.read', 'ledger.export', 'cashflow.read', 'cashflow.add', 'cashflow.edit',
    'accounting.read', 'accounting.export', 'billing.read',
    'areas.read', 'areas.write', 'nas.read', 'nas.write', 'nas.sync', 'nas.share',
    'ip-pools.read', 'ip-pools.write', 'ip-pools.sync', 'ip-pools.share',
    'static-ips.read', 'static-ips.write',
    'network.read', 'network.disconnect', 'network.mac', 'boost.read', 'boost.apply', 'boost.revert',
    'compliance.read', 'compliance.updateKyc', 'compliance.verifyKyc', 'compliance.fup',
    'fiber.read', 'field-jobs.read', 'field-jobs.write',
    'groups.read', 'groups.write', 'insights.read', 'analytics.read', 'segments.read',
    'inventory.read', 'inventory.write', 'inventory.assign',
    'outages.read', 'outages.write', 'outages.notify', 'pricing.read', 'pricing.fees',
    'reports.sales', 'reports.payment', 'reports.bandwidth', 'reports.subscriberCounter',
    'reports.accountingCounter', 'reports.predictions',
    'tickets.read', 'tickets.write', 'topology.read', 'telemetry.read',
    'vouchers.read', 'vouchers.create', 'vouchers.redeem', 'logs.activity', 'logs.login',
    'organization.read',
  ],
  // Dealer: full customer operations on their own subscriber base.
  SUB_RESELLER: [
    'subscribers.read', 'subscribers.write', 'subscribers.import', 'subscribers.export',
    'subscribers.changePassword', 'subscribers.changePackage', 'subscribers.activation',
    'subscribers.customExpiry', 'subscribers.expirationDate', 'subscribers.gracePeriod',
    'subscribers.disconnect', 'subscribers.changeBandwidth', 'subscribers.manageBalance',
    'subscribers.massPayment', 'subscribers.addNote', 'subscribers.addDocument',
    'subscribers.radiusAttributes', 'subscribers.resetMac', 'subscribers.loginLink',
    'subscribers.enableNet', 'subscribers.disableNet',
    'users.read', 'users.write', 'users.changePassword', 'users.topup',
    'users.moveBalance', 'users.transferSubscribers', 'users.accountingLimit',
    'users.subscriberLimit', 'roles.resellerStaff',
    'packages.read', 'packages.assign', 'packages.manageProfit',
    'invoices.read', 'invoices.write', 'invoices.reverse', 'payments.read', 'payments.write',
    'ledger.read', 'cashflow.read', 'accounting.read', 'billing.read',
    'areas.read', 'nas.read', 'nas.sync', 'ip-pools.read', 'ip-pools.sync',
    'static-ips.read', 'static-ips.write',
    'network.read', 'network.disconnect', 'network.mac', 'boost.read', 'boost.apply',
    'compliance.read', 'compliance.updateKyc', 'compliance.fup',
    'groups.read', 'insights.read', 'analytics.read', 'segments.read',
    'inventory.read', 'inventory.write',
    'reports.sales', 'reports.payment', 'reports.subscriberCounter',
    'tickets.read', 'tickets.write', 'vouchers.read', 'vouchers.create', 'vouchers.redeem',
    'logs.activity', 'organization.read',
  ],
  // Retailer: sells to customers; activation, renewal, payments, tickets.
  RETAILER: [
    'subscribers.read', 'subscribers.write', 'subscribers.import', 'subscribers.export',
    'subscribers.changePassword', 'subscribers.changePackage', 'subscribers.activation',
    'subscribers.gracePeriod', 'subscribers.disconnect', 'subscribers.manageBalance',
    'subscribers.addNote', 'subscribers.addDocument', 'subscribers.enableNet', 'subscribers.disableNet',
    'invoices.read', 'invoices.write', 'payments.read', 'payments.write',
    'ledger.read', 'cashflow.read', 'areas.read', 'nas.read',
    'network.read', 'network.disconnect', 'ip-pools.read',
    'packages.read', 'packages.assign',
    'reports.sales', 'reports.payment', 'tickets.read', 'tickets.write',
    'vouchers.read', 'vouchers.redeem', 'users.read', 'logs.activity',
  ],
};

/** Per-role default lists used nowhere automatically — they document the tiers. */
export const ROLE_PRESET_LABELS: Record<string, string> = {
  ADMIN: 'ISP (unrestricted)',
  SALES: 'ISP staff',
  RESELLER: 'Franchise',
  SUB_RESELLER: 'Dealer',
  RETAILER: 'Retailer',
};

@Injectable()
export class SecurityService {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
    private scope: ScopeService,
  ) {}

  // ── Delegated per-child permissions ───────────────────────────
  permissionCatalog() {
    return PERMISSION_CATALOG;
  }

  /** The child's current allow/deny map. Missing key => allowed (inherits role). */
  async getChildPermissions(actor: Actor, childUserId: number) {
    await this.scope.assertUser(actor, childUserId); // must be in your subtree
    const rows = await this.prisma.userPermission.findMany({ where: { userId: childUserId } });
    const map: Record<string, boolean> = {};
    for (const r of rows) map[r.permission] = r.allowed;
    return map; // e.g. { "subscribers.delete": false }
  }

  /** Set the child's permissions. `denied` = list of keys to block; everything else allowed. */
  async setChildPermissions(actor: Actor, childUserId: number, denied: string[]) {
    await this.scope.assertUser(actor, childUserId);
    const validKeys = new Set(PERMISSION_CATALOG.flatMap((g) => g.actions.map((a) => a.key)));
    const clean = [...new Set(denied)].filter((k) => validKeys.has(k));
    await this.prisma.$transaction([
      this.prisma.userPermission.deleteMany({ where: { userId: childUserId } }),
      ...(clean.length
        ? [this.prisma.userPermission.createMany({ data: clean.map((permission) => ({ userId: childUserId, permission, allowed: false })) })]
        : []),
    ]);
    await this.cache.del?.(`uperm:${childUserId}`);
    return { userId: childUserId, denied: clean };
  }

  /** True unless the user has an explicit deny for this permission key. */
  async can(userId: number, permission: string): Promise<boolean> {
    const row = await this.prisma.userPermission.findUnique({
      where: { userId_permission: { userId, permission } },
    });
    return row ? row.allowed : true;
  }

  async assertCan(actor: Actor, permission: string) {
    if (this.scope.isAdmin(actor?.role)) return; // ISP/admin bypass
    const uid = this.scope.actorId(actor);
    if (!(await this.can(uid, permission))) {
      throw new ForbiddenException(`Your account is not allowed to: ${permission}`);
    }
  }

  // ── Permissions matrix ────────────────────────────────────────
  meta() {
    return { resources: RESOURCES, roles: ROLES, actions: ['read', 'write'] };
  }

  async getMatrix() {
    const rows = await this.prisma.rolePermission.findMany();
    const matrix: Record<string, string[]> = {};
    for (const role of ROLES) matrix[role] = [];
    for (const r of rows) (matrix[r.role] ??= []).push(r.permission);
    return matrix;
  }

  /** Replace a role's permission set atomically. Empty list = unrestricted. */
  async setRolePermissions(role: string, permissions: string[]) {
    if (!ROLES.includes(role)) throw new BadRequestException(`Unknown role ${role}`);
    const clean = [...new Set(permissions.map((p) => String(p).trim()).filter(Boolean))];
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { role } }),
      ...(clean.length
        ? [this.prisma.rolePermission.createMany({ data: clean.map((permission) => ({ role, permission })) })]
        : []),
    ]);
    await this.cache.del(`rbac:${role}`);
    return { role, permissions: clean, unrestricted: clean.length === 0 };
  }

  /**
   * Recommended permission sets per tier, for one-click provisioning.
   * Returns the preset map plus what each role is for, so the UI can offer
   * "load recommended set" instead of hand-building a matrix from scratch.
   */
  presets() {
    return {
      roles: PERMISSION_PRESETS,
      labels: ROLE_PRESET_LABELS,
      catalogKeys: ALL_CATALOG_KEYS,
    };
  }

  /** Load a tier's recommended set into a role (same atomic replace as manual save). */
  applyPreset(role: string) {
    const key = role.toUpperCase();
    if (!ROLES.includes(key)) throw new BadRequestException(`Unknown role ${key}`);
    const preset = PERMISSION_PRESETS[key];
    if (!preset) throw new BadRequestException(`No preset defined for ${key}`);
    return this.setRolePermissions(key, preset);
  }

  /** Catalog groups, so the UI can render section headers with labels. */
  catalogGroups() {
    return PERMISSION_CATALOG;
  }

  // ── Two-factor authentication ─────────────────────────────────
  async twoFactorStatus(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { twoFactorEnabled: true } });
    return { enabled: user?.twoFactorEnabled ?? false };
  }

  /** Step 1: generate a secret (not yet active). Returns manual key + otpauth URL. */
  async enrollTwoFactor(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    const secret = generateSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorSecret: secret, twoFactorEnabled: false } });
    return {
      secret,
      otpauth: otpauthUrl(secret, user.email),
      note: 'Add to Google Authenticator (or any TOTP app), then confirm with a code to activate.',
    };
  }

  /** Step 2: confirm with a live code → 2FA becomes required at login. */
  async confirmTwoFactor(userId: number, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.twoFactorSecret) throw new BadRequestException('Enroll first');
    if (!verifyTotp(user.twoFactorSecret, code)) throw new BadRequestException('Invalid code');
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
    await this.prisma.activityLog.create({ data: { userId, action: 'ENABLE_2FA', entity: 'User', entityId: userId } });
    return { enabled: true };
  }

  async disableTwoFactor(userId: number, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.twoFactorEnabled) return { enabled: false };
    if (!verifyTotp(user.twoFactorSecret!, code)) throw new BadRequestException('Invalid code');
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
    await this.prisma.activityLog.create({ data: { userId, action: 'DISABLE_2FA', entity: 'User', entityId: userId } });
    return { enabled: false };
  }

  // ── Active sessions / remote logout ───────────────────────────
  async activeSessions() {
    return this.prisma.sessionLog.findMany({
      where: { isActive: true, expiresAt: { gt: new Date() } },
      include: { user: { select: { name: true, email: true, role: true } } },
      orderBy: { lastActiveAt: 'desc' },
    });
  }

  async killSession(sessionId: string, byUserId?: number) {
    await this.prisma.sessionLog.update({
      where: { sessionId },
      data: { isActive: false, logoutAt: new Date() },
    });
    await this.prisma.activityLog.create({
      data: { userId: byUserId, action: 'REMOTE_LOGOUT', entity: 'Session', details: sessionId },
    });
    return { killed: true };
  }
}

/** Password policy shared with users/auth flows. */
export function validatePassword(password: string): string | null {
  const minLen = Number(process.env.PASSWORD_MIN_LENGTH) || 8;
  if (!password || password.length < minLen) return `Password must be at least ${minLen} characters`;
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return 'Password must contain letters and numbers';
  return null;
}
