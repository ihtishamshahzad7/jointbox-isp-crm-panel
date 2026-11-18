import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CrmCostsService } from './crm-costs.service';

const ACTOR = { sub: 10, role: 'ADMIN' } as any;

function make(o: { deny?: string[]; visible?: number[]; expenseInScope?: boolean } = {}) {
  const prisma: any = {
    subscriber: { findUnique: jest.fn(async () => ({ id: 7, fullName: 'Ali', costPrice: 800, sellPrice: null, package: { name: '10 Mbps', price: 2500 } })) },
    crmStockIssue: {
      findMany: jest.fn(async () => [
        { id: 1, itemId: 31, status: 'ISSUED', charge: 1000, issuedAt: new Date() },
        { id: 2, itemId: 32, status: 'RECOVERED', charge: 0, issuedAt: new Date() },
        { id: 3, itemId: 33, status: 'ISSUED', charge: 0, issuedAt: new Date() },
      ]),
    },
    inventoryItem: {
      findMany: jest.fn(async () => [
        { id: 31, serialNumber: 'ONU-1', type: 'ONU', purchasePrice: 4500 },
        { id: 32, serialNumber: 'RT-1', type: 'ROUTER', purchasePrice: 3000 },
        { id: 33, serialNumber: 'CB-1', type: 'CABLE', purchasePrice: null },
      ]),
    },
    crmExpenseLink: {
      findMany: jest.fn(async () => [{ expenseId: 5 }, { expenseId: 6 }]),
      upsert: jest.fn(async (a: any) => a.create),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    expense: {
      findMany: jest.fn(async () => [
        { id: 5, category: 'FUEL', amount: 300, status: 'APPROVED', expenseDate: new Date() },
        { id: 6, category: 'LABOUR', amount: 999, status: 'REJECTED', expenseDate: new Date() },
      ]),
    },
  };
  const scope: any = {
    assertSubscriberVisible: jest.fn(async (_a: any, id: number) => { if (!(o.visible ?? [7]).includes(id)) throw new NotFoundException('x'); }),
  };
  const perms: any = {
    canActivate: jest.fn(async (ctx: any) => {
      const r = ctx.switchToHttp().getRequest();
      if (o.deny?.includes(`${r.method} ${r.url}`)) throw new ForbiddenException('no');
      return true;
    }),
  };
  const accounting: any = { assertExpenseInScope: jest.fn(async () => { if (o.expenseInScope === false) throw new NotFoundException('Expense not found'); }) };
  return { svc: new CrmCostsService(prisma, scope, perms, accounting), prisma };
}

describe('cost to serve', () => {
  it('equipment at cost + approved linked expenses − what the customer paid, against the monthly margin', async () => {
    const r = await make().svc.costs(ACTOR, 7);
    expect(r.totals).toEqual({
      equipmentOut: 4500, equipmentRecovered: 3000, equipmentLost: 0, unpricedUnits: 1,
      linkedExpenses: 300, chargedToCustomer: 1000, totalCost: 3800,
      monthlyRevenue: 2500, monthlyCost: 800, monthlyMargin: 1700, paybackMonths: 3,
    });
    expect(r.expenses.find((e: any) => e.id === 6).counted).toBe(false);
  });
  it('needs subscribers and accounting read, and a visible customer', async () => {
    await expect(make({ deny: ['GET /accounting'] }).svc.costs(ACTOR, 7)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make({ visible: [] }).svc.costs(ACTOR, 7)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('linking checks the expense AND the customer belong to the caller', async () => {
    const t = make();
    await t.svc.link(ACTOR, 5, { subscriberId: 7 });
    expect(t.prisma.crmExpenseLink.upsert).toHaveBeenCalled();
    await expect(make({ expenseInScope: false }).svc.link(ACTOR, 5, { subscriberId: 7 })).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ visible: [] }).svc.link(ACTOR, 5, { subscriberId: 7 })).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ deny: ['POST /accounting'] }).svc.link(ACTOR, 5, { subscriberId: 7 })).rejects.toBeInstanceOf(ForbiddenException);
    const u = make();
    await u.svc.link(ACTOR, 5, { subscriberId: null });
    expect(u.prisma.crmExpenseLink.deleteMany).toHaveBeenCalledWith({ where: { expenseId: 5 } });
  });
});
