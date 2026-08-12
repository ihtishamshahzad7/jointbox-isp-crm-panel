import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache.service';
import { ScopeService, Actor } from '../common/scope.service';
import { generateSecret, otpauthUrl, verifyTotp } from './totp';

const RESOURCES = [
  'subscribers', 'packages', 'invoices', 'payments', 'accounting', 'billing',
  'communication', 'gateway', 'vouchers', 'tickets', 'nas', 'ip-pool',
  'areas', 'users', 'logs', 'reports', 'service-settings', 'security',
];
const ROLES = ['ADMIN', 'SALES', 'RESELLER', 'SUB_RESELLER', 'RETAILER'];

// Catalog a parent uses to control a child: feature rows with toggleable actions.
// Full Zal-Pro-style set. Untick a key to DENY that capability for the child.
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
    { key: 'users.topup', label: 'Add / manage balance' },
    { key: 'users.transferSubscribers', label: 'Transfer subscribers' },
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
  { resource: 'areas', label: 'Areas', actions: [
    { key: 'areas.read', label: 'View' },
    { key: 'areas.write', label: 'Manage' },
  ]},
  { resource: 'nas', label: 'NAS / Routers', actions: [
    { key: 'nas.read', label: 'View NAS devices' },
    { key: 'nas.write', label: 'Add / edit NAS' },
    { key: 'nas.delete', label: 'Delete NAS' },
    { key: 'nas.sync', label: 'Sync / test NAS connection' },
  ]},
  { resource: 'network', label: 'Network', actions: [
    { key: 'network.read', label: 'View live network' },
    { key: 'network.disconnect', label: 'Disconnect users' },
    { key: 'network.liveGraph', label: 'View live graph' },
    { key: 'network.interfaceGraph', label: 'View NAS interface graph' },
  ]},
  { resource: 'reports', label: 'Reports & Statistics', actions: [
    { key: 'reports.sales', label: 'Sales reports' },
    { key: 'reports.payment', label: 'Payment reports' },
    { key: 'reports.bandwidth', label: 'Bandwidth usage' },
    { key: 'reports.subscriberCounter', label: 'Subscriber counter' },
    { key: 'reports.accountingCounter', label: 'Accounting counter' },
    { key: 'reports.predictions', label: 'Predictions' },
  ]},
  { resource: 'logs', label: 'Logs', actions: [
    { key: 'logs.activity', label: 'Activity logs' },
    { key: 'logs.login', label: 'Login logs' },
    { key: 'logs.session', label: 'Session logs' },
    { key: 'logs.coa', label: 'CoA requests' },
    { key: 'logs.pgw', label: 'PGW transactions' },
    { key: 'logs.export', label: 'Export logs' },
  ]},
  { resource: 'documents', label: 'Documents & Notes', actions: [
    { key: 'documents.add', label: 'Add' },
    { key: 'documents.edit', label: 'Edit' },
    { key: 'documents.delete', label: 'Delete' },
    { key: 'documents.export', label: 'Export' },
    { key: 'notes.view', label: 'View notes' },
    { key: 'notes.edit', label: 'Edit notes' },
    { key: 'notes.delete', label: 'Delete notes' },
  ]},
  { resource: 'myprofile', label: 'My Profile', actions: [
    { key: 'myprofile.edit', label: 'Edit' },
    { key: 'myprofile.changePhoto', label: 'Change photo' },
    { key: 'myprofile.changePassword', label: 'Change password' },
    { key: 'myprofile.balanceTopup', label: 'Topup balance via gateway' },
  ]},
];

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
