import {
  Controller, Get, Post, Put, Patch, Delete,
  Body, Param, Query, UseGuards, Req, BadRequestException,
} from '@nestjs/common';
import { FieldJobsService } from './field-jobs.service';
import { FieldJobSchedulesService } from './field-job-schedules.service';
import { FieldJobReportsService } from './field-job-reports.service';
import { UpdateFieldJobScheduleDto } from './field-job-schedule.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import {
  ProductEntitlementGuard,
  RequireProductFeature,
} from '../common/product-entitlement.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard, ProductEntitlementGuard)
@RequireProductFeature('crm-advanced')
@Controller('field-jobs')
export class FieldJobsController {
  constructor(
    private readonly jobs: FieldJobsService,
    private readonly schedules: FieldJobSchedulesService,
    private readonly reports: FieldJobReportsService,
  ) {}

  @Get('schedules')
  schedulesList(@Req() req: any) {
    return this.schedules.list(req.user);
  }

  @Post('schedules')
  createSchedule(@Body() body: any, @Req() req: any) {
    return this.schedules.create(body || {}, req.user);
  }

  @Patch('schedules/:id')
  updateSchedule(
    @Param('id') id: string,
    @Body() body: UpdateFieldJobScheduleDto,
    @Req() req: any,
  ) {
    const scheduleId = Number(id);
    if (!Number.isSafeInteger(scheduleId) || scheduleId < 1) {
      throw new BadRequestException('A valid recurring schedule ID is required.');
    }
    return this.schedules.update(scheduleId, body, req.user);
  }

  @Patch('schedules/:id/status')
  setScheduleStatus(
    @Param('id') id: string,
    @Body() body: { status?: string },
    @Req() req: any,
  ) {
    return this.schedules.setStatus(+id, String(body?.status ?? ''), req.user);
  }

  @Get('options')
  options(@Req() req: any) {
    return this.jobs.options(req.user);
  }

  @Get('dispatch')
  dispatchQueue(@Query() query: Record<string, unknown>, @Req() req: any) {
    return this.jobs.dispatchQueue(req.user, query || {});
  }

  @Get(':id/dispatch')
  dispatchJob(@Param('id') id: string, @Req() req: any) {
    return this.jobs.dispatchJob(req.user, Number(id));
  }

  @Get(':id/dispatch/history')
  dispatchHistory(
    @Param('id') id: string,
    @Query('cursor') cursor: string | undefined,
    @Req() req: any,
  ) {
    return this.jobs.dispatchHistory(req.user, Number(id), cursor);
  }

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

  @Get('reports/summary')
  reportSummary(@Query() query: Record<string, unknown>, @Req() req: any) {
    return this.reports.summary(req.user, query || {});
  }

  @Get('reports/sla/jobs')
  reportSlaJobs(@Query() query: Record<string, unknown>, @Req() req: any) {
    return this.reports.slaJobs(req.user, query || {});
  }

  @Get('reports/jobs')
  reportJobs(@Query() query: Record<string, unknown>, @Req() req: any) {
    return this.reports.jobs(req.user, query || {});
  }

  @Get(':id/materials')
  materials(@Param('id') id: string, @Req() req: any) {
    return this.jobs.materials(+id, req.user);
  }

  @Post(':id/attachments')
  attachEvidence(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.jobs.attachEvidence(+id, body || {}, req.user);
  }

  @Patch(':id/location/:phase')
  recordLocation(
    @Param('id') id: string,
    @Param('phase') phase: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    return this.jobs.recordLocationCapture(+id, phase, body || {}, req.user);
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
    @Body() body: {
      scheduledAt?: string;
      appointmentEndsAt?: string;
      visitOrder?: number;
      reason?: string;
      expectedAssignedTo?: number | null;
    },
    @Req() req: any,
  ) {
    return this.jobs.assign(
      +id,
      +technicianId,
      req.user,
      body?.scheduledAt,
      body?.appointmentEndsAt,
      body?.visitOrder,
      body?.reason,
      body?.expectedAssignedTo,
    );
  }

  @Patch(':id/unassign')
  unassign(@Param('id') id: string, @Req() req: any) {
    return this.jobs.unassign(+id, req.user);
  }

  @Post(':id/materials/:action')
  moveMaterial(
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() body: { itemId?: number; idempotencyKey?: string; notes?: string },
    @Req() req: any,
  ) {
    return this.jobs.moveMaterial(
      +id,
      {
        itemId: Number(body?.itemId),
        action,
        idempotencyKey: body?.idempotencyKey || '',
        notes: body?.notes,
      },
      req.user,
    );
  }

  @Patch(':id/arrive')
  arrive(@Param('id') id: string, @Req() req: any) {
    return this.jobs.arrive(+id, req.user);
  }

  /** Technician starts work after recording arrival. */
  @Patch(':id/start')
  start(@Param('id') id: string, @Req() req: any) {
    return this.jobs.start(+id, req.user);
  }

  /** Close the job. success:false records a failed attempt with a reason. */
  @Patch(':id/complete')
  complete(
    @Param('id') id: string,
    @Body() body: {
      success?: boolean;
      notes?: string;
      failureReason?: string;
      checklist?: unknown;
      customerConfirmed?: boolean;
      resolution?: string;
      nextAction?: string;
    },
    @Req() req: any,
  ) {
    return this.jobs.complete(+id, body || {}, req.user);
  }

  @Patch(':id/review')
  review(
    @Param('id') id: string,
    @Body() body: { approved?: boolean; reason?: string },
    @Req() req: any,
  ) {
    return this.jobs.reviewCompletion(+id, body?.approved === true, body?.reason || '', req.user);
  }

  @Patch(':id/checklist')
  checklist(
    @Param('id') id: string,
    @Body() body: { items?: unknown },
    @Req() req: any,
  ) {
    return this.jobs.updateChecklist(+id, body?.items, req.user);
  }

  @Post(':id/assistance')
  assistance(
    @Param('id') id: string,
    @Body() body: { detail?: string },
    @Req() req: any,
  ) {
    return this.jobs.requestAssistance(+id, body?.detail || '', req.user);
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
