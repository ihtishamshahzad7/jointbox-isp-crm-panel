import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache.service';
import { permissionForRoute } from './route-permissions';

/**
 * Phase 4A auto-keyed permission guard. Use AFTER JwtAuthGuard:
 *   @UseGuards(JwtAuthGuard, PermissionsGuard)
 *
 * Permission key is derived automatically — no per-endpoint decorators needed:
 *   resource = first URL segment ("subscribers", "accounting", …)
 *   action   = GET → read, anything else → write
 *
 * Rules: SUPER_ADMIN bypasses. Every other operator role is FAIL-CLOSED:
 * it needs `<resource>.<action>`, `<resource>.*`, or `*` to pass.
 *
 * A fresh installation is bootstrapped with the reviewed role presets before
 * HTTP starts, so fail-closed never means "fresh install is unusable".
 */
/**
 * Resources only an ISP-level account may ever WRITE, regardless of the
 * RolePermission matrix.
 *
 * This floor remains defence-in-depth even when the role matrix is configured.
 * It prevents a reseller/dealer from writing installation-level catalogue and
 * platform configuration even if a future role preset accidentally grants a
 * broad resource permission.
 */
const ISP_ONLY_WRITE = new Set([
  'packages',   // the catalogue every tier resells
  'isps',
  'branches',
  'security',   // roles, permission matrix, audit config
  'settings',
  'backup',
]);

const ISP_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
  ) {}

  /** This account and every account above it, up to (not including) the platform. */
  private async chainIds(userId: number): Promise<number[]> {
    if (typeof (this.prisma as any).$queryRaw !== 'function') return [userId];
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: number }>>`
        WITH RECURSIVE up AS (
          SELECT id, "parentId", role, 0 AS depth FROM "User" WHERE id = ${userId}
          UNION ALL
          SELECT p.id, p."parentId", p.role, up.depth + 1 FROM "User" p JOIN up ON p.id = up."parentId"
          WHERE up.depth < 20
        )
        SELECT id FROM up WHERE role <> 'SUPER_ADMIN'`;
      const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
      return ids.length ? ids : [userId];
    } catch {
      return [userId];
    }
  }

  /**
   * A SWITCHED-IN SESSION ("act as", or the platform signed in as a company)
   * may work inside the account, but must not leave a way back in behind it:
   * no API keys, no passwords set, no accounts wiped — and the platform may
   * not create new logins inside a company. Switch back to your own account
   * (or ask the account's owner) to do these.
   */
  static refuseLastingAccessWhileActingAs(req: any): void {
    const path = String(req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '');
    const m = String(req.method || '').toUpperCase();
    const body = req.body || {};
    const byPlatform = req.user?.imp?.byRole === 'SUPER_ADMIN';
    let what: string | null = null;
    if (m === 'POST' && /\/integrations\/api-keys$/.test(path)) what = 'create an API key';
    else if (m === 'POST' && /\/users\/\d+\/purge$/.test(path)) what = 'wipe an account';
    else if ((m === 'PUT' || m === 'PATCH') && /\/users\/\d+$/.test(path) && typeof body.password === 'string' && body.password !== '') what = 'set a password';
    else if (byPlatform && m === 'POST' && /\/users$/.test(path)) what = 'create a login inside this company';
    if (what) {
      throw new ForbiddenException(
        `You are signed in as another account, so you cannot ${what} from here. ` +
        (byPlatform ? 'Ask the company to do it from its own login.' : 'Switch back to your own account to do it.'),
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    /**
     * FAIL CLOSED ON AN AUTHENTICATED PRINCIPAL WITH NO ROLE.
     *
     * This used to be `if (!role) return true`, reasoning that a request with
     * no role must be an unauthenticated route whose own guard decides. That
     * holds for `req.user === undefined`. It does NOT hold once something has
     * authenticated and simply has no role — which is exactly the shape of a
     * subscriber portal token (see jwt.strategy.ts). The permission matrix,
     * the AUDITOR floor and ISP_ONLY_WRITE were all skipped for precisely the
     * principal that should never have reached an operator route.
     *
     * So: no principal at all → still defer to the route's own guard. A
     * principal that authenticated but carries no operator role → refuse.
     */
    if (!req.user) return true; // genuinely unauthenticated — the route's own guard decides
    const role: string | undefined = req.user.role;
    if (!role) {
      throw new ForbiddenException('This account is not an operator account.');
    }
    if (req.user.imp) PermissionsGuard.refuseLastingAccessWhileActingAs(req);
    if (role === 'SUPER_ADMIN') return true;

    const requestPath = (req.url || '').split('?')[0] || String(req.route?.path || '');
    const resource = requestPath.split('/').filter(Boolean)[0] || '';
    const action = req.method === 'GET' ? 'read' : 'write';
    const needed = `${resource}.${action}`;

    /**
     * AUDITOR is read-only everywhere. This floor is applied before the matrix
     * so it can't be widened by RolePermission rows or an empty table — an
     * accountant can inspect the whole subtree but never write, edit, refund,
     * approve, or move money. GET (read) passes through to normal scoping.
     */
    if (role === 'AUDITOR' && action === 'write') {
      throw new ForbiddenException(
        'Your account has read-only (auditor) access. You can view the books and reports but cannot make changes.',
      );
    }

    /**
     * HARD FLOOR — applied before the matrix is consulted, so an empty or
     * misconfigured RolePermission table cannot open these up.
     */
    if (action === 'write' && ISP_ONLY_WRITE.has(resource) && !ISP_ROLES.has(role)) {
      throw new ForbiddenException(
        `Only the ISP can change ${resource}. Your account can use what the ISP publishes, ` +
        `but not create, edit or delete it.`,
      );
    }

    // Delegated per-child deny FIRST (always applies, even if the role is
    // unconfigured): a parent may have blocked this capability for this user.
    const userId: number | undefined = req.user?.sub;
    if (userId) {
      // Short TTL so a permission change a parent just saved takes effect
      // quickly; setChildPermissions also busts this key on save.
      /**
       * INHERITED. A block set on an account applies to everyone under it —
       * its dealers, retailers and staff. It used to bind the one account it
       * was set on, so a franchise blocked from exporting customers could hire
       * a staff member (who has no rows of its own) and export through it. A
       * block the platform sets on a company switches the feature off for the
       * whole company.
       */
      const denied = await this.cache.wrap<string[]>(`uperm:${userId}`, 15, async () => {
        const chain = await this.chainIds(Number(userId));
        const rows = await this.prisma.userPermission.findMany({
          where: { userId: { in: chain }, allowed: false }, select: { permission: true },
        });
        return [...new Set(rows.map((r) => r.permission))];
      });
      const denySet = new Set(denied);
      // Check three things, so a denial bites no matter how it was keyed:
      //   • the coarse key            (subscribers.read / subscribers.write)
      //   • the exact action's key    (subscribers.massDelete, users.delete…)
      //   • for writes, the resource's own read gate — if you can't even VIEW
      //     subscribers you certainly can't write them.
      const granular = permissionForRoute(req.method, requestPath);
      const readKey = `${resource}.read`;
      if (
        denySet.has(needed) ||
        (granular && denySet.has(granular)) ||
        (action === 'write' && denySet.has(readKey))
      ) {
        const what = granular || needed;
        throw new ForbiddenException(`Your account is not allowed to: ${what.replace('.', ' → ')}.`);
      }
    }

    const perms = await this.cache.wrap<string[]>(`rbac:${role}`, 30, async () => {
      const rows = await this.prisma.rolePermission.findMany({ where: { role }, select: { permission: true } });
      return rows.map((r) => r.permission);
    });
    // FAIL CLOSED. Empty RolePermission state is not an authorization grant.
    // The startup bootstrap creates the reviewed defaults on a fresh install;
    // if the table is later cleared or a new role is introduced without a
    // reviewed preset, that role must lose access rather than inherit it.
    if (!perms.length) {
      throw new ForbiddenException(
        'No permissions are configured for this role. Ask the platform owner to configure it.',
      );
    }

    if (perms.includes('*') || perms.includes(`${resource}.*`) || perms.includes(needed)) return true;
    // Granular keys saved into the role matrix (e.g. a preset loaded for
    // "subscribers.import") grant exactly that action, not the whole resource.
    const granular = permissionForRoute(req.method, requestPath);
    if (granular && perms.includes(granular)) return true;
    // write permission implies read
    if (action === 'read' && perms.includes(`${resource}.write`)) return true;

    throw new ForbiddenException(`Missing permission: ${needed}`);
  }
}
