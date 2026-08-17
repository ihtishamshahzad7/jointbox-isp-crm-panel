import {
  Controller, Get, Post, Put, Delete,
  Body, Param, UseGuards, Query, Req,
} from '@nestjs/common';
import { BillingExtService } from './billing-ext.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

/**
 * Billing extensions:
 *   • ProRatedBilling settings per package
 *   • SubscriberBilling (PREPAID / POSTPAID / HYBRID)
 *   • SubscriberBalance + ledger
 *   • Invoice reversal with full / pro-rata / partial support
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('billing-ext')
export class BillingExtController {
  constructor(private readonly svc: BillingExtService) {}

  // ─── Pro-rata ─────────────────────────────────────────────────────────

  @Get('pro-rata')
  listProRated(@Query() query: any) {
    return this.svc.listProRated(query);
  }

  @Get('pro-rata/package/:pkgId')
  getProRatedForPackage(@Param('pkgId') pkgId: string) {
    return this.svc.getProRatedForPackage(+pkgId);
  }

  @Put('pro-rata/package/:pkgId')
  upsertProRatedForPackage(@Param('pkgId') pkgId: string, @Body() body: any, @Req() req: any) {
    return this.svc.upsertProRatedForPackage(+pkgId, body, req.user);
  }

  /**
   * Calculate a pro-rata first-invoice amount for a given package +
   * activation date. Used by the portal "what will I be charged" widget and
   * by staff when reviewing a mid-cycle activation.
   */
  @Post('pro-rata/calculate')
  calculate(@Body() body: any) {
    return this.svc.calculateProRated(body);
  }

  // ─── Subscriber billing mode ─────────────────────────────────────────

  @Get('subscriber-billing/:subId')
  getBilling(@Param('subId') subId: string) {
    return this.svc.getSubscriberBilling(+subId);
  }

  @Put('subscriber-billing/:subId')
  upsertBilling(@Param('subId') subId: string, @Body() body: any, @Req() req: any) {
    return this.svc.upsertSubscriberBilling(+subId, body, req.user);
  }

  // ─── Subscriber balance / wallet ─────────────────────────────────────

  @Get('subscriber-balance/:subId')
  getBalance(@Param('subId') subId: string) {
    return this.svc.getSubscriberBalance(+subId);
  }

  @Get('subscriber-balance/:subId/ledger')
  getLedger(@Param('subId') subId: string, @Query() query: any) {
    return this.svc.getSubscriberLedger(+subId, query);
  }

  @Post('subscriber-balance/:subId/topup')
  topUp(@Param('subId') subId: string, @Body() body: any, @Req() req: any) {
    return this.svc.topUp(+subId, body, req.user);
  }

  @Post('subscriber-balance/:subId/adjust')
  adjust(@Param('subId') subId: string, @Body() body: any, @Req() req: any) {
    return this.svc.adjust(+subId, body, req.user);
  }

  // ─── Invoice reversal ────────────────────────────────────────────────

  @Get('reversals')
  listReversals(@Query() query: any, @Req() req: any) {
    return this.svc.listReversals(query, req.user);
  }

  @Get('reversals/:id')
  getReversal(@Param('id') id: string, @Req() req: any) {
    return this.svc.getReversal(+id, req.user);
  }

  @Post('invoices/:invoiceId/reverse')
  reverseInvoice(@Param('invoiceId') invoiceId: string, @Body() body: any, @Req() req: any) {
    return this.svc.reverseInvoice(+invoiceId, body, req.user);
  }
}
