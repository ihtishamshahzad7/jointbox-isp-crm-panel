import {
  Controller, Get, Post, Put, Patch, Delete,
  Body, Param, Query, UseGuards, Req,
} from '@nestjs/common';
import { OutagesService } from './outages.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('outages')
export class OutagesController {
  constructor(private readonly outages: OutagesService) {}

  /**
   * Live board: which areas are dark, whether it's expected, and what to do.
   * This is what support should check before dispatching a technician.
   */
  @Get('status')
  status(@Req() req: any) {
    return this.outages.currentStatus(req.user);
  }

  /** Uptime split into ISP fault vs power — the honest version. */
  @Get('uptime')
  uptime(@Req() req: any, @Query('days') days?: string) {
    return this.outages.uptimeReport(days ? +days : 30, req.user);
  }

  @Get()
  list(@Query() query: any, @Req() req: any) {
    return this.outages.listOutages(req.user, query);
  }

  @Post()
  createManual(@Body() body: any, @Req() req: any) {
    return this.outages.createManual(body, req.user);
  }

  // Every per-outage route below is checked in OutagesService against the
  // caller's own areas (assertOutage) — out of scope reads as not found.

  /** Reclassify: power vs network. Changes whether it counts against uptime. */
  @Patch(':id/classify')
  classify(@Param('id') id: string, @Body() body: { type: string; notes?: string }, @Req() req: any) {
    return this.outages.classify(+id, body.type, body.notes, req.user);
  }

  @Patch(':id/close')
  close(@Param('id') id: string, @Req() req: any) {
    return this.outages.close(+id, req.user);
  }

  /** Message the caller's own customers in the affected area before they call. */
  @Post(':id/notify')
  notify(@Param('id') id: string, @Body() body: { message?: string }, @Req() req: any) {
    return this.outages.notifyArea(+id, body?.message, req.user);
  }

  // ── Outage Intelligence (root-cause attribution) ────────────
  /** Read the persisted root-cause attribution for an outage. */
  @Get(':id/attribution')
  attribution(@Param('id') id: string, @Req() req: any) {
    return this.outages.getAttribution(+id, req.user);
  }

  /** Recompute attribution from current NDM signals and persist. */
  @Post(':id/attribution/refresh')
  refreshAttribution(@Param('id') id: string, @Req() req: any) {
    return this.outages.attribute(+id, req.user);
  }

  /** Operator confirms (optionally correcting) the attribution. */
  @Patch(':id/attribution/confirm')
  confirmAttribution(@Param('id') id: string, @Body() body: { cause?: string }, @Req() req: any) {
    return this.outages.confirmAttribution(+id, body?.cause, req.user);
  }

  // ── Load-shedding timetable ─────────────────────────────────
  // A schedule belongs to its area; only the area's owner (or the platform
  // owner) may see or change it.
  @Get('schedules/all')
  listSchedules(@Req() req: any, @Query('areaId') areaId?: string) {
    return this.outages.listSchedules(areaId ? +areaId : undefined, req.user);
  }

  @Post('schedules')
  createSchedule(@Body() body: any, @Req() req: any) {
    return this.outages.createSchedule(body, req.user);
  }

  @Put('schedules/:id')
  updateSchedule(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.outages.updateSchedule(+id, body, req.user);
  }

  @Delete('schedules/:id')
  removeSchedule(@Param('id') id: string, @Req() req: any) {
    return this.outages.removeSchedule(+id, req.user);
  }
}
