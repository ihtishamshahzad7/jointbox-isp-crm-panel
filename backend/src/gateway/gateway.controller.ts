import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { GatewayService } from './gateway.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

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
}
