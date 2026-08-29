import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * THE ONE PLACE THAT DECIDES WHAT CURRENCY MONEY IS IN.
 *
 * WHY THIS EXISTS
 * Amounts used to be stored bare and rendered with `Isp.currency`, read at the
 * moment of display. `Isp.currency` is an editable settings field, so changing
 * it silently reinterpreted the whole financial history — a 5,000 PKR invoice
 * from last year reads as 5,000 USD, in every report, with no error and no
 * record anywhere of what the money actually was.
 *
 * That is the same shape as the gateway bug fixed earlier, where an invoice
 * priced in PKR was charged to Stripe as the same NUMBER in USD. Both are a
 * quantity crossing into a context that reinterprets it. Both are fixed the
 * same way: decide the currency ONCE, at write time, from a single authority,
 * and store it beside the number.
 *
 * WHY IT IS A SERVICE AND NOT A HELPER FUNCTION
 * The rule has a precedence order, and precedence rules drift the moment they
 * are copy-pasted. GatewayService had its own private `billingCurrency()`; a
 * second copy in the invoice path would eventually disagree with it, and the
 * disagreement would be invisible until a report did not balance.
 */
@Injectable()
export class CurrencyService {
  private readonly logger = new Logger(CurrencyService.name);

  /**
   * Cached because the write path asks for this on every invoice, payment and
   * ledger line. The TTL is short on purpose: an operator who corrects a
   * misconfigured currency should not have to restart the backend, and a
   * minute of staleness cannot mislabel anything that was not already about
   * to be labelled that way.
   */
  private cached: { code: string; at: number } | null = null;
  private static readonly TTL_MS = 60_000;

  constructor(private prisma: PrismaService) {}

  /** Drop the cache — called when the ISP record is edited. */
  invalidate() {
    this.cached = null;
  }

  /**
   * The deployment's own currency.
   *
   * Precedence, and the reason for it:
   *   1. GATEWAY_CURRENCY — an explicit operator override. If someone has set
   *      it, they have made a deliberate decision and it wins.
   *   2. The Isp record — `isps[0]` ordered by id, the same row the panel UI
   *      and GatewayService already treat as "this deployment".
   *   3. Throw. NEVER a default.
   *
   * The absence of a fallback is the whole point. Every currency defect in
   * this codebase so far has come from a component inventing a plausible
   * default (BDT here, usd there, USD elsewhere) rather than refusing. A
   * refusal is a loud, immediate, fixable configuration error; a guess is a
   * silent mischarge that is discovered in a bank statement.
   */
  async billingCurrency(): Promise<string> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CurrencyService.TTL_MS) {
      return this.cached.code;
    }

    const override = (process.env.GATEWAY_CURRENCY || '').trim();
    if (override) {
      const code = this.normalize(override);
      this.cached = { code, at: now };
      return code;
    }

    const isp = await this.prisma.isp
      .findFirst({ orderBy: { id: 'asc' }, select: { currency: true } })
      .catch(() => null);

    const raw = (isp?.currency || '').trim();
    if (raw) {
      const code = this.normalize(raw);
      this.cached = { code, at: now };
      return code;
    }

    throw new BadRequestException(
      'No billing currency is configured. Set the currency on the ISP record ' +
        '(Settings → Organisation) before recording money, so amounts are not stored unlabelled.',
    );
  }

  /**
   * Same question, but for the write path, which must never explode.
   *
   * A misconfigured currency should stop a PAYMENT being taken — that is
   * `billingCurrency()`. It must not stop an already-completed financial event
   * from being written down: refusing to record a payment that has physically
   * happened loses money in a way no report can reconstruct. So this returns
   * '' and lets the row be written unstamped, loudly, rather than dropping it.
   */
  async billingCurrencyOrBlank(): Promise<string> {
    try {
      return await this.billingCurrency();
    } catch {
      this.logger.error(
        'A money row is being written with no configured currency. Set the ISP currency — ' +
          'these rows cannot be labelled retroactively.',
      );
      return '';
    }
  }

  // ───────────────────────────────────────────────────────────────
  // STAMPS — spread into a Prisma `data` block at each create site.
  //
  // WHY EXPLICIT CALLS AND NOT MIDDLEWARE
  // The obvious move is a Prisma middleware so no call site can forget. That
  // is not available: `$use` was REMOVED in Prisma 6, and its replacement,
  // `$extends`, returns a new client rather than mutating the injected one, so
  // wiring it into a NestJS PrismaService means either a constructor-return
  // trick or proxying every model accessor. Both are framework magic that
  // breaks silently on an upgrade, in the money path, where a silent break is
  // an unlabelled financial record that no later migration can repair.
  //
  // So the stamp is explicit, greppable, and guarded by an architecture test
  // (`currency-stamp.spec.ts`) that reads the source and fails if any
  // invoice/payment create site is missing one. That converts "somebody will
  // forget the fourteenth" from an inevitability into a red build.
  // ───────────────────────────────────────────────────────────────

  /** Spread into `invoice.create({ data })`. */
  async invoiceStamp(): Promise<{ currency: string }> {
    return { currency: await this.billingCurrencyOrBlank() };
  }

  /**
   * Spread into `payment.create({ data })`.
   *
   * `invoiceCurrency` is what the invoice being settled is priced in. When it
   * matches the money that arrived — nearly always — `baseAmount` is the
   * amount itself at a rate of exactly 1, with no multiplication and therefore
   * no rounding introduced into ordinary cash payments.
   */
  async paymentStamp(
    amount: number,
    opts: {
      /** Currency the money actually arrived in; defaults to the deployment's. */
      paidIn?: string | null;
      /** Currency the invoice is priced in; defaults to the deployment's. */
      invoiceCurrency?: string | null;
      /** Rate the payment actually settled at, when the two differ. */
      fxRate?: number | null;
    } = {},
  ): Promise<{ currency: string; baseAmount: number; fxRate: number }> {
    const deployment = await this.billingCurrencyOrBlank();
    const paidIn = (opts.paidIn || deployment || '').toUpperCase();
    const invoiceIn = (opts.invoiceCurrency || deployment || '').toUpperCase();

    // Nothing configured at all: record the money rather than lose it, and let
    // billingCurrencyOrBlank's error log be the alarm.
    if (!paidIn || !invoiceIn) {
      return { currency: paidIn || invoiceIn || '', baseAmount: round2(amount), fxRate: 1 };
    }

    const { baseAmount, fxRate } = this.toBase(amount, paidIn, invoiceIn, opts.fxRate);
    return { currency: paidIn, baseAmount, fxRate };
  }

  /** ISO 4217 shape: three letters, upper case. */
  private normalize(code: string): string {
    const up = code.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(up)) {
      throw new BadRequestException(
        `"${code}" is not a valid ISO currency code. Use a three-letter code such as PKR, USD or BDT.`,
      );
    }
    return up;
  }

  /**
   * Convert an amount that arrived in one currency into the currency the
   * invoice is priced in.
   *
   * DELIBERATELY NOT AN FX LOOKUP. There is no rate table and no rate feed
   * here, and inventing one would be worse than useless: a rate fetched at
   * read time is not evidence of anything, because the rate that mattered is
   * the one that applied on the day the money moved. So the caller supplies
   * the rate it actually used — from the gateway's own settlement response,
   * which is the authoritative record of the conversion that really happened —
   * and this records it alongside the result.
   *
   * When the currencies match, the rate is exactly 1 and no conversion occurs.
   * That is the overwhelmingly common case and it must stay exact: multiplying
   * by a "rate of 1.0" sourced from anywhere else would introduce rounding
   * into every ordinary cash payment in the system.
   */
  toBase(
    amount: number,
    from: string,
    to: string,
    rate?: number | null,
  ): { baseAmount: number; fxRate: number } {
    const a = this.normalize(from || to || 'XXX');
    const b = this.normalize(to || from || 'XXX');

    if (a === b) return { baseAmount: round2(amount), fxRate: 1 };

    if (!rate || !Number.isFinite(rate) || rate <= 0) {
      throw new BadRequestException(
        `A payment in ${a} cannot be applied to an invoice priced in ${b} without an exchange rate. ` +
          `Record the rate the payment actually settled at.`,
      );
    }
    return { baseAmount: round2(amount * rate), fxRate: rate };
  }
}

/** Money is stored as Float here; keep every derived amount to two places. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
