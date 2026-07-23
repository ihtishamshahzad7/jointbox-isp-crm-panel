import {
  Controller, Get, Post, Put, Delete,
  Body, Param, UseGuards, Query, Req,
} from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  findAll(@Req() req: any) {
    return this.invoicesService.findAll(req.user);
  }

  @Get('stats')
  getStats() {
    return this.invoicesService.getStats();
  }

  @Get('subscriber/:subscriberId')
  findBySubscriber(@Param('subscriberId') subscriberId: string) {
    return this.invoicesService.findBySubscriber(+subscriberId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.invoicesService.findOne(+id);
  }

  @Post()
  create(@Body() body: any) {
    return this.invoicesService.create(body);
  }

  @Post(':id/payment')
  recordPayment(@Param('id') id: string, @Body() body: any) {
    return this.invoicesService.recordPayment(+id, body);
  }
}