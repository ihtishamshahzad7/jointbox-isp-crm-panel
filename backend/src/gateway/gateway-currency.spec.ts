import { BadRequestException } from '@nestjs/common';
import { GatewayService } from './gateway.service';
import { CurrencyService } from '../common/currency.service';

/**
 * GATEWAY CURRENCY — money-path regression tests.
 *
 * THE BUG THESE CLOSE
 *
 * Every amount in this product is a bare number denominated in the operator's
 * own currency (`Isp.currency`). Nothing converts between currencies. But each
 * gateway driver used to invent its own default when GATEWAY_CURRENCY was
 * unset:
 *
 *   - the GatewayTransaction row defaulted to 'BDT'
 *   - Stripe defaulted to 'usd'
 *   - PayPal defaulted to 'USD'
 *
 * So on an unconfigured Pakistani deployment, a 1,500 PKR invoice was sent to
 * Stripe as unit_amount=150000 with currency=usd: a USD 1,500 charge for a
 * bill worth roughly USD 5, while the stored record claimed BDT — agreeing
 * with neither the invoice nor the actual charge.
 *
 * What must never regress:
 *   1. The currency charged is the currency the invoice is DENOMINATED in
 *      (the ISP record), not a hardcoded foreign default.
 *   2. GATEWAY_CURRENCY remains an explicit override.
 *   3. With neither available, checkout FAILS rather than guessing — a wrong
 *      currency moves real money; a failed checkout does not.
 *   4. A single-country gateway refuses an invoice in another currency
 *      instead of sending the same number under a different currency code.
 */
describe('GatewayService — billing currency', () => {
  const originalEnv = { ...process.env };

  function makeService(opts: { ispCurrency?: string | null } = {}) {
    const prisma: any = {
      isp: {
        findFirst: jest.fn().mockResolvedValue(
          opts.ispCurrency === undefined ? { currency: 'PKR' } : opts.ispCurrency === null ? null : { currency: opts.ispCurrency },
        ),
      },
      invoice: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          invoiceNo: 'INV-001',
          subscriberId: 42,
          status: 'UNPAID',
          dueAmount: 1500,
          total: 1500,
          subscriber: { fullName: 'Test', phone: '0300' },
        }),
      },
      gatewayTransaction: {
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 9, ...data })),
        update: jest.fn().mockResolvedValue({}),
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
    return { prisma, svc };
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Keep the driver list deterministic; SANDBOX needs no network.
    process.env.NODE_ENV = 'development';
    delete process.env.GATEWAY_CURRENCY;
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  const billingCurrency = (svc: GatewayService) => (svc as any).billingCurrency();

  describe('billingCurrency()', () => {
    it("uses the ISP record's currency — the one the amounts are actually in", async () => {
      const { svc } = makeService({ ispCurrency: 'PKR' });
      await expect(billingCurrency(svc)).resolves.toBe('PKR');
    });

    it('does NOT fall back to BDT or USD for a non-Bangladeshi, non-US deployment', async () => {
      const { svc } = makeService({ ispCurrency: 'INR' });
      const code = await billingCurrency(svc);
      expect(code).toBe('INR');
      expect(['BDT', 'USD']).not.toContain(code);
    });

    it('honours GATEWAY_CURRENCY as an explicit override', async () => {
      process.env.GATEWAY_CURRENCY = 'aed';
      const { svc, prisma } = makeService({ ispCurrency: 'PKR' });
      await expect(billingCurrency(svc)).resolves.toBe('AED'); // normalised
      expect(prisma.isp.findFirst).not.toHaveBeenCalled();
    });

    it('REFUSES rather than guessing when no currency can be determined', async () => {
      const { svc } = makeService({ ispCurrency: null });
      await expect(billingCurrency(svc)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('treats a blank ISP currency as "not configured", not as a valid code', async () => {
      const { svc } = makeService({ ispCurrency: '   ' });
      await expect(billingCurrency(svc)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('assertGatewaySupportsCurrency()', () => {
    const assert_ = (svc: GatewayService, gw: string, cur: string) =>
      (svc as any).assertGatewaySupportsCurrency(gw, cur);

    it('allows a single-country gateway when the currency matches', () => {
      const { svc } = makeService();
      expect(() => assert_(svc, 'BKASH', 'BDT')).not.toThrow();
      expect(() => assert_(svc, 'JAZZCASH', 'PKR')).not.toThrow();
    });

    it('REFUSES bKash for a PKR deployment — it would send the PKR number as BDT', () => {
      const { svc } = makeService();
      expect(() => assert_(svc, 'BKASH', 'PKR')).toThrow(BadRequestException);
    });

    it('REFUSES JazzCash for a BDT deployment', () => {
      const { svc } = makeService();
      expect(() => assert_(svc, 'JAZZCASH', 'BDT')).toThrow(BadRequestException);
    });

    it('explains the mismatch in the error, naming both currencies', () => {
      const { svc } = makeService();
      expect(() => assert_(svc, 'SSLCOMMERZ', 'INR')).toThrow(/only take payments in BDT/);
      expect(() => assert_(svc, 'SSLCOMMERZ', 'INR')).toThrow(/bills in INR/);
    });

    it('leaves multi-currency gateways (Stripe, PayPal, SANDBOX) unrestricted', () => {
      const { svc } = makeService();
      for (const gw of ['STRIPE', 'PAYPAL', 'SANDBOX']) {
        expect(() => assert_(svc, gw, 'PKR')).not.toThrow();
        expect(() => assert_(svc, gw, 'EUR')).not.toThrow();
      }
    });
  });

  describe('initiate() stamps the resolved currency on the transaction', () => {
    it("records the ISP's currency, not the old hardcoded BDT default", async () => {
      const { svc, prisma } = makeService({ ispCurrency: 'PKR' });

      await svc.initiate(1, 'SANDBOX', 42);

      const created = prisma.gatewayTransaction.create.mock.calls[0][0].data;
      expect(created.currency).toBe('PKR');
      expect(created.currency).not.toBe('BDT');
      // The amount is unchanged — only the currency label was ever wrong.
      expect(created.amount).toBe(1500);
    });

    it('creates NO transaction row when the currency cannot be resolved', async () => {
      const { svc, prisma } = makeService({ ispCurrency: null });

      await expect(svc.initiate(1, 'SANDBOX', 42)).rejects.toBeInstanceOf(BadRequestException);
      // Failing before the insert is what keeps an orphan row out of the books.
      expect(prisma.gatewayTransaction.create).not.toHaveBeenCalled();
    });
  });
});
