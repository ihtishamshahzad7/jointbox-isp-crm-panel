import { NotFoundException } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { ScopeService } from '../common/scope.service';

/**
 * INVOICES TENANCY — create, record payment, printable PDF, per-subscriber list.
 *
 * Real ScopeService over a hand-rolled two-company tree:
 *
 *   1 SUPER_ADMIN (platform owner)
 *   ├─ 10 ADMIN  company A ── 11 RESELLER  (subscriber 100, invoice 500)
 *   └─ 20 ADMIN  company B ── 21 RESELLER  (subscriber 200, invoice 600)
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

const invoiceRow = (id: number) => ({
  id,
  invoiceNo: `INV-2026-${id}`,
  subscriberId: INVOICE_SUB[id],
  subscriberName: null,
  subscriber: { fullName: 'Customer', phone: '', email: '', address: null, package: null, userId: SUB_OWNER[INVOICE_SUB[id]] },
  currency: 'PKR',
  invoiceDate: new Date('2026-10-01'),
  dueDate: new Date('2026-10-31'),
  status: 'UNPAID',
  amount: 1000, tax: 0, discount: 0, total: 1000, paidAmount: 0, dueAmount: 1000,
  items: [], payments: [],
});

function make() {
  const prisma: any = {
    $queryRaw: jest.fn(async (s: any, ...v: any[]) => treeQuery(s, ...v)),
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ n: BigInt(7) }]),
    user: { findUnique: jest.fn() },
    subscriber: {
      findUnique: jest.fn(async ({ where }: any) =>
        SUB_OWNER[where.id] ? { id: where.id, userId: SUB_OWNER[where.id] } : null,
      ),
    },
    invoice: {
      findUnique: jest.fn(async ({ where }: any) => (INVOICE_SUB[where.id] ? invoiceRow(where.id) : null)),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => ({ id: 1, ...data, items: [] })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    payment: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 9, ...data })),
    },
  };
  const accounting: any = {
    assertPeriodOpen: jest.fn().mockResolvedValue(undefined),
    postInvoiceCreated: jest.fn().mockResolvedValue(undefined),
    postPaymentReceived: jest.fn().mockResolvedValue(undefined),
  };
  const notifications: any = { fireEvent: jest.fn().mockResolvedValue(undefined) };
  const organization: any = { distributeCommission: jest.fn().mockResolvedValue(undefined) };
  const events: any = { broadcast: jest.fn() };
  const currency: any = {
    invoiceStamp: jest.fn().mockResolvedValue({}),
    paymentStamp: jest.fn().mockResolvedValue({}),
  };
  const svc = new InvoicesService(prisma, accounting, notifications, organization, new ScopeService(prisma), events, currency);
  return { svc, prisma, accounting };
}

describe('invoices tenancy', () => {
  it("(i) another company's ADMIN gets NotFound on its invoice PDF and cannot pay against it", async () => {
    const { svc, prisma, accounting } = make();
    await expect(svc.getInvoicePdf(500, ADMIN_B)).rejects.toThrow(new NotFoundException('Invoice not found'));
    await expect(svc.recordPayment(500, { amount: 100, method: 'CASH' }, ADMIN_B)).rejects.toThrow(
      new NotFoundException('Invoice not found'),
    );
    expect(accounting.assertPeriodOpen).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it('(i) a missing invoice and a foreign invoice look identical (no existence oracle)', async () => {
    const { svc } = make();
    const missing = await svc.getInvoicePdf(999, ADMIN_B).catch((e) => e);
    const foreign = await svc.getInvoicePdf(500, ADMIN_B).catch((e) => e);
    expect(missing).toBeInstanceOf(NotFoundException);
    expect(foreign.getStatus()).toBe(missing.getStatus());
    expect(foreign.message).toBe(missing.message);
  });

  it("(i) cannot bill or list another company's subscriber", async () => {
    const { svc, prisma } = make();
    await expect(svc.create({ subscriberId: 100, amount: 500, dueDate: '2026-11-01' }, ADMIN_B)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // An invoice with no subscriber is installation-level: platform owner only.
    await expect(svc.create({ amount: 500, dueDate: '2026-11-01' }, ADMIN_B)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.findBySubscriber(100, ADMIN_B)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled(); // no invoice number was even allocated
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('a company works on its own invoices and subscribers', async () => {
    const { svc, prisma } = make();
    await expect(svc.getInvoicePdf(600, ADMIN_B)).resolves.toMatch(/INV-2026-600/);
    await expect(svc.recordPayment(600, { amount: 100, method: 'CASH' }, ADMIN_B)).resolves.toMatchObject({
      status: 'PARTIAL',
    });
    await svc.create({ subscriberId: 200, amount: 500, dueDate: '2026-11-01' }, ADMIN_B);
    expect(prisma.invoice.create).toHaveBeenCalled();
  });

  it('(ii) the platform owner passes for any company', async () => {
    const { svc, prisma } = make();
    await expect(svc.getInvoicePdf(500, OWNER)).resolves.toMatch(/INV-2026-500/);
    await expect(svc.findBySubscriber(100, OWNER)).resolves.toEqual([]);
    await svc.create({ subscriberId: 100, amount: 500, dueDate: '2026-11-01' }, OWNER);
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
  });

  it('(iii) list routes pass a scoped where', async () => {
    const { svc, prisma } = make();
    await svc.findBySubscriber(200, ADMIN_B);
    expect(prisma.invoice.findMany.mock.calls[0][0].where).toEqual({ subscriberId: 200 });

    await svc.findAll(ADMIN_B);
    expect(prisma.invoice.findMany.mock.calls[1][0].where).toEqual({ subscriber: { userId: { in: [20, 21] } } });
  });

  it('internal callers with no actor (gateway callback, renewals) are unchanged', async () => {
    const { svc, prisma } = make();
    await svc.recordPayment(500, { amount: 100, method: 'ONLINE' });
    await svc.create({ subscriberId: 100, amount: 500, dueDate: '2026-11-01' });
    expect(prisma.payment.create).toHaveBeenCalled();
    expect(prisma.invoice.create).toHaveBeenCalled();
  });
});
