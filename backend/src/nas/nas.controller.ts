import {
  Controller, Get, Post, Put, Delete,
  Body, Param, Query, UseGuards, Patch, Req,
} from '@nestjs/common';
import { NasService } from './nas.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService, type Actor } from '../common/scope.service';
import { RadiusClientVaultService } from './radius-client-vault.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('nas')
export class NasController {
  constructor(
    private readonly nasService: NasService,
    private readonly scope: ScopeService,
    private readonly radiusVault: RadiusClientVaultService,
  ) {}

  /**
   * FreeRADIUS client vault: where FreeRADIUS takes router secrets from on
   * this server, whether the generated file is in place and readable, how many
   * routers are in it, what was left out and why, and the last sync result.
   * Server state, counts and router ids only — no secret, no address book.
   * Platform account only.
   */
  @Get('radius/vault')
  vaultStatus(@Req() req: { user: Actor }) {
    this.scope.assertPlatformOwner(req.user);
    return this.radiusVault.status();
  }

  /** Re-render, check and (if changed) restart FreeRADIUS now. Platform account only. */
  @Post('radius/vault/sync')
  vaultSync(@Req() req: { user: Actor }) {
    this.scope.assertPlatformOwner(req.user);
    return this.radiusVault.apply('manual');
  }

  /**
   * Router by router: in FreeRADIUS's list or left out (and why), legacy
   * plaintext still kept, last accounting FreeRADIUS accepted from it.
   *
   *   • platform account — every router on the server, by id and address only
   *     (the server's RADIUS clients; no company names);
   *   • a company — only the routers it can see, plus whether the server's
   *     FreeRADIUS sync is healthy. Another company's routers, ids or errors
   *     never appear.
   */
  @Get('radius/vault/routers')
  async vaultRouters(@Req() req: { user: Actor }) {
    const platform = this.scope.isPlatformOwner(req.user);
    const where: Record<string, unknown> = platform
      ? {}
      : ((await this.scope.nasWhere(req.user)) as Record<string, unknown>);
    const routers = await this.radiusVault.routerReport(where);
    const st = await this.radiusVault.status();
    const healthy = st.freeradiusOnThisServer
      ? st.running !== false && (st.last ? st.last.ok : true)
      : null;
    // The installation's error text can name other companies' routers: only
    // the platform account gets it; a company gets the remedy.
    const companyError =
      'FreeRADIUS could not be updated on the server. Your routers keep working with the last good list; the platform administrator has been notified.';
    return {
      mode: st.mode,
      freeradiusRunning: st.running,
      syncHealthy: healthy,
      lastOkAt: st.lastOkAt,
      lastError:
        st.last && !st.last.ok
          ? platform
            ? st.last.message
            : companyError
          : null,
      routers: platform ? routers.map((r) => ({ ...r, name: null })) : routers,
    };
  }

  /**
   * Retire legacy plaintext router secrets kept since the switch to the vault
   * file. By default only routers FreeRADIUS has accepted accounting from
   * since the switch; `{ all: true }` after the operator has tested logins.
   * Platform account only.
   */
  @Post('radius/vault/retire-plaintext')
  vaultRetire(@Body() body: { all?: boolean }, @Req() req: { user: Actor }) {
    this.scope.assertPlatformOwner(req.user);
    return this.radiusVault.retireProvenPlaintext({ all: body?.all === true });
  }

  // ── CRUD ────────────────────────────────────────────────────
  @Get()
  findAll(@Query() query: any, @Req() req: any) { return this.nasService.findAll(query, req.user); }

  // ── Assign / unassign a router to a downline account ────────
  /** Bulk: give several routers to several accounts at once. */
  @Post('assign-bulk')
  assignBulk(@Body() body: { nasIds: number[]; userIds: number[]; propagate?: boolean }, @Req() req: any) {
    return this.nasService.assignBulk(body?.nasIds || [], body?.userIds || [], req.user, body?.propagate !== false);
  }

  @Post(':id/assign/:userId')
  assign(@Param('id') id: string, @Param('userId') userId: string, @Body() body: { propagate?: boolean }, @Req() req: any) {
    // propagate defaults to true (cascades to the whole downline) unless the
    // caller explicitly passes false to restrict the share to this one account.
    return this.nasService.assignToUser(+id, +userId, req.user, body?.propagate !== false);
  }

  @Delete(':id/assign/:userId')
  unassign(@Param('id') id: string, @Param('userId') userId: string, @Req() req: any) {
    return this.nasService.unassignFromUser(+id, +userId, req.user);
  }

  @Get('stats')
  getStats(@Req() req: any) { return this.nasService.getStats(req.user); }

  @Get('overview')
  getOverview(@Req() req: any) { return this.nasService.getOverview(req.user); }

  /** Group NAS by owner | type | site, with counts. */
  @Get('grouped')
  grouped(@Query('by') by: string, @Req() req: any) { return this.nasService.groupedBy(by || 'owner', req.user); }

  /**
   * Dumps EVERY router on the installation — both the FreeRADIUS `nas` table
   * (shared secrets included) and every company's Nas rows. Installation
   * diagnostics, so the platform owner only.
   */
  @Get('debug/radius-sync')
  debugRadiusSync(@Req() req: any) {
    this.scope.assertPlatformOwner(req.user);
    return this.nasService.debugRadiusSync();
  }

  // IMPORTANT: named routes like 'stats' and 'radius/stats' must come
  // BEFORE ':id' — otherwise NestJS treats them as id params
  @Get('radius/stats')
  getRadiusStats(@Req() req: any) { return this.nasService.getRadiusStats(req.user); }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) { return this.nasService.findOne(+id, req.user); }

  @Post()
  create(@Body() body: any, @Req() req: any) { return this.nasService.create(body, req.user); }

  @Post('import')
  importMany(@Body() body: any, @Req() req: any) { return this.nasService.importMany(body?.rows || [], req.user); }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.nasService.update(+id, body, req.user);
  }

  @Patch(':id/toggle')
  toggleStatus(@Param('id') id: string, @Req() req: any) {
    return this.nasService.toggleStatus(+id, req.user);
  }

  /** Register the interfaces/ports to monitor (empty array = monitor all). */
  @Patch(':id/monitored-ports')
  setMonitoredPorts(@Param('id') id: string, @Body() body: { ports: string[] }, @Req() req: any) {
    return this.nasService.setMonitoredPorts(+id, body?.ports || [], req.user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) { return this.nasService.remove(+id, req.user); }

  // ── MikroTik + RADIUS endpoints ─────────────────────────────
  //
  // Every one of these makes the server talk to the router (API login, ICMP,
  // RADIUS lookups) using credentials stored on the row, so the caller must be
  // able to see that router first. Out of scope reads as "not found".
  @Get(':id/reachability')
  async checkReachability(@Param('id') id: string, @Req() req: any) {
    await this.scope.assertNas(req.user, +id);
    return this.nasService.checkReachability(+id);
  }

  @Get(':id/ping')
  async ping(@Param('id') id: string, @Req() req: any) {
    await this.scope.assertNas(req.user, +id);
    return this.nasService.ping(+id);
  }

  @Get(':id/sync')
  async syncDetails(@Param('id') id: string, @Req() req: any) {
    await this.scope.assertNas(req.user, +id);
    return this.nasService.syncDetails(+id);
  }

  @Get(':id/quick-check')
  async quickCheck(@Param('id') id: string, @Req() req: any) {
    await this.scope.assertNas(req.user, +id);
    return this.nasService.quickCheck(+id);
  }

  /**
   * Live sessions on one router. A shared router carries more than one
   * account's customers, so the service also drops sessions whose subscriber
   * the caller cannot see.
   */
  @Get(':id/sessions')
  async getActiveSessions(@Param('id') id: string, @Req() req: any) {
    await this.scope.assertNas(req.user, +id);
    return this.nasService.getActiveSessions(+id, req.user);
  }

  /**
   * Accounting-pipeline health — a one-call answer to "why is nobody online?".
   * Not per-NAS: it inspects the whole radacct/radpostauth flow — every
   * company's sessions and logins — so it is installation diagnostics and
   * reserved for the platform owner.
   */
  @Get('diagnostics/accounting')
  accountingHealth(@Req() req: any) {
    this.scope.assertPlatformOwner(req.user);
    return this.nasService.accountingHealth();
  }
}