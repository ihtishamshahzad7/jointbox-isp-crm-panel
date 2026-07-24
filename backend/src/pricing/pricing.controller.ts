import {
  Controller, Get, Post, Put, Delete,
  Body, Param, UseGuards, Query, Req,
} from '@nestjs/common';
import { PricingService } from './pricing.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

/**
 * Pricing — extra fees and subscriber-level discounts. Distinct from
 * packages (which carry the headline price) and from taxes (which are
 * recurring). Use cases:
 *   • "Customer X gets 25% off for 6 months" → SubscriberDiscount
 *   • "Every new connection pays a 500 PKR setup fee" → ExtraFee on package
 *   • "VIP customers skip the QoS fee" → SubscriberDiscount
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('pricing')
export class PricingController {
  constructor(private readonly svc: PricingService) {}

  // ─── Extra fees ──────────────────────────────────────────────────────

  @Get('fees')
  listFees(@Query() query: any) {
    return this.svc.listFees(query);
  }

  @Get('fees/options')
  feeOptions() {
    return this.svc.feeOptions();
  }

  @Get('fees/:id')
  getFee(@Param('id') id: string) {
    return this.svc.getFee(+id);
  }

  @Post('fees')
  createFee(@Body() body: any, @Req() req: any) {
    return this.svc.createFee(body, req.user);
  }

  @Put('fees/:id')
  updateFee(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.svc.updateFee(+id, body, req.user);
  }

  @Delete('fees/:id')
  removeFee(@Param('id') id: string, @Req() req: any) {
    return this.svc.removeFee(+id, req.user);
  }

  // ─── Subscriber discounts ────────────────────────────────────────────

  @Get('subscriber-discounts')
  listDiscounts(@Query() query: any) {
    return this.svc.listDiscounts(query);
  }

  @Get('subscriber-discounts/:id')
  getDiscount(@Param('id') id: string) {
    return this.svc.getDiscount(+id);
  }

  @Post('subscriber-discounts')
  createDiscount(@Body() body: any, @Req() req: any) {
    return this.svc.createDiscount(body, req.user);
  }

  @Put('subscriber-discounts/:id')
  updateDiscount(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.svc.updateDiscount(+id, body, req.user);
  }

  @Delete('subscriber-discounts/:id')
  removeDiscount(@Param('id') id: string, @Req() req: any) {
    return this.svc.removeDiscount(+id, req.user);
  }
}
