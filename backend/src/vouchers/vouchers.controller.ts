import {
  Controller, Get, Post, Delete,
  Body, Param, UseGuards, Query, Req,
} from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('vouchers')
export class VouchersController {
  constructor(private readonly vouchersService: VouchersService) {}

  @Get()
  findAll(@Req() req: any) {
    return this.vouchersService.findAll(req.user);
  }

  @Get('stats')
  getStats(@Req() req: any) {
    return this.vouchersService.getStats(req.user);
  }

  /**
   * Card stock per reseller — what each account is holding and its unsold
   * value. Declared before ':id' so "stock" is not read as an id.
   */
  @Get('stock')
  stock(@Req() req: any) {
    return this.vouchersService.stockByReseller(req.user);
  }

  @Get('code/:code')
  findByCode(@Param('code') code: string, @Req() req: any) {
    return this.vouchersService.findByCode(code, req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.vouchersService.findOne(+id, req.user);
  }

  @Post('bulk')
  createBulk(@Body() body: any, @Req() req: any) {
    return this.vouchersService.createBulk(body, req.user);
  }

  /**
   * Hand cards to a reseller, or take them back with assignToUserId: null.
   * Accepts either an explicit set of ids or a whole batch.
   */
  @Post('allocate')
  allocate(
    @Body() body: { voucherIds?: number[]; batchId?: string; assignToUserId: number | null },
    @Req() req: any,
  ) {
    return this.vouchersService.allocate(body, req.user);
  }

  @Post('redeem')
  redeem(@Body() body: any) {
    return this.vouchersService.redeemVoucher(body.code, body.pin, body.subscriberId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.vouchersService.deleteVoucher(+id, req.user);
  }
}