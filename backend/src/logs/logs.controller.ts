import {
  Controller, Get, Post, Param, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { BlockDemoGuard } from '../security/block-demo.guard';
import { LogsService } from './logs.service';

// Demo accounts never see logs — security / no data leak.
@UseGuards(JwtAuthGuard, PermissionsGuard, BlockDemoGuard)
@Controller('logs')
export class LogsController {
  constructor(private readonly logs: LogsService) {}

  // ── Unified Timeline ──────────────────────────────────────────
  @Get('timeline')
  timeline(
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Query('severity') severity: string,
    @Query('forUser') forUser: string,
    @Req() req: any,
  ) {
    return this.logs.getTimeline(req.user, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      severity,
      forUser: forUser ? +forUser : undefined,
    });
  }

  // ── Stats + Heatmap ───────────────────────────────────────────
  @Get('stats')
  stats(
    @Query('hours') hours: string,
    @Req() req: any,
  ) {
    return this.logs.getStats(req.user, hours ? +hours : 24);
  }

  // ── Login Logs ────────────────────────────────────────────────
  @Get('login')
  loginLogs(
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Query('forUser') forUser: string,
    @Req() req: any,
  ) {
    return this.logs.getLoginLogs(req.user, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      forUser: forUser ? +forUser : undefined,
    });
  }

  // ── Activity Logs ─────────────────────────────────────────────
  @Get('activity')
  activityLogs(
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Query('forUser') forUser: string,
    @Query('action') action: string,
    @Query('financial') financial: string,
    @Req() req: any,
  ) {
    return this.logs.getActivityLogs(req.user, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      forUser: forUser ? +forUser : undefined,
      action: action || undefined,
      financial: financial === '1' || financial === 'true',
    });
  }

  // ── RADIUS auth logs (radpostauth) ────────────────────────────
  @Get('radius-auth')
  radiusAuthLogs(
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Query('q') q: string,
    @Query('days') days: string,
    @Req() req: any,
  ) {
    return this.logs.getRadiusAuthLogs(req.user, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      q: q || undefined,
      days: days ? +days : undefined,
    });
  }

  // ── Network Logs ──────────────────────────────────────────────
  @Get('network')
  networkLogs(
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Req() req: any,
  ) {
    return this.logs.getNetworkLogs(req.user, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
    });
  }

  @Get('router/subscriber/:id')
  routerLogs(
    @Param('id') id: string,
    @Query('limit') limit: string,
    @Req() req: any,
  ) {
    return this.logs.getRouterLogsForSubscriber(req.user, +id, limit ? +limit : 200);
  }

  // ── System Logs ───────────────────────────────────────────────
  @Get('system')
  systemLogs(
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Req() req: any,
  ) {
    return this.logs.getSystemLogs(req.user, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
    });
  }

  // ── Web Sessions ──────────────────────────────────────────────
  @Get('sessions')
  sessions(
    @Query('forUser') forUser: string,
    @Req() req: any,
  ) {
    return this.logs.getSessions(req.user, {
      forUser: forUser ? +forUser : undefined,
    });
  }

  // ── RADIUS session history (with RFC 2866 termination causes) ──
  @Get('radius-sessions')
  radiusSessions(
    @Query('limit') limit: string,
    @Query('username') username: string,
    @Req() req: any,
  ) {
    return this.logs.getRadiusSessions(req.user, {
      limit: limit ? +limit : undefined,
      username: username || undefined,
    });
  }

  // ── Failed Activations ────────────────────────────────────────
  @Get('failed-activations')
  failedActivations(
    @Query('limit') limit: string,
    @Req() req: any,
  ) {
    return this.logs.getFailedActivations(req.user, {
      limit: limit ? +limit : undefined,
    });
  }

  // ── RADIUS Health ─────────────────────────────────────────────
  @Get('radius/diagnostics')
  radiusDiagnostics(@Req() req: any) {
    return this.logs.getRadiusDiagnostics(req.user);
  }

  @Post('radius/close-stale')
  closeStale(@Req() req: any) {
    return this.logs.closeStaleSessions(req.user);
  }
}