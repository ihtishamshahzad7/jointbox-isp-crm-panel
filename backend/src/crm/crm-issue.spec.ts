import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CrmIssueService } from './crm-issue.service';

const ACTOR = { sub: 50, role: 'ADMIN' } as any;
const KEY = '7d9f1c2e-4b6a-4c1d-9e8f-0a1b2c3d4e5f';

function make(o: { deny?: string[]; moved?: number; invoiceFails?: boolean; visible?: number[]; issueRow?: any; createP2002?: boolean; claim?: number } = {}) {
  const issues = new Map<number, any>(o.issueRow ? [[o.issueRow.id, o.issueRow]] : []);
  const byKey = () => [...issues.values()];
  const tx: any = {
    inventoryItem: {
      findFirst: jest.fn(async () => ({ id: 3, status: 'IN_STOCK', ownerId: 50, warehouseId: 20, serialNumber: 'ONU-3', type: 'ONU', model: 'HG8' })),
      updateMany: jest.fn(async () => ({ count: o.moved ?? 1 })),
    },
    crmStockIssue: {
      create: jest.fn(async ({ data }: any) => {
        if (o.createP2002) throw Object.assign(new Error('dup'), { code: 'P2002' });
        const row = { id: 9, status: 'ISSUED', ...data };
        issues.set(9, row);
        return row;
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUnique: jest.fn(async ({ where }: any) => issues.get(where.id) ?? null),
    },
    inventoryMovement: { create: jest.fn(async () => ({})) },
  };
  const prisma: any = {
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    crmStockIssue: {
      findUnique: jest.fn(async ({ where }: any) => (where.requestKey ? byKey().find((r) => r.requestKey === where.requestKey) ?? null : issues.get(where.id) ?? null)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const r = issues.get(where.id);
        if (o.claim !== undefined && data.billing === 'BILLING') return { count: o.claim };
        if (!r || (where.billing && r.billing !== where.billing)) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(issues.get(where.id), data)),
      findMany: jest.fn(async () => []),
    },
    inventoryItem: { findUnique: jest.fn(async () => ({ serialNumber: 'ONU-3', type: 'ONU', model: null })), findMany: jest.fn(async () => []) },
    crmWarehouse: { findFirst: jest.fn(async ({ where }: any) => (where.id === 20 ? { id: 20 } : null)) },
    subscriber: { findMany: jest.fn(async () => []) },
  };
  const visible = o.visible ?? [7];
  const scope: any = {
    demoUserIds: async () => new Set<number>(),
    isAdmin: () => false,
    rootId: async () => 50,
    ownedWhere: async () => ({ ownerId: { in: [50, 51] } }),
    descendantIds: async () => [50, 51],
    subscriberWhere: async () => ({ userId: { in: [50, 51] } }),
    assertSubscriberVisible: jest.fn(async (_a: any, id: number) => {
      if (!visible.includes(id)) throw new NotFoundException('Subscriber not found');
    }),
  };
  const perms: any = {
    canActivate: jest.fn(async (ctx: any) => {
      const r = ctx.switchToHttp().getRequest();
      if (o.deny?.includes(`${r.method} ${r.url}`)) throw new ForbiddenException('no');
      return true;
    }),
  };
  const invoices: any = {
    create: jest.fn(async (data: any) => {
      if (o.invoiceFails) throw new Error('posting failed');
      return { id: 555, ...data };
    }),
  };
  const terminations: any = { refresh: jest.fn(async () => undefined) };
  return { svc: new CrmIssueService(prisma, scope, perms, invoices, terminations), prisma, tx, invoices, issues, terminations };
}

const body = (x: any = {}) => ({ itemId: 3, subscriberId: 7, requestKey: KEY, ...x });

describe('issuing a unit to a customer', () => {
  it('free issue: moves the unit IN_STOCK → INSTALLED conditionally, logs it, raises no invoice', async () => {
    const t = make();
    const r = await t.svc.issue(ACTOR, body());
    expect(t.tx.inventoryItem.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 3, status: 'IN_STOCK', ownerId: { in: [50, 51] } },
      data: { status: 'INSTALLED', subscriberId: 7 },
    });
    expect(t.tx.inventoryMovement.create.mock.calls[0][0].data.notes).toMatch(/Issued to customer \(ISS-9\) · free/);
    expect(r.billing).toBe('NONE');
    expect(t.invoices.create).not.toHaveBeenCalled();
  });

  it('charged issue: one invoice through the normal invoice service, linked back', async () => {
    const t = make();
    const r = await t.svc.issue(ACTOR, body({ charge: 4500 }));
    expect(t.invoices.create).toHaveBeenCalledTimes(1);
    const [data, actor] = t.invoices.create.mock.calls[0];
    expect(actor).toBe(ACTOR);
    expect(data).toMatchObject({ subscriberId: 7, amount: 4500, items: [{ description: 'ONU HG8 · S/N ONU-3', quantity: 1, unitPrice: 4500, total: 4500 }] });
    expect(r).toMatchObject({ billing: 'BILLED', invoiceId: 555 });
  });

  it('a unit that is not in stock rolls the whole issue back', async () => {
    const t = make({ moved: 0 });
    await expect(t.svc.issue(ACTOR, body())).rejects.toBeInstanceOf(ConflictException);
    expect(t.tx.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('a unit already with a customer is refused by the database', async () => {
    const t = make({ createP2002: true });
    await expect(t.svc.issue(ACTOR, body())).rejects.toThrow('already with a customer');
  });

  it('a retried click (same requestKey) returns the first issue and does not issue or bill again', async () => {
    const t = make({ issueRow: { id: 9, requestKey: KEY, itemId: 3, subscriberId: 7, charge: 4500, billing: 'BILLED', status: 'ISSUED' } });
    const r: any = await t.svc.issue(ACTOR, body({ charge: 4500 }));
    expect(r.replay).toBe(true);
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
    expect(t.invoices.create).not.toHaveBeenCalled();
    await expect(t.svc.issue(ACTOR, body({ charge: 1 }))).rejects.toThrow('different issue');
  });

  it('validates input and requires the right permissions and a visible customer', async () => {
    await expect(make().svc.issue(ACTOR, body({ requestKey: 'x' }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(make().svc.issue(ACTOR, body({ charge: 10.005 }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(make().svc.issue(ACTOR, body({ charge: -1 }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(make({ deny: ['POST /inventory'] }).svc.issue(ACTOR, body())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make({ deny: ['POST /invoices'] }).svc.issue(ACTOR, body({ charge: 100 }))).rejects.toBeInstanceOf(ForbiddenException);
    const t = make({ deny: ['POST /invoices'] });
    await t.svc.issue(ACTOR, body()); // free issue does not need invoice rights
    await expect(make({ visible: [] }).svc.issue(ACTOR, body())).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('billing is raised once', () => {
  it('a failed invoice leaves the issue PENDING with a clear message, ready to retry', async () => {
    const t = make({ invoiceFails: true });
    const r: any = await t.svc.issue(ACTOR, body({ charge: 4500 }));
    expect(r.billing).toBe('PENDING');
    expect(r.billingError).toMatch(/Bill now/);
  });
  it('if another request already claimed billing, no second invoice is raised', async () => {
    const t = make({ claim: 0, issueRow: { id: 9, itemId: 3, subscriberId: 7, charge: 4500, billing: 'BILLING', status: 'ISSUED' } });
    await t.svc.bill(ACTOR, 9);
    expect(t.invoices.create).not.toHaveBeenCalled();
  });
});

describe('recovery', () => {
  const open = { id: 9, itemId: 3, subscriberId: 7, ownerId: 50, status: 'ISSUED', billing: 'NONE' };
  it('returns the unit (to a warehouse) and closes the issue — both conditional', async () => {
    const t = make({ issueRow: { ...open } });
    await t.svc.recover(ACTOR, 9, { condition: 'IN_STOCK', warehouseId: 20 });
    expect(t.tx.crmStockIssue.updateMany.mock.calls[0][0].where).toEqual({ id: 9, status: 'ISSUED' });
    expect(t.tx.inventoryItem.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 3, status: 'INSTALLED', subscriberId: 7 },
      data: { status: 'IN_STOCK', subscriberId: null, warehouseId: 20 },
    });
    expect(t.terminations.refresh).toHaveBeenCalledWith(7);
  });
  it('a second recovery is refused', async () => {
    const t = make({ issueRow: { ...open } });
    t.tx.crmStockIssue.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(t.svc.recover(ACTOR, 9, { condition: 'FAULTY' })).rejects.toThrow('already been recovered');
  });
  it('rejects unknown conditions, foreign warehouses and other companies\' issues', async () => {
    await expect(make({ issueRow: { ...open } }).svc.recover(ACTOR, 9, { condition: 'BROKEN' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(make({ issueRow: { ...open } }).svc.recover(ACTOR, 9, { condition: 'IN_STOCK', warehouseId: 99 })).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ issueRow: { ...open }, visible: [] }).svc.recover(ACTOR, 9, { condition: 'LOST' })).rejects.toBeInstanceOf(NotFoundException);
  });
  it('the recovery queue looks only at the caller\'s ended customers', async () => {
    const t = make();
    await t.svc.recoveries(ACTOR);
    expect(t.prisma.subscriber.findMany.mock.calls[0][0].where).toEqual({
      AND: [{ userId: { in: [50, 51] } }, { status: { in: ['EXPIRED', 'SUSPENDED', 'INACTIVE'] } }],
    });
  });
});
