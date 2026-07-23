import {
  Controller, Get, Post, Param, Body, Query, UseGuards, Req, ForbiddenException,
} from '@nestjs/common';
import { TopologyService } from './topology.service';
import { DeviceIntelService } from './device-intel.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('topology')
export class TopologyController {
  constructor(
    private readonly topology: TopologyService,
    private readonly devices: DeviceIntelService,
  ) {}

  // ── Detection that needs nothing from your hardware ──────────

  /** What equipment is on the network, by manufacturer, with online rates. */
  @Get('devices')
  devices_(@Req() req: any) {
    return this.devices.deviceReport(req.user);
  }

  /**
   * Shared segments inferred from correlated disconnects — works even when
   * the OLT never sends a circuit-id.
   */
  @Get('segments/inferred')
  inferred(@Query() q: any, @Req() req: any) {
    return this.devices.inferSegments(req.user, {
      days: q.days ? +q.days : undefined,
      windowSeconds: q.window ? +q.window : undefined,
      minShared: q.minShared ? +q.minShared : undefined,
      minScore: q.minScore ? +q.minScore : undefined,
    });
  }

  /** Identify a single MAC address. */
  @Post('mac')
  mac(@Body() body: { mac: string }) {
    return this.devices.identifyMac(body?.mac);
  }

  /** OLT → PON port tree with live health at each level. */
  @Get('tree')
  tree(@Req() req: any) {
    return this.topology.tree(req.user);
  }

  /** Shared faults — splitters and OLTs with most of their customers down. */
  @Get('faults')
  faults(@Req() req: any) {
    return this.topology.faults(req.user);
  }

  /**
   * Full path for one subscriber with a verdict naming the likely fault
   * location, so nobody has to infer it from four separate numbers.
   */
  @Get('trace/:subscriberId')
  trace(@Param('subscriberId') id: string, @Req() req: any) {
    return this.topology.traceSubscriber(+id, req.user);
  }

  /** Test what a circuit-id parses to — useful when adding a new OLT vendor. */
  @Post('parse')
  parse(@Body() body: { circuitId: string }) {
    return this.topology.parseCircuitId(body?.circuitId);
  }

  /**
   * Force a learning pass instead of waiting for the ten-minute cycle.
   * ISP-only: it writes network-wide topology records and scans every
   * session, so it is not something a dealer should be able to trigger.
   */
  @Post('detect')
  detect(@Req() req: any) {
    if (req?.user?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only the ISP owner can trigger topology detection.');
    }
    return this.topology.learnFromSessions().then(() => ({ started: true }));
  }
}
