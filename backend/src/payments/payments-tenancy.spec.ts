import { NotFoundException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { ScopeService } from '../common/scope.service';

/**
 * PAYMENTS TENANCY — create, edit, delete. Money, so every write is checked
 * against the payment's subscriber BEFORE anything is posted.
 *
 * Real ScopeService over a hand-rolled two-company tree:
 *
 *   1 SUPER_ADMIN (platform owner)
 *   ├─ 10 ADMIN  company A ── 11 RESELLER  (subscriber 100, invoice 500, payment 50)
 *   └─ 20 ADMIN  company B ── 21 RESELLER  (subscriber 200, invoice 600, payment 60)
 */
const USERS = [
  { id: 1, parentId: null as number | null },
  { id: 10, parentId: 1 },
  { id: 11, parentId: 10 },
  { id: 20, parentId: 1 },
  { id: 21, parentId: 20 },
];
const SUB_OWNER: Record<number, number> = { 100: 11, 200: 21 };
const INVOICE_SUB: Record<number, number> = { 500: 100, 600: 200 };
const PAYMENT_SUB: Record<number, number> = { 50: 100, 60: 200 };
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const ADMIN_B = { sub: 20, role: 'ADMIN' };

function treeQuery(strings: TemplateStringsArray, ...vals: any[]) {
  const id = Number(vals[0]);
  if (strings.join('?').includes('WITH RECURSIVE sub')) {
    const out = USERS.some((u) => u.id === id) ? [id] : [];
    for (let i = 0; i < out.length; i++) USERS.filter((u) => u.parentId === out[i]).forEach((u) => out.push(u.id));
    return out.map((x) => ({ id: x }));
  }
  return [];
}

const paymentRow = (id: number) => ({
  id, paymentNo: `PAY-${id}`, invoiceId: null, subscriberId: PAYMENT_SUB[id], amount: 100,
});

function make() {
  const prisma: any = {
    $queryRaw: jest.fn(async (s: any, ...v: any[]) => treeQuery(s, ...v)),
    user: { findUnique: jest.fn() },
    subscriber: {
      findUnique: jest.fn(async ({ where }: any) =>
        SUB_OWNER[where.id] ? { id: where.id, userId: SUB_OWNER[where.id] } : null,
      ),
    },
    invoice: {
      findUnique: jest.fn(async ({ where }: any) =>
        INVOICE_SUB[where.id] ? { id: where.id, subscriberId: INVOICE_SUB[where.id], currency: 'PKR', paidAmount: 0, total: 1000, status: 'UNPAID' } : null,
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: {
      findUnique: jest.fn(async ({ where }: any) => (PAYMENT_SUB[where.id] ? paymentRow(where.id) : null)),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => ({ id: 9, ...data, invoice: null, subscriber: null })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      delete: jest.fn(async ({ where }: any) => ({ id: where.id })),
    },
  };
  const accounting: any = {
    assertPeriodOpen: jest.fn().mockResolvedValue(undefined),
    postPaymentReceived: jest.fn().mockResolvedValue(undefined),
    post: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new PaymentsService(
    prisma,
    accounting,
    { fireEvent: jest.fn().mockResolvedValue(undefined) } as any,
    { distributeCommission: jest.fn().mockResolvedValue(undefined) } as any,
    new ScopeService(prisma),
    { broadcast: jest.fn() } as any,
    { paymentStamp: jest.fn().mockResolvedValue({}) } as any,
  );
  return { svc, prisma, accounting };
}

describe('payments tenancy', () => {
  it("(i) another company's ADMIN gets NotFound editing or deleting its payment — nothing is written", async () => {
    const { svc, prisma, accounting } = make();
    await expect(svc.update(50, { amount: 999 }, ADMIN_B)).rejects.toThrow(
      new NotFoundException('Payment with ID 50 not found'),
    );
    await expect(svc.remove(50, ADMIN_B)).rejects.toThrow(new NotFoundException('Payment with ID 50 not found'));
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.payment.delete).not.toHaveBeenCalled();
    expect(accounting.post).not.toHaveBeenCalled();
  });

  it("(i) cannot record money against another company's subscriber or invoice", async () => {
    const { svc, prisma, accounting } = make();
    await expect(svc.create({ subscriberId: 100, amount: 100 }, ADMIN_B)).rejects.toBeInstanceOf(NotFoundException);
    // Own subscriber, foreign invoice.
    await expect(svc.create({ subscriberId: 200, invoiceId: 500, amount: 100 }, ADMIN_B)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // No subscriber at all: installation-level, platform owner only.
    await expect(svc.create({ amount: 100 }, ADMIN_B)).rejects.toBeInstanceOf(NotFoundException);
    expect(accounting.assertPeriodOpen).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("(i) an edit cannot point its own payment at another company's subscriber", async () => {
    const { svc, prisma } = make();
    await expect(svc.update(60, { subscriberId: 100, notes: 'x' }, ADMIN_B)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  it('a company works on its own payments', async () => {
    const { svc, prisma } = make();
    await svc.create({ subscriberId: 200, invoiceId: 600, amount: 100 }, ADMIN_B);
    await svc.create({ invoiceId: 600, amount: 50, force: true }, ADMIN_B); // subscriber taken from the invoice
    await svc.update(60, { notes: 'ok', subscriberId: 200 }, ADMIN_B);
    await svc.remove(60, ADMIN_B);
    expect(prisma.payment.create).toHaveBeenCalledTimes(2);
    expect(prisma.payment.update).toHaveBeenCalledTimes(1);
    expect(prisma.payment.delete).toHaveBeenCalledWith({ where: { id: 60 } });
  });

  it('(ii) the platform owner passes for any company', async () => {
    const { svc, prisma } = make();
    await svc.create({ subscriberId: 100, invoiceId: 500, amount: 100 }, OWNER);
    await svc.update(50, { notes: 'owner' }, OWNER);
    await svc.remove(50, OWNER);
    expect(prisma.payment.create).toHaveBeenCalled();
    expect(prisma.payment.update).toHaveBeenCalled();
    expect(prisma.payment.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });

  it('(iii) the payment list passes a subscriber-scoped where', async () => {
    const { svc, prisma } = make();
    await svc.findAll({}, ADMIN_B);
    expect(prisma.payment.findMany.mock.calls[0][0].where).toEqual({ subscriber: { userId: { in: [20, 21] } } });
  });
});
