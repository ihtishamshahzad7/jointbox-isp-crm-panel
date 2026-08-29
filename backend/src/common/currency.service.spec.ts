import { BadRequestException } from '@nestjs/common';
import { CurrencyService } from './currency.service';

/**
 * THE CURRENCY AUTHORITY.
 *
 * WHAT THIS PROTECTS AGAINST
 * Every currency defect found in this codebase has had the same shape: a
 * number crossing into a context that reinterprets it, because no component
 * recorded what the number actually was.
 *
 *   • The gateway bug: a 1,500 PKR invoice sent to Stripe as USD 1,500,
 *     roughly a 278x mischarge, because each driver invented its own default
 *     when GATEWAY_CURRENCY was unset — BDT here, "usd" there, "USD"
 *     elsewhere, and none of them consulted the ISP record.
 *   • The ledger bug this service closes: Invoice, Payment and LedgerEntry
 *     stored amounts bare and the panel rendered them with `Isp.currency`,
 *     read at display time. `Isp.currency` is an editable settings field, so
 *     changing it silently reinterprets the entire financial history.
 *
 * Both come from GUESSING. So the single most important behaviour below is
 * that this service REFUSES rather than defaults: a refusal is a loud,
 * immediate, fixable configuration error, whereas a guess is a mischarge
 * discovered in a bank statement months later.
 */
describe('CurrencyService', () => {
  function make(ispCurrency: string | null | undefined, opts: { throws?: boolean } = {}) {
    const prisma: any = {
      isp: {
        findFirst: opts.throws
          ? jest.fn().mockRejectedValue(new Error('db down'))
          : jest.fn().mockResolvedValue(
              ispCurrency === undefined ? null : { currency: ispCurrency },
            ),
      },
    };
    return { prisma, svc: new CurrencyService(prisma) };
  }

  afterEach(() => {
    delete process.env.GATEWAY_CURRENCY;
  });

  // ───────────────────────────────────────────────────────────────
  // Never guess
  // ───────────────────────────────────────────────────────────────
  describe('billingCurrency()', () => {
    it('reads the ISP record', async () => {
      const { svc } = make('PKR');
      expect(await svc.billingCurrency()).toBe('PKR');
    });

    it('normalises case and whitespace, so "pkr " is not a different currency', async () => {
      const { svc } = make('  pkr ');
      expect(await svc.billingCurrency()).toBe('PKR');
    });

    it('lets an explicit operator override win', async () => {
      process.env.GATEWAY_CURRENCY = 'usd';
      const { svc, prisma } = make('PKR');
      expect(await svc.billingCurrency()).toBe('USD');
      // Someone who set the override made a deliberate decision; we do not
      // second-guess it by consulting the database as well.
      expect(prisma.isp.findFirst).not.toHaveBeenCalled();
    });

    it('THROWS rather than defaulting when nothing is configured', async () => {
      // The whole point. A default here is how a 278x mischarge happens.
      const { svc } = make('');
      await expect(svc.billingCurrency()).rejects.toThrow(BadRequestException);
    });

    it('throws when there is no ISP record at all', async () => {
      const { svc } = make(undefined);
      await expect(svc.billingCurrency()).rejects.toThrow(BadRequestException);
    });

    it('rejects a code that is not ISO 4217 shaped', async () => {
      // "Rs" is the SYMBOL, not the code; storing it would make every
      // downstream comparison against "PKR" silently fail to match.
      const { svc } = make('Rs');
      await expect(svc.billingCurrency()).rejects.toThrow(/three-letter/i);
    });

    it('caches, so a ledger posting does not re-query per line', async () => {
      const { svc, prisma } = make('PKR');
      await svc.billingCurrency();
      await svc.billingCurrency();
      await svc.billingCurrency();
      expect(prisma.isp.findFirst).toHaveBeenCalledTimes(1);
    });

    it('picks up a corrected currency after invalidation, without a restart', async () => {
      const { svc, prisma } = make('PKR');
      expect(await svc.billingCurrency()).toBe('PKR');
      prisma.isp.findFirst.mockResolvedValue({ currency: 'USD' });
      svc.invalidate();
      expect(await svc.billingCurrency()).toBe('USD');
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Recording money must never fail
  // ───────────────────────────────────────────────────────────────
  describe('billingCurrencyOrBlank()', () => {
    it('returns blank instead of throwing, so a real payment is still recorded', async () => {
      // A misconfigured currency must stop a payment being TAKEN. It must not
      // stop a payment that has physically happened from being written down —
      // refusing to record cash that is already in the drawer loses money in a
      // way no report can reconstruct afterwards.
      const { svc } = make('');
      expect(await svc.billingCurrencyOrBlank()).toBe('');
    });

    it('survives the database being unreachable', async () => {
      const { svc } = make('PKR', { throws: true });
      expect(await svc.billingCurrencyOrBlank()).toBe('');
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Conversion
  // ───────────────────────────────────────────────────────────────
  describe('toBase()', () => {
    it('is EXACT when the currencies match — no rate, no multiplication', async () => {
      // The common case by far. Multiplying by a "rate of 1.0" sourced from
      // anywhere else would introduce rounding into every ordinary cash
      // payment in the system.
      const { svc } = make('PKR');
      expect(svc.toBase(1234.56, 'PKR', 'PKR')).toEqual({ baseAmount: 1234.56, fxRate: 1 });
    });

    it('refuses to cross currencies without a rate', async () => {
      // Silently treating 100 USD as 100 PKR is precisely the gateway bug.
      const { svc } = make('PKR');
      expect(() => svc.toBase(100, 'USD', 'PKR')).toThrow(BadRequestException);
      expect(() => svc.toBase(100, 'USD', 'PKR')).toThrow(/exchange rate/i);
    });

    it('rejects a nonsensical rate rather than producing a nonsensical amount', async () => {
      const { svc } = make('PKR');
      for (const bad of [0, -5, NaN, Infinity]) {
        expect(() => svc.toBase(100, 'USD', 'PKR', bad)).toThrow(BadRequestException);
      }
    });

    it('converts and rounds to two places when given the rate that was used', async () => {
      const { svc } = make('PKR');
      expect(svc.toBase(100, 'USD', 'PKR', 278.5)).toEqual({ baseAmount: 27850, fxRate: 278.5 });
    });
  });

  // ───────────────────────────────────────────────────────────────
  // The stamps that call sites spread
  // ───────────────────────────────────────────────────────────────
  describe('paymentStamp()', () => {
    it('records base amount and a rate of 1 for an ordinary local payment', async () => {
      const { svc } = make('PKR');
      expect(await svc.paymentStamp(1500)).toEqual({
        currency: 'PKR',
        baseAmount: 1500,
        fxRate: 1,
      });
    });

    it('records the currency the money ACTUALLY arrived in', async () => {
      // The gateway settled in its own currency. Relabelling that as local
      // money is how a foreign number gets treated as a local amount.
      const { svc } = make('PKR');
      const out = await svc.paymentStamp(100, {
        paidIn: 'USD',
        invoiceCurrency: 'PKR',
        fxRate: 278.5,
      });
      expect(out).toEqual({ currency: 'USD', baseAmount: 27850, fxRate: 278.5 });
    });

    it('refuses a cross-currency payment with no rate', async () => {
      const { svc } = make('PKR');
      await expect(
        svc.paymentStamp(100, { paidIn: 'USD', invoiceCurrency: 'PKR' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('still records the money when nothing is configured at all', async () => {
      const { svc } = make('');
      expect(await svc.paymentStamp(1500)).toEqual({
        currency: '',
        baseAmount: 1500,
        fxRate: 1,
      });
    });

    it('uses the invoice currency when the payment does not state one', async () => {
      // A cash payment against a foreign-priced invoice is in that invoice's
      // currency by default — the note handed over is what the invoice asked for.
      const { svc } = make('PKR');
      const out = await svc.paymentStamp(50, { invoiceCurrency: 'PKR' });
      expect(out).toMatchObject({ currency: 'PKR', fxRate: 1 });
    });
  });

  describe('invoiceStamp()', () => {
    it('stamps the deployment currency', async () => {
      const { svc } = make('BDT');
      expect(await svc.invoiceStamp()).toEqual({ currency: 'BDT' });
    });
  });
});
