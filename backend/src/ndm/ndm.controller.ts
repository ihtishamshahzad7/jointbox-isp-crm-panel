import {
  Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { createReadStream } from 'fs';
import { basename } from 'path';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { NdmService } from './ndm.service';
import { NdmSyslogArchiveService } from './syslog-archive.service';

/**
 * Network device monitoring — switches/routers over SNMP + syslog.
 *
 * Lives under the existing /monitoring prefix so the established
 * `monitoring.read` / `monitoring.write` permission keys and the
 * JwtAuthGuard + PermissionsGuard apply automatically. Scope enforcement is
 * per-request inside NdmService (SUPER_ADMIN = all, admin = subtree,
 * user = own rows).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('monitoring')
export class NdmController {
  constructor(
    private readonly ndm: NdmService,
    private readonly archive: NdmSyslogArchiveService,
  ) {}

  // ── Devices ──────────────────────────────────────────────────
  @Get('ndm/devices')
  devices(@Req() req: any) { return this.ndm.list(req.user); }

  @Get('ndm/devices/:id')
  device(@Param('id') id: string, @Req() req: any) { return this.ndm.getOne(+id, req.user); }

  @Post('ndm/devices/test')
  testDevice(@Body() body: any) { return this.ndm.testDevice(body); }

  @Post('ndm/devices/discover')
  discover(@Body() body: any) { return this.ndm.discover(body); }

  @Post('ndm/devices')
  create(@Body() body: any, @Req() req: any) { return this.ndm.create(body, req.user); }

  @Put('ndm/devices/:id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) { return this.ndm.update(+id, body, req.user); }

  /** Soft-disable: keeps history, stops polling + alerts. */
  @Delete('ndm/devices/:id')
  remove(@Param('id') id: string, @Req() req: any) { return this.ndm.remove(+id, req.user); }

  @Post('ndm/devices/:id/check')
  check(@Param('id') id: string, @Req() req: any) { return this.ndm.checkNow(+id, req.user); }

  @Post('ndm/devices/:id/discover')
  discoverDevice(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.ndm.discoverDevice(+id, body, req.user);
  }

  // ── Ports & history ──────────────────────────────────────────
  @Get('ndm/devices/:id/ports')
  ports(@Param('id') id: string, @Req() req: any) { return this.ndm.ports(+id, req.user); }

  /** Per-port settings (monitoring / sound override). */
  @Put('ndm/devices/:id/ports/:portId')
  setPortSettings(@Param('id') id: string, @Param('portId') portId: string, @Body() body: any, @Req() req: any) {
    return this.ndm.setPortSettings(+id, +portId, body, req.user);
  }

  @Get('ndm/devices/:id/ports/:portId/history')
  portHistory(@Param('id') id: string, @Param('portId') portId: string, @Query('range') range: string, @Req() req: any) {
    return this.ndm.portHistory(+id, +portId, range || '1h', req.user);
  }

  /**
   * Dev-test: drive a synthetic PORT DOWN / PORT UP through the REAL pipeline
   * (event → rule → alert → notify → SSE → browser sound). The next SNMP poll
   * corrects the forced state, so it never leaves a fake outage behind.
   */
  @Post('ndm/devices/:id/ports/:portId/test')
  testPortAlert(@Param('id') id: string, @Param('portId') portId: string, @Body() body: any, @Req() req: any) {
    return this.ndm.testPortAlert(+id, +portId, body?.direction === 'up' ? 'up' : 'down', req.user);
  }

  @Get('ndm/devices/:id/stream')
  deviceStream(@Param('id') id: string, @Query('range') range: string, @Req() req: any) {
    return this.ndm.deviceStream(+id, range || '24h', req.user);
  }

  // ── Syslog feed ──────────────────────────────────────────────
  @Get('ndm/syslog')
  syslog(@Query('deviceId') deviceId: string, @Query('severity') severity: string,
         @Query('limit') limit: string, @Query('page') page: string, @Req() req: any) {
    return this.ndm.syslog({
      deviceId: deviceId ? +deviceId : undefined,
      severity: severity || undefined,
      limit: limit ? +limit : undefined,
      page: page ? +page : undefined,
    }, req.user);
  }

  @Get('ndm/devices/:id/syslog')
  deviceSyslog(@Param('id') id: string, @Query('limit') limit: string, @Req() req: any) {
    return this.ndm.syslog({ deviceId: +id, limit: limit ? +limit : undefined }, req.user);
  }

  // ── Events ───────────────────────────────────────────────────
  @Get('ndm/events')
  events(@Query('status') status: string, @Query('type') type: string, @Query('deviceId') deviceId: string,
         @Query('limit') limit: string, @Query('page') page: string, @Req() req: any) {
    return this.ndm.events({
      status: status || undefined, type: type || undefined,
      deviceId: deviceId ? +deviceId : undefined,
      limit: limit ? +limit : undefined, page: page ? +page : undefined,
    }, req.user);
  }

  @Get('ndm/devices/:id/events')
  deviceEvents(@Param('id') id: string, @Query('status') status: string, @Req() req: any) {
    return this.ndm.events({ deviceId: +id, status: status || undefined }, req.user);
  }

  // ── Alerts ───────────────────────────────────────────────────
  @Get('ndm/alerts')
  alerts(@Query('status') status: string, @Query('deviceId') deviceId: string,
         @Query('limit') limit: string, @Query('page') page: string, @Req() req: any) {
    return this.ndm.listAlerts({
      status: status || undefined, deviceId: deviceId ? +deviceId : undefined,
      limit: limit ? +limit : undefined, page: page ? +page : undefined,
    }, req.user);
  }

  @Post('ndm/alerts/:id/ack')
  ack(@Param('id') id: string, @Req() req: any) { return this.ndm.ackAlert(+id, req.user); }

  @Post('ndm/alerts/:id/resolve')
  resolve(@Param('id') id: string, @Req() req: any) { return this.ndm.resolveAlert(+id, req.user); }

  @Get('ndm/devices/:id/alerts')
  deviceAlerts(@Param('id') id: string, @Req() req: any) {
    return this.ndm.listAlerts({ deviceId: +id, limit: 200 }, req.user);
  }

  // ── Rules ────────────────────────────────────────────────────
  @Get('ndm/rules')
  rules(@Req() req: any) { return this.ndm.listRules(req.user); }

  @Post('ndm/rules')
  createRule(@Body() body: any, @Req() req: any) { return this.ndm.createRule(body, req.user); }

  @Put('ndm/rules/:id')
  updateRule(@Param('id') id: string, @Body() body: any, @Req() req: any) { return this.ndm.updateRule(+id, body, req.user); }

  @Delete('ndm/rules/:id')
  deleteRule(@Param('id') id: string, @Req() req: any) { return this.ndm.deleteRule(+id, req.user); }

  @Get('ndm/rule-help')
  ruleHelp() { return this.ndm.ruleHelp(); }

  // ── Dashboard ────────────────────────────────────────────────
  @Get('ndm/stats')
  stats(@Req() req: any) { return this.ndm.stats(req.user); }

  // ── Listener settings (SUPER_ADMIN only) ─────────────────────
  /**
   * Syslog forwarding targets — relay received messages to another collector
   * (SIEM, archive, head office). ISP-level only: a forward target sends this
   * tenant's log stream off-box, which is a data-egress decision.
   */
  @Get('ndm/forward-targets')
  forwardTargets(@Req() req: any) { return this.ndm.listForwardTargets(req.user); }

  @Post('ndm/forward-targets')
  createForwardTarget(@Body() body: any, @Req() req: any) { return this.ndm.saveForwardTarget(null, body, req.user); }

  @Put('ndm/forward-targets/:id')
  updateForwardTarget(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.ndm.saveForwardTarget(+id, body, req.user);
  }

  @Delete('ndm/forward-targets/:id')
  deleteForwardTarget(@Param('id') id: string, @Req() req: any) { return this.ndm.deleteForwardTarget(+id, req.user); }

  /**
   * Syslog archive — the on-disk audit copy. ISP-level only, same reasoning as
   * forwarding: these endpoints describe and hand out the raw log stream.
   */
  @Get('ndm/archive/status')
  archiveStatus(@Req() req: any) {
    this.ndm.assertIspActor(req.user);
    return this.archive.status();
  }

  @Get('ndm/archive/files')
  archiveFiles(@Req() req: any) {
    this.ndm.assertIspActor(req.user);
    return this.archive.listArchive();
  }

  /**
   * Download one archive file. Streamed rather than read into memory: a day of
   * syslog from a busy network is measured in gigabytes, and buffering that to
   * serve one download would take the backend with it.
   */
  @Get('ndm/archive/download')
  async archiveDownload(@Query('name') name: string, @Req() req: any, @Res() res: any) {
    this.ndm.assertIspActor(req.user);
    const full = this.archive.resolveArchiveFile(String(name || ''));
    if (!full) throw new NotFoundException('Archive file not found');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${basename(full)}"`,
    );
    createReadStream(full).pipe(res);
  }

  /**
   * Subsystem health for Settings → Diagnostics.
   *
   * This route did not exist, while the Settings page had been calling it since
   * it was written — so that screen showed "Diagnostics are only visible to
   * admins" to everyone, including admins, and every panel below it was dead.
   */
  @Get('ndm/diagnostics')
  diagnostics(@Req() req: any) { return this.ndm.getDiagnostics(req.user); }

  @Get('ndm/settings')
  settings(@Req() req: any) { return this.ndm.getSettings(req.user); }

  @Put('ndm/settings')
  updateSettings(@Body() body: any, @Req() req: any) { return this.ndm.updateSettings(body, req.user); }
}