import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { InvoicesService } from '../invoices/invoices.service';
import { RadiusSyncService } from '../nas/radius-sync.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CurrencyService } from '../common/currency.service';

/**
 * Phase 3 payment gateway engine.
 * Drivers are env-gated:
 *   SANDBOX     — always available in dev; fake checkout page for end-to-end testing
 *   STRIPE      — STRIPE_SECRET_KEY (+ STRIPE_WEBHOOK_SECRET for signed webhooks)
 *   BKASH       — BKASH_BASE_URL, BKASH_APP_KEY, BKASH_APP_SECRET, BKASH_USERNAME, BKASH_PASSWORD
 *   SSLCOMMERZ  — SSLCZ_STORE_ID, SSLCZ_STORE_PASS (+ SSLCZ_SANDBOX=1 for test mode)
 *   JAZZCASH    — JAZZCASH_MERCHANT_ID, JAZZCASH_PASSWORD, JAZZCASH_INTEGERITY_SALT (+ JAZZCASH_SANDBOX=0/1)
 *   EASYPAISA   — EASYPAISA_STORE_ID, EASYPAISA_STORE_PASS (+ EASYPAISA_SANDBOX=0/1)
 *   PAYPAL      — PAYPAL_CLIENT_ID, PAYPAL_SECRET (+ PAYPAL_ENV=live)
 *   RAZORPAY    — RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
 *   PAYSTACK    — PAYSTACK_SECRET_KEY (+ PAYSTACK_PLACEHOLDER_DOMAIN)
 *
 * Which currencies each can settle is declared in GATEWAY_CURRENCIES and
 * enforced at initiate(); see billingCurrency() for why that matters.
 *
 * Flow: initiate() → subscriber pays on gateway → callback → handleSuccess():
 *   record payment (ledger + notification) → extend expiry → reactivate → RADIUS re-add.
 * Idempotent: a transaction can only transition INITIATED → SUCCESS once.
 */
@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    private prisma: PrismaService,
    private invoices: InvoicesService,
    private radiusSync: RadiusSyncService,
    private notifications: NotificationsService,
    private currency: CurrencyService,
  ) {}

  private get backendUrl() {
    return process.env.BACKEND_PUBLIC_URL || 'http://localhost:3001';
  }
  private get frontendUrl() {
    return process.env.FRONTEND_PUBLIC_URL || 'http://localhost:3000';
  }

  /**
   * The currencies each gateway can actually settle in. A gateway absent from
   * this map is treated as unrestricted (Stripe, PayPal, SANDBOX).
   *
   * Charging a restricted gateway for an invoice priced in a currency it does
   * not support converts nothing — it sends the same NUMBER with a different
   * currency code attached, which is a real mischarge.
   */
  private static readonly GATEWAY_CURRENCIES: Record<string, string[]> = {
    BKASH: ['BDT'],
    SSLCOMMERZ: ['BDT'],
    JAZZCASH: ['PKR'],
    EASYPAISA: ['PKR'],
    RAZORPAY: ['INR'],
    // Paystack is multi-country (Nigeria, Ghana, South Africa, Kenya) and also
    // settles USD, so it is a set rather than a single currency.
    PAYSTACK: ['NGN', 'GHS', 'ZAR', 'KES', 'USD'],
  };

  /**
   * The currency this deployment actually bills in.
   *
   * WHY THIS EXISTS — this was the most expensive bug in the product.
   *
   * Every amount in the system (invoice.total, payment.amount) is a bare
   * number denominated in the operator's own currency: the `Isp.currency`
   * field that the whole UI already renders through. Nothing converts it.
   *
   * The gateway drivers, however, each invented their own default when
   * GATEWAY_CURRENCY was unset:
   *   - the GatewayTransaction row defaulted to 'BDT'
   *   - Stripe defaulted to 'usd'
   *   - PayPal defaulted to 'USD'
   * ...so on an unconfigured Pakistani deployment, a 1,500 PKR invoice was
   * sent to Stripe as unit_amount=150000 with currency=usd — a charge of
   * USD 1,500 for a bill worth about USD 5. The stored record then said BDT,
   * agreeing with neither the invoice nor the actual charge.
   *
   * The currency is now taken from the ISP record, which is the only value
   * the amounts are actually denominated in. GATEWAY_CURRENCY still works as
   * an explicit override. If neither is available we refuse rather than
   * guess: a wrong-but-plausible currency silently moves real money, and a
   * failed checkout does not.
   */
  /**
   * Delegates to CurrencyService, which is now the single authority.
   *
   * This method used to carry its own copy of the precedence rule. A second
   * copy of a precedence rule is how the original bug happened — three drivers
   * each with their own idea of the default, disagreeing invisibly until a
   * charge went out roughly 278x wrong. Keeping the method as a thin wrapper
   * rather than deleting it leaves every call site below untouched, while
   * making it impossible for the two rules to drift apart.
   */
  private billingCurrency(): Promise<string> {
    return this.currency.billingCurrency();
  }

  /**
   * Refuse a checkout whose gateway cannot settle in the invoice's currency.
   *
   * Nothing in this product converts between currencies, so the alternative
   * to refusing is sending the invoice's number to a provider that will read
   * it as a different currency entirely.
   */
  private assertGatewaySupportsCurrency(gateway: string, currency: string) {
    const supported = GatewayService.GATEWAY_CURRENCIES[gateway];
    if (supported && !supported.includes(currency)) {
      const list = supported.join(', ');
      throw new BadRequestException(
        `${gateway} can only take payments in ${list}, but this deployment bills in ${currency}. ` +
          `Charging it would send the ${currency} amount as ${supported[0]} without converting it. ` +
          `Use a gateway that supports ${currency}, or bill in ${list}.`,
      );
    }
  }

  availableGateways() {
    const list: string[] = [];
    if ((process.env.NODE_ENV || 'development') !== 'production' || process.env.GATEWAY_SANDBOX === 'on') list.push('SANDBOX');
    if (process.env.STRIPE_SECRET_KEY) list.push('STRIPE');
    if (process.env.BKASH_APP_KEY) list.push('BKASH');
    if (process.env.SSLCZ_STORE_ID) list.push('SSLCOMMERZ');
    if (process.env.JAZZCASH_MERCHANT_ID) list.push('JAZZCASH');
    if (process.env.EASYPAISA_STORE_ID) list.push('EASYPAISA');
    if (process.env.PAYPAL_CLIENT_ID) list.push('PAYPAL');
    if (process.env.RAZORPAY_KEY_ID) list.push('RAZORPAY');
    if (process.env.PAYSTACK_SECRET_KEY) list.push('PAYSTACK');
    return list;
  }

  // ─────────────────────────────────────────────────────────────
  // INITIATE
  // ─────────────────────────────────────────────────────────────
  async initiate(invoiceId: number, gateway: string, subscriberId?: number) {
    gateway = gateway.toUpperCase();
    if (!this.availableGateways().includes(gateway)) {
      throw new BadRequestException(`Gateway ${gateway} is not configured`);
    }
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId }, include: { subscriber: true } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (subscriberId && invoice.subscriberId !== subscriberId) throw new BadRequestException('Not your invoice');
    if (invoice.status === 'PAID' || invoice.status === 'CANCELLED') {
      throw new BadRequestException(`Invoice is ${invoice.status}`);
    }
    const amount = invoice.dueAmount > 0 ? invoice.dueAmount : invoice.total;

    /**
     * A gateway charge needs someone to charge. An invoice detached from its
     * subscriber (customer deleted after billing) cannot start a new online
     * payment — settle it manually instead of creating a transaction pointing
     * at nobody.
     */
    if (invoice.subscriberId == null) {
      throw new BadRequestException(
        'This invoice is no longer linked to a subscriber, so it cannot be paid online. Record the payment manually.',
      );
    }

    // Resolve the real billing currency BEFORE creating the transaction row,
    // so a misconfiguration fails without leaving an orphan record behind.
    const currency = await this.billingCurrency();
    this.assertGatewaySupportsCurrency(gateway, currency);

    const tx = await this.prisma.gatewayTransaction.create({
      data: {
        gateway,
        invoiceId,
        subscriberId: invoice.subscriberId,
        amount,
        currency,
        idempotencyKey: randomUUID(),
      },
    });

    let paymentUrl: string;
    switch (gateway) {
      case 'SANDBOX':
        paymentUrl = `${this.backendUrl}/gateway/sandbox/checkout/${tx.idempotencyKey}`;
        break;
      case 'STRIPE':
        paymentUrl = await this.stripeCheckout(tx, invoice);
        break;
      case 'BKASH':
        paymentUrl = await this.bkashCheckout(tx, invoice);
        break;
      case 'SSLCOMMERZ':
        paymentUrl = await this.sslczCheckout(tx, invoice);
        break;
      case 'JAZZCASH':
        paymentUrl = await this.jazzcashCheckout(tx, invoice);
        break;
      case 'EASYPAISA':
        paymentUrl = await this.epCheckout(tx, invoice);
        break;
      case 'PAYPAL':
        paymentUrl = await this.paypalCheckout(tx, invoice);
        break;
      case 'RAZORPAY':
        paymentUrl = await this.razorpayCheckout(tx, invoice);
        break;
      case 'PAYSTACK':
        paymentUrl = await this.paystackCheckout(tx, invoice);
        break;
      default:
        throw new BadRequestException('Unknown gateway');
    }
    return { transactionId: tx.id, key: tx.idempotencyKey, paymentUrl, amount, gateway };
  }

  // ─────────────────────────────────────────────────────────────
  // SUCCESS / FAIL handling (idempotent)
  // ─────────────────────────────────────────────────────────────
  /**
   * Settle a transaction. Callers must have PROVEN the payment first — a
   * signed webhook, or a server-side check with the provider. Redirect URLs
   * prove nothing: the customer can open /gateway/callback/stripe?result=success
   * themselves, and that used to mark the invoice PAID, extend the service and
   * pay commission with no money moved.
   *
   * `gateway` must match the transaction's own gateway, so one provider's
   * proof cannot settle another provider's (or the sandbox's) transaction.
   * The claim is a conditional update, so two deliveries cannot both settle.
   */
  async handleSuccess(idempotencyKey: string, gatewayRef?: string, payload?: string, gateway?: string) {
    const tx = await this.prisma.gatewayTransaction.findUnique({ where: { idempotencyKey } });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (gateway && tx.gateway !== gateway) {
      this.logger.warn(`Settlement for ${idempotencyKey} came from ${gateway}, but it is a ${tx.gateway} transaction. Ignored.`);
      return { ok: false };
    }
    if (tx.status === 'SUCCESS') return { ok: true, already: true }; // idempotent replay

    const claim = await this.prisma.gatewayTransaction.updateMany({
      where: { id: tx.id, status: { not: 'SUCCESS' } },
      data: { status: 'SUCCESS', gatewayRef: gatewayRef || tx.gatewayRef || null, payload: payload?.slice(0, 4000) || null },
    });
    if (claim.count === 0) return { ok: true, already: true };

    // 1. record payment (posts ledger + PAYMENT_RECEIVED notification via InvoicesService)
    await this.invoices.recordPayment(tx.invoiceId, {
      amount: tx.amount,
      method: 'ONLINE',
      referenceNo: `${tx.gateway}:${gatewayRef || tx.idempotencyKey}`,
      notes: `Online payment via ${tx.gateway}`,
    });

    // 2. extend service + reactivate + RADIUS (the "not exist in world" chain 🔍)
    await this.extendServiceAfterPayment(tx.subscriberId);

    this.logger.log(`Gateway payment SUCCESS tx#${tx.id} ${tx.gateway} invoice#${tx.invoiceId}`);
    return { ok: true };
  }

  async handleFailure(idempotencyKey: string, reason = 'cancelled') {
    const tx = await this.prisma.gatewayTransaction.findUnique({ where: { idempotencyKey } });
    if (!tx || tx.status !== 'INITIATED') return { ok: true };
    await this.prisma.gatewayTransaction.update({
      where: { id: tx.id },
      data: { status: reason === 'cancelled' ? 'CANCELLED' : 'FAILED', payload: reason.slice(0, 500) },
    });
    return { ok: true };
  }

  private async extendServiceAfterPayment(subscriberId: number) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      include: { package: { include: { pool: true } }, serviceSettings: true },
    });
    if (!sub?.package) return;

    const base = sub.serviceSettings?.expiryDate && sub.serviceSettings.expiryDate > new Date()
      ? new Date(sub.serviceSettings.expiryDate)
      : new Date();
    base.setDate(base.getDate() + (sub.package.duration || 30));

    if (sub.serviceSettings) {
      await this.prisma.serviceSettings.update({ where: { subscriberId }, data: { expiryDate: base, isBlocked: false } });
    } else {
      await this.prisma.serviceSettings.create({ data: { subscriberId, expiryDate: base } });
    }
    // New period, fresh allowance — clear any FUP throttle from last cycle.
    await this.prisma.subscriber.update({
      where: { id: subscriberId },
      data: { status: 'ACTIVE', fupApplied: false, fupAppliedAt: null },
    });
    try {
      const subForOpts = await this.prisma.subscriber.findUnique({
        where: { id: subscriberId },
        include: { serviceSettings: true },
      });
      const wantsStatic = subForOpts?.authMethod === 'STATIC' || subForOpts?.serviceSettings?.ipType === 'STATIC';
      const staticIp = wantsStatic ? subForOpts?.serviceSettings?.ipAddress ?? null : null;

      await this.radiusSync.syncSubscriberProfile(
        sub.username,
        sub.password,
        sub.package as any,
        {
          serviceType: subForOpts?.authMethod as any,
          staticIp,
          macAddress: subForOpts?.serviceSettings?.macAddress ?? null,
          sessionTimeout: Number(process.env.HOTSPOT_SESSION_TIMEOUT || 0) || null,
          idleTimeout: Number(process.env.HOTSPOT_IDLE_TIMEOUT || 0) || null,
        },
      );
    } catch (e: any) {
      this.logger.error(`RADIUS re-enable failed for ${sub.username}: ${e.message}`);
    }
    void this.notifications.fireEvent('RENEWAL', sub, { expiry: base });
  }

  /** Whose invoice this is — for the operator route's tenancy check. */
  async invoiceSubscriberId(invoiceId: number): Promise<number | null | undefined> {
    const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId }, select: { subscriberId: true } });
    return inv ? inv.subscriberId : undefined;
  }

  /**
   * `subscriberIds` narrows to the caller's own customers (a company's view);
   * null or omitted is the whole installation (platform owner, internal).
   */
  async getTransactions(query: any, subscriberIds?: number[] | null) {
    const where: any = {};
    if (Array.isArray(subscriberIds)) where.subscriberId = { in: subscriberIds };
    if (query?.status) where.status = query.status;
    if (query?.gateway) where.gateway = query.gateway;
    const limit = Math.min(Number(query?.limit) || 50, 200);
    const cursor = Number(query?.cursor) || 0;
    const rows = await this.prisma.gatewayTransaction.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
      ...(cursor > 0 ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null, hasMore };
  }

  /** Lookup a transaction by its idempotency key (used by controller for JazzCash form). */
  async findTransactionByIdempotencyKey(key: string) {
    return this.prisma.gatewayTransaction.findUnique({ where: { idempotencyKey: key } });
  }

  /** Reconciliation: SUCCESS gateway transactions without a matching payment row. */
  async reconcile(subscriberIds?: number[] | null) {
    const success = await this.prisma.gatewayTransaction.findMany({
      where: { status: 'SUCCESS', ...(Array.isArray(subscriberIds) ? { subscriberId: { in: subscriberIds } } : {}) },
    });
    const mismatches: any[] = [];
    for (const tx of success) {
      const payment = await this.prisma.payment.findFirst({
        where: { invoiceId: tx.invoiceId, referenceNo: { contains: tx.gatewayRef || tx.idempotencyKey } },
      });
      if (!payment) mismatches.push({ transactionId: tx.id, gateway: tx.gateway, invoiceId: tx.invoiceId, amount: tx.amount });
    }
    return { checked: success.length, mismatches };
  }

  // ─────────────────────────────────────────────────────────────
  // DRIVER: STRIPE (Checkout Session via REST)
  // ─────────────────────────────────────────────────────────────
  private async stripeCheckout(tx: any, invoice: any): Promise<string> {
    const params = new URLSearchParams({
      mode: 'payment',
      // tx.currency is the resolved billing currency (see billingCurrency()).
      // It must match the currency tx.amount is denominated in — defaulting
      // this to 'usd' is what caused PKR invoices to be charged as dollars.
      'line_items[0][price_data][currency]': String(tx.currency).toLowerCase(),
      'line_items[0][price_data][product_data][name]': `Invoice ${invoice.invoiceNo}`,
      'line_items[0][price_data][unit_amount]': String(Math.round(tx.amount * 100)),
      'line_items[0][quantity]': '1',
      success_url: `${this.backendUrl}/gateway/callback/stripe?key=${tx.idempotencyKey}&result=success`,
      cancel_url: `${this.backendUrl}/gateway/callback/stripe?key=${tx.idempotencyKey}&result=cancel`,
      client_reference_id: tx.idempotencyKey,
    });
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data: any = await res.json();
    if (!res.ok) throw new BadRequestException(`Stripe: ${data?.error?.message || res.status}`);
    await this.prisma.gatewayTransaction.update({ where: { id: tx.id }, data: { gatewayRef: data.id } });
    return data.url;
  }

  // ─────────────────────────────────────────────────────────────
  // DRIVER: PAYPAL (global — REST v2 orders, redirect + capture)
  // ─────────────────────────────────────────────────────────────
  private get paypalBase() {
    return process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  }
  private async paypalToken(): Promise<string> {
    const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
    const res = await fetch(`${this.paypalBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const data: any = await res.json();
    if (!res.ok) throw new BadRequestException(`PayPal auth failed: ${data?.error_description || res.status}`);
    return data.access_token;
  }
  private async paypalCheckout(tx: any, invoice: any): Promise<string> {
    const token = await this.paypalToken();
    // PAYPAL_CURRENCY stays available as a deliberate override, but the
    // fallback is now the deployment's real billing currency rather than USD.
    const currency = (process.env.PAYPAL_CURRENCY || tx.currency).toUpperCase();
    const res = await fetch(`${this.paypalBase}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: tx.idempotencyKey,
          description: `Invoice ${invoice.invoiceNo}`,
          amount: { currency_code: currency, value: tx.amount.toFixed(2) },
        }],
        application_context: {
          brand_name: 'Internet Service',
          user_action: 'PAY_NOW',
          return_url: `${this.backendUrl}/gateway/callback/paypal?key=${tx.idempotencyKey}`,
          cancel_url: `${this.backendUrl}/gateway/callback/paypal?key=${tx.idempotencyKey}&result=cancel`,
        },
      }),
    });
    const data: any = await res.json();
    if (!res.ok) throw new BadRequestException(`PayPal order failed: ${data?.message || res.status}`);
    await this.prisma.gatewayTransaction.update({ where: { id: tx.id }, data: { gatewayRef: data.id } });
    const approve = (data.links || []).find((l: any) => l.rel === 'approve' || l.rel === 'payer-action');
    if (!approve?.href) throw new BadRequestException('PayPal did not return an approval link');
    return approve.href;
  }
  /** Capture a PayPal order after the payer approves. Returns true on success. */
  async paypalCapture(key: string): Promise<boolean> {
    const tx = await this.prisma.gatewayTransaction.findUnique({ where: { idempotencyKey: key } });
    if (!tx?.gatewayRef) return false;
    const token = await this.paypalToken();
    const res = await fetch(`${this.paypalBase}/v2/checkout/orders/${tx.gatewayRef}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && data?.status === 'COMPLETED') {
      const unit = data?.purchase_units?.[0]?.payments?.captures?.[0]?.amount;
      if (unit?.value != null && Math.abs(Number(unit.value) - Number(tx.amount)) > 0.01) {
        this.logger.error(`PayPal amount mismatch on ${key}: captured ${unit.value}, expected ${tx.amount}. Not settling.`);
        await this.handleFailure(key, 'paypal-amount-mismatch');
        return false;
      }
      const r = await this.handleSuccess(key, data.id, JSON.stringify(data).slice(0, 4000), 'PAYPAL');
      return r.ok;
    }
    await this.handleFailure(key, data?.message || 'paypal-not-completed');
    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // DRIVER: RAZORPAY (India — order + hosted checkout page)
  // ─────────────────────────────────────────────────────────────
  private async razorpayCheckout(tx: any, invoice: any): Promise<string> {
    const basic = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: Math.round(tx.amount * 100), // paise
        currency: (process.env.RAZORPAY_CURRENCY || 'INR').toUpperCase(),
        receipt: invoice.invoiceNo,
        notes: { key: tx.idempotencyKey },
      }),
    });
    const data: any = await res.json();
    if (!res.ok) throw new BadRequestException(`Razorpay order failed: ${data?.error?.description || res.status}`);
    await this.prisma.gatewayTransaction.update({ where: { id: tx.id }, data: { gatewayRef: data.id } });
    // We serve a small hosted page that opens Razorpay Checkout with this order.
    return `${this.backendUrl}/gateway/razorpay/form/${tx.idempotencyKey}`;
  }
  // ─────────────────────────────────────────────────────────────
  // DRIVER: PAYSTACK (Nigeria / Ghana / South Africa / Kenya)
  // ─────────────────────────────────────────────────────────────
  /**
   * Paystack initialise → hosted checkout → callback → verify.
   *
   * Two things this API is strict about, both of which silently corrupt a
   * charge if you get them wrong:
   *
   *   1. `amount` is in the currency's MINOR unit (kobo/pesewa/cent), so it is
   *      the major-unit amount × 100. Sending the major unit undercharges by
   *      100×; sending it to the wrong currency is the bug fixed in
   *      billingCurrency(), so the currency is passed explicitly rather than
   *      left to Paystack's account default.
   *   2. `email` is REQUIRED and is what Paystack keys the customer record on.
   *      A subscriber here may have no email (it is optional in the schema),
   *      so a stable per-subscriber placeholder is used rather than a shared
   *      constant — otherwise every such customer collapses into one Paystack
   *      customer record and their payment history merges.
   */
  private async paystackCheckout(tx: any, invoice: any): Promise<string> {
    const secret = process.env.PAYSTACK_SECRET_KEY || '';
    const email =
      invoice.subscriber?.email?.trim() ||
      `subscriber-${tx.subscriberId}@${process.env.PAYSTACK_PLACEHOLDER_DOMAIN || 'no-email.invalid'}`;

    const res = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        amount: Math.round(tx.amount * 100), // minor unit — see note above
        currency: String(tx.currency).toUpperCase(),
        reference: tx.idempotencyKey,
        callback_url: `${this.backendUrl}/gateway/callback/paystack?key=${tx.idempotencyKey}`,
        metadata: { invoiceNo: invoice.invoiceNo, subscriberId: tx.subscriberId },
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.status) {
      throw new BadRequestException(`Paystack: ${data?.message || res.status}`);
    }
    const url = data?.data?.authorization_url;
    if (!url) throw new BadRequestException('Paystack did not return a checkout URL');
    await this.prisma.gatewayTransaction.update({
      where: { id: tx.id },
      data: { gatewayRef: data.data.reference || tx.idempotencyKey },
    });
    return url;
  }

  /**
   * Confirm a Paystack payment by asking Paystack, never by trusting the
   * redirect. A browser landing on our callback URL proves only that a
   * browser landed there.
   *
   * The amount and currency Paystack reports are checked against what we
   * asked for: a `success` for the wrong amount is not a paid invoice, and
   * accepting it would mark the bill settled for less than it was worth.
   */
  async paystackVerify(key: string): Promise<boolean> {
    const tx = await this.prisma.gatewayTransaction.findUnique({ where: { idempotencyKey: key } });
    if (!tx) return false;

    const secret = process.env.PAYSTACK_SECRET_KEY || '';
    const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const data: any = await res.json().catch(() => ({}));
    const paid = data?.data;

    if (!res.ok || paid?.status !== 'success') {
      await this.handleFailure(key, paid?.gateway_response || data?.message || 'paystack-not-completed');
      return false;
    }

    const expected = Math.round(tx.amount * 100);
    if (Number(paid.amount) !== expected) {
      this.logger.error(
        `Paystack amount mismatch on ${key}: charged ${paid.amount}, expected ${expected} (${tx.currency}). Not settling.`,
      );
      await this.handleFailure(key, `paystack-amount-mismatch:${paid.amount}!=${expected}`);
      return false;
    }
    if (paid.currency && String(paid.currency).toUpperCase() !== String(tx.currency).toUpperCase()) {
      this.logger.error(
        `Paystack currency mismatch on ${key}: charged ${paid.currency}, expected ${tx.currency}. Not settling.`,
      );
      await this.handleFailure(key, `paystack-currency-mismatch:${paid.currency}!=${tx.currency}`);
      return false;
    }

    const r = await this.handleSuccess(key, paid.reference || key, JSON.stringify(paid).slice(0, 4000), 'PAYSTACK');
    return r.ok;
  }

  /**
   * JazzCash response hash: HMAC-SHA256 (key = integrity salt) of the salt
   * followed by every non-empty pp_* value, keys sorted alphabetically,
   * joined with '&'. Compared case-insensitively.
   */
  verifyJazzcashHash(body: any): boolean {
    const salt = process.env.JAZZCASH_INTEGERITY_SALT || '';
    const given = String(body?.pp_SecureHash ?? body?.PP_SECUREHASH ?? '');
    if (!salt || !given) return false;
    const keys = Object.keys(body || {})
      .filter((k) => /^pp_/i.test(k) && k.toLowerCase() !== 'pp_securehash')
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const values = keys.map((k) => String(body[k] ?? '')).filter((v) => v !== '');
    const expected = createHmac('sha256', salt).update([salt, ...values].join('&')).digest('hex');
    return GatewayService.digestsMatch(expected.toLowerCase(), given.toLowerCase());
  }

  /**
   * Stripe redirect: ask Stripe whether the Checkout Session was paid, for
   * the right amount and currency, instead of trusting ?result=success.
   */
  async stripeVerify(key: string): Promise<boolean> {
    const tx = await this.prisma.gatewayTransaction.findUnique({ where: { idempotencyKey: key } });
    if (!tx || tx.gateway !== 'STRIPE' || !tx.gatewayRef || !process.env.STRIPE_SECRET_KEY) return false;
    if (tx.status === 'SUCCESS') return true;
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(tx.gatewayRef)}`, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    }).catch(() => null);
    const s: any = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok || s?.payment_status !== 'paid') return false; // not paid (yet) — the webhook may still settle it
    if (s.client_reference_id && s.client_reference_id !== key) return false;
    if (s.amount_total != null && Number(s.amount_total) !== Math.round(tx.amount * 100)) {
      this.logger.error(`Stripe amount mismatch on ${key}: ${s.amount_total} vs ${Math.round(tx.amount * 100)}. Not settling.`);
      return false;
    }
    if (s.currency && String(s.currency).toUpperCase() !== String(tx.currency).toUpperCase()) return false;
    const r = await this.handleSuccess(key, s.payment_intent || s.id, undefined, 'STRIPE');
    return r.ok;
  }

  /**
   * SSLCommerz: the success redirect carries a val_id that must be confirmed
   * with SSLCommerz's validation API (status VALID/VALIDATED, our tran_id,
   * our amount) before anything settles.
   */
  async sslczVerify(key: string, valId: string): Promise<boolean> {
    const tx = await this.prisma.gatewayTransaction.findUnique({ where: { idempotencyKey: key } });
    if (!tx || tx.gateway !== 'SSLCOMMERZ' || !valId) return false;
    if (tx.status === 'SUCCESS') return true;
    const sandbox = process.env.SSLCZ_SANDBOX !== '0';
    const base = sandbox ? 'https://sandbox.sslcommerz.com' : 'https://securepay.sslcommerz.com';
    const q = new URLSearchParams({
      val_id: valId, store_id: process.env.SSLCZ_STORE_ID || '', store_passwd: process.env.SSLCZ_STORE_PASS || '', format: 'json',
    });
    const res = await fetch(`${base}/validator/api/validationserverAPI.php?${q.toString()}`).catch(() => null);
    const v: any = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok || !['VALID', 'VALIDATED'].includes(String(v?.status))) return false;
    if (v.tran_id && v.tran_id !== key) return false;
    if (v.amount != null && Math.abs(Number(v.amount) - tx.amount) > 0.01) {
      this.logger.error(`SSLCommerz amount mismatch on ${key}: ${v.amount} vs ${tx.amount}. Not settling.`);
      return false;
    }
    if (v.currency && String(v.currency).toUpperCase() !== String(tx.currency).toUpperCase()) return false;
    const r = await this.handleSuccess(key, v.bank_tran_id || valId, JSON.stringify(v).slice(0, 4000), 'SSLCOMMERZ');
    return r.ok;
  }

  /** Verify Razorpay's payment signature (HMAC-SHA256 of order_id|payment_id). */
  verifyRazorpaySignature(orderId: string, paymentId: string, signature: string): boolean {
    const secret = process.env.RAZORPAY_KEY_SECRET || '';
    if (!secret || !orderId || !paymentId || !signature) return false;
    const expected = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
    return GatewayService.digestsMatch(expected, String(signature));
  }

  /**
   * Constant-time hex-digest comparison.
   *
   * `===` on a digest leaks, byte by byte, how much of a guess was correct.
   * timingSafeEqual also throws on a length mismatch, so that is checked
   * first — a wrong-length digest is simply wrong.
   */
  private static digestsMatch(a: string, b: string): boolean {
    if (!a || !b || a.length !== b.length) return false;
    try {
      return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
    } catch {
      return false;
    }
  }

  /**
   * Verify a Stripe webhook signature (`t=...,v1=...`).
   *
   * The timestamp is enforced, not merely parsed: without a freshness window
   * a captured webhook stays replayable forever, and replaying a
   * `checkout.session.completed` is an attempt to settle an invoice for free.
   * handleSuccess() is idempotent, so a replay of an ALREADY-settled payment
   * is harmless — but a replay aimed at a NEW transaction that reuses a
   * captured body is not, and five minutes (Stripe's own recommendation) is
   * ample for legitimate delivery and retries.
   */
  verifyStripeSignature(rawBody: string, header: string): boolean {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !header) return false;
    const parts = Object.fromEntries(
      header.split(',').map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as [string, string];
      }),
    );
    const ts = Number(parts.t);
    if (!Number.isFinite(ts)) return false;
    const ageSeconds = Math.abs(Date.now() / 1000 - ts);
    const tolerance = Number(process.env.WEBHOOK_TOLERANCE_SECONDS || 300);
    if (ageSeconds > tolerance) return false;

    const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    return GatewayService.digestsMatch(expected, parts.v1);
  }

  /**
   * Verify a Paystack webhook: HMAC-SHA512 of the raw body, keyed with the
   * SECRET key (not a separate webhook secret), sent as `x-paystack-signature`.
   */
  verifyPaystackSignature(rawBody: string, header: string): boolean {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret || !header) return false;
    const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
    return GatewayService.digestsMatch(expected, header.trim());
  }

  /**
   * Verify a Razorpay webhook: HMAC-SHA256 of the raw body, keyed with the
   * WEBHOOK secret — a different value from RAZORPAY_KEY_SECRET used for
   * payment signatures, which is an easy and silent thing to mix up.
   */
  verifyRazorpayWebhook(rawBody: string, header: string): boolean {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret || !header) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return GatewayService.digestsMatch(expected, header.trim());
  }

  /**
   * Settle a transaction from a webhook whose signature has ALREADY been
   * verified by the caller.
   *
   * The amount and currency the provider reports are checked against what we
   * asked for before anything settles — the same rule as paystackVerify().
   * A webhook is a claim about money; a valid signature proves who sent it,
   * not that it says what we expected.
   *
   * `minorUnits` says whether the provider quotes the amount in the
   * currency's minor unit (Stripe, Paystack, Razorpay all do).
   */
  async settleFromWebhook(opts: {
    key: string;
    gateway: string;
    amount?: number | null;
    currency?: string | null;
    reference?: string | null;
    payload?: string;
    minorUnits?: boolean;
  }): Promise<{ ok: boolean; reason?: string }> {
    const { key, gateway } = opts;
    if (!key) return { ok: false, reason: 'no-transaction-key' };

    const tx = await this.prisma.gatewayTransaction.findUnique({ where: { idempotencyKey: key } });
    if (!tx) {
      this.logger.warn(`${gateway} webhook referenced unknown transaction ${key}`);
      return { ok: false, reason: 'unknown-transaction' };
    }
    // Already settled — a duplicate delivery or a retry. handleSuccess() is
    // idempotent, but returning early keeps the logs honest about what
    // actually happened.
    if (tx.status === 'SUCCESS') return { ok: true, reason: 'already-settled' };

    if (opts.amount != null) {
      const expected = opts.minorUnits ? Math.round(tx.amount * 100) : tx.amount;
      const reported = Number(opts.amount);
      // Compare with a cent of slack for the non-minor-unit (float) case.
      const differs = opts.minorUnits
        ? Math.round(reported) !== expected
        : Math.abs(reported - expected) > 0.005;
      if (differs) {
        this.logger.error(
          `${gateway} webhook amount mismatch on ${key}: reported ${reported}, expected ${expected}. Not settling.`,
        );
        await this.handleFailure(key, `${gateway.toLowerCase()}-webhook-amount-mismatch`);
        return { ok: false, reason: 'amount-mismatch' };
      }
    }

    if (opts.currency && String(opts.currency).toUpperCase() !== String(tx.currency).toUpperCase()) {
      this.logger.error(
        `${gateway} webhook currency mismatch on ${key}: reported ${opts.currency}, expected ${tx.currency}. Not settling.`,
      );
      await this.handleFailure(key, `${gateway.toLowerCase()}-webhook-currency-mismatch`);
      return { ok: false, reason: 'currency-mismatch' };
    }

    const settled = await this.handleSuccess(key, opts.reference || key, opts.payload, gateway);
    if (!settled.ok) return { ok: false, reason: 'gateway-mismatch' };
    this.logger.log(`${gateway} webhook settled transaction ${key}`);
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────
  // DRIVER: BKASH (tokenized checkout)
  // ─────────────────────────────────────────────────────────────
  private async bkashToken(): Promise<string> {
    const base = process.env.BKASH_BASE_URL || 'https://tokenized.sandbox.bka.sh/v1.2.0-beta';
    const res = await fetch(`${base}/tokenized/checkout/token/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        username: process.env.BKASH_USERNAME || '',
        password: process.env.BKASH_PASSWORD || '',
      },
      body: JSON.stringify({ app_key: process.env.BKASH_APP_KEY, app_secret: process.env.BKASH_APP_SECRET }),
    });
    const data: any = await res.json();
    if (!data?.id_token) throw new BadRequestException(`bKash token failed: ${data?.statusMessage || res.status}`);
    return data.id_token;
  }

  private async bkashCheckout(tx: any, invoice: any): Promise<string> {
    const base = process.env.BKASH_BASE_URL || 'https://tokenized.sandbox.bka.sh/v1.2.0-beta';
    const token = await this.bkashToken();
    const res = await fetch(`${base}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: token,
        'X-APP-Key': process.env.BKASH_APP_KEY || '',
      },
      body: JSON.stringify({
        mode: '0011',
        payerReference: String(tx.subscriberId),
        callbackURL: `${this.backendUrl}/gateway/callback/bkash?key=${tx.idempotencyKey}`,
        amount: tx.amount.toFixed(2),
        currency: 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: invoice.invoiceNo,
      }),
    });
    const data: any = await res.json();
    if (!data?.bkashURL) throw new BadRequestException(`bKash create failed: ${data?.statusMessage || res.status}`);
    await this.prisma.gatewayTransaction.update({ where: { id: tx.id }, data: { gatewayRef: data.paymentID } });
    return data.bkashURL;
  }

  async bkashExecute(key: string, paymentID: string) {
    const own = await this.prisma.gatewayTransaction.findUnique({ where: { idempotencyKey: key } });
    // The paymentID in the redirect must be the one bKash issued for THIS
    // transaction — otherwise one completed payment could settle another.
    if (!own || own.gateway !== 'BKASH' || !own.gatewayRef || own.gatewayRef !== paymentID) {
      return { ok: false };
    }
    const base = process.env.BKASH_BASE_URL || 'https://tokenized.sandbox.bka.sh/v1.2.0-beta';
    const token = await this.bkashToken();
    const res = await fetch(`${base}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token, 'X-APP-Key': process.env.BKASH_APP_KEY || '' },
      body: JSON.stringify({ paymentID }),
    });
    const data: any = await res.json();
    if (data?.transactionStatus === 'Completed') {
      if (data.amount != null && Math.abs(Number(data.amount) - Number(own.amount)) > 0.01) {
        this.logger.error(`bKash amount mismatch on ${key}: paid ${data.amount}, expected ${own.amount}. Not settling.`);
        return this.handleFailure(key, 'bkash-amount-mismatch');
      }
      return this.handleSuccess(key, data.trxID, JSON.stringify(data), 'BKASH');
    }
    return this.handleFailure(key, data?.statusMessage || 'bkash-failed');
  }

  // ─────────────────────────────────────────────────────────────
  // DRIVER: SSLCOMMERZ
  // ─────────────────────────────────────────────────────────────
  private async sslczCheckout(tx: any, invoice: any): Promise<string> {
    const sandbox = process.env.SSLCZ_SANDBOX !== '0';
    const base = sandbox ? 'https://sandbox.sslcommerz.com' : 'https://securepay.sslcommerz.com';
    const params = new URLSearchParams({
      store_id: process.env.SSLCZ_STORE_ID || '',
      store_passwd: process.env.SSLCZ_STORE_PASS || '',
      total_amount: tx.amount.toFixed(2),
      currency: 'BDT',
      tran_id: tx.idempotencyKey,
      success_url: `${this.backendUrl}/gateway/callback/sslcommerz?key=${tx.idempotencyKey}&result=success`,
      fail_url: `${this.backendUrl}/gateway/callback/sslcommerz?key=${tx.idempotencyKey}&result=fail`,
      cancel_url: `${this.backendUrl}/gateway/callback/sslcommerz?key=${tx.idempotencyKey}&result=cancel`,
      cus_name: invoice.subscriber?.fullName || 'Subscriber',
      cus_email: invoice.subscriber?.email || 'no@email.com',
      cus_phone: invoice.subscriber?.phone || '0',
      cus_add1: invoice.subscriber?.address || 'N/A',
      cus_city: 'N/A',
      cus_country: 'Bangladesh',
      shipping_method: 'NO',
      product_name: `Invoice ${invoice.invoiceNo}`,
      product_category: 'ISP',
      product_profile: 'non-physical-goods',
    });
    const res = await fetch(`${base}/gwprocess/v4/api.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data: any = await res.json();
    if (data?.status !== 'SUCCESS' || !data?.GatewayPageURL) {
      throw new BadRequestException(`SSLCommerz: ${data?.failedreason || 'session failed'}`);
    }
    return data.GatewayPageURL;
  }

  // ─────────────────────────────────────────────────────────────
  // DRIVER: JAZZCASH (Pakistan — Mobilink Microfinance Bank)
  // ─────────────────────────────────────────────────────────────
  //
  // JazzCash uses a POST-redirect model: the merchant sends a form to the
  // customer's browser which POSTs to JazzCash's hosted checkout page.
  // The gateway then redirects back to the callback URL with a POST.
  //
  // https://merchants.jazzcash.com.pk/ — Integrated API v2.1
  //
  private async jazzcashCheckout(tx: any, invoice: any): Promise<string> {
    const merchantId = process.env.JAZZCASH_MERCHANT_ID || '';
    const password   = process.env.JAZZCASH_PASSWORD || '';
    const salt       = process.env.JAZZCASH_INTEGERITY_SALT || '';
    const sandbox    = process.env.JAZZCASH_SANDBOX !== '0';
    const base       = sandbox
      ? 'https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/'
      : 'https://payments.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/';

    const pp_TxnDateTime   = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const pp_TxnExpiryDateTime = new Date(Date.now() + 86400_000).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

    // JazzCash requires a specific HMAC-SHA256 integrity check string
    const integrityString = [
      salt,
      'INTEGRITY_SALT_FIXED',      // PP_VERSION
      merchantId,                   // PP_MERCHANT_ID
      password,                     // PP_PASSWORD
      tx.idempotencyKey,            // PP_TXNREFNO
      pp_TxnDateTime,               // PP_TXN_DATE_TIME
      '',                           // PP_BILL_REFERENCE (optional)
      tx.amount.toFixed(2),         // PP_AMOUNT
      '',                           // PP_DISCOUNT (optional)
      'PKR',                        // PP_CURRENCY
      invoice.subscriber?.phone || '0', // PP_MOBILE_NO (optional but recommended)
      invoice.subscriber?.email || '',  // PP_EMAIL (optional)
      '',                           // PP_PIN (optional)
      `${this.backendUrl}/gateway/callback/jazzcash?key=${tx.idempotencyKey}`, // PP_RETURN_URL
      '',                           // PP_SUB_MERCHANT_ID (optional)
      '',                           // PPMP_1 (optional)
      '',                           // PPMP_2 (optional)
      '',                           // PPMP_3 (optional)
      salt,                         // Trailing salt
    ].join('&');

    const pp_SecureHash = createHmac('sha256', salt).update(integrityString).digest('hex');

    // JazzCash doesn't return a URL — the merchant POSTs a form from their
    // own page. We return a self-submitting HTML page instead.
    await this.prisma.gatewayTransaction.update({
      where: { id: tx.id },
      data: { gatewayRef: tx.idempotencyKey },
    });

    const formFields = [
      ['PP_VERSION', 'INTEGRITY_SALT_FIXED'],
      ['PP_MERCHANT_ID', merchantId],
      ['PP_PASSWORD', password],
      ['PP_TXNREFNO', tx.idempotencyKey],
      ['PP_TXN_DATE_TIME', pp_TxnDateTime],
      ['PP_TXN_EXP_DATE_TIME', pp_TxnExpiryDateTime],
      ['PP_AMOUNT', tx.amount.toFixed(2)],
      ['PP_CURRENCY', 'PKR'],
      ['PP_BILL_REFERENCE', `INV-${invoice.id}`],
      ['PP_DESCRIPTION', `Invoice ${invoice.invoiceNo}`],
      ['PP_MOBILE_NO', invoice.subscriber?.phone || ''],
      ['PP_EMAIL', invoice.subscriber?.email || ''],
      ['PP_RETURN_URL', `${this.backendUrl}/gateway/callback/jazzcash?key=${tx.idempotencyKey}`],
      ['PP_SECURE_HASH', pp_SecureHash],
    ];

    const fieldsHtml = formFields
      .map(([name, val]) => `<input type="hidden" name="${name}" value="${val}"/>`)
      .join('\n');

    return `${this.backendUrl}/gateway/jazzcash/form/${tx.idempotencyKey}`;
  }

  /** JazzCash callback — POST from JazzCash after payment. */
  async jazzcashHandle(key: string, body: any): Promise<{ ok: boolean }> {
    // JazzCash POSTs back to our return URL with payment details.
    // pp_ResponseCode = '000' means success — but only when the response is
    // signed with our integrity salt and is about THIS transaction. Anyone can
    // send pp_ResponseCode=000 to this URL.
    if (body?.pp_ResponseCode === '000') {
      const tx = await this.prisma.gatewayTransaction.findUnique({ where: { idempotencyKey: key } });
      if (!tx || tx.gateway !== 'JAZZCASH') return { ok: false };
      if (!this.verifyJazzcashHash(body)) {
        this.logger.warn(`JazzCash response for ${key} failed its integrity hash. Not settling.`);
        return { ok: false };
      }
      const ref = String(body.pp_TxnRefNo ?? body.pp_TXNREFNO ?? '');
      if (ref && ref !== key) return { ok: false };
      const amt = body.pp_Amount ?? body.pp_AMOUNT;
      if (amt != null) {
        const n = Number(amt);
        const okAmount = Math.abs(n - tx.amount) < 0.01 || Math.round(n) === Math.round(tx.amount * 100);
        if (!okAmount) {
          this.logger.error(`JazzCash amount mismatch on ${key}: ${amt} vs ${tx.amount}. Not settling.`);
          await this.handleFailure(key, 'jazzcash-amount-mismatch');
          return { ok: false };
        }
      }
      return this.handleSuccess(key, ref || key, JSON.stringify(body), 'JAZZCASH');
    }
    await this.handleFailure(key, body?.pp_ResponseCode || 'jazzcash-failed');
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────
  // DRIVER: EASYPAISA (Pakistan — Telenor Microfinance Bank)
  // ─────────────────────────────────────────────────────────────
  //
  // Easypaisa uses a hosted checkout page. Merchant sends a POST request to
  // Easypaisa's API, gets back a redirect URL. Callback comes via GET/POST.
  //
  private async epCheckout(tx: any, invoice: any): Promise<string> {
    const storeId   = process.env.EASYPAISA_STORE_ID || '';
    const storePass = process.env.EASYPAISA_STORE_PASS || '';
    const sandbox   = process.env.EASYPAISA_SANDBOX !== '0';
    const base      = sandbox
      ? 'https://sandbox.easypaisa.com.pk/merchantpayment/v2/api'
      : 'https://easypaisa.com.pk/merchantpayment/v2/api';

    const res = await fetch(`${base}/CreateOrder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeId,
        storePass,
        orderId: tx.idempotencyKey,
        transactionAmount: tx.amount.toFixed(2),
        transactionType: 'PAYMENT',
        currency: 'PKR',
        description: `Invoice ${invoice.invoiceNo}`,
        customerName: invoice.subscriber?.fullName || 'Subscriber',
        customerMobile: invoice.subscriber?.phone || '0',
        customerEmail: invoice.subscriber?.email || '',
        token: tx.idempotencyKey,
        successUrl: `${this.backendUrl}/gateway/callback/easypaisa?key=${tx.idempotencyKey}&result=success`,
        failureUrl: `${this.backendUrl}/gateway/callback/easypaisa?key=${tx.idempotencyKey}&result=fail`,
        cancelUrl: `${this.backendUrl}/gateway/callback/easypaisa?key=${tx.idempotencyKey}&result=cancel`,
      }),
    });

    const data: any = await res.json();
    if (!res.ok || !data?.paymentUrl) {
      throw new BadRequestException(`Easypaisa: ${data?.message || data?.error || res.status}`);
    }

    await this.prisma.gatewayTransaction.update({
      where: { id: tx.id },
      data: { gatewayRef: data.orderRef || data.orderId || null },
    });

    return data.paymentUrl;
  }

  /** Easypaisa callback — user redirected back after payment. */
  async epHandle(key: string, result: string): Promise<{ ok: boolean; pending?: boolean }> {
    if (result === 'success') {
      // Easypaisa's redirect carries no signature, so it cannot settle the
      // invoice by itself (anyone can open this URL). The transaction stays
      // open for a verified confirmation, or for staff to record the payment
      // after checking the Easypaisa merchant portal.
      const tx = await this.prisma.gatewayTransaction.findUnique({ where: { idempotencyKey: key } });
      if (tx && tx.gateway === 'EASYPAISA' && tx.status === 'INITIATED') {
        await this.prisma.gatewayTransaction.update({ where: { id: tx.id }, data: { payload: 'customer-returned:awaiting-confirmation' } });
      }
      return { ok: false, pending: true };
    }
    await this.handleFailure(key, result || 'easypaisa-cancelled');
    return { ok: true };
  }
}
