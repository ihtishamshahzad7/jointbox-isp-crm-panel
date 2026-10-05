import { createHmac } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { GatewayService } from './gateway.service';

/**
 * A redirect URL is not proof of payment. Found on a running panel: a customer
 * opened /gateway/callback/stripe?key=K&result=success (or posted to the
 * sandbox confirm route for ANY gateway's transaction) and the invoice was
 * marked PAID, service extended and commission paid — with no money moved.
 */
function make(tx: any) {
  const row = { id: 9, idempotencyKey: 'K', amount: 1000, currency: 'PKR', status: 'INITIATED', gatewayRef: null, invoiceId: 1, subscriberId: 1, ...tx };
  const prisma: any = {
    gatewayTransaction: {
      findUnique: jest.fn(async () => row),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async () => row),
    },
  };
  const invoices: any = { recordPayment: jest.fn(async () => ({})) };
  const svc = new GatewayService(prisma, invoices, {} as any, {} as any, {} as any);
  (svc as any).extendServiceAfterPayment = jest.fn(async () => undefined);
  return { svc, prisma, invoices };
}

describe('gateway settlement needs proof', () => {
  const OLD = { ...process.env };
  afterEach(() => { process.env = { ...OLD }; });

  it("one provider's proof cannot settle another provider's transaction", async () => {
    const { svc, invoices } = make({ gateway: 'STRIPE' });
    await expect(svc.handleSuccess('K', 'x', undefined, 'SANDBOX')).resolves.toEqual({ ok: false });
    expect(invoices.recordPayment).not.toHaveBeenCalled();
  });

  it('a second delivery cannot settle twice', async () => {
    const { svc, prisma, invoices } = make({ gateway: 'STRIPE' });
    prisma.gatewayTransaction.updateMany.mockResolvedValueOnce({ count: 0 });
    await svc.handleSuccess('K', 'x', undefined, 'STRIPE');
    expect(invoices.recordPayment).not.toHaveBeenCalled();
  });

  it('JazzCash: pp_ResponseCode=000 without a valid integrity hash settles nothing', async () => {
    process.env.JAZZCASH_INTEGERITY_SALT = 'salt123';
    const { svc, invoices } = make({ gateway: 'JAZZCASH' });
    await expect(svc.jazzcashHandle('K', { pp_ResponseCode: '000', pp_TxnRefNo: 'K' })).resolves.toEqual({ ok: false });
    expect(invoices.recordPayment).not.toHaveBeenCalled();

    const body: any = { pp_Amount: '100000', pp_ResponseCode: '000', pp_TxnRefNo: 'K' };
    const vals = Object.keys(body).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map((k) => body[k]);
    body.pp_SecureHash = createHmac('sha256', 'salt123').update(['salt123', ...vals].join('&')).digest('hex').toUpperCase();
    await svc.jazzcashHandle('K', body);
    expect(invoices.recordPayment).toHaveBeenCalled();
  });

  it('Easypaisa: the success redirect alone settles nothing', async () => {
    const { svc, invoices } = make({ gateway: 'EASYPAISA' });
    await expect(svc.epHandle('K', 'success')).resolves.toMatchObject({ ok: false, pending: true });
    expect(invoices.recordPayment).not.toHaveBeenCalled();
  });

  it('Razorpay: no secret means no valid signature', () => {
    delete process.env.RAZORPAY_KEY_SECRET;
    const { svc } = make({ gateway: 'RAZORPAY' });
    const forged = createHmac('sha256', '').update('o|p').digest('hex');
    expect(svc.verifyRazorpaySignature('o', 'p', forged)).toBe(false);
  });

  it('the Stripe and SSLCommerz redirects and the sandbox route check with the provider / gateway', () => {
    const ctl = fs.readFileSync(path.join(__dirname, 'gateway.controller.ts'), 'utf8');
    expect(ctl).toMatch(/const ok = await this\.gateway\.stripeVerify\(key\)/);
    expect(ctl).toMatch(/const ok = await this\.gateway\.sslczVerify\(/);
    expect(ctl).toMatch(/if \(!\(await this\.isSandboxTx\(key\)\)\) return res\.status\(404\)/);
    expect(ctl).not.toMatch(/handleSuccess\(key, 'stripe-redirect'\)/);
  });
});
