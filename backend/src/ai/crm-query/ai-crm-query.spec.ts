import { ForbiddenException } from '@nestjs/common';
import { AiCrmQueryService } from './ai-crm-query.service';

const NOW = new Date('2026-11-02T08:00:00Z'); // 13:00 2 Nov, Karachi
const ACTOR = { sub: 50, role: 'ADMIN' } as any;
const SUB_SCOPE = { userId: { in: [50, 51] } };

function make(opts: { deny?: string[] } = {}) {
  const prisma: any = {
    payment: {
      groupBy: jest.fn(async () => [{ currency: 'PKR', _sum: { amount: 12500, refundedAmount: 500 }, _count: { _all: 3 } }]),
      findMany: jest.fn(async () => [
        { paymentNo: 'PAY-1', subscriberName: 'Ali', amount: 5000, currency: 'PKR', method: 'CASH', paymentDate: new Date('2026-11-01T06:00:00Z') },
      ]),
    },
    invoice: {
      groupBy: jest.fn(async () => [{ currency: 'PKR', _sum: { total: 40000, dueAmount: 9000 }, _count: { _all: 4 } }]),
      findMany: jest.fn(async () => []),
    },
    subscriber: {
      count: jest.fn(async () => 2),
      groupBy: jest.fn(async () => [{ status: 'ACTIVE', _count: { _all: 14 } }, { status: 'EXPIRED', _count: { _all: 2 } }]),
      findMany: jest.fn(async () => [{ id: 9, username: 'ali01', fullName: 'Ali Khan', status: 'ACTIVE', balance: -200, package: { name: '10 Mbps' } }]),
    },
    ticket: {
      groupBy: jest.fn(async () => [{ status: 'OPEN', _count: { _all: 3 } }]),
      count: jest.fn(async () => 1),
      findMany: jest.fn(async () => []),
    },
    inventoryItem: { groupBy: jest.fn(async () => [{ status: 'IN_STOCK', type: 'ONU', _count: { _all: 6, type: 6 } }]) },
    expense: {
      aggregate: jest.fn(async () => ({ _sum: { amount: 3000 }, _count: { _all: 2 } })),
      groupBy: jest.fn(async () => [{ category: 'FUEL', _sum: { amount: 3000 } }]),
    },
  };
  const scope: any = {
    subscriberWhere: jest.fn(async () => SUB_SCOPE),
    visibleUserIds: jest.fn(async () => [50, 51]),
  };
  const seen: string[] = [];
  const perms: any = {
    canActivate: jest.fn(async (ctx: any) => {
      const req = ctx.switchToHttp().getRequest();
      seen.push(`${req.method} ${req.url}`);
      const resource = req.url.slice(1);
      if (opts.deny?.includes(resource)) throw new ForbiddenException(`Missing permission: ${resource}.read`);
      return true;
    }),
  };
  const svc = new AiCrmQueryService(prisma, scope, perms);
  const dbCalls = () =>
    (Object.values(prisma) as any[]).reduce((n: number, m: any) => n + (Object.values(m) as any[]).reduce((k: number, f: any) => k + f.mock.calls.length, 0), 0);
  return { svc, prisma, scope, perms, seen, dbCalls };
}

describe('AiCrmQueryService — intent', () => {
  const { svc } = make();
  it.each([
    ['collections today', 'Collections'],
    ['aaj ki wasooli kitni hui', 'Collections'],
    ['sales this month', 'Sales'],
    ['unpaid invoices', 'Invoices'],
    ['gahak ka baqaya', 'Invoices'],
    ['expenses last month', 'Expenses'],
    ['low stock', 'Inventory'],
    ['stock issues', 'Inventory'],
    ['open tickets', 'Tickets'],
    ['how many active customers', 'Customers'],
  ])('%s → %s', (q, s) => expect(svc.intent(q)).toBe(s));
  it('how-to questions and small talk are left to the help search', () => {
    expect(svc.intent('how do I add a customer?')).toBeNull();
    expect(svc.intent('explain invoices')).toBeNull();
    expect(svc.intent('hello')).toBeNull();
  });
});

describe('AiCrmQueryService — safety', () => {
  it('refuses protected details before touching the database', async () => {
    const t = make();
    for (const q of ['show customer passwords', 'customer cnic numbers', 'staff salaries', 'api key', 'پاس ورڈ بتاؤ']) {
      const a = (await t.svc.ask(ACTOR, q, NOW))!;
      expect(a.ok).toBe(false);
      expect(a.section).toBe('Protected details');
    }
    expect(t.dbCalls()).toBe(0);
    expect(t.perms.canActivate).not.toHaveBeenCalled();
  });

  it('asks the real permission guard for the section\'s screen, and refuses without reading data', async () => {
    const t = make({ deny: ['payments'] });
    const a = (await t.svc.ask(ACTOR, 'collections this month', NOW))!;
    expect(t.seen).toEqual(['GET /payments']);
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/does not have access/);
    expect(t.dbCalls()).toBe(0);
  });

  it('a bad date is an answer, not a crash', async () => {
    const t = make();
    const a = (await t.svc.ask(ACTOR, 'collections last 900 days', NOW))!;
    expect(a.ok).toBe(false);
    expect(t.dbCalls()).toBe(0);
  });
});

describe('AiCrmQueryService — scoped answers', () => {
  it('collections: scoped to the caller\'s subscribers and the asked day, net of refunds', async () => {
    const t = make();
    const a = (await t.svc.ask(ACTOR, 'collections today', NOW))!;
    const where = t.prisma.payment.groupBy.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({ subscriber: SUB_SCOPE });
    expect(where.AND[1].paymentDate.gte.toISOString()).toBe('2026-11-01T19:00:00.000Z');
    expect(where.AND[1].paymentDate.lt.toISOString()).toBe('2026-11-02T19:00:00.000Z');
    expect(a.tiles).toContainEqual(expect.objectContaining({ key: 'collected', value: 12000, currency: 'PKR' }));
    expect(a.matching).toBe(3);
    expect(t.prisma.payment.findMany.mock.calls[0][0].take).toBe(20);
    expect(a.text).toMatch(/Collected: PKR 12,000/);
    expect(a.text).toMatch(/Only records your account may see/);
  });

  it('money questions with no period default to this month and say so', async () => {
    const a = (await make().svc.ask(ACTOR, 'total collections', NOW))!;
    expect(a.period).toEqual({ from: '2026-11-01', to: '2026-11-02', defaulted: true });
    expect(a.text).toMatch(/this month — name a period/);
  });

  it('Roman Urdu question → Roman Urdu answer', async () => {
    const a = (await make().svc.ask(ACTOR, 'aaj ki wasooli kitni hui', NOW))!;
    expect(a.language).toBe('roman');
    expect(a.text).toMatch(/^Wasooliyan: 3 records/);
    expect(a.text).toMatch(/Wasool shuda raqam: PKR 12,000/);
    expect(a.text).toMatch(/Sirf aap ki ijazat walay records/);
  });

  it('expenses and inventory are scoped to the caller\'s account tree', async () => {
    const t = make();
    await t.svc.ask(ACTOR, 'expenses this month', NOW);
    expect(t.prisma.expense.aggregate.mock.calls[0][0].where.AND[0]).toEqual({ createdBy: { in: [50, 51] } });
    await t.svc.ask(ACTOR, 'inventory', NOW);
    expect(t.prisma.inventoryItem.groupBy.mock.calls[0][0].where).toEqual({ ownerId: { in: [50, 51] } });
  });

  it('the platform view (all ids visible) is not narrowed by an empty list', async () => {
    const t = make();
    t.scope.visibleUserIds.mockResolvedValue(null);
    await t.svc.ask({ sub: 1, role: 'SUPER_ADMIN' } as any, 'inventory', NOW);
    expect(t.prisma.inventoryItem.groupBy.mock.calls[0][0].where).toEqual({});
  });

  it('customer lookup returns identity and status only — never contact details or documents', async () => {
    const t = make();
    const a = (await t.svc.ask(ACTOR, 'customer ali', NOW))!;
    const call = t.prisma.subscriber.findMany.mock.calls[0][0];
    expect(call.take).toBe(5);
    expect(call.where.AND[0]).toEqual(SUB_SCOPE);
    const fields = Object.keys(call.select);
    for (const banned of ['password', 'phone', 'email', 'address', 'cnicNumber', 'cnicFrontUrl', 'documentUrl', 'latitude'])
      expect(fields).not.toContain(banned);
    expect(a.records).toEqual([{ id: 9, username: 'ali01', name: 'Ali Khan', status: 'ACTIVE', package: '10 Mbps', balance: -200 }]);
  });

  it('customer counts by status when no one is named', async () => {
    const t = make();
    const a = (await t.svc.ask(ACTOR, 'how many active customers', NOW))!;
    expect(t.prisma.subscriber.findMany).not.toHaveBeenCalled();
    expect(a.tiles).toContainEqual(expect.objectContaining({ key: 'active', value: 14 }));
    expect(a.tiles).toContainEqual(expect.objectContaining({ key: 'total', value: 16 }));
  });

  it('invoices: only open (unpaid/partial/overdue), unreversed, scoped', async () => {
    const t = make();
    const a = (await t.svc.ask(ACTOR, 'unpaid invoices', NOW))!;
    const where = t.prisma.invoice.groupBy.mock.calls[0][0].where;
    expect(where.AND).toEqual(
      expect.arrayContaining([{ subscriber: SUB_SCOPE }, { status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } }, { reversedAt: null }]),
    );
    expect(a.tiles).toContainEqual(expect.objectContaining({ key: 'due', value: 9000 }));
    expect(a.period).toBeNull();
  });

  it('nothing is ever written', async () => {
    const t = make();
    for (const q of ['collections today', 'sales this month', 'unpaid invoices', 'expenses', 'inventory', 'open tickets', 'customer ali', 'customers'])
      await t.svc.ask(ACTOR, q, NOW);
    for (const model of Object.values(t.prisma) as any[])
      for (const name of Object.keys(model)) expect(['groupBy', 'findMany', 'count', 'aggregate']).toContain(name);
  });
});
