import type { PermissionsGuard } from '../security/permissions.guard';
import type { Actor } from './scope.service';

/**
 * May `actor` READ the screen `resource` belongs to (subscribers, payments…)?
 *
 * Asks the real PermissionsGuard with a synthetic GET, so the deny chain, the
 * role matrix and the auditor floor are the SAME rules that protect that
 * screen — there is no second copy to drift out of step. Any refusal → false.
 */
export async function canRead(perms: PermissionsGuard, actor: Actor, resource: string): Promise<boolean> {
  const req = { user: actor, method: 'GET', url: `/${resource}`, originalUrl: `/${resource}`, body: {} };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as never;
  try {
    return (await perms.canActivate(ctx)) === true;
  } catch {
    return false;
  }
}

/** May `actor` WRITE to `resource`? Same guard, synthetic POST (auditor floor, ISP-only writes, deny chain). */
export async function canWrite(perms: PermissionsGuard, actor: Actor, resource: string): Promise<boolean> {
  const req = { user: actor, method: 'POST', url: `/${resource}`, originalUrl: `/${resource}`, body: {} };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as never;
  try {
    return (await perms.canActivate(ctx)) === true;
  } catch {
    return false;
  }
}
