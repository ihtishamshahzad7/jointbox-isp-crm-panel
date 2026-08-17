import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { DiagnosticsService } from './diagnostics.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('monitoring')
export class MonitoringController {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly diag: DiagnosticsService,
  ) {}

  // ── History for the detail page ──
  @Get('targets/:id/history')
  history(@Param('id') id: string, @Query('range') range: string, @Req() req: any) {
    return this.monitoring.history(+id, range || '1h', req.user);
  }

  // ── Diagnostics (on-demand; validated + shell-safe) ──
  @Post('diagnostics/ping')
  dPing(@Body() b: { host: string; count?: number }) { return this.diag.ping(b.host, b.count); }
  @Post('diagnostics/traceroute')
  dTrace(@Body() b: { host: string }) { return this.diag.traceroute(b.host); }
  @Post('diagnostics/tcp')
  dTcp(@Body() b: { host: string; port: number }) { return this.diag.tcpPort(b.host, b.port); }
  @Post('diagnostics/tcp-trace')
  dTcpTrace(@Body() b: { host: string; port: number }) { return this.diag.tcpTrace(b.host, b.port); }
  @Post('diagnostics/dns')
  dDns(@Body() b: { name: string; type?: string; resolver?: string }) { return this.diag.dnsLookup(b.name, b.type, b.resolver); }
  @Post('diagnostics/http')
  dHttp(@Body() b: { url: string }) { return this.diag.httpCheck(b.url); }

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
