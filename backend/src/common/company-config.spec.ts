import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ScopeService } from './scope.service';

/**
 * COMPANY-OWNED CONFIGURATION — the rules every template / tax / fee /
 * throttle-policy route relies on (ScopeService.config*).
 *
 *   1 SUPER_ADMIN ─┬─ 10 ADMIN (company A) ─┬─ 12 SALES (A's staff)
 *                  │                         └─ 11 RESELLER ── 13 SUB_RESELLER
 *                  └─ 20 ADMIN (company B)
 */
const USERS: Record<number, { parentId: number | null; role: string }> = {
  1: { parentId: null, role: 'SUPER_ADMIN' },
  10: { parentId: 1, role: 'ADMIN' },
  11: { parentId: 10, role: 'RESELLER' },
  12: { parentId: 10, role: 'SALES' },
  13: { parentId: 11, role: 'SUB_RESELLER' },
  20: { parentId: 1, role: 'ADMIN' },
};

function scope() {
  const prisma: any = {
    $queryRaw: jest.fn(async (q: any, ...vals: any[]) => {
      const out: number[] = [];
      for (let cur: number | null = Number(vals[0]); cur != null && USERS[cur]; cur = USERS[cur].parentId) out.push(cur);
      return out.map((id) => ({ id }));
    }),
    user: {
      findMany: jest.fn(async ({ where }: any) => where.id.in.map((id: number) => ({ id, role: USERS[id]?.role }))),
      findUnique: jest.fn(async ({ where }: any) => ({ parentId: USERS[where.id]?.parentId ?? null })),
    },
  };
  return new ScopeService(prisma);
}

const A = { sub: 10, role: 'ADMIN' };
const A_STAFF = { sub: 12, role: 'SALES' };
const A_DEALER = { sub: 11, role: 'RESELLER' };
const A_SUBDEALER = { sub: 13, role: 'SUB_RESELLER' };
const B = { sub: 20, role: 'ADMIN' };
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };

describe('company-owned configuration rules', () => {
  it('everyone in a company resolves to the same company root', async () => {
    const s = scope();
    for (const u of [10, 11, 12, 13]) expect(await s.companyRootId(u)).toBe(10);
    expect(await s.companyRootId(20)).toBe(20);
    expect(await s.companyRootId(1)).toBeNull();
  });

  it('reads: platform defaults plus the own company; the platform owner reads all', async () => {
    const s = scope();
    expect(await s.configReadWhere(A_SUBDEALER)).toEqual({ OR: [{ ownerId: null }, { ownerId: 10 }] });
    expect(await s.configReadWhere(B)).toEqual({ OR: [{ ownerId: null }, { ownerId: 20 }] });
    expect(await s.configReadWhere(OWNER)).toEqual({});
  });

  it('creating: the company admin and its staff create for the company; dealers may not', async () => {
    const s = scope();
    expect(await s.configOwnerForCreate(A)).toBe(10);
    expect(await s.configOwnerForCreate(A_STAFF)).toBe(10);
    expect(await s.configOwnerForCreate(OWNER)).toBeNull();
    await expect(s.configOwnerForCreate(A_DEALER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.configOwnerForCreate(A_SUBDEALER)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('editing: own rows only; a platform default is the platform owner\'s; another company\'s is not found', async () => {
    const s = scope();
    await expect(s.assertConfigWritable(A, { ownerId: 10 })).resolves.toBeUndefined();
    await expect(s.assertConfigWritable(A, { ownerId: null })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.assertConfigWritable(B, { ownerId: 10 })).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.assertConfigWritable(A_DEALER, { ownerId: 10 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.assertConfigWritable(OWNER, { ownerId: 10 })).resolves.toBeUndefined();
    await expect(s.assertConfigWritable(OWNER, null)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reading one row: defaults and own are readable, another company\'s is not found', async () => {
    const s = scope();
    await expect(s.assertConfigReadable(A_DEALER, { ownerId: null })).resolves.toBeUndefined();
    await expect(s.assertConfigReadable(A_DEALER, { ownerId: 10 })).resolves.toBeUndefined();
    await expect(s.assertConfigReadable(B, { ownerId: 10 })).rejects.toBeInstanceOf(NotFoundException);
  });
});
