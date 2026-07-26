import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /** Registered job types (for a "run" dropdown in the UI). */
  @Get('types')
  types() {
    return this.jobs.registeredTypes();
  }

  @Get()
  list(@Query('status') status: string, @Query('limit') limit: string, @Request() req: any) {
    return this.jobs.list(req.user, status, limit ? parseInt(limit, 10) : 50);
  }

  @Get(':id')
  get(@Param('id') id: string, @Request() req: any) {
    return this.jobs.get(req.user, +id);
  }

  /** Enqueue a job. Returns immediately with the job row to poll. */
  @Post()
  enqueue(@Body() body: { type: string; payload?: any; label?: string }, @Request() req: any) {
    return this.jobs.enqueue(body.type, { payload: body.payload, label: body.label, actor: req.user });
  }
}
