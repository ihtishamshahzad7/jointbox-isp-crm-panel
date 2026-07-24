import {
  Controller, Get, Post, Put, Delete,
  Body, Param, UseGuards, Patch, Query, Req,
} from '@nestjs/common';
import { PaymentGatewaysService } from './payment-gateways.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

/**
 * Payment gateways
 *
 * Two surfaces:
 *   /payment-gateways/portal/*  — public, used by the subscriber portal at
 *                                 checkout (no auth, only safe publicConfig
 *                                 is exposed)
 *   /payment-gateways/admin/*   — protected, full CRUD + secret management
 *                                 for ISP staff
 *
 * The actual gateway integrations live in the service. Each provider has its
 * own method (createOrder, verifySignature, parseWebhook). The controller is
 * a thin shell that enforces auth.
 */
@Controller('payment-gateways')
export class PaymentGatewaysController {
  constructor(private readonly svc: PaymentGatewaysService) {}

  // ─── Public portal surface ────────────────────────────────────────────

  /** Used by the portal to render the checkout list. No auth. */
  @Get('portal/active')
  publicList() {
    return this.svc.publicList();
  }

  /** Initiate a checkout. Returns a redirect URL or a payment form. */
  @Post('portal/checkout')
  publicCheckout(@Body() body: any, @Req() req: any) {
    return this.svc.createCheckout(body, req);
  }

  /**
   * Webhook for gateway callbacks. No auth — the gateway signs the request
   * and we verify the signature in the service. Idempotent: same transaction
   * reference is a no-op.
   */
  @Post('portal/webhook/:provider')
  publicWebhook(@Param('provider') provider: string, @Body() body: any, @Req() req: any) {
    return this.svc.handleWebhook(provider, body, req);
  }

  /** Used by the portal to poll the status of an in-flight payment. */
  @Get('portal/transaction/:reference')
  publicStatus(@Param('reference') reference: string) {
    return this.svc.publicStatus(reference);
  }

  // ─── Admin surface ────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Get('admin')
  adminList(@Query() query: any) {
    return this.svc.adminList(query);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Get('admin/:id')
  adminGet(@Param('id') id: string) {
    return this.svc.adminGet(+id);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Post('admin')
  adminCreate(@Body() body: any, @Req() req: any) {
    return this.svc.adminCreate(body, req.user);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Put('admin/:id')
  adminUpdate(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.svc.adminUpdate(+id, body, req.user);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Delete('admin/:id')
  adminRemove(@Param('id') id: string, @Req() req: any) {
    return this.svc.adminRemove(+id, req.user);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Patch('admin/:id/toggle')
  adminToggle(@Param('id') id: string) {
    return this.svc.adminToggle(+id);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Get('admin/:id/transactions')
  adminTransactions(@Param('id') id: string, @Query() query: any) {
    return this.svc.adminTransactions(+id, query);
  }
}
