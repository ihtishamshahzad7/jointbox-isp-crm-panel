import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { createHmac } from 'crypto';
import { GatewayService } from './gateway.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

/**
 * Parse a webhook body without letting malformed JSON become a 500.
 *
 * A provider retries on 5xx, so throwing here would turn one bad delivery
 * into an indefinite retry loop.
 */
function safeJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

@Controller('gateway')
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}

  // ── Admin (JWT-protected) ─────────────────────────────────────
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Get('available')
  available() {
    return this.gateway.availableGateways();
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Post('initiate/:invoiceId/:gateway')
  initiate(@Param('invoiceId') invoiceId: string, @Param('gateway') gateway: string) {
    return this.gateway.initiate(+invoiceId, gateway);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Get('transactions')
  transactions(@Query() query: any) {
    return this.gateway.getTransactions(query);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Get('reconcile')
  reconcile() {
    return this.gateway.reconcile();
  }

  // ── Public callbacks (gateways redirect the payer here) ───────

  /** Sandbox checkout page — end-to-end test without a real gateway. */
  @Get('sandbox/checkout/:key')
  sandboxCheckout(@Param('key') key: string, @Res() res: Response) {
    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sandbox Gateway</title>
<style>body{font-family:system-ui;background:#0c1220;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#151f30;border:1px solid #1e2d47;border-radius:14px;padding:32px;text-align:center;max-width:340px}
button{border:none;border-radius:8px;padding:12px 22px;font-size:15px;font-weight:600;cursor:pointer;margin:6px}
.pay{background:#22c55e;color:#fff}.cancel{background:#334155;color:#cbd5e1}</style></head>
<body><div class="card"><h2>🧪 Sandbox Gateway</h2><p>This simulates an online payment.<br>No real money moves.</p>
<form method="POST" action="/gateway/sandbox/confirm/${key}"><button class="pay" name="result" value="success">Pay now</button>
<button class="cancel" name="result" value="cancel">Cancel</button></form></div></body></html>`);
  }

  @Post('sandbox/confirm/:key')
  async sandboxConfirm(@Param('key') key: string, @Body() body: any, @Res() res: Response) {
    const frontend = process.env.FRONTEND_PUBLIC_URL || 'http://localhost:3000';
    if (body?.result === 'success') {
      await this.gateway.handleSuccess(key, `SANDBOX-${Date.now()}`);
      return res.redirect(`${frontend}/portal?paid=1`);
    }
    await this.gateway.handleFailure(key, 'cancelled');
    return res.redirect(`${frontend}/portal?paid=0`);
  }

  /** Stripe redirect callback (also handles cancel). */
  @Get('callback/stripe')
  async stripeCallback(@Query('key') key: string, @Query('result') result: string, @Res() res: Response) {
    const frontend = process.env.FRONTEND_PUBLIC_URL || 'http://localhost:3000';
    if (result === 'success') {
      await this.gateway.handleSuccess(key, 'stripe-redirect');
      return res.redirect(`${frontend}/portal?paid=1`);
    }
    await this.gateway.handleFailure(key, 'cancelled');
    return res.redirect(`${frontend}/portal?paid=0`);
  }

  /** PayPal return callback — capture the approved order, then redirect. */
  @Get('callback/paypal')
  async paypalCallback(@Query('key') key: string, @Query('result') result: string, @Res() res: Response) {
    const frontend = process.env.FRONTEND_PUBLIC_URL || 'http://localhost:3000';
    if (result === 'cancel') {
      await this.gateway.handleFailure(key, 'cancelled');
      return res.redirect(`${frontend}/portal?paid=0`);
    }
    const ok = await this.gateway.paypalCapture(key);
    return res.redirect(`${frontend}/portal?paid=${ok ? 1 : 0}`);
  }

  /**
   * Paystack return callback. Paystack appends its own `reference` and
   * `trxref` to the redirect, but neither is trusted: paystackVerify() asks
   * Paystack's API what actually happened, and checks the amount and
   * currency against what we asked for before settling anything.
   *
   * A customer who pays and then closes the browser never reaches this route,
   * so that payment stays INITIATED until `GET /gateway/reconcile` surfaces
   * it — the same characteristic as the other redirect-based gateways here.
   */
  @Get('callback/paystack')
  async paystackCallback(@Query('key') key: string, @Res() res: Response) {
    const frontend = process.env.FRONTEND_PUBLIC_URL || 'http://localhost:3000';
    const ok = await this.gateway.paystackVerify(key);
    return res.redirect(`${frontend}/portal?paid=${ok ? 1 : 0}`);
  }

  // ── Webhooks (server-to-server, signature-verified) ───────────
  //
  // WHY THESE EXIST
  //
  // Every gateway integration here was redirect-only: the invoice was settled
  // when the payer's BROWSER came back to /gateway/callback/*. A customer who
  // pays and then closes the tab, loses signal, or gets a failed redirect
  // never delivers that callback — so their money left their account while
  // the invoice stayed unpaid, and it was only noticed if someone happened to
  // run GET /gateway/reconcile. Webhooks are the provider telling us
  // server-to-server, independent of the payer's browser.
  //
  // These routes are deliberately unauthenticated — the provider has no JWT.
  // The signature IS the authentication, so an unverified body is rejected
  // and never acted on. They return 200 on "verified but not settled" (e.g.
  // an event type we ignore) so the provider does not retry forever; 400 is
  // reserved for a body we could not authenticate.

  /**
   * Stripe: `checkout.session.completed` carries client_reference_id, which
   * stripeCheckout() sets to the transaction's idempotency key.
   */
  @Post('webhook/stripe')
  async stripeWebhook(@Req() req: any, @Headers('stripe-signature') sig: string, @Res() res: Response) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    if (!this.gateway.verifyStripeSignature(raw, sig || '')) {
      return res.status(400).json({ received: false, error: 'invalid-signature' });
    }
    const event = safeJson(raw);
    if (event?.type !== 'checkout.session.completed') {
      return res.status(200).json({ received: true, ignored: event?.type ?? 'unparseable' });
    }
    const session = event.data?.object ?? {};
    const result = await this.gateway.settleFromWebhook({
      key: session.client_reference_id,
      gateway: 'STRIPE',
      amount: session.amount_total,
      currency: session.currency,
      reference: session.id,
      payload: raw.slice(0, 4000),
      minorUnits: true,
    });
    return res.status(200).json({ received: true, ...result });
  }

  /** Paystack: `charge.success`; `data.reference` is our idempotency key. */
  @Post('webhook/paystack')
  async paystackWebhook(@Req() req: any, @Headers('x-paystack-signature') sig: string, @Res() res: Response) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    if (!this.gateway.verifyPaystackSignature(raw, sig || '')) {
      return res.status(400).json({ received: false, error: 'invalid-signature' });
    }
    const event = safeJson(raw);
    if (event?.event !== 'charge.success') {
      return res.status(200).json({ received: true, ignored: event?.event ?? 'unparseable' });
    }
    const d = event.data ?? {};
    const result = await this.gateway.settleFromWebhook({
      key: d.reference,
      gateway: 'PAYSTACK',
      amount: d.amount,
      currency: d.currency,
      reference: d.reference,
      payload: raw.slice(0, 4000),
      minorUnits: true,
    });
    return res.status(200).json({ received: true, ...result });
  }

  /**
   * Razorpay: `payment.captured`. razorpayCheckout() puts the idempotency key
   * in the ORDER's notes, and Razorpay copies order notes onto the payment.
   */
  @Post('webhook/razorpay')
  async razorpayWebhook(@Req() req: any, @Headers('x-razorpay-signature') sig: string, @Res() res: Response) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    if (!this.gateway.verifyRazorpayWebhook(raw, sig || '')) {
      return res.status(400).json({ received: false, error: 'invalid-signature' });
    }
    const event = safeJson(raw);
    if (event?.event !== 'payment.captured') {
      return res.status(200).json({ received: true, ignored: event?.event ?? 'unparseable' });
    }
    const payment = event.payload?.payment?.entity ?? {};
    const result = await this.gateway.settleFromWebhook({
      key: payment.notes?.key,
      gateway: 'RAZORPAY',
      amount: payment.amount,
      currency: payment.currency,
      reference: payment.id,
      payload: raw.slice(0, 4000),
      minorUnits: true,
    });
    return res.status(200).json({ received: true, ...result });
  }

  /** Razorpay hosted checkout page — opens the Razorpay modal for this order. */
  @Get('razorpay/form/:key')
  async razorpayForm(@Param('key') key: string, @Res() res: Response) {
    const tx = await this.gateway.findTransactionByIdempotencyKey(key);
    if (!tx) return res.status(404).send('Transaction not found');
    const keyId = process.env.RAZORPAY_KEY_ID || '';
    const backend = process.env.BACKEND_PUBLIC_URL || 'http://localhost:3001';
    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Razorpay</title></head>
<body style="font-family:system-ui;background:#0c1220;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh">
<div style="text-align:center"><p>Opening secure payment…</p></div>
<form id="f" method="POST" action="${backend}/gateway/callback/razorpay?key=${key}">
  <input type="hidden" name="razorpay_payment_id" id="pid"><input type="hidden" name="razorpay_order_id" id="oid"><input type="hidden" name="razorpay_signature" id="sig">
</form>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
  var rzp = new Razorpay({
    key: ${JSON.stringify(keyId)},
    order_id: ${JSON.stringify(tx.gatewayRef || '')},
    amount: ${Math.round(tx.amount * 100)},
    name: 'Internet Service',
    description: 'Invoice payment',
    handler: function (r) {
      document.getElementById('pid').value = r.razorpay_payment_id;
      document.getElementById('oid').value = r.razorpay_order_id;
      document.getElementById('sig').value = r.razorpay_signature;
      document.getElementById('f').submit();
    },
    modal: { ondismiss: function () { window.location = '${backend}/gateway/callback/razorpay?key=${key}&cancel=1'; } }
  });
  rzp.open();
</script></body></html>`);
  }

  /** Razorpay callback — verify the signature, then record + redirect. */
  @Post('callback/razorpay')
  async razorpayCallback(@Query('key') key: string, @Body() body: any, @Res() res: Response) {
    const frontend = process.env.FRONTEND_PUBLIC_URL || 'http://localhost:3000';
    const ok = this.gateway.verifyRazorpaySignature(body?.razorpay_order_id, body?.razorpay_payment_id, body?.razorpay_signature);
    if (ok) { await this.gateway.handleSuccess(key, body?.razorpay_payment_id, JSON.stringify(body).slice(0, 2000)); return res.redirect(`${frontend}/portal?paid=1`); }
    await this.gateway.handleFailure(key, 'signature-mismatch');
    return res.redirect(`${frontend}/portal?paid=0`);
  }

  @Get('callback/razorpay')
  async razorpayCancel(@Query('key') key: string, @Res() res: Response) {
    const frontend = process.env.FRONTEND_PUBLIC_URL || 'http://localhost:3000';
    await this.gateway.handleFailure(key, 'cancelled');
    return res.redirect(`${frontend}/portal?paid=0`);
  }

  /** bKash redirect callback: status=success requires an execute call. */
  @Get('callback/bkash')
  async bkashCallback(
    @Query('key') key: string,
    @Query('paymentID') paymentID: string,
    @Query('status') status: string,
    @Res() res: Response,
  ) {
    const frontend = process.env.FRONTEND_PUBLIC_URL || 'http://localhost:3000';
    if (status === 'success' && paymentID) {
      const result: any = await this.gateway.bkashExecute(key, paymentID);
      return res.redirect(`${frontend}/portal?paid=${result?.ok ? 1 : 0}`);
    }
    await this.gateway.handleFailure(key, status || 'cancelled');
    return res.redirect(`${frontend}/portal?paid=0`);
  }

  /** SSLCommerz success/fail/cancel callbacks (POST from gateway). */
  @Post('callback/sslcommerz')
  async sslczCallbackPost(@Query('key') key: string, @Query('result') result: string, @Body() body: any, @Res() res: Response) {
    return this.sslczHandle(key, result, body, res);
  }

  @Get('callback/sslcommerz')
  async sslczCallbackGet(@Query('key') key: string, @Query('result') result: string, @Res() res: Response) {
    return this.sslczHandle(key, result, {}, res);
  }

  private async sslczHandle(key: string, result: string, body: any, res: Response) {
    const frontend = process.env.FRONTEND_PUBLIC_URL || 'http://localhost:3000';
    if (result === 'success') {
      await this.gateway.handleSuccess(key, body?.bank_tran_id || body?.tran_id || 'sslcz', JSON.stringify(body || {}));
      return res.redirect(`${frontend}/portal?paid=1`);
    }
    await this.gateway.handleFailure(key, result || 'failed');
    return res.redirect(`${frontend}/portal?paid=0`);
  }

  // ───────────────────────────────────────────────────────────────
  // JAZZCASH (Pakistan)
  // ───────────────────────────────────────────────────────────────

  /** JazzCash checkout form — renders a self-submitting HTML page. */
  @Get('jazzcash/form/:key')
  async jazzcashForm(@Param('key') key: string, @Res() res: Response) {
    const tx = await this.gateway.findTransactionByIdempotencyKey(key);
    if (!tx) return res.status(404).send('Transaction not found');

    const merchantId = process.env.JAZZCASH_MERCHANT_ID || '';
    const password   = process.env.JAZZCASH_PASSWORD || '';
    const salt       = process.env.JAZZCASH_INTEGERITY_SALT || '';
    const sandbox    = process.env.JAZZCASH_SANDBOX !== '0';
    const base       = sandbox
      ? 'https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/'
      : 'https://payments.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/';

    const pp_TxnDateTime = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const pp_TxnExpiryDateTime = new Date(Date.now() + 86400_000).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

    const integrityString = [
      salt, 'INTEGRITY_SALT_FIXED', merchantId, password, key,
      pp_TxnDateTime, '', tx.amount.toFixed(2), '', 'PKR', '', '', '',
      `${process.env.BACKEND_PUBLIC_URL || 'http://localhost:3001'}/gateway/callback/jazzcash?key=${key}`,
      '', '', '', '', salt,
    ].join('&');

    const pp_SecureHash = createHmac('sha256', salt).update(integrityString).digest('hex');

    res.type('html').send(`<!doctype html><html><head><title>Redirecting to JazzCash...</title>
<style>body{font-family:system-ui;background:#0c1220;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh}
.card{background:#151f30;border:1px solid #1e2d47;border-radius:14px;padding:32px;text-align:center;max-width:380px}
.spinner{border:3px solid #1e2d47;border-top:3px solid #22c55e;border-radius:50%;width:32px;height:32px;animation:spin .8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div class="card"><div class="spinner"></div><h2>Redirecting to JazzCash...</h2>
<p style="color:#94a3b8;font-size:14px;">You are being redirected to JazzCash's secure payment page.</p>
<form id="jazzcash" action="${base}" method="POST">
  <input type="hidden" name="PP_VERSION" value="INTEGRITY_SALT_FIXED">
  <input type="hidden" name="PP_MERCHANT_ID" value="${merchantId}">
  <input type="hidden" name="PP_PASSWORD" value="${password}">
  <input type="hidden" name="PP_TXNREFNO" value="${key}">
  <input type="hidden" name="PP_TXN_DATE_TIME" value="${pp_TxnDateTime}">
  <input type="hidden" name="PP_TXN_EXP_DATE_TIME" value="${pp_TxnExpiryDateTime}">
  <input type="hidden" name="PP_AMOUNT" value="${tx.amount.toFixed(2)}">
  <input type="hidden" name="PP_CURRENCY" value="PKR">
  <input type="hidden" name="PP_BILL_REFERENCE" value="INV-${tx.invoiceId}">
  <input type="hidden" name="PP_DESCRIPTION" value="Invoice Payment">
  <input type="hidden" name="PP_RETURN_URL" value="${process.env.BACKEND_PUBLIC_URL || 'http://localhost:3001'}/gateway/callback/jazzcash?key=${key}">
  <input type="hidden" name="PP_SECURE_HASH" value="${pp_SecureHash}">
  <noscript><button type="submit" style="padding:10px 24px;background:#2563eb;color:white;border:none;border-radius:6px;margin-top:16px;cursor:pointer;">Continue to JazzCash</button></noscript>
</form>
<script>document.getElementById('jazzcash').submit()</script>
</div></body></html>`);
  }

  /** JazzCash callback — POST from JazzCash after payment. */
  @Post('callback/jazzcash')
  async jazzcashCallback(@Query('key') key: string, @Body() body: any, @Res() res: Response) {
    const frontend = process.env.FRONTEND_PUBLIC_URL || 'http://localhost:3000';
    const result: any = await this.gateway.jazzcashHandle(key, body || {});
    return res.redirect(`${frontend}/portal?paid=${result?.ok ? 1 : 0}`);
  }

  @Get('callback/jazzcash')
  async jazzcashCallbackGet(@Query('key') key: string, @Query() query: any, @Res() res: Response) {
    const frontend = process.env.FRONTEND_PUBLIC_URL || 'http://localhost:3000';
    const result: any = await this.gateway.jazzcashHandle(key, query || {});
    return res.redirect(`${frontend}/portal?paid=${result?.ok ? 1 : 0}`);
  }

  // ───────────────────────────────────────────────────────────────
  // EASYPAISA (Pakistan)
  // ───────────────────────────────────────────────────────────────

  @Get('callback/easypaisa')
  async epCallback(@Query('key') key: string, @Query('result') result: string, @Res() res: Response) {
    const frontend = process.env.FRONTEND_PUBLIC_URL || 'http://localhost:3000';
    const r: any = await this.gateway.epHandle(key, result || 'failed');
    return res.redirect(`${frontend}/portal?paid=${r?.ok ? 1 : 0}`);
  }

  @Post('callback/easypaisa')
  async epCallbackPost(@Query('key') key: string, @Query('result') result: string, @Res() res: Response) {
    return this.epCallback(key, result, res);
  }
}
