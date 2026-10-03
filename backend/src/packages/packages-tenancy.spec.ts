import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../common/scope.service';
import { PackagesService } from './packages.service';
import { PackagesController } from './packages.controller';

/**
 * Package routes vs. tenancy.
 *
 * Company A (ADMIN 10, its SALES staff 12) and company B (ADMIN 20). Package 7
 * is owned by A. Pool 70 belongs to B. The real ScopeService runs against a
 * hand-rolled prisma, so the asserts exercised are the production ones.
 */
const TREE: Record<number, number[]> = { 10: [10, 12], 20: [20], 1: [1] };
const PACKAGES = [{ id: 7, ownerId: 10, name: 'A 10MB', price: 1000, dataQuotaGb: null }];

const ADMIN_A = { sub: 10, role: 'ADMIN' };
const STAFF_A = { sub: 12, role: 'SALES' };
const ADMIN_B = { sub: 20, role: 'ADMIN' };
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };

function makePrisma() {
  return {
    $queryRaw: jest.fn(async (q: any, ...vals: any[]) => {
      if (Array.isArray(q) && q.join('').includes('WITH RECURSIVE sub')) {
        return (TREE[vals[0]] ?? [vals[0]]).map((id) => ({ id }));
      }
      if (Array.isArray(q) && q.join('').includes('WITH RECURSIVE up')) {
        // [self, parent, …]: staff 12 sits under company A's admin 10.
        return vals[0] === 12 ? [{ id: 12 }, { id: 10 }] : [{ id: vals[0] }];
      }
      return [];
    }),
    user: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === 12 ? { parentId: 10 } : null)),
      findMany: jest.fn(async ({ where }: any) =>
        where.id.in.map((id: number) => ({ id, role: id === 1 ? 'SUPER_ADMIN' : id === 12 ? 'SALES' : 'ADMIN' })),
      ),
    },
    package: {
      // assertPackage: { AND: [{ id }, packageWhere] } — packageWhere's first OR arm is { ownerId: self }.
      findFirst: jest.fn(async ({ where }: any) => {
        if (!where?.AND) return null; // create()'s duplicate-name lookup
        const [idClause, scoped] = where.AND;
        const pkg = PACKAGES.find((p) => p.id === idClause.id);
        if (!pkg) return null;
        return pkg.ownerId === scoped.OR[0].ownerId ? { id: pkg.id } : null;
      }),
      findUnique: jest.fn(async ({ where }: any) => PACKAGES.find((p) => p.id === where.id) ?? null),
      create: jest.fn(async ({ data }: any) => ({ id: 99, ...data })),
    },
    ipPool: { findFirst: jest.fn(async () => null) },
    packageSetting: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})) },
    packageTax: { create: jest.fn(async ({ data }: any) => ({ id: 1, ...data, createdAt: new Date() })) },
    activityLog: { create: jest.fn(async () => ({})) },
  } as any;
}

function make() {
  const prisma = makePrisma();
  const scope = new ScopeService(prisma);
  const ipPool: any = { checkPoolAvailable: jest.fn(async () => undefined) };
  const cache: any = { delPrefix: jest.fn(async () => undefined) };
  const service = new PackagesService(prisma, ipPool, cache, scope, {} as any, {} as any, {} as any);
  const controller = new PackagesController(service, scope);
  return { prisma, service, controller };
}

describe('packages tenancy', () => {
  it('another company gets 404 for a package it neither owns nor was assigned', async () => {
    const { prisma, controller } = make();
    await expect(controller.findOne('7', { user: ADMIN_B })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.package.findUnique).not.toHaveBeenCalled();
  });

  it('the owning company and the platform owner can read it', async () => {
    const { controller } = make();
    await expect(controller.findOne('7', { user: ADMIN_A })).resolves.toMatchObject({ id: 7 });
    await expect(controller.findOne('7', { user: OWNER })).resolves.toMatchObject({ id: 7 });
  });

  it('import stamps the caller root account as owner, whatever the file says', async () => {
    const { prisma, controller } = make();
    const out: any = await controller.importMany(
      { rows: [{ name: 'Imported', price: 500, ownerId: 20 }] },
      { user: STAFF_A },
    );
    expect(out).toMatchObject({ success: 1, failed: 0 });
    expect(prisma.package.create.mock.calls[0][0].data.ownerId).toBe(10);
  });

  it('platform-owner import keeps today\x27s behaviour (no owner) unless a row names one', async () => {
    const { prisma, controller } = make();
    await controller.importMany({ rows: [{ name: 'P1', price: 1 }, { name: 'P2', price: 1, ownerId: 20 }] }, { user: OWNER });
    expect(prisma.package.create.mock.calls[0][0].data).not.toHaveProperty('ownerId');
    expect(prisma.package.create.mock.calls[1][0].data.ownerId).toBe(20);
  });

  it('a tenant import row cannot reference another company\x27s IP pool (scoped where)', async () => {
    const { prisma, controller } = make();
    const out: any = await controller.importMany({ rows: [{ name: 'X', price: 1, poolId: 70 }] }, { user: ADMIN_A });
    expect(out).toMatchObject({ success: 0, failed: 1 });
    expect(prisma.package.create).not.toHaveBeenCalled();
    const where = prisma.ipPool.findFirst.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({ id: 70 });
    expect(where.AND[1].OR[0]).toEqual({ ownerId: { in: [10, 12] } });
  });

  it('RADIUS policy / allocation writes stay platform-owner only', () => {
    const { controller } = make();
    expect(() => controller.deletePolicy('1', { user: ADMIN_A })).toThrow(ForbiddenException);
    expect(() => controller.updateAllocation('1', {}, { user: ADMIN_A })).toThrow(ForbiddenException);
  });

  it('a company administrator creates its OWN tax; the platform owner a platform default', async () => {
    const { prisma, controller } = make();
    await controller.createTax({ name: 'GST' }, { user: ADMIN_A });
    expect(prisma.packageTax.create.mock.calls[0][0].data.ownerId).toBe(10);
    await controller.createTax({ name: 'GST' }, { user: STAFF_A }); // the admin's staff act for the company
    expect(prisma.packageTax.create.mock.calls[1][0].data.ownerId).toBe(10);
    await controller.createTax({ name: 'Federal' }, { user: OWNER });
    expect(prisma.packageTax.create.mock.calls[2][0].data.ownerId).toBeNull();
  });
});

describe('package writes are an ownership test, not a visibility test', () => {
  it.each(['update', 'toggleStatus', 'archive', 'remove'])(
    'another company cannot %s a package it does not own',
    async (op) => {
      const { service } = make();
      (service as any).security = { assertCan: jest.fn(async () => undefined) };
      const call =
        op === 'update' ? service.update(7, { price: 1 }, ADMIN_B as any) : (service as any)[op](7, ADMIN_B);
      await expect(call).rejects.toBeInstanceOf(NotFoundException);
    },
  );

  it('a company owns the package it creates', async () => {
    const { service, prisma } = make();
    await service.create({ name: 'A new', price: 900 }, STAFF_A as any);
    expect(prisma.package.create.mock.calls[0][0].data.ownerId).toBe(10);
  });

  it("the platform owner's packages stay installation-level", async () => {
    const { service, prisma } = make();
    await service.create({ name: 'Global', price: 900 }, OWNER as any);
    expect('ownerId' in prisma.package.create.mock.calls[0][0].data).toBe(false);
  });

  it("a company cannot attach another company's pool", async () => {
    const { service } = make();
    await expect(service.create({ name: 'X', price: 1, poolId: 70 }, ADMIN_A as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
