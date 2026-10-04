import { BadRequestException } from '@nestjs/common';
import { PaymentsService } from './payments.service';

/**
 * Money in must be positive, for the invoice's own customer, and no more than
 * the invoice still owes. Found on a running panel: -500 and 0 "payments"
 * were accepted (un-paying the invoice and posting negative cash), a payment
 * for one customer settled another's invoice, and a paid invoice kept taking
 * money until its due amount went negative.
 */
const INVOICES: Record<number, any> = {
  1: { subscriberId: 3, status: 'UNPAID', total: 1500, paidAmount: 0, dueAmount: 1500, currency: null, invoiceNo: 'INV-1' },
  2: { subscriberId: 3, status: 'PAID', total: 1500, paidAmount: 1500, dueAmount: 0, currency: null, invoiceNo: 'INV-2' },
  3: { subscriberId: 3, status: 'CANCELLED', total: 1500, paidAmount: 0, dueAmount: 1500, currency: null, invoiceNo: 'INV-3' },
};

function make() {
  const prisma: any = {
    invoice: { findUnique: jest.fn(async ({ where }: any) => INVOICES[where.id] ?? null) },
  };
  const svc = new PaymentsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return (data: any) => (svc as any).assertPayable(data);
}

describe('payment validation', () => {
  it('refuses zero, negative and non-numeric amounts', async () => {
    const check = make();
    for (const amount of [0, -500, 'abc', null]) {
      await expect(check({ invoiceId: 1, subscriberId: 3, amount })).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("refuses another customer's invoice, a paid or cancelled invoice, and more than is due", async () => {
    const check = make();
    await expect(check({ invoiceId: 1, subscriberId: 9, amount: 100 })).rejects.toThrow(/different customer/);
    await expect(check({ invoiceId: 2, subscriberId: 3, amount: 100 })).rejects.toThrow(/already paid/);
    await expect(check({ invoiceId: 3, subscriberId: 3, amount: 100 })).rejects.toThrow(/cancelled/);
    await expect(check({ invoiceId: 1, subscriberId: 3, amount: 2000 })).rejects.toThrow(/1500 due/);
    await expect(check({ subscriberId: 3, amount: 100 })).rejects.toThrow(/Pick the invoice/);
  });

  it('accepts a part or the full due amount', async () => {
    const check = make();
    await expect(check({ invoiceId: 1, subscriberId: 3, amount: 500 })).resolves.toBeTruthy();
    await expect(check({ invoiceId: 1, amount: 1500 })).resolves.toBeTruthy();
  });
});
