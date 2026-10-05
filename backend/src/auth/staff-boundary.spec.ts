import { ForbiddenException } from '@nestjs/common';
import { ScopeService } from '../common/scope.service';
import { AuthService } from './auth.service';

/**
 * Staff (SALES) work inside their owner's scope, so the plain subtree check
 * admitted the owner itself. Found on a running panel: a company's staff
 * member could sign in AS the company (POST /auth/impersonate/<company>),
 * reset its password, suspend it, or rewrite its permissions.
 *
 *   10 company (ADMIN) ─┬─ 11 staff (SALES)
 *                       └─ 12 franchise ── 13 dealer
 */
const USERS: Record<number, any> = {
  10: { id: 10, role: 'ADMIN', parentId: 1, name: 'Co', email: 'c@x.pk' },
  11: { id: 11, role: 'SALES', parentId: 10, name: 'Staff', email: 's@x.pk' },
  12: { id: 12, role: 'RESELLER', parentId: 10, name: 'Fr', email: 'f@x.pk' },
  13: { id: 13, role: 'SUB_RESELLER', parentId: 12, name: 'De', email: 'd@x.pk' },
};
const TREE: Record<number, number[]> = { 10: [10, 11, 12, 13], 11: [11], 12: [12, 13], 13: [13] };

function scopeWith() {
  const prisma: any = { user: { findUnique: jest.fn(async ({ where }: any) => USERS[where.id] ?? null) } };
  const scope = new ScopeService(prisma);
  jest.spyOn(scope, 'descendantIds').mockImplementation(async (id: number) => TREE[id] ?? [id]);
  return { prisma, scope };
}

describe('staff never manage the account they work for', () => {
  it('assertUserWritable refuses the owner, allows the business beneath it', async () => {
    const { scope } = scopeWith();
    const staff = { sub: 11, role: 'SALES' } as any;
    await expect(scope.assertUser(staff, 10)).resolves.toBeUndefined(); // can still SEE it
    await expect(scope.assertUserWritable(staff, 10)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(scope.assertUserWritable(staff, 12)).resolves.toBeUndefined();
  });

  it('staff cannot switch into any account; nobody switches into a company or upward', async () => {
    const { prisma, scope } = scopeWith();
    prisma.activityLog = { create: jest.fn(() => ({ catch: () => undefined })) };
    const auth = new AuthService(prisma, { sign: () => 'T' } as any, {} as any, scope, {} as any);
    await expect(auth.impersonate({ sub: 11, role: 'SALES' }, 10)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(auth.impersonate({ sub: 11, role: 'SALES' }, 12)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(auth.impersonate({ sub: 13, role: 'SUB_RESELLER' }, 12)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(auth.impersonate({ sub: 10, role: 'ADMIN' }, 13)).resolves.toMatchObject({ impersonating: true });
  });
});
