import {
  Controller, Get, Post, Param, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { BlockDemoGuard } from '../security/block-demo.guard';
import { LogsService } from './logs.service';
import { DisconnectsService } from './disconnects.service';

// Demo accounts never see logs — security / no data leak.
@UseGuards(JwtAuthGuard, PermissionsGuard, BlockDemoGuard)
@Controller('logs')
export class LogsController {
  constructor(
    private readonly logs: LogsService,
    private readonly disconnects: DisconnectsService,
  ) {}

  // ── Unified Timeline ──────────────────────────────────────────
  @Get('timeline')
  timeline(
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Query('severity') severity: string,
    @Query('forUser') forUser: string,
    @Query('type') type: string,
    @Query('sinceHours') sinceHours: string,
    @Req() req: any,
  ) {
    return this.logs.getTimeline(req.user, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      severity,
      forUser: forUser ? +forUser : undefined,
      type: type || undefined,
      sinceHours: sinceHours ? +sinceHours : undefined,
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
    @Query('q') q: string,
    @Query('sinceHours') sinceHours: string,
    @Req() req: any,
  ) {
    return this.logs.getLoginLogs(req.user, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      forUser: forUser ? +forUser : undefined,
      q: q || undefined,
      sinceHours: sinceHours ? +sinceHours : undefined,
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
    @Query('q') q: string,
    @Query('sinceHours') sinceHours: string,
    @Query('auditType') auditType: string,
    @Req() req: any,
  ) {
    return this.logs.getActivityLogs(req.user, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      forUser: forUser ? +forUser : undefined,
      action: action || undefined,
      financial: financial === '1' || financial === 'true',
      q: q || undefined,
      sinceHours: sinceHours ? +sinceHours : undefined,
      auditType: auditType || undefined,
    });
  }

  // ── RADIUS auth logs (radpostauth) ────────────────────────────
  @Get('radius-auth')
  radiusAuthLogs(
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Query('q') q: string,
    @Query('days') days: string,
    @Query('sinceHours') sinceHours: string,
    @Query('forUser') forUser: string,
    @Query('outcome') outcome: string,
    @Req() req: any,
  ) {
    return this.logs.getRadiusAuthLogs(req.user, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      q: q || undefined,
      days: days ? +days : undefined,
      sinceHours: sinceHours ? +sinceHours : undefined,
      forUser: forUser ? +forUser : undefined,
      outcome: outcome || undefined,
    });
  }

  // ── Network Logs ──────────────────────────────────────────────
  @Get('network')
  networkLogs(
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Query('q') q: string,
    @Query('severity') severity: string,
    @Query('sinceHours') sinceHours: string,
    @Query('forUser') forUser: string,
    @Req() req: any,
  ) {
    return this.logs.getNetworkLogs(req.user, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      q: q || undefined,
      severity: severity || undefined,
      sinceHours: sinceHours ? +sinceHours : undefined,
      forUser: forUser ? +forUser : undefined,
    });
  }

  /** Router Console: the live log of one router (scoped in the service). */
  @Get('router')
  routerLog(
    @Query('nasId') nasId: string,
    @Query('limit') limit: string,
    @Req() req: any,
  ) {
    return this.logs.getRouterLogsForNas(req.user, Number(nasId), limit ? +limit : 120);
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
    @Query('q') q: string,
    @Query('sinceHours') sinceHours: string,
    @Req() req: any,
  ) {
    return this.logs.getSystemLogs(req.user, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      q: q || undefined,
      sinceHours: sinceHours ? +sinceHours : undefined,
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
    @Query('cause') cause: string,
    @Query('sinceHours') sinceHours: string,
    @Query('offset') offset: string,
    @Query('q') q: string,
    @Query('forUser') forUser: string,
    @Req() req: any,
  ) {
    return this.logs.getRadiusSessions(req.user, {
      limit: limit ? +limit : undefined,
      username: username || undefined,
      cause: cause || undefined,
      sinceHours: sinceHours ? +sinceHours : undefined,
      offset: offset ? +offset : undefined,
      q: q || undefined,
      forUser: forUser ? +forUser : undefined,
    });
  }

  // ── Disconnect report: why sessions ended (all 18 RFC 2866 causes) ──
  @Get('disconnects')
  disconnectReport(
    @Query('sinceHours') sinceHours: string,
    @Query('nasIp') nasIp: string,
    @Query('username') username: string,
    @Query('search') search: string,
    @Query('cause') cause: string,
    @Query('category') category: string,
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Query('tz') tz: string,
    @Req() req: any,
  ) {
    return this.disconnects.report(req.user, {
      sinceHours: sinceHours ? +sinceHours : undefined,
      nasIp: nasIp || undefined,
      username: username || undefined,
      search: search || undefined,
      cause: cause || undefined,
      category: category || undefined,
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      tz: tz ? +tz : undefined,
    });
  }

  // ── Failed logins: refused connection attempts, grouped, with the likely reason ──
  @Get('failed-logins')
  failedLogins(
    @Query('sinceHours') sinceHours: string,
    @Query('search') search: string,
    @Query('nasIp') nasIp: string,
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Req() req: any,
  ) {
    return this.disconnects.failedLogins(req.user, {
      sinceHours: sinceHours ? +sinceHours : undefined,
      search: search || undefined,
      nasIp: nasIp || undefined,
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
    });
  }

  // ── Failed Activations ────────────────────────────────────────
  @Get('failed-activations')
  failedActivations(
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Query('q') q: string,
    @Query('sinceHours') sinceHours: string,
    @Query('forUser') forUser: string,
    @Req() req: any,
  ) {
    return this.logs.getFailedActivations(req.user, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      q: q || undefined,
      sinceHours: sinceHours ? +sinceHours : undefined,
      forUser: forUser ? +forUser : undefined,
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