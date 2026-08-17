import { Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';
import { NasMonitorService } from './nas-monitor.service';
import { SnmpPollerService } from './snmp-poller.service';
import { DeviceHealthService } from './device-health.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('telemetry')
export class TelemetryController {
  constructor(
    private readonly telemetry: TelemetryService,
    private readonly monitor: NasMonitorService,
    private readonly snmp: SnmpPollerService,
    private readonly health: DeviceHealthService,
    private readonly scope: ScopeService,
  ) {}

  /** One-off SNMP walk to list a NAS's interfaces for port registration. */
  @Get('nas/:id/discover-interfaces')
  async discover(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    await this.scope.assertNas(req.user, id);
    return this.snmp.discoverInterfaces(id);
  }

  /**
   * Really contact the device over SNMP and report what came back — uptime,
   * interface count, CPU/memory — or exactly why it failed.
   */
  @Post('nas/:id/snmp-test')
  async snmpTest(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    await this.scope.assertNas(req.user, id);
    return this.health.testSnmp(id);
  }

  /** Device health history (CPU/memory/temperature/SNMP response) for the graphs. */
  @Get('nas/:id/health-history')
  async healthHistory(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: any,
    @Query('range') range?: string,
    @Query('metrics') metrics?: string,
  ) {
    await this.scope.assertNas(req.user, id);
    return this.health.history(id, {
      range,
      metrics: metrics ? metrics.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    });
  }

  /** Interfaces with their latest sample. */
  @Get('nas/:id/interfaces')
  async ifaces(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    await this.scope.assertNas(req.user, id);
    return this.health.interfaces(id);
  }

  /** One interface's traffic/error history. */
  @Get('nas/:id/interfaces/:ifIndex/history')
  async ifaceHistory(
    @Param('id', ParseIntPipe) id: number,
    @Param('ifIndex', ParseIntPipe) ifIndex: number,
    @Req() req: any,
    @Query('range') range?: string,
  ) {
    await this.scope.assertNas(req.user, id);
    return this.health.interfaceHistory(id, ifIndex, range || '1h');
  }

  /** Health of every NAS: online count + throughput + reporting status. */
  @Get('nas-health')
  nasHealth() {
    return this.monitor.healthOverview();
  }

  /** Recent operational alerts (admin ops screen). Demo accounts blocked. */
  @Get('ops-alerts')
  opsAlerts(@Req() req: any) {
    if (req?.user?.isDemo) return [];
    return this.monitor.opsAlerts(40);
  }

  /** MRTG-style traffic for a NAS: range = 1h | 6h | 7d | 30d, optional vlan. */
  @Get('nas/:id/traffic')
  async nasTraffic(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: any,
    @Query('range') range?: string,
    @Query('vlan') vlan?: string,
  ) {
    await this.scope.assertNas(req.user, id);
    return this.monitor.traffic(id, range || '7d', vlan || undefined);
  }

  /** Current per-VLAN online + throughput breakdown for a NAS. */
  @Get('nas/:id/vlans')
  async nasVlans(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    await this.scope.assertNas(req.user, id);
    return this.monitor.vlanBreakdown(id);
  }

  /** Availability % + downtime windows for a NAS over N days. */
  @Get('nas/:id/uptime')
  async nasUptime(@Param('id', ParseIntPipe) id: number, @Req() req: any, @Query('days') days?: string) {
    await this.scope.assertNas(req.user, id);
    return this.monitor.nasUptime(id, days ? +days : 7);
  }

  /** Link up/down + optical signal for every ONU on a NAS. */
  @Get('nas/:id/signals')
  async nasSignals(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    await this.scope.assertNas(req.user, id);
    return this.monitor.nasSignals(id);
  }

  /** Optical-signal history for one ONU (trend graph). */
  @Get('onu/:id/signal')
  onuSignal(@Param('id', ParseIntPipe) id: number, @Query('range') range?: string) {
    return this.monitor.onuSignal(id, range || '7d');
  }

  /** Live network feed for the sidebar widget (in-memory, newest first). */
  @Get('feed')
  feed(@Query('limit') limit?: string) {
    return this.telemetry.liveFeed(limit ? Number(limit) : 50);
  }

  /** Durable event log, optionally filtered to one NAS. */
  @Get('events')
  async events(@Req() req: any, @Query('nasId') nasId?: string, @Query('limit') limit?: string) {
    if (nasId) await this.scope.assertNas(req.user, Number(nasId));
    return this.telemetry.events({
      nasId: nasId ? Number(nasId) : undefined,
      limit: limit ? Number(limit) : 100,
      actor: req.user,          // service filters to the caller's own devices
    } as any);
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
