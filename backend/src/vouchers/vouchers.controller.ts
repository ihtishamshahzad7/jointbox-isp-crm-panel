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
  getStats() {
    return this.vouchersService.getStats();
  }

  @Get('code/:code')
  findByCode(@Param('code') code: string) {
    return this.vouchersService.findByCode(code);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.vouchersService.findOne(+id);
  }

  @Post('bulk')
  createBulk(@Body() body: any) {
    return this.vouchersService.createBulk(body);
  }

  @Post('redeem')
  redeem(@Body() body: any) {
    return this.vouchersService.redeemVoucher(body.code, body.pin, body.subscriberId);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.vouchersService.deleteVoucher(+id);
  }
}