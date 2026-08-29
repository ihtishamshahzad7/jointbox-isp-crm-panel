import { BadRequestException } from '@nestjs/common';
import { GatewayService } from './gateway.service';
import { CurrencyService } from '../common/currency.service';

/**
 * PAYSTACK driver — money-path tests.
 *
 * Paystack (Nigeria / Ghana / South Africa / Kenya) was the one gateway on
 * ADVANCEMENT.md's list that was genuinely still missing — PayPal, Razorpay,
 * JazzCash, EasyPaisa and SSLCommerz all turned out to be implemented already.
 *
 * What must never regress:
 *   1. `amount` is sent in the MINOR unit (kobo/pesewa/cent) — major × 100.
 *      Getting this wrong undercharges by 100×.
 *   2. The currency sent is the resolved billing currency, never Paystack's
 *      account default (the class of bug fixed in billingCurrency()).
 *   3. A missing subscriber email does not collapse every such customer into
 *      one Paystack customer record.
 *   4. Settlement is decided by ASKING Paystack, never by trusting the
 *      redirect — and a `success` for the wrong amount or currency is NOT a
 *      paid invoice.
 */
describe('GatewayService — Paystack', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  function makeService(opts: { subscriberEmail?: string | null; currency?: string } = {}) {
    const prisma: any = {
      isp: { findFirst: jest.fn().mockResolvedValue({ currency: opts.currency ?? 'NGN' }) },
      invoice: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          invoiceNo: 'INV-77',
          subscriberId: 42,
          status: 'UNPAID',
          dueAmount: 1500.5,
          total: 1500.5,
          subscriber: {
            fullName: 'Ada',
            phone: '0801',
            email: opts.subscriberEmail === undefined ? 'ada@example.com' : opts.subscriberEmail,
          },
        }),
      },
      gatewayTransaction: {
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 9, ...data })),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({
          id: 9,
          idempotencyKey: 'KEY-1',
          amount: 1500.5,
          currency: 'NGN',
          status: 'INITIATED',
          subscriberId: 42,
        }),
      },
    };
    const svc = new GatewayService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      // The real CurrencyService, on the same mocked prisma: these specs exist
      // to prove the currency RESOLUTION is right, so stubbing it out would
      // hollow out the very thing under test.
      new CurrencyService(prisma),
    );
    // handleSuccess/handleFailure are exercised by their own specs; here we
    // only care about which one this driver decides to call.
    const onSuccess = jest.spyOn(svc, 'handleSuccess').mockResolvedValue({ ok: true } as any);
    const onFailure = jest.spyOn(svc, 'handleFailure').mockResolvedValue({ ok: true } as any);
    return { prisma, svc, onSuccess, onFailure };
  }

  /** Stub fetch with one JSON response. */
  function stubFetch(body: any, ok = true) {
    const fn = jest.fn().mockResolvedValue({ ok, json: async () => body });
    (global as any).fetch = fn;
    return fn;
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_x';
    delete process.env.GATEWAY_CURRENCY;
  });

  afterAll(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  describe('availability', () => {
    it('is offered only when PAYSTACK_SECRET_KEY is set', () => {
      const { svc } = makeService();
      expect(svc.availableGateways()).toContain('PAYSTACK');

      delete process.env.PAYSTACK_SECRET_KEY;
      expect(svc.availableGateways()).not.toContain('PAYSTACK');
    });
  });

  describe('checkout request', () => {
    it('sends the amount in the MINOR unit (× 100), not the major unit', async () => {
      const fetchMock = stubFetch({ status: true, data: { authorization_url: 'https://paystack/x', reference: 'KEY-1' } });
      const { svc } = makeService({ currency: 'NGN' });

      await svc.initiate(1, 'PAYSTACK', 42);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.amount).toBe(150050); // 1500.50 → 150050 kobo
      expect(body.amount).not.toBe(1500.5);
    });

    it('sends the resolved billing currency, not a Paystack account default', async () => {
      const fetchMock = stubFetch({ status: true, data: { authorization_url: 'https://paystack/x' } });
      const { svc } = makeService({ currency: 'GHS' });

      await svc.initiate(1, 'PAYSTACK', 42);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.currency).toBe('GHS');
    });

    it("uses the subscriber's real email when there is one", async () => {
      const fetchMock = stubFetch({ status: true, data: { authorization_url: 'https://paystack/x' } });
      const { svc } = makeService({ subscriberEmail: 'ada@example.com' });

      await svc.initiate(1, 'PAYSTACK', 42);

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).email).toBe('ada@example.com');
    });

    it('falls back to a per-subscriber placeholder email — never a shared one', async () => {
      const fetchMock = stubFetch({ status: true, data: { authorization_url: 'https://paystack/x' } });
      const { svc } = makeService({ subscriberEmail: null });

      await svc.initiate(1, 'PAYSTACK', 42);

      const email = JSON.parse(fetchMock.mock.calls[0][1].body).email;
      // Must carry the subscriber id, so two email-less customers do not
      // merge into a single Paystack customer record.
      expect(email).toContain('42');
    });

    it('uses the idempotency key as the Paystack reference (so verify can find it)', async () => {
      const fetchMock = stubFetch({ status: true, data: { authorization_url: 'https://paystack/x' } });
      const { svc, prisma } = makeService();

      await svc.initiate(1, 'PAYSTACK', 42);

      const created = prisma.gatewayTransaction.create.mock.calls[0][0].data;
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).reference).toBe(created.idempotencyKey);
    });

    it('fails loudly when Paystack returns no checkout URL', async () => {
      stubFetch({ status: true, data: {} });
      const { svc } = makeService();
      await expect(svc.initiate(1, 'PAYSTACK', 42)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('surfaces a Paystack error message rather than a bare status code', async () => {
      stubFetch({ status: false, message: 'Invalid key' }, false);
      const { svc } = makeService();
      await expect(svc.initiate(1, 'PAYSTACK', 42)).rejects.toThrow(/Invalid key/);
    });
  });

  describe('currency support guard', () => {
    it('REFUSES a PKR deployment — Paystack cannot settle PKR', async () => {
      const { svc, prisma } = makeService({ currency: 'PKR' });
      await expect(svc.initiate(1, 'PAYSTACK', 42)).rejects.toThrow(/can only take payments in/);
      // Refused before the row was written.
      expect(prisma.gatewayTransaction.create).not.toHaveBeenCalled();
    });

    it('accepts each currency Paystack genuinely supports', () => {
      const { svc } = makeService();
      for (const cur of ['NGN', 'GHS', 'ZAR', 'KES', 'USD']) {
        expect(() => (svc as any).assertGatewaySupportsCurrency('PAYSTACK', cur)).not.toThrow();
      }
    });
  });

  describe('paystackVerify()', () => {
    const verified = (amount: number, currency = 'NGN', status = 'success') => ({
      status: true,
      data: { status, amount, currency, reference: 'KEY-1', gateway_response: 'Successful' },
    });

    it('settles when Paystack confirms success for the exact amount and currency', async () => {
      stubFetch(verified(150050, 'NGN'));
      const { svc, onSuccess, onFailure } = makeService();

      await expect(svc.paystackVerify('KEY-1')).resolves.toBe(true);
      expect(onSuccess).toHaveBeenCalledWith('KEY-1', 'KEY-1', expect.any(String));
      expect(onFailure).not.toHaveBeenCalled();
    });

    it('REFUSES to settle a success reported for the WRONG amount', async () => {
      stubFetch(verified(100, 'NGN')); // paid 1 NGN against a 1500.50 invoice
      const { svc, onSuccess, onFailure } = makeService();

      await expect(svc.paystackVerify('KEY-1')).resolves.toBe(false);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledWith('KEY-1', expect.stringContaining('amount-mismatch'));
    });

    it('REFUSES to settle a success reported in the WRONG currency', async () => {
      stubFetch(verified(150050, 'USD')); // right number, wrong currency
      const { svc, onSuccess, onFailure } = makeService();

      await expect(svc.paystackVerify('KEY-1')).resolves.toBe(false);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledWith('KEY-1', expect.stringContaining('currency-mismatch'));
    });

    it('marks a non-success Paystack status as a failure', async () => {
      stubFetch({ status: true, data: { status: 'abandoned', gateway_response: 'Abandoned' } });
      const { svc, onSuccess, onFailure } = makeService();

      await expect(svc.paystackVerify('KEY-1')).resolves.toBe(false);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledWith('KEY-1', 'Abandoned');
    });

    it('returns false for an unknown key without calling Paystack', async () => {
      const fetchMock = stubFetch({});
      const { svc, prisma } = makeService();
      prisma.gatewayTransaction.findUnique.mockResolvedValue(null);

      await expect(svc.paystackVerify('NOPE')).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
