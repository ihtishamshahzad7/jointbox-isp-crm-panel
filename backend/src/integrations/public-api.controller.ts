import {
  Controller, Get, Post, Put, Delete,
  Body, Param, Query, UseGuards, Req, NotFoundException,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScope } from './api-key.guard';
import { SubscribersService } from '../subscribers/subscribers.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvoicesService } from '../invoices/invoices.service';
import { GatewayService } from '../gateway/gateway.service';
import { CoaService } from '../network/coa.service';
import { ThrottleService, ThrottleRule } from '../network/throttle.service';
import { FiberService } from '../fiber/fiber.service';
import { PackagesService } from '../packages/packages.service';
import { ScopeService } from '../common/scope.service';

/**
 * Public API v1 — key-authenticated REST endpoints for external integrations.
 *
 * All endpoints are scoped using @RequireScope('read'|'write').
 * The API key's owner determines the data scope (reseller keys only see their
 * own subtree).
 */
@UseGuards(ApiKeyGuard)
@Controller('api/v1')
export class PublicApiController {
  constructor(
    private readonly subscribers: SubscribersService,
    private readonly analytics: AnalyticsService,
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly gateway: GatewayService,
    private readonly coa: CoaService,
    private readonly throttle: ThrottleService,
    private readonly fiber: FiberService,
    private readonly pkgService: PackagesService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * TENANCY FOR API KEYS.
   *
   * ApiKeyGuard makes the key's OWNER the actor (role 'API'), so the subtree
   * helpers scope a key exactly like its owner's own session. Every route
   * below that takes an id now checks it — before this, a key held by one
   * company could disconnect, throttle, invoice or look up any other
   * company's customers by id, phone or username.
   *
   * Installation-wide operations (gateway reconciliation, the transaction
   * ledger) need a key whose owner IS the platform owner — the 'API' role on
   * the actor is not enough to tell, so the owner's real role is read.
   */
  /** findOne answers null (not a throw) for another company's invoice. */
  private async assertInvoice(id: number, req: any): Promise<void> {
    const inv = await this.invoices.findOne(id, req.user);
    if (!inv) throw new NotFoundException('Invoice not found');
  }

  private async assertKeyOwnerIsPlatform(req: any): Promise<void> {
    const owner = await this.prisma.user.findUnique({
      where: { id: Number(req?.user?.id) },
      select: { role: true },
    });
    this.scope.assertPlatformOwner({ role: owner?.role } as any);
  }

  // ── Health & Ping ────────────────────────────────────────────
  @Get('ping')
  ping(@Req() req: any) {
    return {
      ok: true,
      keyName: req.apiKey?.name,
      scopes: (req.apiKey?.scopes || '').split(','),
      serverTime: new Date().toISOString(),
      version: '1.0',
    };
  }

  @Get('health')
  async health(@Req() req: any) {
    // The key owner's own numbers — these were installation-wide totals, so
    // any company's key read every other company's customer count.
    const owners = await this.scope.visibleUserIds(req.user);
    const [subs, online] = await Promise.all([
      this.prisma.subscriber.count({ where: await this.scope.subscriberWhere(req.user) }),
      (owners
        ? this.prisma.$queryRaw<any[]>`SELECT COUNT(*)::int AS n FROM radacct a
             JOIN "Subscriber" s ON s.username = a.username
            WHERE a.acctstoptime IS NULL
              AND COALESCE(a.acctupdatetime, a.acctstarttime) > NOW() - INTERVAL '15 minutes'
              AND s."userId" = ANY(${owners}::int[])`
        : this.prisma.$queryRaw<any[]>`SELECT COUNT(*)::int AS n FROM radacct WHERE acctstoptime IS NULL AND COALESCE(acctupdatetime, acctstarttime) > NOW() - INTERVAL '15 minutes'`
      ).catch(() => [{ n: 0 }]),
    ]);
    return {
      status: 'ok',
      subscribers: subs,
      onlineSessions: Number(online?.[0]?.n ?? 0),
      timestamp: new Date().toISOString(),
    };
  }

  // ── Subscribers ──────────────────────────────────────────────
  @Get('subscribers')
  @RequireScope('read')
  listSubscribers(@Query() query: any, @Req() req: any) {
    return this.subscribers.findAll(query, req.user);
  }

  @Get('subscribers/:id')
  @RequireScope('read')
  getSubscriber(@Param('id') id: string, @Req() req: any) {
    return this.subscribers.findOne(+id, req.user);
  }

  @Post('subscribers')
  @RequireScope('write')
  createSubscriber(@Body() body: any, @Req() req: any) {
    return this.subscribers.create(body, req.user);
  }

  @Put('subscribers/:id')
  @RequireScope('write')
  updateSubscriber(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.subscribers.update(+id, body, req.user);
  }

  @Delete('subscribers/:id')
  @RequireScope('write')
  async deleteSubscriber(@Param('id') id: string, @Req() req: any) {
    await this.subscribers.remove(+id, req.user);
    return { deleted: true, id: +id };
  }

  /** Live connection state with RADIUS status. */
  @Get('subscribers/:id/status')
  @RequireScope('read')
  async subscriberStatus(@Param('id') id: string, @Req() req: any) {
    const sub = await this.subscribers.findOne(+id, req.user);
    const [enriched] = await this.subscribers.attachLiveStatus([sub]);
    return {
      id: enriched.id,
      username: enriched.username,
      fullName: enriched.fullName,
      billingStatus: enriched.status,
      online: enriched.liveStatus === 'ONLINE',
      ipAddress: enriched.framedIp,
      macAddress: enriched.macAddress,
      lastSeenAt: enriched.lastSeenAt,
      offlineReason: enriched.offlineReason,
      expiryDate: (enriched as any).serviceSettings?.expiryDate ?? null,
    };
  }

  // ── Network Actions (CoA / Throttle) ─────────────────────────
  @Post('subscribers/:id/disconnect')
  @RequireScope('write')
  async disconnect(@Param('id') id: string, @Req() req: any) {
    await this.scope.assertSubscriberVisible(req.user, +id);
    return this.coa.disconnectSubscriber(+id);
  }

  @Post('subscribers/:id/bandwidth')
  @RequireScope('write')
  async changeBandwidth(
    @Param('id') id: string,
    @Body() body: { downloadSpeed: number; uploadSpeed: number },
    @Req() req: any,
  ) {
    await this.scope.assertSubscriberVisible(req.user, +id);
    return this.coa.changeBandwidth(+id, body.downloadSpeed, body.uploadSpeed);
  }

  @Post('subscribers/:id/throttle')
  @RequireScope('write')
  async applyThrottle(
    @Param('id') id: string,
    @Body() body: { downloadSpeed: number; uploadSpeed: number; reason: string; expiresInMinutes?: number },
    @Req() req: any,
  ) {
    await this.scope.assertSubscriberVisible(req.user, +id);
    return this.throttle.applyThrottle(+id, body.downloadSpeed, body.uploadSpeed, body.reason, body.expiresInMinutes);
  }

  @Delete('subscribers/:id/throttle')
  @RequireScope('write')
  async removeThrottle(@Param('id') id: string, @Req() req: any) {
    await this.scope.assertSubscriberVisible(req.user, +id);
    return this.throttle.removeThrottle(+id);
  }

  @Get('throttles')
  @RequireScope('read')
  async listThrottles(@Req() req: any): Promise<ThrottleRule[]> {
    const all = this.throttle.getActiveThrottles();
    const visible = await this.scope.visibleSubscriberIds(req.user);
    if (visible === null) return all;
    const set = new Set(visible);
    return all.filter((r) => set.has(r.subscriberId));
  }

  // ── Invoices ─────────────────────────────────────────────────
  @Get('invoices')
  @RequireScope('read')
  listInvoices(@Req() req: any) {
    return this.invoices.findAll(req.user);
  }

  @Get('invoices/:id')
  @RequireScope('read')
  getInvoice(@Param('id') id: string, @Req() req: any) {
    return this.invoices.findOne(+id, req.user);
  }

  @Get('invoices/subscriber/:subscriberId')
  @RequireScope('read')
  async getInvoicesBySubscriber(@Param('subscriberId') subscriberId: string, @Req() req: any) {
    await this.scope.assertSubscriberVisible(req.user, +subscriberId);
    return this.invoices.findBySubscriber(+subscriberId, req.user);
  }

  @Post('invoices')
  @RequireScope('write')
  async createInvoice(@Body() body: any, @Req() req: any) {
    await this.scope.assertViaSubscriber(req.user, body?.subscriberId, 'Subscriber');
    return this.invoices.create(body, req.user);
  }

  @Get('invoices/stats')
  @RequireScope('read')
  invoiceStats(@Req() req: any) {
    return this.invoices.getStats(req.user);
  }

  @Get('invoices/:id/pdf')
  @RequireScope('read')
  async invoicePdf(@Param('id') id: string, @Req() req: any) {
    await this.assertInvoice(+id, req);
    return this.invoices.getInvoicePdf(+id, req.user);
  }

  @Post('invoices/:id/payment')
  @RequireScope('write')
  async recordPayment(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    await this.assertInvoice(+id, req);
    return this.invoices.recordPayment(+id, body, req.user);
  }

  // ── Payments / Gateway ───────────────────────────────────────
  @Get('gateways')
  @RequireScope('read')
  availableGateways() {
    return this.gateway.availableGateways();
  }

  @Post('gateways/initiate/:invoiceId/:gateway')
  @RequireScope('write')
  async initiatePayment(
    @Param('invoiceId') invoiceId: string,
    @Param('gateway') gateway: string,
    @Req() req: any,
  ) {
    await this.assertInvoice(+invoiceId, req);
    return this.gateway.initiate(+invoiceId, gateway);
  }

  @Get('gateways/transactions')
  @RequireScope('read')
  async gatewayTransactions(@Query() query: any, @Req() req: any) {
    await this.assertKeyOwnerIsPlatform(req);
    return this.gateway.getTransactions(query);
  }

  @Get('gateways/reconcile')
  @RequireScope('write')
  async reconcile(@Req() req: any) {
    await this.assertKeyOwnerIsPlatform(req);
    return this.gateway.reconcile();
  }

  // ── Packages ─────────────────────────────────────────────────
  @Get('packages')
  @RequireScope('read')
  packages(@Req() req: any): Promise<any> {
    // Scoped to the API key owner's visibility (same as admin panel)
    return this.pkgService.findAll({ isActive: true }, req.user);
  }

  // ── Fiber / OLT ──────────────────────────────────────────────
  @Get('fiber/summary')
  @RequireScope('read')
  fiberSummary(@Req() req: any) {
    return this.fiber.getFiberSummary(req.user);
  }

  @Get('fiber/olts')
  @RequireScope('read')
  listOlts(@Req() req: any) {
    return this.fiber.listOlts(req.user);
  }

  @Get('fiber/olts/:id')
  @RequireScope('read')
  getOlt(@Param('id') id: string, @Req() req: any) {
    return this.fiber.getOlt(+id, req.user);
  }

  @Get('fiber/onus')
  @RequireScope('read')
  listOnus(@Query() query: any, @Req() req: any) {
    return this.fiber.listOnus({
      ...(query.oltId ? { oltId: +query.oltId } : {}),
      ...(query.unassigned ? { unassigned: true } : {}),
      page: query.page ? +query.page : undefined,
      limit: query.limit ? +query.limit : undefined,
    }, req.user);
  }

  @Get('fiber/subscribers/:subscriberId')
  @RequireScope('read')
  async getSubscriberFiber(@Param('subscriberId') subscriberId: string, @Req() req: any) {
    await this.scope.assertSubscriberVisible(req.user, +subscriberId);
    return this.fiber.getSubscriberFiber(+subscriberId);
  }

  // ── NSLookup (NAS, Areas, Users) ─────────────────────────────
  @Get('nas')
  @RequireScope('read')
  async nas(@Req() req: any) {
    return this.prisma.nas.findMany({
      where: await this.scope.nasWhere(req.user),
      select: { id: true, nasname: true, nasIp: true, type: true, isActive: true },
      orderBy: { nasname: 'asc' },
    });
  }

  @Get('areas')
  @RequireScope('read')
  async areas(@Req() req: any) {
    return this.prisma.area.findMany({
      where: await this.scope.ownedWhere(req.user),
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  // ── Analytics ────────────────────────────────────────────────
  @Get('analytics/overview')
  @RequireScope('read')
  overview(@Query('days') days: string, @Req() req: any) {
    return this.analytics.overview(req.user, days ? +days : 30);
  }

  // ── Subscriber Lookup ────────────────────────────────────────
  /** Look up a subscriber by phone number. */
  @Get('lookup/phone/:phone')
  @RequireScope('read')
  async lookupByPhone(@Param('phone') phone: string, @Req() req: any) {
    const sub = await this.prisma.subscriber.findFirst({
      where: { AND: [{ phone }, await this.scope.subscriberWhere(req.user)] },
      include: { package: true, serviceSettings: true },
    });
    if (!sub) return { found: false };
    return {
      found: true,
      id: sub.id,
      fullName: sub.fullName,
      username: sub.username,
      phone: sub.phone,
      status: sub.status,
      balance: sub.balance,
      package: sub.package?.name || null,
      expiryDate: sub.serviceSettings?.expiryDate || null,
    };
  }

  /** Look up a subscriber by username. */
  @Get('lookup/username/:username')
  @RequireScope('read')
  async lookupByUsername(@Param('username') username: string, @Req() req: any) {
    const sub = await this.prisma.subscriber.findFirst({
      where: { AND: [{ username }, await this.scope.subscriberWhere(req.user)] },
      include: { package: true, serviceSettings: true },
    });
    if (!sub) return { found: false };
    return {
      found: true,
      id: sub.id,
      fullName: sub.fullName,
      username: sub.username,
      phone: sub.phone,
      status: sub.status,
      balance: sub.balance,
      package: sub.package?.name || null,
      expiryDate: sub.serviceSettings?.expiryDate || null,
    };
  }

  // ── Manual billing trigger ───────────────────────────────────
  @Post('billing/run/:type')
  @RequireScope('write')
  triggerBilling(@Param('type') type: string, @Query('dryRun') dryRun?: string) {
    const validTypes = ['auto-invoice', 'auto-renewal', 'suspension'];
    if (!validTypes.includes(type)) {
      return { error: `type must be one of: ${validTypes.join(', ')}` };
    }
    return {
      message: `Billing run '${type}' triggered via admin panel. Use the /billing/run/:type endpoint with JWT auth for full control.`,
      type,
      dryRun: dryRun === 'true',
      note: 'Execute this from the admin API at POST /billing/run/:type',
    };
  }
}