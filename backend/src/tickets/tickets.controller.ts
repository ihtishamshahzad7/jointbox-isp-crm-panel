import {
  Controller, Get, Post, Put, Delete,
  Body, Param, Query, UseGuards, Req,
} from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { TicketSlaService } from './ticket-sla.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly ticketsService: TicketsService,
    private readonly sla: TicketSlaService,
    private readonly scope: ScopeService,
  ) {}

  @Get()
  findAll(@Req() req: any) {
    return this.ticketsService.findAll(req.user);
  }

  /**
   * SLA dashboard: what's late, due soon, and compliance over the period.
   * Counted over the caller's own subscribers' tickets only.
   */
  @Get('sla/report')
  slaReport(@Req() req: any, @Query('days') days?: string) {
    return this.sla.slaReport(days ? +days : 30, req.user);
  }

  /**
   * Stamp SLA targets on tickets created before SLA existed. Rewrites SLA
   * fields across the whole installation - platform owner only.
   */
  @Post('sla/backfill')
  slaBackfill(@Req() req: any) {
    this.scope.assertPlatformOwner(req.user);
    return this.sla.backfill();
  }

  @Get('stats')
  getStats(@Req() req: any) {
    return this.ticketsService.getStats(req.user);
  }

  @Get('subscriber/:subscriberId')
  findBySubscriber(@Param('subscriberId') subscriberId: string, @Req() req: any) {
    return this.ticketsService.findBySubscriber(+subscriberId, req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.ticketsService.findOne(+id, req.user);
  }

  @Post()
  create(@Body() body: any, @Req() req: any) {
    return this.ticketsService.create(body, req.user);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.ticketsService.update(+id, body, req.user);
  }

  @Post(':id/message')
  addMessage(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.ticketsService.addMessage(+id, body, req.user);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @Req() req: any) {
    return this.ticketsService.delete(+id, req.user);
  }
}