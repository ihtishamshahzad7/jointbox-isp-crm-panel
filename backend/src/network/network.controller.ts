import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import { NetworkService } from './network.service';
import { CoaService } from './coa.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';
import { PrismaService } from '../prisma/prisma.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('network')
export class NetworkController {
  constructor(
    private readonly network: NetworkService,
    private readonly coa: CoaService,
    private readonly scope: ScopeService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * SECURITY: verify the caller may act on this subscriber before any
   * session-control action. Without this, a reseller could disconnect, re-speed
   * or read the MAC of ANY customer in the whole ISP by guessing a username/id.
   */
  private async assertOwns(actor: any, opts: { username?: string; subscriberId?: number }) {
    if (this.scope.isAdmin(actor?.role)) return;
    let id = opts.subscriberId;
    if (!id && opts.username) {
      const sub = await this.prisma.subscriber.findUnique({ where: { username: opts.username }, select: { id: true } });
      if (!sub) throw new ForbiddenException('Not found or not permitted.');
      id = sub.id;
    }
    if (!id) throw new ForbiddenException('Not permitted.');
    await this.scope.assertSubscriber(actor, id);
  }

  @Get('live')
  live(@Query('nasIp') nasIp: string, @Req() req: any) {
    return this.network.liveSessions(nasIp, req.user);
  }

  @Get('live/stats')
  liveStats(@Req() req: any) {
    return this.network.liveStats(req.user);
  }

  @Post('disconnect/:username')
  async disconnect(@Param('username') username: string, @Req() req: any) {
    await this.assertOwns(req.user, { username });
    return this.network.disconnect(username);
  }

  /** Cut EVERY open session for one username — duplicate-login takedown. */
  @Post('disconnect/:username/all')
  async cutAll(@Param('username') username: string, @Req() req: any) {
    await this.assertOwns(req.user, { username });
    return this.network.cutAllSessions(username);
  }

  /**
   * Find any username online from more than one device right now, log it, and
   * disconnect ALL of that user's sessions. Runs automatically every 2 minutes;
   * this endpoint lets an operator force it on demand.
   */
  @Post('duplicate-sessions/sweep')
  async sweepDuplicates() {
    return this.coa.disconnectDuplicateSessions();
  }

  /** Live bandwidth change via RADIUS CoA (vendor-agnostic). */
  @Post('bandwidth/:subscriberId')
  async changeBandwidth(
    @Param('subscriberId') subscriberId: string,
    @Body() body: { downloadSpeed: number; uploadSpeed: number },
    @Req() req: any,
  ) {
    await this.assertOwns(req.user, { subscriberId: +subscriberId });
    return this.coa.changeBandwidth(+subscriberId, Number(body.downloadSpeed), Number(body.uploadSpeed));
  }

  /** Probe whether a NAS accepts RADIUS CoA (harmless, changes nothing). */
  @Get('nas/:id/test-coa')
  testCoa(@Param('id') id: string) {
    return this.coa.testCoa(+id);
  }

  // ── MAC binding ───────────────────────────────────────────────
  @Get('mac/:username')
  async getMac(@Param('username') username: string, @Req() req: any) {
    await this.assertOwns(req.user, { username });
    return this.network.getMacBinding(username);
  }

  @Post('mac/:username')
  async bindMac(@Param('username') username: string, @Body() body: { mac: string }, @Req() req: any) {
    await this.assertOwns(req.user, { username });
    return this.network.bindMac(username, body.mac);
  }

  @Post('mac/:username/autolearn')
  async autolearn(@Param('username') username: string, @Req() req: any) {
    await this.assertOwns(req.user, { username });
    return this.network.autolearnMac(username);
  }

  @Delete('mac/:username')
  async unbindMac(@Param('username') username: string, @Query('mac') mac: string, @Req() req: any) {
    await this.assertOwns(req.user, { username });
    return this.network.unbindMac(username, mac);
  }
}
