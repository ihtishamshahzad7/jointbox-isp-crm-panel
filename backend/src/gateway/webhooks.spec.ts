import { createHmac } from 'crypto';
import { GatewayService } from './gateway.service';

/**
 * GATEWAY WEBHOOKS — signature verification and settlement guards.
 *
 * WHY WEBHOOKS EXIST HERE
 *
 * Every gateway was redirect-only: the invoice settled when the payer's
 * BROWSER returned to /gateway/callback/*. A customer who paid and then closed
 * the tab never delivered that callback — money left their account while the
 * invoice stayed unpaid, noticed only if someone ran GET /gateway/reconcile.
 *
 * These routes are unauthenticated by necessity (a provider has no JWT), so
 * THE SIGNATURE IS THE AUTHENTICATION. That makes the checks below the whole
 * security boundary, and a webhook is a claim about money: a valid signature
 * proves who sent it, not that it says what we expected.
 */
describe('GatewayService — webhooks', () => {
  const originalEnv = { ...process.env };

  function makeService(tx: any = {}) {
    const prisma: any = {
      gatewayTransaction: {
        findUnique: jest.fn().mockResolvedValue(
          tx === null
            ? null
            : {
                id: 9,
                idempotencyKey: 'KEY-1',
                amount: 1500.5,
                currency: 'NGN',
                status: 'INITIATED',
                ...tx,
              },
        ),
      },
    };
    const svc = new GatewayService(prisma, {} as any, {} as any, {} as any);
    const onSuccess = jest.spyOn(svc, 'handleSuccess').mockResolvedValue({ ok: true } as any);
    const onFailure = jest.spyOn(svc, 'handleFailure').mockResolvedValue({ ok: true } as any);
    return { prisma, svc, onSuccess, onFailure };
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
  });
  afterAll(() => {
    process.env = { ...originalEnv };
  });

  // ─────────────────────────────────────────────────────────────
  // Stripe
  // ─────────────────────────────────────────────────────────────
  describe('verifyStripeSignature()', () => {
    const secret = 'whsec_test';
    const body = '{"type":"checkout.session.completed"}';
    const sign = (ts: number, b = body, key = secret) =>
      `t=${ts},v1=${createHmac('sha256', key).update(`${ts}.${b}`).digest('hex')}`;

    beforeEach(() => {
      process.env.STRIPE_WEBHOOK_SECRET = secret;
    });

    it('accepts a correctly signed, fresh webhook', () => {
      const { svc } = makeService();
      const now = Math.floor(Date.now() / 1000);
      expect(svc.verifyStripeSignature(body, sign(now))).toBe(true);
    });

    it('rejects a signature made with the wrong secret', () => {
      const { svc } = makeService();
      const now = Math.floor(Date.now() / 1000);
      expect(svc.verifyStripeSignature(body, sign(now, body, 'whsec_wrong'))).toBe(false);
    });

    it('rejects a valid signature over DIFFERENT bytes (tampered body)', () => {
      const { svc } = makeService();
      const now = Math.floor(Date.now() / 1000);
      const header = sign(now, body);
      expect(svc.verifyStripeSignature('{"type":"evil"}', header)).toBe(false);
    });

    it('REJECTS a replay: correctly signed but outside the freshness window', () => {
      const { svc } = makeService();
      const old = Math.floor(Date.now() / 1000) - 3600; // an hour ago
      // The HMAC itself is perfectly valid — only the age disqualifies it.
      expect(svc.verifyStripeSignature(body, sign(old))).toBe(false);
    });

    it('honours a configurable tolerance', () => {
      process.env.WEBHOOK_TOLERANCE_SECONDS = '7200';
      const { svc } = makeService();
      const old = Math.floor(Date.now() / 1000) - 3600;
      expect(svc.verifyStripeSignature(body, sign(old))).toBe(true);
    });

    it('rejects when no webhook secret is configured (fails closed)', () => {
      delete process.env.STRIPE_WEBHOOK_SECRET;
      const { svc } = makeService();
      const now = Math.floor(Date.now() / 1000);
      expect(svc.verifyStripeSignature(body, sign(now))).toBe(false);
    });

    it('rejects a missing or malformed header instead of throwing', () => {
      const { svc } = makeService();
      expect(svc.verifyStripeSignature(body, '')).toBe(false);
      expect(svc.verifyStripeSignature(body, 'garbage')).toBe(false);
      expect(svc.verifyStripeSignature(body, 't=notanumber,v1=abc')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Paystack (HMAC-SHA512, keyed with the secret key)
  // ─────────────────────────────────────────────────────────────
  describe('verifyPaystackSignature()', () => {
    const secret = 'sk_test_x';
    const body = '{"event":"charge.success"}';

    beforeEach(() => {
      process.env.PAYSTACK_SECRET_KEY = secret;
    });

    it('accepts a correct SHA512 signature', () => {
      const { svc } = makeService();
      const sig = createHmac('sha512', secret).update(body).digest('hex');
      expect(svc.verifyPaystackSignature(body, sig)).toBe(true);
    });

    it('rejects a SHA256 signature — the algorithm matters', () => {
      const { svc } = makeService();
      const wrongAlgo = createHmac('sha256', secret).update(body).digest('hex');
      expect(svc.verifyPaystackSignature(body, wrongAlgo)).toBe(false);
    });

    it('rejects a tampered body', () => {
      const { svc } = makeService();
      const sig = createHmac('sha512', secret).update(body).digest('hex');
      expect(svc.verifyPaystackSignature('{"event":"evil"}', sig)).toBe(false);
    });

    it('fails closed with no secret configured', () => {
      delete process.env.PAYSTACK_SECRET_KEY;
      const { svc } = makeService();
      expect(svc.verifyPaystackSignature(body, 'anything')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Razorpay (separate WEBHOOK secret — easy to confuse with the key secret)
  // ─────────────────────────────────────────────────────────────
  describe('verifyRazorpayWebhook()', () => {
    const body = '{"event":"payment.captured"}';

    it('accepts a signature made with RAZORPAY_WEBHOOK_SECRET', () => {
      process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_rzp';
      const { svc } = makeService();
      const sig = createHmac('sha256', 'whsec_rzp').update(body).digest('hex');
      expect(svc.verifyRazorpayWebhook(body, sig)).toBe(true);
    });

    it('does NOT accept one made with the payment key secret', () => {
      process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_rzp';
      process.env.RAZORPAY_KEY_SECRET = 'keysecret';
      const { svc } = makeService();
      const sig = createHmac('sha256', 'keysecret').update(body).digest('hex');
      expect(svc.verifyRazorpayWebhook(body, sig)).toBe(false);
    });

    it('fails closed when the webhook secret is unset', () => {
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
      const { svc } = makeService();
      expect(svc.verifyRazorpayWebhook(body, 'anything')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // settleFromWebhook — what a verified webhook is allowed to do
  // ─────────────────────────────────────────────────────────────
  describe('settleFromWebhook()', () => {
    const base = { key: 'KEY-1', gateway: 'PAYSTACK', minorUnits: true };

    it('settles when the reported amount and currency match', async () => {
      const { svc, onSuccess } = makeService();
      const r = await svc.settleFromWebhook({ ...base, amount: 150050, currency: 'NGN' });
      expect(r.ok).toBe(true);
      expect(onSuccess).toHaveBeenCalledWith('KEY-1', 'KEY-1', undefined);
    });

    it('REFUSES a verified webhook reporting the WRONG amount', async () => {
      const { svc, onSuccess, onFailure } = makeService();
      const r = await svc.settleFromWebhook({ ...base, amount: 100, currency: 'NGN' });
      expect(r).toMatchObject({ ok: false, reason: 'amount-mismatch' });
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalled();
    });

    it('REFUSES a verified webhook reporting the WRONG currency', async () => {
      const { svc, onSuccess, onFailure } = makeService();
      const r = await svc.settleFromWebhook({ ...base, amount: 150050, currency: 'USD' });
      expect(r).toMatchObject({ ok: false, reason: 'currency-mismatch' });
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalled();
    });

    it('treats a duplicate delivery of an already-settled payment as a no-op', async () => {
      const { svc, onSuccess } = makeService({ status: 'SUCCESS' });
      const r = await svc.settleFromWebhook({ ...base, amount: 150050, currency: 'NGN' });
      expect(r).toMatchObject({ ok: true, reason: 'already-settled' });
      // Not re-settled — no second payment row, no second notification.
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('ignores a webhook for an unknown transaction without settling anything', async () => {
      const { svc, onSuccess, onFailure } = makeService(null);
      const r = await svc.settleFromWebhook({ ...base, amount: 150050 });
      expect(r).toMatchObject({ ok: false, reason: 'unknown-transaction' });
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
    });

    it('ignores a webhook carrying no transaction key', async () => {
      const { svc, onSuccess } = makeService();
      const r = await svc.settleFromWebhook({ ...base, key: '' });
      expect(r).toMatchObject({ ok: false, reason: 'no-transaction-key' });
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('compares in major units when the provider does not use minor units', async () => {
      const { svc, onSuccess } = makeService();
      const r = await svc.settleFromWebhook({
        key: 'KEY-1', gateway: 'PAYPAL', amount: 1500.5, currency: 'NGN', minorUnits: false,
      });
      expect(r.ok).toBe(true);
      expect(onSuccess).toHaveBeenCalled();
    });

    it('settles when the provider reports no amount at all (nothing to contradict)', async () => {
      const { svc, onSuccess } = makeService();
      const r = await svc.settleFromWebhook({ key: 'KEY-1', gateway: 'STRIPE' });
      expect(r.ok).toBe(true);
      expect(onSuccess).toHaveBeenCalled();
    });
  });
});
