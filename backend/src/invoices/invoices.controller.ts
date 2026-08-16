import {
  Controller, Get, Post, Put, Delete,
  Body, Param, UseGuards, Query, Req, Res, Header,
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
  getStats(@Req() req: any) {
    return this.invoicesService.getStats(req.user);
  }

  @Get('subscriber/:subscriberId')
  findBySubscriber(@Param('subscriberId') subscriberId: string) {
    return this.invoicesService.findBySubscriber(+subscriberId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.invoicesService.findOne(+id);
  }

  /** Printable HTML invoice (browser print → Save as PDF). */
  @Get(':id/pdf')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async getPdf(@Param('id') id: string, @Res() res: any) {
    const html = await this.invoicesService.getInvoicePdf(+id);
    res.send(html);
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