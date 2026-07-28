import {
  Controller, Get, Post, Put, Delete,
  Body, Param, Query, UseGuards, Req,
} from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { TicketSlaService } from './ticket-sla.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly ticketsService: TicketsService,
    private readonly sla: TicketSlaService,
  ) {}

  @Get()
  findAll(@Req() req: any) {
    return this.ticketsService.findAll(req.user);
  }

  /** SLA dashboard: what's late, due soon, and compliance over the period. */
  @Get('sla/report')
  slaReport(@Query('days') days?: string) {
    return this.sla.slaReport(days ? +days : 30);
  }

  /** Stamp SLA targets on tickets created before SLA existed. */
  @Post('sla/backfill')
  slaBackfill() {
    return this.sla.backfill();
  }

  @Get('stats')
  getStats() {
    return this.ticketsService.getStats();
  }

  @Get('subscriber/:subscriberId')
  findBySubscriber(@Param('subscriberId') subscriberId: string) {
    return this.ticketsService.findBySubscriber(+subscriberId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ticketsService.findOne(+id);
  }

  @Post()
  create(@Body() body: any) {
    return this.ticketsService.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.ticketsService.update(+id, body);
  }

  @Post(':id/message')
  addMessage(@Param('id') id: string, @Body() body: any) {
    return this.ticketsService.addMessage(+id, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.ticketsService.delete(+id);
  }
}