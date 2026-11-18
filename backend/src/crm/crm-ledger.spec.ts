import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CrmLedgerService } from './crm-ledger.service';
import { CrmController } from './crm.controller';
import { REQUIRED_FEATURE } from '../common/feature.guard';

const ACTOR = { sub: 50, role: 'ADMIN' } as any;
const D = (s: string) => new Date(`${s}T10:00:00Z`);

function make(o: { deny?: string[]; visible?: number[]; receipt?: any } = {}) {
  const receipts = new Map<number, any>(o.receipt ? [[o.receipt.paymentId, o.receipt]] : []);
  const prisma: any = {
    subscriber: { findUnique: jest.fn(async () => ({ id: 9, fullName: 'Ali Khan', username: 'ali01', status: 'ACTIVE' })) },
    invoice: {
      findMany: jest.fn(async () => [
        { invoiceNo: 'INV-1', invoiceDate: D('2026-09-01'), total: 2000, currency: 'PKR' },
        { invoiceNo: 'INV-2', invoiceDate: D('2026-10-01'), total: 2000, currency: 'PKR' },
        { invoiceNo: 'INV-3', invoiceDate: D('2026-10-01'), total: 50, currency: 'USD' },
      ]),
    },
    payment: {
      findMany: jest.fn(async () => [
        { paymentNo: 'PAY-1', paymentDate: D('2026-09-05'), amount: 2000, refundedAmount: 0, currency: 'PKR', method: 'CASH' },
        { paymentNo: 'PAY-2', paymentDate: D('2026-10-01'), amount: 1500, refundedAmount: 500, currency: 'PKR', method: 'BANK', referenceNo: 'TX9' },
      ]),
      findUnique: jest.fn(async () => ({
        id: 77, paymentNo: 'PAY-77', subscriberId: 9, subscriberName: 'Ali', amount: 1000, currency: 'PKR', method: 'CASH',
        referenceNo: null, paymentDate: D('2026-11-01'), invoice: { invoiceNo: 'INV-5', total: 2000, dueAmount: 1000 },
        subscriber: { fullName: 'Ali Khan', username: 'ali01', package: { name: '10 Mbps' } }, receivedByUser: { name: 'Cashier' },
      })),
    },
    crmPaymentReceipt: {
      findUnique: jest.fn(async ({ where }: any) => receipts.get(where.paymentId) ?? null),
      createMany: jest.fn(async ({ data }: any) => {
        let n = 0;
        for (const d of data) if (!receipts.has(d.paymentId)) { receipts.set(d.paymentId, { ...d, issuedAt: new Date() }); n++; }
        return { count: n };
      }),
    },
  };
  const visible = o.visible ?? [9];
  const scope: any = {
    isAdmin: (r?: string) => r === 'SUPER_ADMIN',
    assertSubscriberVisible: jest.fn(async (_a: any, id: number) => {
      if (!visible.includes(id)) throw new NotFoundException('Subscriber not found');
    }),
  };
  const perms: any = {
    canActivate: jest.fn(async (ctx: any) => {
      const res = ctx.switchToHttp().getRequest().url.slice(1);
      if (o.deny?.includes(res)) throw new ForbiddenException('no');
      return true;
    }),
  };
  return { svc: new CrmLedgerService(prisma, scope, perms), prisma, scope, receipts };
}

describe('Advanced CRM — entitlement', () => {
  it('the whole controller requires crm-advanced (independent of ai-assistant)', () => {
    expect(new Reflector().get(REQUIRED_FEATURE, CrmController)).toBe('crm-advanced');
  });
});

describe('customer statement', () => {
  it('orders entries, keeps a running balance, nets refunds and never mixes currencies', async () => {
    const r = await make().svc.statement(ACTOR, 9);
    const pkr = r.sections.find((s) => s.currency === 'PKR')!;
    expect(pkr.entries.map((e) => [e.reference, e.debit, e.credit, e.balance])).toEqual([
      ['INV-1', 2000, 0, 2000],
      ['PAY-1', 0, 2000, 0],
      ['INV-2', 2000, 0, 2000], // same day: charge first
      ['PAY-2', 0, 1000, 1000], // 1500 paid, 500 refunded
    ]);
    expect(pkr.entries[3].description).toMatch(/BANK · TX9 \(refunded 500\)/);
    expect([pkr.debits, pkr.credits, pkr.closing]).toEqual([4000, 3000, 1000]);
    expect(r.sections.find((s) => s.currency === 'USD')!.closing).toBe(50);
  });

  it('carries everything before `from` into the opening balance', async () => {
    const r = await make().svc.statement(ACTOR, 9, { from: '2026-10-01' });
    const pkr = r.sections.find((s) => s.currency === 'PKR')!;
    expect(pkr.opening).toBe(0);
    expect(pkr.entries.map((e) => e.reference)).toEqual(['INV-2', 'PAY-2']);
    const r2 = await make().svc.statement(ACTOR, 9, { from: '2026-09-03' });
    expect(r2.sections[0].opening).toBe(2000);
  });

  it('excludes reversed, cancelled and draft invoices and bounds by `to`', async () => {
    const t = make();
    await t.svc.statement(ACTOR, 9, { to: '2026-09-30' });
    const where = t.prisma.invoice.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ subscriberId: 9, reversedAt: null, status: { notIn: ['CANCELLED', 'DRAFT'] } });
    expect(where.invoiceDate.lt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('refuses a customer outside the account, before reading money', async () => {
    const t = make({ visible: [] });
    await expect(t.svc.statement(ACTOR, 9)).rejects.toBeInstanceOf(NotFoundException);
    expect(t.prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('needs subscribers + invoices + payments read', async () => {
    const t = make({ deny: ['payments'] });
    await expect(t.svc.statement(ACTOR, 9)).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('rejects bad dates', async () => {
    const { svc } = make();
    await expect(svc.statement(ACTOR, 9, { from: '2026-13-01' })).rejects.toThrow('not a valid date');
    await expect(svc.statement(ACTOR, 9, { from: '2026-10-05', to: '2026-10-01' })).rejects.toThrow('after the start');
  });
});

describe('receipts', () => {
  it('first print freezes a snapshot; a reprint returns the same copy without re-reading the payment', async () => {
    const t = make();
    const first = await t.svc.receipt(ACTOR, 77);
    expect(first).toMatchObject({ receiptNo: 'PAY-77', customerName: 'Ali Khan', packageName: '10 Mbps', dueAfter: 1000, receivedBy: 'Cashier', reprint: false });
    expect(Object.keys(first)).not.toEqual(expect.arrayContaining(['phone']));
    t.prisma.payment.findUnique.mockClear();
    const again = await t.svc.receipt(ACTOR, 77);
    expect(again.reprint).toBe(true);
    expect(again.customerName).toBe('Ali Khan');
    expect(t.prisma.payment.findUnique).not.toHaveBeenCalled();
  });

  it('two first prints at once produce one receipt (insert-or-ignore, then read back)', async () => {
    const t = make();
    const [a, b] = await Promise.all([t.svc.receipt(ACTOR, 77), t.svc.receipt(ACTOR, 77)]);
    expect(t.receipts.size).toBe(1);
    expect(a.receiptNo).toBe(b.receiptNo);
    for (const call of t.prisma.crmPaymentReceipt.createMany.mock.calls) expect(call[0].skipDuplicates).toBe(true);
  });

  it('another company cannot read a receipt, even a frozen one', async () => {
    const t = make({ visible: [], receipt: { paymentId: 77, subscriberId: 9, receiptNo: 'PAY-77' } });
    await expect(t.svc.receipt(ACTOR, 77)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('needs payments read', async () => {
    await expect(make({ deny: ['payments'] }).svc.receipt(ACTOR, 77)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
