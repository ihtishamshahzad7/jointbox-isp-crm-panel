import { Controller, Get, Param, ParseIntPipe, Query, Req, UseGuards } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('telemetry')
export class TelemetryController {
  constructor(
    private readonly telemetry: TelemetryService,
    private readonly scope: ScopeService,
  ) {}

  /** Live network feed for the sidebar widget (in-memory, newest first). */
  @Get('feed')
  feed(@Query('limit') limit?: string) {
    return this.telemetry.liveFeed(limit ? Number(limit) : 50);
  }

  /** Durable event log, optionally filtered to one NAS. */
  @Get('events')
  events(@Query('nasId') nasId?: string, @Query('limit') limit?: string) {
    return this.telemetry.events({
      nasId: nasId ? Number(nasId) : undefined,
      limit: limit ? Number(limit) : 100,
    });
  }

  /** Full live connection path + signal history for one subscriber. */
  @Get('subscriber/:id/path')
  async subscriberPath(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    // SECURITY: a subscriber's link trace + signal history is customer-specific
    // data; only accounts that own the subscriber may view it.
    await this.scope.assertSubscriber(req.user, id);
    return this.telemetry.subscriberPath(id);
  }
}
