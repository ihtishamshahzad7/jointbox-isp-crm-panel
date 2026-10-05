import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';

function context(user: any, method = 'GET', url = '/subscribers') {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user, method, url, route: { path: url } }),
    }),
  } as unknown as ExecutionContext;
}

function make(rolePermissions: string[] = [], denied: string[] = []) {
  const prisma = {
    rolePermission: {
      findMany: jest.fn().mockResolvedValue(rolePermissions.map((permission) => ({ permission }))),
    },
    userPermission: {
      findMany: jest.fn().mockResolvedValue(denied.map((permission) => ({ permission }))),
    },
  } as any;

  const cache = {
    wrap: jest.fn().mockImplementation(async (_key: string, _ttl: number, factory: () => Promise<any>) => factory()),
  } as any;

  return { guard: new PermissionsGuard(prisma, cache), prisma, cache };
}

describe('PermissionsGuard fail-closed authorization', () => {
  it('does not make an unauthenticated request authenticated', async () => {
    const { guard } = make();
    await expect(guard.canActivate(context(undefined))).resolves.toBe(true);
  });

  it('rejects an authenticated principal without an operator role', async () => {
    const { guard } = make();
    await expect(guard.canActivate(context({ sub: 10 }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a role with an empty permission set', async () => {
    const { guard } = make([], []);
    await expect(guard.canActivate(context({ sub: 10, role: 'SALES' }))).rejects.toThrow(
      'No permissions are configured for this role',
    );
  });

  it('allows an explicitly configured wildcard role', async () => {
    const { guard } = make(['*']);
    await expect(guard.canActivate(context({ sub: 10, role: 'ADMIN' }))).resolves.toBe(true);
  });

  it('still applies explicit child denies before the role grant', async () => {
    const { guard } = make(['*'], ['subscribers.read']);
    await expect(guard.canActivate(context({ sub: 10, role: 'SALES' }))).rejects.toThrow(
      'Your account is not allowed to',
    );
  });
});
