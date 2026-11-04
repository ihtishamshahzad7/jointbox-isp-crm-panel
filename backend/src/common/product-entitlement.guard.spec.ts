import { ForbiddenException } from '@nestjs/common';
import { ProductEntitlementGuard } from './product-entitlement.guard';

describe('ProductEntitlementGuard', () => {
  const context = {
    getHandler: () => 'handler',
    getClass: () => 'controller',
    switchToHttp: () => ({
      getRequest: () => ({ user: { sub: 10, role: 'ADMIN' } }),
    }),
  };

  it('enforces a declared backend product entitlement', async () => {
    const reflector = { getAllAndOverride: jest.fn(() => 'crm-advanced') };
    const entitlements = {
      assertEnabled: jest.fn(() => Promise.resolve({ enabled: true })),
    };
    const guard = new ProductEntitlementGuard(
      reflector as never,
      entitlements as never,
    );
    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(entitlements.assertEnabled).toHaveBeenCalledWith(
      { sub: 10, role: 'ADMIN' },
      'crm-advanced',
    );
  });

  it('propagates an explicit disabled entitlement and does not silently allow it', async () => {
    const reflector = { getAllAndOverride: jest.fn(() => 'crm-advanced') };
    const entitlements = {
      assertEnabled: jest.fn(() => {
        throw new ForbiddenException();
      }),
    };
    const guard = new ProductEntitlementGuard(
      reflector as never,
      entitlements as never,
    );
    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('leaves unmarked routes unchanged', async () => {
    const reflector = { getAllAndOverride: jest.fn(() => undefined) };
    const entitlements = { assertEnabled: jest.fn() };
    const guard = new ProductEntitlementGuard(
      reflector as never,
      entitlements as never,
    );
    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(entitlements.assertEnabled).not.toHaveBeenCalled();
  });
});
