import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UsersService } from './users.service';

/**
 * Found on a running panel:
 *  - a retailer sent PUT /users/<itself> { parentId: <platform>, role: 'ADMIN' }
 *    and became a company of its own;
 *  - a franchise moved its dealer under ANOTHER company's account;
 *  - an account set its own creditLimit / canTopupDownline / isDemo, because
 *    the body was spread straight into the update.
 *
 *   1 platform · 10 company A · 11 franchise · 12 dealer · 13 retailer · 20 company B
 */
const USERS: Record<number, any> = {
  1: { id: 1, role: 'SUPER_ADMIN', parentId: null },
  10: { id: 10, role: 'ADMIN', parentId: 1 },
  11: { id: 11, role: 'RESELLER', parentId: 10, email: 'f@x.pk' },
  12: { id: 12, role: 'SUB_RESELLER', parentId: 11, email: 'd@x.pk' },
  13: { id: 13, role: 'RETAILER', parentId: 12, email: 'r@x.pk', isActive: true, commissionPercent: 0 },
  20: { id: 20, role: 'ADMIN', parentId: 1 },
};
const TREE: Record<number, number[]> = { 10: [10, 11, 12, 13], 11: [11, 12, 13], 12: [12, 13], 13: [13], 20: [20] };

function make() {
  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => (where.id ? USERS[where.id] ?? null : null)),
      update: jest.fn(async ({ data }: any) => ({ id: 0, ...data })),
      count: jest.fn(async () => 0),
    },
  };
  const scope: any = {
    isAdmin: (r: string) => r === 'SUPER_ADMIN',
    isOwner: (r: string) => r === 'SUPER_ADMIN' || r === 'ADMIN',
    actorId: (a: any) => Number(a.sub),
    assertUser: jest.fn(async (a: any, id: number) => {
      if (!(TREE[Number(a.sub)] ?? []).includes(id)) throw new ForbiddenException('outside');
    }),
  };
  return { prisma, svc: new UsersService(prisma, scope) };
}
const as = (sub: number) => ({ sub, role: USERS[sub].role }) as any;

describe('editing an account', () => {
  it('an account cannot re-home or re-rank itself', async () => {
    const { svc, prisma } = make();
    await expect(svc.update(13, { parentId: 1, role: 'ADMIN' } as any, as(13))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.update(13, { parentId: 20 } as any, as(13))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.update(13, { commissionPercent: 50 } as any, as(13))).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('unchanged place and role sent back by the form are fine', async () => {
    const { svc, prisma } = make();
    await svc.update(13, { name: 'Me', parentId: 12, role: 'RETAILER', isActive: true } as any, as(13));
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ name: 'Me' });
  });

  it('fields the form does not edit are dropped', async () => {
    const { svc, prisma } = make();
    await svc.update(13, { name: 'x', creditLimit: 99999, canTopupDownline: true, isDemo: true, balance: 5 } as any, as(12));
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ name: 'x' });
  });

  it("an account cannot be moved under another company's account", async () => {
    const { svc, prisma } = make();
    await expect(svc.update(12, { parentId: 20 } as any, as(11))).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('a move must still fit the ladder', async () => {
    const { svc } = make();
    // a dealer moved directly under the company skips the franchise rung
    await expect(svc.update(12, { parentId: 10 } as any, as(10))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('nobody edits an account into a company', async () => {
    const { svc } = make();
    await expect(svc.update(11, { role: 'ADMIN' } as any, as(10))).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('changing your own password through the account form', () => {
  it('needs the current password', async () => {
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash('Old#Pass123', 4);
    USERS[13].password = hash;
    const { svc, prisma } = make();
    await expect(svc.update(13, { password: 'N3w!Passw0rd#' } as any, as(13))).rejects.toThrow(/current password/);
    await expect(svc.update(13, { password: 'N3w!Passw0rd#', currentPassword: 'wrong' } as any, as(13))).rejects.toThrow(/current password/);
    await svc.update(13, { password: 'N3w!Passw0rd#', currentPassword: 'Old#Pass123' } as any, as(13));
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    delete USERS[13].password;
  });
});
