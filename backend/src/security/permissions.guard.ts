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
 * Rules: SUPER_ADMIN bypasses. A role with no RolePermission rows is
 * unrestricted (nothing breaks until you configure the matrix). Once a role
 * has rows, it needs `<resource>.<action>`, `<resource>.*`, or `*` to pass.
 */
/**
 * Resources only an ISP-level account may ever WRITE, regardless of the
 * RolePermission matrix.
 *
 * This exists because the matrix fails OPEN: a role with no rows is treated as
 * unrestricted. On a fresh deployment that table is empty, so until someone
 * discovers and configures it, every reseller can write everything — including
 * `DELETE /packages/:id`, which removes a package the whole downline sells.
 * "Nothing breaks until you configure it" is a reasonable default for reporting
 * screens; it is not a reasonable default for the catalogue and the platform
 * config, where one call by one dealer damages every account above and below.
 *
 * A floor cannot be switched off by leaving a table empty.
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

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const role: string | undefined = req.user?.role;
    if (!role) return true; // unauthenticated routes are handled by their own guards
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
      const denied = await this.cache.wrap<string[]>(`uperm:${userId}`, 15, async () => {
        const rows = await this.prisma.userPermission.findMany({
          where: { userId, allowed: false }, select: { permission: true },
        });
        return rows.map((r) => r.permission);
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
    if (!perms.length) return true; // unconfigured role = unrestricted (deny-list still applied above)

    if (perms.includes('*') || perms.includes(`${resource}.*`) || perms.includes(needed)) return true;
    // write permission implies read
    if (action === 'read' && perms.includes(`${resource}.write`)) return true;

    throw new ForbiddenException(`Missing permission: ${needed}`);
  }
}
