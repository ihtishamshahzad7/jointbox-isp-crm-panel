import {
  Controller, Get, Post, Put, Delete,
  Body, Param, Query, Req, UseGuards,
} from '@nestjs/common';
import { FiberService } from './fiber.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('fiber')
export class FiberController {
  constructor(
    private readonly fiber: FiberService,
    private readonly scope: ScopeService,
  ) {}

  // SECURITY: OLTs/ports/ONUs are shared infrastructure (permission-gated), but
  // anything tied to a specific subscriber must be limited to accounts that own
  // that subscriber — otherwise fiber/box/ONU details leak across resellers.
  private assertOwns(actor: any, subscriberId: number) {
    return this.scope.assertSubscriber(actor, subscriberId);
  }

  // ── Summary ──────────────────────────────────────────────────
  @Get('summary')
  summary(@Req() req: any) {
    return this.fiber.getFiberSummary(req.user);
  }

  // ── OLT CRUD ─────────────────────────────────────────────────
  // An OLT is scoped through its NAS; ports and ONUs inherit from it. The
  // checks live in FiberService so every route goes through the same ones.
  @Get('olts')
  listOlts(@Req() req: any) {
    return this.fiber.listOlts(req.user);
  }

  @Get('olts/:id')
  getOlt(@Param('id') id: string, @Req() req: any) {
    return this.fiber.getOlt(+id, req.user);
  }

  @Post('olts')
  createOlt(@Body() body: {
    name: string; vendor?: string; model?: string; mgmtIp?: string;
    location?: string; nasId?: number; areaId?: number;
  }, @Req() req: any) {
    return this.fiber.createOlt(body, req.user);
  }

  @Put('olts/:id')
  updateOlt(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.fiber.updateOlt(+id, body, req.user);
  }

  @Delete('olts/:id')
  deleteOlt(@Param('id') id: string, @Req() req: any) {
    return this.fiber.deleteOlt(+id, req.user);
  }

  // ── Fiber Topology Tree ──────────────────────────────────────
  @Get('olts/:id/tree')
  getTree(@Param('id') id: string, @Req() req: any) {
    return this.fiber.getFiberTree(+id, req.user);
  }

  // ── PON Ports ────────────────────────────────────────────────
  @Get('ports')
  listPorts(@Req() req: any, @Query('oltId') oltId?: string) {
    return this.fiber.listPorts(oltId ? +oltId : undefined, req.user);
  }

  @Post('ports')
  createPort(@Body() body: {
    oltId: number; portName: string; slot?: string; port?: string;
    splitRatio?: number; splitterLocation?: string;
  }, @Req() req: any) {
    return this.fiber.createPort(body, req.user);
  }

  @Put('ports/:id')
  updatePort(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.fiber.updatePort(+id, body, req.user);
  }

  @Delete('ports/:id')
  deletePort(@Param('id') id: string, @Req() req: any) {
    return this.fiber.deletePort(+id, req.user);
  }

  // ── ONUs ─────────────────────────────────────────────────────
  @Get('onus')
  listOnus(@Query() query: {
    oltId?: string; portId?: string; subscriberId?: string;
    unassigned?: string; page?: string; limit?: string;
  }, @Req() req: any) {
    return this.fiber.listOnus({
      ...(query.oltId ? { oltId: +query.oltId } : {}),
      ...(query.portId ? { portId: +query.portId } : {}),
      ...(query.subscriberId ? { subscriberId: +query.subscriberId } : {}),
      ...(query.unassigned ? { unassigned: true } : {}),
      page: query.page ? +query.page : undefined,
      limit: query.limit ? +query.limit : undefined,
    }, req.user);
  }

  @Post('onus/:id/assign/:subscriberId')
  async assignOnu(@Param('id') id: string, @Param('subscriberId') subscriberId: string, @Req() req: any) {
    await this.assertOwns(req.user, +subscriberId);
    return this.fiber.assignOnu(+id, +subscriberId, req.user);
  }

  @Post('onus/:id/unassign')
  unassignOnu(@Param('id') id: string, @Req() req: any) {
    return this.fiber.unassignOnu(+id, req.user);
  }

  @Put('onus/:id')
  updateOnu(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.fiber.updateOnu(+id, body, req.user);
  }

  @Delete('onus/:id')
  deleteOnu(@Param('id') id: string, @Req() req: any) {
    return this.fiber.deleteOnu(+id, req.user);
  }

  // ── ONU Provisioning ─────────────────────────────────────────
  @Get('onus/:id/provision-commands')
  getProvisionCommands(@Param('id') id: string, @Req() req: any, @Query('vlan') vlan?: string) {
    return this.fiber.generateProvisionCommands(+id, vlan ? +vlan : undefined, req.user);
  }

  @Get('onus/:id/unprovision-commands')
  getUnprovisionCommands(@Param('id') id: string, @Req() req: any) {
    return this.fiber.generateUnprovisionCommands(+id, req.user);
  }

  @Get('onus/:id/diagnostic-commands')
  getDiagnosticCommands(@Param('id') id: string, @Req() req: any) {
    return this.fiber.generateDiagnosticCommands(+id, req.user);
  }

  // ── Circuit-ID Parser ────────────────────────────────────────
  // Tenant-free: a pure string parser (TopologyService.parseCircuitId), no
  // database read. The actor is taken only so the route is identity-aware.
  @Get('parse-circuit')
  parseCircuit(@Req() _req: any, @Query('circuitId') circuitId?: string) {
    return this.fiber.parseCircuitId(circuitId || '');
  }

  // ── Subscriber Fiber Details ─────────────────────────────────
  @Get('subscribers/:subscriberId')
  async getSubscriberFiber(@Param('subscriberId') subscriberId: string, @Req() req: any) {
    await this.assertOwns(req.user, +subscriberId);
    return this.fiber.getSubscriberFiber(+subscriberId);
  }

  @Put('subscribers/:subscriberId')
  async updateSubscriberFiber(
    @Param('subscriberId') subscriberId: string,
    @Body() body: {
      boxNumber?: string; boxAddress?: string; switchBoard?: string; switchPort?: string;
      electricSocket?: string; cableType?: string; uplinkPort?: string;
      fiberCode?: string; fiberColor?: string; onuNote?: string;
    },
    @Req() req: any,
  ) {
    await this.assertOwns(req.user, +subscriberId);
    return this.fiber.updateSubscriberFiber(+subscriberId, body);
  }
}