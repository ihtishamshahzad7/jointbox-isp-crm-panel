import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHmac, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { InvoicesService } from '../invoices/invoices.service';
import { RadiusSyncService } from '../nas/radius-sync.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Phase 3 payment gateway engine.
 * Drivers are env-gated:
 *   SANDBOX     — always available in dev; fake checkout page for end-to-end testing
 *   STRIPE      — STRIPE_SECRET_KEY (+ STRIPE_WEBHOOK_SECRET for signed webhooks)
 *   BKASH       — BKASH_BASE_URL, BKASH_APP_KEY, BKASH_APP_SECRET, BKASH_USERNAME, BKASH_PASSWORD
 *   SSLCOMMERZ  — SSLCZ_STORE_ID, SSLCZ_STORE_PASS (+ SSLCZ_SANDBOX=1 for test mode)
 *   JAZZCASH    — JAZZCASH_MERCHANT_ID, JAZZCASH_PASSWORD, JAZZCASH_INTEGERITY_SALT (+ JAZZCASH_SANDBOX=0/1)
 *   EASYPAISA   — EASYPAISA_STORE_ID, EASYPAISA_STORE_PASS (+ EASYPAISA_SANDBOX=0/1)
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
  ) {}

  private get backendUrl() {
    return process.env.BACKEND_PUBLIC_URL || 'http://localhost:3001';
  }
  private get frontendUrl() {
    return process.env.FRONTEND_PUBLIC_URL || 'http://localhost:3000';
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

    const tx = await this.prisma.gatewayTransaction.create({
      data: {
        gateway,
        invoiceId,
        subscriberId: invoice.subscriberId,
        amount,
        currency: process.env.GATEWAY_CURRENCY || 'BDT',
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
      default:
        throw new BadRequestException('Unknown gateway');
    }
    return { transactionId: tx.id, key: tx.idempotencyKey, paymentUrl, amount, gateway };
  }

  // ─────────────────────────────────────────────────────────────
  // SUCCESS / FAIL handling (idempotent)
  // ─────────────────────────────────────────────────────────────
  async handleSuccess(idempotencyKey: string, gatewayRef?: string, payload?: string) {
    const tx = await this.prisma.gatewayTransaction.findUnique({ where: { idempotencyKey } });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.status === 'SUCCESS') return { ok: true, already: true }; // idempotent replay

    await this.prisma.gatewayTransaction.update({
      where: { id: tx.id },
      data: { status: 'SUCCESS', gatewayRef: gatewayRef || null, payload: payload?.slice(0, 4000) || null },
    });

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

  async getTransactions(query: any) {
    const where: any = {};
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
  async reconcile() {
    const success = await this.prisma.gatewayTransaction.findMany({ where: { status: 'SUCCESS' } });
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
      'line_items[0][price_data][currency]': (process.env.GATEWAY_CURRENCY || 'usd').toLowerCase(),
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
    const currency = (process.env.PAYPAL_CURRENCY || process.env.GATEWAY_CURRENCY || 'USD').toUpperCase();
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
      await this.handleSuccess(key, data.id, JSON.stringify(data).slice(0, 4000));
      return true;
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
  /** Verify Razorpay's payment signature (HMAC-SHA256 of order_id|payment_id). */
  verifyRazorpaySignature(orderId: string, paymentId: string, signature: string): boolean {
    const secret = process.env.RAZORPAY_KEY_SECRET || '';
    const expected = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
    return expected === signature;
  }

  /** Verify a Stripe webhook signature (t=...,v1=... header format). */
  verifyStripeSignature(rawBody: string, header: string): boolean {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return false;
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
    const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
    return expected === parts.v1;
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
    const base = process.env.BKASH_BASE_URL || 'https://tokenized.sandbox.bka.sh/v1.2.0-beta';
    const token = await this.bkashToken();
    const res = await fetch(`${base}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token, 'X-APP-Key': process.env.BKASH_APP_KEY || '' },
      body: JSON.stringify({ paymentID }),
    });
    const data: any = await res.json();
    if (data?.transactionStatus === 'Completed') {
      return this.handleSuccess(key, data.trxID, JSON.stringify(data));
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
    // pp_ResponseCode = '000' means success.
    if (body?.pp_ResponseCode === '000') {
      return this.handleSuccess(key, body.pp_TxnRefNo || body.pp_TXNREFNO, JSON.stringify(body));
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
  async epHandle(key: string, result: string): Promise<{ ok: boolean }> {
    if (result === 'success') {
      return this.handleSuccess(key, `easypaisa-${Date.now()}`);
    }
    await this.handleFailure(key, result || 'easypaisa-cancelled');
    return { ok: true };
  }
}
