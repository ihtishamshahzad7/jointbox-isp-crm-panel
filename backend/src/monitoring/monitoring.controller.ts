import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { DiagnosticsService } from './diagnostics.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('monitoring')
export class MonitoringController {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly diag: DiagnosticsService,
    private readonly scope: ScopeService,
  ) {}

  // ── History for the detail page ──
  @Get('targets/:id/history')
  history(@Param('id') id: string, @Query('range') range: string, @Req() req: any) {
    return this.monitoring.history(+id, range || '1h', req.user);
  }

  // ── Diagnostics (on-demand; validated + shell-safe) ──
  //
  // Each of these makes THIS SERVER send traffic to whatever target the caller
  // names, from inside the operator network (assertDestination allows RFC1918
  // on purpose). On a shared installation that is every company's LAN, so the
  // tool is the platform owner's alone. The outbound guard in
  // DiagnosticsService still applies on top of this.
  @Post('diagnostics/ping')
  dPing(@Body() b: { host: string; count?: number }, @Req() req: any) {
    this.scope.assertPlatformOwner(req.user);
    return this.diag.ping(b.host, b.count);
  }
  @Post('diagnostics/traceroute')
  dTrace(@Body() b: { host: string }, @Req() req: any) {
    this.scope.assertPlatformOwner(req.user);
    return this.diag.traceroute(b.host);
  }
  @Post('diagnostics/tcp')
  dTcp(@Body() b: { host: string; port: number }, @Req() req: any) {
    this.scope.assertPlatformOwner(req.user);
    return this.diag.tcpPort(b.host, b.port);
  }
  @Post('diagnostics/tcp-trace')
  dTcpTrace(@Body() b: { host: string; port: number }, @Req() req: any) {
    this.scope.assertPlatformOwner(req.user);
    return this.diag.tcpTrace(b.host, b.port);
  }
  @Post('diagnostics/dns')
  dDns(@Body() b: { name: string; type?: string; resolver?: string }, @Req() req: any) {
    this.scope.assertPlatformOwner(req.user);
    return this.diag.dnsLookup(b.name, b.type, b.resolver);
  }
  @Post('diagnostics/http')
  dHttp(@Body() b: { url: string }, @Req() req: any) {
    this.scope.assertPlatformOwner(req.user);
    return this.diag.httpCheck(b.url);
  }

  /**
   * Unified device list — ping monitors and SNMP devices correlated by address
   * so one physical box is one row, with a summary for the dashboard header.
   * This is what the main Network Monitoring page should render.
   */
  @Get('unified')
  unified(@Req() req: any) {
    return this.monitoring.unifiedList(req.user);
  }

  @Get('targets')
  list(@Req() req: any) {
    return this.monitoring.list(req.user);
  }

  @Get('targets/:id')
  getOne(@Param('id') id: string, @Req() req: any) {
    return this.monitoring.getOne(+id, req.user);
  }

  @Post('targets')
  create(@Body() body: any, @Req() req: any) {
    return this.monitoring.create(body, req.user);
  }

  /**
   * Bulk import monitors from a spreadsheet. The file is parsed in the browser
   * (the frontend already ships SheetJS, and the same pattern is used by the
   * subscriber import), so this receives plain rows and stays format-agnostic.
   * Returns a per-row outcome so the UI can report the exact failing line.
   */
  @Post('targets/import')
  importTargets(@Body() body: { rows: any[] }, @Req() req: any) {
    return this.monitoring.importTargets(body?.rows || [], req.user);
  }

  @Put('targets/:id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.monitoring.update(+id, body, req.user);
  }

  @Delete('targets/:id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.monitoring.remove(+id, req.user);
  }

  @Post('targets/:id/check')
  check(@Param('id') id: string, @Req() req: any) {
    return this.monitoring.checkTarget(+id, req.user);
  }

  @Post('groups/rename')
  renameGroup(@Body() body: { from: string; to: string }, @Req() req: any) {
    return this.monitoring.renameGroup(body.from, body.to, req.user);
  }
}
