import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { AuthService } from '../auth/auth.service';

/**
 * The platform account manages COMPANIES — and nobody inside them.
 *
 *   1 SUPER_ADMIN ── 10 ADMIN (company) ── 11 RESELLER
 */
const PLATFORM = { sub: 1, role: 'SUPER_ADMIN' } as any;
const USERS: Record<number, any> = {
  1: { id: 1, role: 'SUPER_ADMIN', parentId: null, email: 'p@x.pk', name: 'Platform' },
  10: { id: 10, role: 'ADMIN', parentId: 1, email: 'c@x.pk', name: 'Company', balance: 0 },
  11: { id: 11, role: 'RESELLER', parentId: 10, email: 'r@x.pk', name: 'Franchise', balance: 0 },
};

function make() {
  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => (where.id ? USERS[where.id] ?? null : null)),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => ({ id: 99, ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 10, ...data })),
      count: jest.fn(async () => 0),
      groupBy: jest.fn(async () => []),
    },
    loginLog: { groupBy: jest.fn(async () => []) },
    payment: { groupBy: jest.fn(async () => []) },
    ticket: { groupBy: jest.fn(async () => []) },
    subscriber: { count: jest.fn(async () => 0), groupBy: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => []),
    activityLog: { create: jest.fn(async () => ({})) },
  };
  const scope: any = {
    isAdmin: (r: string) => r === 'SUPER_ADMIN',
    isOwner: (r: string) => r === 'SUPER_ADMIN' || r === 'ADMIN',
    actorId: (a: any) => Number(a?.sub),
    assertUser: jest.fn(async () => undefined),
  };
  return { prisma, scope, svc: new UsersService(prisma, scope) };
}

describe('platform account vs the people inside companies', () => {
  it('lists companies only', async () => {
    const { svc, prisma } = make();
    await svc.findAll(PLATFORM);
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ role: 'ADMIN', isDemo: false });
  });

  it("cannot open, edit, suspend or delete a company's franchise — not found", async () => {
    const { svc, prisma } = make();
    await expect(svc.findOne(11, PLATFORM)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.update(11, { name: 'x' }, PLATFORM)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.toggleStatus(11, PLATFORM)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.delete(11, PLATFORM)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.purgeAccount(PLATFORM, 11, { dryRun: true })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('creates companies only, always directly under itself', async () => {
    const { svc, prisma } = make();
    for (const role of ['RESELLER', 'SALES', 'AUDITOR']) {
      await expect(svc.create({ name: 'n', email: `${role}@x.pk`, password: 'Str0ng!Pass#1', role }, PLATFORM))
        .rejects.toBeInstanceOf(BadRequestException);
    }
    await svc.create({ name: 'ISP', email: 'isp@x.pk', password: 'Str0ng!Pass#1', role: 'ADMIN', parentId: 10 }, PLATFORM);
    expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({ role: 'ADMIN', parentId: 1 });
  });

  it("edits a company's details and password, never its role or place", async () => {
    const { svc, prisma } = make();
    await expect(svc.update(10, { role: 'SUPER_ADMIN' }, PLATFORM)).rejects.toBeInstanceOf(BadRequestException);
    await svc.update(10, { name: 'Renamed', parentId: 11 } as any, PLATFORM);
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.name).toBe('Renamed');
    expect(data).not.toHaveProperty('parentId');
  });

  it('a company administrator may purge inside its own company', async () => {
    const { svc, scope } = make();
    await svc.purgeAccount({ sub: 10, role: 'ADMIN' } as any, 11, { dryRun: true }).catch(() => undefined);
    expect(scope.assertUser).toHaveBeenCalledWith({ sub: 10, role: 'ADMIN' }, 11);
  });
});

describe('platform account signing in as a company', () => {
  function auth() {
    const prisma: any = {
      user: { findUnique: jest.fn(async ({ where }: any) => USERS[where.id] ?? null) },
      activityLog: { create: jest.fn(() => ({ catch: () => undefined })) },
    };
    const jwt: any = { sign: jest.fn(() => 'TOKEN') };
    const scope: any = { assertUser: jest.fn(async () => undefined) };
    const svc = new AuthService(prisma, jwt, {} as any, scope, {} as any);
    return svc;
  }

  it('opens a company', async () => {
    await expect(auth().impersonate(PLATFORM, 10)).resolves.toMatchObject({ token: 'TOKEN', impersonating: true });
  });

  it('never jumps straight to a franchise or staff member inside one', async () => {
    await expect(auth().impersonate(PLATFORM, 11)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
