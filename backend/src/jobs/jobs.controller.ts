import { Body, Controller, ForbiddenException, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

/**
 * The background-job queue is server maintenance — PLATFORM ACCOUNT ONLY.
 *
 * Its one real job, integrity.reconcile, runs over the whole installation:
 * it cuts and re-pushes RADIUS logins for every company and closes sessions
 * on every router. A company (or one of its dealers) starting it would act
 * on every other company on the server, so nobody but the platform account
 * may list, read or start jobs. Companies get the same protection from the
 * nightly run, which needs no button.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  private platformOnly(req: any) {
    if (req?.user?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Background jobs are server maintenance, run by the platform account.');
    }
  }

  /** Registered job types (for a "run" dropdown in the UI). */
  @Get('types')
  types(@Request() req: any) {
    this.platformOnly(req);
    return this.jobs.registeredTypes();
  }

  @Get()
  list(@Query('status') status: string, @Query('limit') limit: string, @Request() req: any) {
    this.platformOnly(req);
    return this.jobs.list(req.user, status, limit ? parseInt(limit, 10) : 50);
  }

  @Get(':id')
  get(@Param('id') id: string, @Request() req: any) {
    this.platformOnly(req);
    return this.jobs.get(req.user, +id);
  }

  /** Enqueue a job. Returns immediately with the job row to poll. */
  @Post()
  enqueue(@Body() body: { type: string; payload?: any; label?: string }, @Request() req: any) {
    this.platformOnly(req);
    return this.jobs.enqueue(body.type, { payload: body.payload, label: body.label, actor: req.user });
  }
}
