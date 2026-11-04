import {
  Controller, Get, Post, Put, Delete,
  Body, Param, Query, UseGuards, Req,
} from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { TicketSlaService } from './ticket-sla.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';
import {
  ProductEntitlementGuard,
  RequireProductFeature,
} from '../common/product-entitlement.guard';

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
  @UseGuards(ProductEntitlementGuard)
  @RequireProductFeature('crm-advanced')
  @Get('sla/report')
  slaReport(
    @Req() req: any,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('priority') priority?: string,
  ) {
    return this.sla.slaReport(days ? +days : 30, req.user, from, to, priority);
  }

  @UseGuards(ProductEntitlementGuard)
  @RequireProductFeature('crm-advanced')
  @Get('sla/records')
  slaRecords(@Query() query: Record<string, unknown>, @Req() req: any) {
    return this.sla.slaRecords(req.user, query || {});
  }

  @UseGuards(ProductEntitlementGuard)
  @RequireProductFeature('crm-advanced')
  @Get('sla/policies')
  slaPolicies(@Req() req: any) {
    return this.sla.policies(req.user);
  }

  @UseGuards(ProductEntitlementGuard)
  @RequireProductFeature('crm-advanced')
  @Post('sla/policies')
  createSlaPolicy(@Body() body: Record<string, unknown>, @Req() req: any) {
    return this.sla.createPolicy(body || {}, req.user);
  }

  @UseGuards(ProductEntitlementGuard)
  @RequireProductFeature('crm-advanced')
  @Post('sla/policies/:seriesId/versions')
  createSlaPolicyVersion(
    @Param('seriesId') seriesId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: any,
  ) {
    return this.sla.createPolicyVersion(seriesId, body || {}, req.user);
  }

  /** Kept as a compatibility route; historical records are no longer assigned invented targets. */
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