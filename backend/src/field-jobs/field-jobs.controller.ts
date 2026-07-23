import {
  Controller, Get, Post, Put, Patch, Delete,
  Body, Param, Query, UseGuards, Req,
} from '@nestjs/common';
import { FieldJobsService } from './field-jobs.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('field-jobs')
export class FieldJobsController {
  constructor(private readonly jobs: FieldJobsService) {}

  @Get()
  findAll(@Query() query: any, @Req() req: any) {
    return this.jobs.findAll(req.user, query);
  }

  /** Dispatch board: pending, overdue, unassigned, scheduled today. */
  @Get('stats')
  stats(@Req() req: any) {
    return this.jobs.stats(req.user);
  }

  /** The logged-in technician's own worklist — the field/mobile view. */
  @Get('mine')
  myJobs(@Query('all') all: string, @Req() req: any) {
    return this.jobs.myJobs(req.user, all === 'true');
  }

  /** Completion counts and average time on site, per technician. */
  @Get('performance')
  performance(@Query('days') days: string, @Req() req: any) {
    return this.jobs.technicianPerformance(req.user, days ? +days : 30);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.jobs.findOne(+id, req.user);
  }

  @Post()
  create(@Body() body: any, @Req() req: any) {
    return this.jobs.create(body, req.user);
  }

  /** Raise a job directly from a support ticket. */
  @Post('from-ticket/:ticketId')
  fromTicket(@Param('ticketId') ticketId: string, @Body() body: any, @Req() req: any) {
    return this.jobs.fromTicket(+ticketId, body, req.user);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.jobs.update(+id, body, req.user);
  }

  @Patch(':id/assign/:technicianId')
  assign(
    @Param('id') id: string,
    @Param('technicianId') technicianId: string,
    @Body() body: { scheduledAt?: string },
    @Req() req: any,
  ) {
    return this.jobs.assign(+id, +technicianId, req.user, body?.scheduledAt);
  }

  /** Technician arrived on site. */
  @Patch(':id/start')
  start(@Param('id') id: string, @Req() req: any) {
    return this.jobs.start(+id, req.user);
  }

  /** Close the job. success:false records a failed attempt with a reason. */
  @Patch(':id/complete')
  complete(
    @Param('id') id: string,
    @Body() body: { success?: boolean; notes?: string; failureReason?: string; photoUrls?: string[] },
    @Req() req: any,
  ) {
    return this.jobs.complete(+id, body || {}, req.user);
  }

  @Patch(':id/cancel')
  cancel(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: any) {
    return this.jobs.cancel(+id, body?.reason || '', req.user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.jobs.remove(+id, req.user);
  }
}
