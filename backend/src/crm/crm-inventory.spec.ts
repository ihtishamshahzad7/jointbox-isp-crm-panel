import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CrmInventoryService } from './crm-inventory.service';

const ACTOR = { sub: 50, role: 'ADMIN' } as any;
const SCOPE = { ownerId: { in: [50, 51] } };

function make(o: { deny?: string[]; items?: any[]; updateCount?: number; p2002?: boolean } = {}) {
  const items = o.items ?? [
    { id: 1, warehouseId: 10, status: 'IN_STOCK', qrCode: null },
    { id: 2, warehouseId: null, status: 'IN_STOCK', qrCode: 'UPL-AAAAAAAAAAAAAAAA' },
  ];
  const tx: any = {
    inventoryItem: {
      findMany: jest.fn(async ({ where }: any) => items.filter((i) => where.id?.in?.includes(i.id) ?? true)),
      updateMany: jest.fn(async ({ where }: any) => ({ count: o.updateCount ?? (where.id?.in?.length ?? 1) })),
    },
    crmWarehouse: { findMany: jest.fn(async () => [{ id: 10, name: 'Main' }]) },
    inventoryMovement: { createMany: jest.fn(async () => ({ count: 1 })) },
    crmStocktake: {
      create: jest.fn(async ({ data }: any) => {
        if (o.p2002) throw Object.assign(new Error('unique'), { code: 'P2002' });
        return { id: 7, status: 'OPEN', ...data };
      }),
    },
    crmStocktakeLine: { createMany: jest.fn(async () => ({ count: 2 })) },
  };
  const prisma: any = {
    ...tx,
    crmWarehouse: {
      findFirst: jest.fn(async ({ where }: any) => (where.id === 20 ? { id: 20, name: 'North', ownerId: 50, isActive: true } : where.id === 21 ? { id: 21, name: 'Old', ownerId: 50, isActive: false } : null)),
      create: jest.fn(async ({ data }: any) => ({ id: 30, ...data })),
    },
    inventoryItem: {
      ...tx.inventoryItem,
      findFirst: jest.fn(async () => null),
    },
    crmStocktake: {
      findFirst: jest.fn(async () => ({ id: 7, status: 'CLOSED', warehouseId: 20, ownerId: 50 })),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    $executeRaw: jest.fn(async () => 1),
  };
  const scope: any = {
    demoUserIds: async () => new Set<number>(),
    isAdmin: (r?: string) => r === 'SUPER_ADMIN',
    rootId: jest.fn(async () => 50),
    ownedWhere: jest.fn(async () => ({ ownerId: { in: [50, 51] } })),
    descendantIds: jest.fn(async () => [50, 51]),
  };
  const perms: any = {
    canActivate: jest.fn(async (ctx: any) => {
      const r = ctx.switchToHttp().getRequest();
      if (o.deny?.includes(`${r.method} ${r.url}`)) throw new ForbiddenException('no');
      return true;
    }),
  };
  return { svc: new CrmInventoryService(prisma, scope, perms), prisma, tx };
}

describe('warehouses', () => {
  it('are created under the caller\'s own account and validated', async () => {
    const t = make();
    await t.svc.createWarehouse(ACTOR, { name: '  North  ', address: 'Plot 4' });
    expect(t.prisma.crmWarehouse.create.mock.calls[0][0].data).toEqual({ name: 'North', address: 'Plot 4', ownerId: 50 });
    await expect(t.svc.createWarehouse(ACTOR, { name: '' })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('writes need inventory write permission (read-only roles are refused)', async () => {
    const t = make({ deny: ['POST /inventory'] });
    await expect(t.svc.createWarehouse(ACTOR, { name: 'X' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.prisma.crmWarehouse.create).not.toHaveBeenCalled();
  });
});

describe('transfers (all or nothing)', () => {
  it('moves only in-scope, in-stock units and logs each in the existing movement history', async () => {
    const t = make();
    const r = await t.svc.transfer(ACTOR, { itemIds: [1, 2], toWarehouseId: 20, notes: 'van restock' });
    expect(r).toEqual({ moved: 2, toWarehouseId: 20 });
    const upd = t.tx.inventoryItem.updateMany.mock.calls[0][0];
    expect(upd.where).toMatchObject({ status: 'IN_STOCK', ...SCOPE });
    expect(upd.data).toEqual({ warehouseId: 20 });
    const notes = t.tx.inventoryMovement.createMany.mock.calls[0][0].data.map((d: any) => d.notes);
    expect(notes).toEqual(['Warehouse transfer: Main → North · van restock', 'Warehouse transfer: unassigned → North · van restock']);
  });
  it('rolls back when any unit changed state under it', async () => {
    const t = make({ updateCount: 1 });
    await expect(t.svc.transfer(ACTOR, { itemIds: [1, 2], toWarehouseId: 20 })).rejects.toBeInstanceOf(ConflictException);
    expect(t.tx.inventoryMovement.createMany).not.toHaveBeenCalled();
  });
  it('refuses units outside the account, unknown or switched-off warehouses, and oversized batches', async () => {
    const t = make({ items: [{ id: 1, warehouseId: null, status: 'IN_STOCK' }] });
    await expect(t.svc.transfer(ACTOR, { itemIds: [1, 99], toWarehouseId: 20 })).rejects.toBeInstanceOf(NotFoundException);
    await expect(t.svc.transfer(ACTOR, { itemIds: [1], toWarehouseId: 999 })).rejects.toBeInstanceOf(NotFoundException);
    await expect(t.svc.transfer(ACTOR, { itemIds: [1], toWarehouseId: 21 })).rejects.toThrow('switched off');
    await expect(t.svc.transfer(ACTOR, { itemIds: Array.from({ length: 501 }, (_, i) => i + 1), toWarehouseId: 20 })).rejects.toThrow('At most 500');
  });
});

describe('QR labels', () => {
  it('labels only unlabelled units, conditionally, and keeps existing codes', async () => {
    const t = make();
    await t.svc.issueQr(ACTOR, { itemIds: [1, 2] });
    const calls = t.prisma.inventoryItem.updateMany.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].where).toEqual({ id: 1, qrCode: null });
    expect(calls[0][0].data.qrCode).toMatch(/^UPL-[A-Z2-9]{16}$/);
  });
  it('a label from another company (or garbage) is simply unknown', async () => {
    const t = make();
    await expect(t.svc.scan(ACTOR, 'UPL-AAAAAAAAAAAAAAAA')).rejects.toBeInstanceOf(NotFoundException);
    expect(t.prisma.inventoryItem.findFirst.mock.calls[0][0].where).toMatchObject({ qrCode: 'UPL-AAAAAAAAAAAAAAAA', ...SCOPE });
    await expect(t.svc.scan(ACTOR, "x' OR 1=1")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('stock counts', () => {
  it('a second count of the same warehouse is refused by the database', async () => {
    const t = make({ p2002: true });
    await expect(t.svc.openStocktake(ACTOR, { warehouseId: 20 })).rejects.toThrow('already in progress');
  });
  it('opening freezes the in-stock units of that warehouse as expected', async () => {
    const t = make();
    await t.svc.openStocktake(ACTOR, { warehouseId: 20 });
    expect(t.tx.inventoryItem.findMany.mock.calls[0][0].where).toMatchObject({ warehouseId: 20, status: 'IN_STOCK', ...SCOPE });
  });
  it('closing is conditional: a closed count cannot be closed or scanned again', async () => {
    const t = make();
    await expect(t.svc.closeStocktake(ACTOR, 7)).rejects.toThrow('already closed');
    expect(t.prisma.crmStocktake.updateMany.mock.calls[0][0].where).toEqual({ id: 7, status: 'OPEN' });
    await expect(t.svc.scanIntoStocktake(ACTOR, 7, { code: 'UPL-AAAAAAAAAAAAAAAA' })).rejects.toThrow('closed');
    expect(t.prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
