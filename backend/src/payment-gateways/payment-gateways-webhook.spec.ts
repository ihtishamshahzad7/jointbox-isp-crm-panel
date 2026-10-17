import * as crypto from 'crypto';
import { PaymentGatewaysService } from './payment-gateways.service';

/**
 * The portal webhook is public. Until this change its signature check answered
 * ok for every request, so a forged `{reference, status: "SUCCESS"}` marked a
 * real invoice PAID. These pin the fail-closed behaviour.
 */
function make(gateway: any, amount = 1500) {
  const tx = {
    id: 7,
    reference: 'JT-1',
    status: 'PENDING',
    amount,
    invoiceId: 99,
    subscriberId: 5,
    currency: 'PKR',
    gatewayRef: null,
    gateway,
  };
  const updates: any[] = [];
  const payments: any[] = [];
  const invoice = {
    id: 99,
    total: amount,
    paidAmount: 0,
    paidDate: null,
    status: 'UNPAID',
  };
  // A stateful stand-in for the row lock: updateMany only matches while the
  // transaction is still in a non-final state, exactly like the SQL WHERE.
  const db: any = {
    paymentTransaction: {
      updateMany: jest.fn(async (a: any) => {
        if (a.where.status?.notIn?.includes(tx.status)) return { count: 0 };
        updates.push(a);
        Object.assign(tx, a.data);
        return { count: 1 };
      }),
      update: jest.fn(async (a: any) => ({ ...tx, ...a.data })),
    },
    payment: {
      create: jest.fn(async (a: any) => {
        payments.push(a.data);
        return { id: payments.length };
      }),
    },
    invoice: {
      update: jest.fn(async (a: any) => {
        if (a.data.paidAmount?.increment !== undefined)
          invoice.paidAmount += a.data.paidAmount.increment;
        else Object.assign(invoice, a.data);
        return { ...invoice };
      }),
    },
  };
  const prisma: any = {
    paymentTransaction: {
      findUnique: jest.fn(async () => ({ ...tx })),
      update: jest.fn(async (a: any) => {
        updates.push(a);
        return { ...tx, ...a.data };
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(db)),
  };
  const currency: any = { paymentStamp: jest.fn(async () => ({})) };
  const svc = new PaymentGatewaysService(prisma, currency, {} as any);
  return { svc, updates, prisma, payments, invoice };
}

function jazzSign(body: Record<string, any>, salt: string) {
  const keys = Object.keys(body)
    .filter((k) => k.startsWith('pp_') && body[k] !== '')
    .sort();
  const material = [salt, ...keys.map((k) => String(body[k]))].join('&');
  return crypto
    .createHmac('sha256', salt)
    .update(material)
    .digest('hex')
    .toUpperCase();
}

describe('payment gateway webhook verification', () => {
  const prev = process.env.PAYMENT_WEBHOOK_INSECURE;
  afterEach(() => {
    if (prev === undefined) delete process.env.PAYMENT_WEBHOOK_INSECURE;
    else process.env.PAYMENT_WEBHOOK_INSECURE = prev;
  });

  it('REFUSES an unsigned "SUCCESS" — the forged-payment attack', async () => {
    const { svc, updates } = make({
      provider: 'STRIPE',
      name: 'Stripe',
      secretConfig: {},
    });
    const r: any = await svc.handleWebhook(
      'stripe',
      { reference: 'JT-1', status: 'succeeded' },
      {},
    );
    expect(r.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('refuses a callback naming a different provider than the transaction', async () => {
    const { svc, updates } = make({
      provider: 'JAZZCASH',
      name: 'JC',
      secretConfig: { integritySalt: 's' },
    });
    const r: any = await svc.handleWebhook(
      'other',
      { reference: 'JT-1', status: 'SUCCESS' },
      {},
    );
    expect(r.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('accepts a correctly signed JazzCash callback', async () => {
    const salt = 'integrity-salt';
    const { svc, updates } = make({
      provider: 'JAZZCASH',
      name: 'JC',
      secretConfig: { integritySalt: salt },
    });
    const body: any = {
      pp_BillReference: 'JT-1',
      pp_Amount: '150000',
      pp_ResponseCode: '000',
      pp_TxnRefNo: 'T1',
    };
    body.pp_SecureHash = jazzSign(body, salt);
    const r: any = await svc.handleWebhook('jazzcash', body, {});
    expect(r.ok).toBe(true);
    expect(updates[0].data.status).toBe('SUCCESS');
  });

  it('credits the invoice ONCE when the same callback arrives twice at the same moment', async () => {
    // Gateways deliver the browser redirect and the server IPN together. Both
    // used to read PENDING, both created a Payment, and the invoice was
    // credited twice for one payment.
    const salt = 'integrity-salt';
    const { svc, payments, invoice } = make({
      provider: 'JAZZCASH',
      name: 'JC',
      secretConfig: { integritySalt: salt },
    });
    const body: any = {
      pp_BillReference: 'JT-1',
      pp_Amount: '150000',
      pp_ResponseCode: '000',
      pp_TxnRefNo: 'T1',
    };
    body.pp_SecureHash = jazzSign(body, salt);
    const [a, b]: any[] = await Promise.all([
      svc.handleWebhook('jazzcash', body, {}),
      svc.handleWebhook('jazzcash', body, {}),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(payments).toHaveLength(1);
    expect(invoice.paidAmount).toBe(1500);
    expect(invoice.status).toBe('PAID');
    // And a third, late replay changes nothing either.
    await svc.handleWebhook('jazzcash', body, {});
    expect(payments).toHaveLength(1);
    expect(invoice.paidAmount).toBe(1500);
  });

  it('refuses a JazzCash callback whose fields were edited after signing', async () => {
    const salt = 'integrity-salt';
    const { svc, updates } = make({
      provider: 'JAZZCASH',
      name: 'JC',
      secretConfig: { integritySalt: salt },
    });
    const body: any = {
      pp_BillReference: 'JT-1',
      pp_Amount: '100',
      pp_ResponseCode: '999',
    };
    body.pp_SecureHash = jazzSign(body, salt);
    body.pp_ResponseCode = '000';
    const r: any = await svc.handleWebhook('jazzcash', body, {});
    expect(r.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('refuses a genuinely signed JazzCash callback for a smaller amount', async () => {
    const salt = 'integrity-salt';
    const { svc, updates } = make({
      provider: 'JAZZCASH',
      name: 'JC',
      secretConfig: { integritySalt: salt },
    });
    const body: any = {
      pp_BillReference: 'JT-1',
      pp_Amount: '100',
      pp_ResponseCode: '000',
    };
    body.pp_SecureHash = jazzSign(body, salt);
    const r: any = await svc.handleWebhook('jazzcash', body, {});
    expect(r).toEqual({
      ok: false,
      reason: 'amount does not match the transaction',
    });
    expect(updates).toHaveLength(0);
  });

  it('accepts a generic provider only with a valid HMAC of the raw body', async () => {
    const whsec = 'whsec_test';
    const raw = JSON.stringify({ reference: 'JT-1', status: 'SUCCESS' });
    const good = crypto.createHmac('sha256', whsec).update(raw).digest('hex');
    for (const [sig, ok] of [
      [good, true],
      ['deadbeef', false],
      ['', false],
    ] as const) {
      const { svc } = make({
        provider: 'PAYPAL',
        name: 'PP',
        secretConfig: { webhookSecret: whsec },
      });
      const req = {
        rawBody: Buffer.from(raw),
        headers: { 'x-signature': sig },
      };
      const r: any = await svc.handleWebhook('paypal', JSON.parse(raw), req);
      expect(r.ok).toBe(ok);
    }
  });

  it('the insecure test switch never works in production', async () => {
    process.env.PAYMENT_WEBHOOK_INSECURE = '1';
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { svc, updates } = make({
        provider: 'STRIPE',
        name: 'Stripe',
        secretConfig: {},
      });
      const r: any = await svc.handleWebhook(
        'stripe',
        { reference: 'JT-1', status: 'succeeded' },
        {},
      );
      expect(r.ok).toBe(false);
      expect(updates).toHaveLength(0);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});
