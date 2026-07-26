import {
  Controller, Get, Post, Put, Patch, Delete,
  Body, Param, Query, UseGuards, Req,
} from '@nestjs/common';
import { SubscribersService } from './subscribers.service';
import { RenewalService } from './renewal.service';
import { ExportService } from './export.service';
import { LifecycleService } from './lifecycle.service';
import { IntegrityService } from './integrity.service';
import { PANEL_COLUMNS, CONNECTION_TYPE, PROFILE_STATUS, DISCOUNT_TYPE } from './panel-format';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import {
  ForbiddenException, NotFoundException,
  BadRequestException, InternalServerErrorException,
} from '@nestjs/common';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('subscribers')
export class SubscribersController {
  constructor(
    private readonly subscribersService: SubscribersService,
    private readonly renewal: RenewalService,
    private readonly exporter: ExportService,
    private readonly lifecycle: LifecycleService,
    private readonly integrity: IntegrityService,
  ) {}

  private assertIsp(req: any) {
    if (req?.user?.role !== 'SUPER_ADMIN' && req?.user?.role !== 'ADMIN') {
      throw new ForbiddenException('Only the ISP account can run this.');
    }
  }

  /** Run the reminder + auto-suspend sweep now instead of waiting for 07:10. ISP only. */
  @Post('lifecycle/run')
  runLifecycle(@Req() req: any) {
    this.assertIsp(req);
    return this.lifecycle.runNow();
  }

  /** Put a subscriber on billing hold (dispute) — pauses auto-suspension. */
  @Patch(':id/hold')
  hold(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: any) {
    return this.subscribersService.setHold(+id, true, body?.reason, req.user);
  }

  /** Clear a billing hold. */
  @Patch(':id/unhold')
  unhold(@Param('id') id: string, @Req() req: any) {
    return this.subscribersService.setHold(+id, false, undefined, req.user);
  }

  /** Wallet-vs-ledger drift report (money integrity). ISP only. */
  @Get('integrity/wallets')
  reconcileWallets(@Req() req: any) {
    this.assertIsp(req);
    return this.integrity.reconcileWallets();
  }

  /** RADIUS-vs-billing drift: inactive subscribers still online. `?apply=false` = dry run. ISP only. */
  @Get('integrity/radius')
  reconcileRadius(@Req() req: any, @Query('apply') apply?: string) {
    this.assertIsp(req);
    return this.integrity.reconcileRadiusState(apply !== 'false');
  }

  // ========== BASIC CRUD ENDPOINTS ==========

  @Get()
  findAll(@Query() query: any, @Req() req: any) {
    return this.subscribersService.findAll(query, req.user);
  }

  @Get('stats')
  getStats(@Req() req: any) {
    return this.subscribersService.getStats(req.user);
  }

  @Get('overview')
  getOverview(@Req() req: any) {
    return this.subscribersService.getOverview(req.user);
  }

  @Get('expiring')
  getExpiring(@Query('days') days?: string) {
    const parsed = days !== undefined ? Number(days) : undefined;
    return this.subscribersService.getExpiring(parsed);
  }

  /** What can be filtered on, restricted to what the caller may see. */
  @Get('export/options')
  exportOptions(@Req() req: any) {
    return this.exporter.filterOptions(req.user);
  }

  /** How many rows the current filter set would produce. */
  @Post('export/preview')
  exportPreview(@Body() body: any, @Req() req: any) {
    return this.exporter.preview(body || {}, req.user);
  }

  /** The rows themselves — the client renders CSV or Excel from these. */
  @Post('export/run')
  exportRun(@Body() body: any, @Req() req: any) {
    return this.exporter.run(body || {}, req.user);
  }

  /**
   * Export in the standard 46-column panel exchange format.
   * Fixed column set and order, so the file interoperates with other ISP
   * tooling and loads back into this panel unchanged.
   */
  @Post('export/panel')
  exportPanel(@Body() body: any, @Req() req: any) {
    return this.exporter.runPanelFormat(body || {}, req.user);
  }

  /** The canonical column list, for building a template or validating a file. */
  @Get('format/columns')
  formatColumns() {
    return {
      columns: PANEL_COLUMNS,
      count: PANEL_COLUMNS.length,
      dateFormat: 'M/D/YYYY HH:mm',
      codes: {
        connection_type: CONNECTION_TYPE,
        profile_status: PROFILE_STATUS,
        discount_type: DISCOUNT_TYPE,
        booleans: '1 = yes, 0 = no (mac_lock_status, sms_status)',
      },
      required: ['username', 'password or connection_password', 'full_name'],
      note:
        'Column ORDER and header spelling are part of the format. Empty columns ' +
        'must still be present — other systems match on position as well as name.',
    };
  }

  /**
   * Import a file in the panel exchange format.
   * Send `dryRun: true` first — it validates everything and writes nothing.
   */
  @Post('import/panel')
  importPanel(@Body() body: any) {
    return this.subscribersService.importPanelFormat(body || {});
  }

  @Get('export')
  exportSubscribers(@Query() query: any, @Req() req: any) {
    return this.subscribersService.exportSubscribers(query, req.user);
  }

  @Post('import')
  importSubscribers(@Body() body: { rows: any[]; salespersonId?: number | null }) {
    return this.subscribersService.importSubscribers(body);
  }

  /**
   * Re-push this subscriber's full RADIUS profile — service type, static IP,
   * speed and session limits. Use after changing any of those.
   */
  @Post(':id/sync-profile')
  syncProfile(@Param('id') id: string) {
    return this.subscribersService.syncToRadius(+id);
  }

  // Rebuild package / NAS / install-date links for every subscriber that lost
  // them. Fills NULLs only — safe to run any time. Also runs on backend start.
  @Post('repair-links')
  repairLinks() {
    return this.subscribersService.repairMissingLinks();
  }

  // ── Move a subscriber between resellers (dealer 1 → dealer 2) ──
  @Post(':id/transfer')
  transfer(
    @Param('id') id: string,
    @Body() body: { toUserId: number; reason?: string; settle?: boolean },
    @Req() req: any,
  ) {
    return this.subscribersService.transferOwnership(+id, Number(body.toUserId), {
      reason: body.reason,
      actor: req.user,
      settle: body.settle, // default true — pass false to move without settling
    });
  }

  /**
   * List subscribers attached to two accounts at once, left behind by
   * transfers made before the move was made total. `?repair=true` fixes them.
   */
  @Get('audit/split-ownership')
  splitOwnership(@Req() req: any, @Query('repair') repair?: string) {
    return this.subscribersService.findSplitOwnership(req.user, repair === 'true');
  }

  /** Who has owned this subscriber, when, and at what price. */
  @Get(':id/transfers')
  transfers(@Param('id') id: string, @Req() req: any) {
    return this.subscribersService.transferHistory(+id, req.user);
  }

  /** Move many subscribers at once — e.g. re-assigning a dealer's whole book. */
  @Post('bulk-transfer')
  async bulkTransfer(
    @Body() body: { ids: number[]; toUserId: number; reason?: string; settle?: boolean },
    @Req() req: any,
  ) {
    const results: any[] = [];
    for (const id of body.ids || []) {
      try {
        results.push(await this.subscribersService.transferOwnership(
          Number(id), Number(body.toUserId),
          // settle:false hands the customer over without charging the receiver.
          // Needed when the ISP is seeding an account that has no wallet yet —
          // otherwise the very first hand-over is blocked by a balance check.
          { reason: body.reason, actor: req.user, settle: body.settle },
        ));
      } catch (e: any) {
        results.push({ transferred: false, subscriberId: id, error: e?.message || String(e) });
      }
    }
    return {
      requested: (body.ids || []).length,
      moved: results.filter((r) => r.transferred).length,
      results,
    };
  }

  /**
   * Preview a renewal before committing — days, price and the resulting
   * expiry date. Lets the operator see "5 days = PKR 83, expires 25 Jul"
   * before taking any money.
   */
  @Post('renew/quote')
  quoteRenewal(@Body() body: any, @Req() req: any) {
    // req.user is required here — see the note on quote(). Omitting it made
    // every subscriber's pricing readable by any logged-in account.
    return this.renewal.quote(Number(body.subscriberId), body, req.user);
  }

  /** Activate on trust. Records the debt and who authorised it. */
  @Post('renew/credit/:id')
  grantCredit(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.renewal.grantCredit(+id, body, req.user);
  }

  @Get('renew/credits')
  listCredits(@Query('status') status: string, @Req() req: any) {
    return this.renewal.listCredits(req.user, status || 'OUTSTANDING');
  }

  @Post('renew/credits/:creditId/settle')
  settleCredit(@Param('creditId') creditId: string, @Body() body: any, @Req() req: any) {
    return this.renewal.settleCredit(+creditId, body, req.user);
  }

  @Post('activate-renewal')
  activateRenewal(@Body() body: any, @Req() req: any) {
    return this.subscribersService.activateRenewal({ ...body, actorId: req.user?.sub });
  }

  @Delete('bulk-delete')
  bulkDelete(@Body() body: { ids: number[]; force?: boolean }, @Req() req: any) {
    // Actor added: this route previously bypassed scope and permission checks
    // that the single-delete route enforces.
    return this.subscribersService.bulkDelete(body.ids || [], req.user, !!body.force);
  }

  @Patch('bulk-service-settings')
  bulkServiceSettings(@Body() body: { ids: number[]; payload: any }) {
    return this.subscribersService.bulkUpdateServiceSettings(body.ids || [], body.payload || {});
  }

  @Get('search')
  search(@Query('q') q: string, @Req() req: any) {
    return this.subscribersService.search(q, req.user);
  }

  @Get(':id/profile-bundle')
  profileBundle(@Param('id') id: string) {
    return this.subscribersService.getProfileBundle(+id);
  }

  // ========== BACKGROUND SYNC JOBS (Phase 0 — queued, non-blocking) ==========

  @Post('sync-all-to-radius/queue')
  queueSyncAll() {
    return this.subscribersService.enqueueRadiusSync('all');
  }

  @Post('sync-missing-to-radius/queue')
  queueSyncMissing() {
    return this.subscribersService.enqueueRadiusSync('missing');
  }

  @Get('sync-jobs/:jobId')
  getSyncJob(@Param('jobId') jobId: string) {
    return this.subscribersService.getSyncJobStatus(jobId);
  }

  // ========== RADIUS PROFILE ROUTES (must come before @Get(':id')) ==========

  @Get('radius-session/:username')
  async getRadiusSession(@Param('username') username: string) {
    return this.subscribersService.getRadiusSession(username);
  }

  @Get('bandwidth-history/:username')
  async getBandwidthHistory(
    @Param('username') username: string,
    @Query('minutes') minutes?: string,
  ) {
    return this.subscribersService.getBandwidthHistory(username, Number(minutes) || 60);
  }

  @Get('radius-auth-log/:username')
  async getRadiusAuthLog(@Param('username') username: string) {
    return this.subscribersService.getRadiusAuthLog(username);
  }

  @Get('radius-checks/:username')
  async getRadiusChecks(@Param('username') username: string) {
    return this.subscribersService.getRadiusChecks(username);
  }

  // ========== REST PARAMETER ROUTES ==========

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.subscribersService.findOne(+id, req.user);
  }

  @Post()
  create(@Body() body: any, @Req() req: any) {
    return this.subscribersService.create(body, req.user);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.subscribersService.update(+id, body, req.user);
  }

  /**
   * Cut service and free the addresses, keeping the record. The safe
   * alternative to deletion, and the one that keeps accounting intact.
   */
  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: any) {
    return this.subscribersService.deactivateAndRelease(+id, req.user, body?.reason);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any, @Query('force') force?: string) {
    // ?force=true bypasses the "has recorded payments" guard — for test data.
    return this.subscribersService.remove(+id, req.user, force === 'true');
  }

  // ========== RADIUS SYNC ENDPOINTS ==========

  // Sync ALL active subscribers to RADIUS
  @Post('sync-all-to-radius')
  async syncAllToRadius() {
    return this.subscribersService.syncAllToRadius();
  }

  // Sync ONLY missing subscribers to RADIUS (doesn't overwrite existing)
  @Post('sync-missing-to-radius')
  async syncMissingToRadius() {
    return this.subscribersService.syncMissingToRadius();
  }

  // Check if a specific user exists in RADIUS
  @Get('radius-status/:username')
  async checkRadiusStatus(@Param('username') username: string) {
    return this.subscribersService.checkRadiusStatus(username);
  }

  // Test RADIUS database connection
  @Get('test-radius-connection')
  async testRadiusConnection() {
    return this.subscribersService.testRadiusConnection();
  }

  // Find subscriber by username (not ID)
  @Get('username/:username')
  async findByUsername(@Param('username') username: string) {
    return this.subscribersService.findByUsername(username);
  }

  // Manually sync a specific subscriber to RADIUS by ID (full profile)
  @Post(':id/sync-to-radius')
  async syncOneToRadius(@Param('id') id: string) {
    const subscriber = await this.subscribersService.findOne(+id);
    if (!subscriber) {
      throw new NotFoundException('Subscriber not found');
    }
    
    if (!subscriber.username || !subscriber.password) {
      throw new BadRequestException('Subscriber missing username or password');
    }
    
    // Fetch package with pool to sync speed + Framed-Pool
    const pkg = subscriber.package ?? null;
    // Build opts like syncToRadius does
    const wantsStatic = subscriber.authMethod === 'STATIC' || subscriber.serviceSettings?.ipType === 'STATIC';
    const staticIp = wantsStatic ? subscriber.serviceSettings?.ipAddress ?? null : null;
    await this.subscribersService.radiusSync.syncSubscriberProfile(
      subscriber.username,
      subscriber.password,
      pkg,
      {
        serviceType: subscriber.authMethod as any,
        staticIp,
        macAddress: subscriber.serviceSettings?.macAddress ?? null,
        sessionTimeout: Number(process.env.HOTSPOT_SESSION_TIMEOUT || 0) || null,
        idleTimeout: Number(process.env.HOTSPOT_IDLE_TIMEOUT || 0) || null,
      },
    );
    return {
      message: `Subscriber ${subscriber.username} synced to RADIUS`,
      username: subscriber.username,
      package: pkg?.name || 'none',
    };
  }

  // Bulk sync specific subscribers by IDs
  @Post('bulk-sync-to-radius')
  async bulkSyncToRadius(@Body() body: { ids: number[] }) {
    const results: Array<{
      id: number;
      username?: string;
      status: string;
      error?: string;
      reason?: string;
    }> = [];
    
    for (const id of body.ids) {
      const subscriber = await this.subscribersService.findOne(id);
      if (subscriber && subscriber.username && subscriber.password) {
        try {
          const pkg = subscriber.package ?? null;
          // Build opts like syncToRadius does
          const wantsStatic = subscriber.authMethod === 'STATIC' || subscriber.serviceSettings?.ipType === 'STATIC';
          const staticIp = wantsStatic ? subscriber.serviceSettings?.ipAddress ?? null : null;
          await this.subscribersService.radiusSync.syncSubscriberProfile(
            subscriber.username,
            subscriber.password,
            pkg,
            {
              serviceType: subscriber.authMethod as any,
              staticIp,
              macAddress: subscriber.serviceSettings?.macAddress ?? null,
              sessionTimeout: Number(process.env.HOTSPOT_SESSION_TIMEOUT || 0) || null,
              idleTimeout: Number(process.env.HOTSPOT_IDLE_TIMEOUT || 0) || null,
            },
          );
          results.push({
            id,
            username: subscriber.username,
            status: 'success',
          });
        } catch (error: any) {
          results.push({
            id,
            username: subscriber.username,
            status: 'failed',
            error: error.message,
          });
        }
      } else {
        results.push({
          id,
          status: 'skipped',
          reason: 'Missing username or password',
        });
      }
    }
    return { results };
  }

  // Remove a subscriber from RADIUS only (doesn't delete from CRM)
  @Delete('radius/:username')
  async removeFromRadius(@Param('username') username: string) {
    await this.subscribersService.radiusSync.removeSubscriberFromRadius(username);
    return { message: `Subscriber ${username} removed from RADIUS` };
  }

  // Get all subscribers that are missing from RADIUS
  @Get('missing-from-radius')
  async getMissingFromRadius() {
    // findAll() without pagination params always returns the full array
    const allSubscribers = (await this.subscribersService.findAll()) as Array<any>;

    const missing: Array<{
      id: number;
      username: string;
      fullName: string;
      status: string;
    }> = [];
    
    for (const sub of allSubscribers) {
      if (sub.username) {
        const exists = await this.subscribersService.checkRadiusStatus(sub.username);
        if (!exists.existsInRadius) {
          missing.push({
            id: sub.id,
            username: sub.username,
            fullName: sub.fullName,
            status: sub.status,
          });
        }
      }
    }
    
    return {
      total: allSubscribers.length,
      missing: missing.length,
      subscribers: missing,
    };
  }

  // Fix: Re-sync a subscriber with correct password format (full profile)
  @Post(':id/fix-radius-password')
  async fixRadiusPassword(@Param('id') id: string) {
    const subscriber = await this.subscribersService.findOne(+id);
    if (!subscriber) {
      throw new NotFoundException('Subscriber not found');
    }
    
    if (!subscriber.username || !subscriber.password) {
      throw new BadRequestException('Subscriber missing username or password');
    }
    
    // Remove and re-add with full profile
    await this.subscribersService.radiusSync.removeSubscriberFromRadius(subscriber.username);
    const pkg = subscriber.package ?? null;
    
    // Build opts like syncToRadius does
    const wantsStatic = subscriber.authMethod === 'STATIC' || subscriber.serviceSettings?.ipType === 'STATIC';
    const staticIp = wantsStatic ? subscriber.serviceSettings?.ipAddress ?? null : null;
    
    await this.subscribersService.radiusSync.syncSubscriberProfile(
      subscriber.username,
      subscriber.password,
      pkg,
      {
        serviceType: subscriber.authMethod as any,
        staticIp,
        macAddress: subscriber.serviceSettings?.macAddress ?? null,
        sessionTimeout: Number(process.env.HOTSPOT_SESSION_TIMEOUT || 0) || null,
        idleTimeout: Number(process.env.HOTSPOT_IDLE_TIMEOUT || 0) || null,
      },
    );
    return {
      message: `RADIUS profile re-synced for ${subscriber.username}`,
      username: subscriber.username,
      package: pkg?.name || 'none',
    };
  }
}