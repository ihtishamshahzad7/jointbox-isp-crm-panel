import { Controller, Get, Param, ParseIntPipe, Query, Req, UseGuards } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';
import { NasMonitorService } from './nas-monitor.service';
import { SnmpPollerService } from './snmp-poller.service';
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
    private readonly scope: ScopeService,
  ) {}

  /** One-off SNMP walk to list a NAS's interfaces for port registration. */
  @Get('nas/:id/discover-interfaces')
  discover(@Param('id', ParseIntPipe) id: number) {
    return this.snmp.discoverInterfaces(id);
  }

  /** Health of every NAS: online count + throughput + reporting status. */
  @Get('nas-health')
  nasHealth() {
    return this.monitor.healthOverview();
  }

  /** MRTG-style traffic for a NAS: range = 1h | 6h | 7d | 30d, optional vlan. */
  @Get('nas/:id/traffic')
  nasTraffic(
    @Param('id', ParseIntPipe) id: number,
    @Query('range') range?: string,
    @Query('vlan') vlan?: string,
  ) {
    return this.monitor.traffic(id, range || '7d', vlan || undefined);
  }

  /** Current per-VLAN online + throughput breakdown for a NAS. */
  @Get('nas/:id/vlans')
  nasVlans(@Param('id', ParseIntPipe) id: number) {
    return this.monitor.vlanBreakdown(id);
  }

  /** Availability % + downtime windows for a NAS over N days. */
  @Get('nas/:id/uptime')
  nasUptime(@Param('id', ParseIntPipe) id: number, @Query('days') days?: string) {
    return this.monitor.nasUptime(id, days ? +days : 7);
  }

  /** Link up/down + optical signal for every ONU on a NAS. */
  @Get('nas/:id/signals')
  nasSignals(@Param('id', ParseIntPipe) id: number) {
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
