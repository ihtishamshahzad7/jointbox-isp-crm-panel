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
  status() {
    return this.outages.currentStatus();
  }

  /** Uptime split into ISP fault vs power — the honest version. */
  @Get('uptime')
  uptime(@Query('days') days?: string) {
    return this.outages.uptimeReport(days ? +days : 30);
  }

  @Get()
  list(@Query() query: any, @Req() req: any) {
    return this.outages.listOutages(req.user, query);
  }

  @Post()
  createManual(@Body() body: any, @Req() req: any) {
    return this.outages.createManual(body, req.user);
  }

  /** Reclassify: power vs network. Changes whether it counts against uptime. */
  @Patch(':id/classify')
  classify(@Param('id') id: string, @Body() body: { type: string; notes?: string }) {
    return this.outages.classify(+id, body.type, body.notes);
  }

  @Patch(':id/close')
  close(@Param('id') id: string) {
    return this.outages.close(+id);
  }

  /** Message everyone in the affected area before they call you. */
  @Post(':id/notify')
  notify(@Param('id') id: string, @Body() body: { message?: string }) {
    return this.outages.notifyArea(+id, body?.message);
  }

  // ── Load-shedding timetable ─────────────────────────────────
  @Get('schedules/all')
  listSchedules(@Query('areaId') areaId?: string) {
    return this.outages.listSchedules(areaId ? +areaId : undefined);
  }

  @Post('schedules')
  createSchedule(@Body() body: any) {
    return this.outages.createSchedule(body);
  }

  @Put('schedules/:id')
  updateSchedule(@Param('id') id: string, @Body() body: any) {
    return this.outages.updateSchedule(+id, body);
  }

  @Delete('schedules/:id')
  removeSchedule(@Param('id') id: string) {
    return this.outages.removeSchedule(+id);
  }
}
