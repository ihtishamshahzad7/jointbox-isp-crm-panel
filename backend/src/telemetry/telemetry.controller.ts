import { Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';
import { NasMonitorService } from './nas-monitor.service';
import { DeviceHealthService } from './device-health.service';
import { LiveTrafficService } from './live-traffic.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('telemetry')
export class TelemetryController {
  constructor(
    private readonly telemetry: TelemetryService,
    private readonly monitor: NasMonitorService,
    private readonly health: DeviceHealthService,
    private readonly scope: ScopeService,
    private readonly live: LiveTrafficService,
  ) {}

  // REMOVED: GET nas/:id/discover-interfaces — port registration was part of
  // the SNMP device monitor, which has been removed. Device health (CPU,
  // memory, uptime, interface list) is kept and served by DeviceHealthService
  // below, which does its own SNMP walk and does not depend on the poller.

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

  /** Aggregate throughput across EVERY NAS — the whole-network MRTG series. */
  @Get('network-traffic')
  networkTraffic(@Query('range') range?: string) {
    return this.monitor.networkTraffic(range || '1h');
  }

  /** Top-N subscribers by live throughput — dashboard "who's using now" list. */
  @Get('top-subscribers')
  topSubscribers(@Query('limit') limit?: string) {
    return this.monitor.topSubscribers(limit ? Number(limit) : 8);
  }

  /**
   * Real-time whole-network meter (2s resolution, last 60 points). Polls the
   * routers' live PPPoE session counters on demand — NOT the 5/10-minute DB
   * sample tables — so both series move every ~2 seconds.
   */
  @Get('live-traffic')
  liveTraffic() {
    return this.live.snapshot();
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

  // REMOVED: GET nas/:id/signals and GET onu/:id/signal — ONU optical signal
  // readings were SNMP-polled. Removed with the rest of SNMP by operator
  // decision. Subscriber traffic graphs are unaffected: they come from
  // radacct, not from SNMP.

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
