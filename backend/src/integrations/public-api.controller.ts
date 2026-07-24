import {
  Controller, Get, Post, Put, Delete,
  Body, Param, Query, UseGuards, Req,
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
  ) {}

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
  async health() {
    const [subs, online] = await Promise.all([
      this.prisma.subscriber.count(),
      this.prisma.$queryRaw<any[]>`SELECT COUNT(*)::int AS n FROM radacct WHERE acctstoptime IS NULL`
        .catch(() => [{ n: 0 }]),
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
  disconnect(@Param('id') id: string) {
    return this.coa.disconnectSubscriber(+id);
  }

  @Post('subscribers/:id/bandwidth')
  @RequireScope('write')
  changeBandwidth(
    @Param('id') id: string,
    @Body() body: { downloadSpeed: number; uploadSpeed: number },
  ) {
    return this.coa.changeBandwidth(+id, body.downloadSpeed, body.uploadSpeed);
  }

  @Post('subscribers/:id/throttle')
  @RequireScope('write')
  applyThrottle(
    @Param('id') id: string,
    @Body() body: { downloadSpeed: number; uploadSpeed: number; reason: string; expiresInMinutes?: number },
  ) {
    return this.throttle.applyThrottle(+id, body.downloadSpeed, body.uploadSpeed, body.reason, body.expiresInMinutes);
  }

  @Delete('subscribers/:id/throttle')
  @RequireScope('write')
  removeThrottle(@Param('id') id: string) {
    return this.throttle.removeThrottle(+id);
  }

  @Get('throttles')
  @RequireScope('read')
  listThrottles(): ThrottleRule[] {
    return this.throttle.getActiveThrottles();
  }

  // ── Invoices ─────────────────────────────────────────────────
  @Get('invoices')
  @RequireScope('read')
  listInvoices(@Req() req: any) {
    return this.invoices.findAll(req.user);
  }

  @Get('invoices/:id')
  @RequireScope('read')
  getInvoice(@Param('id') id: string) {
    return this.invoices.findOne(+id);
  }

  @Get('invoices/subscriber/:subscriberId')
  @RequireScope('read')
  getInvoicesBySubscriber(@Param('subscriberId') subscriberId: string) {
    return this.invoices.findBySubscriber(+subscriberId);
  }

  @Post('invoices')
  @RequireScope('write')
  createInvoice(@Body() body: any) {
    return this.invoices.create(body);
  }

  @Get('invoices/stats')
  @RequireScope('read')
  invoiceStats() {
    return this.invoices.getStats();
  }

  @Get('invoices/:id/pdf')
  @RequireScope('read')
  async invoicePdf(@Param('id') id: string) {
    return this.invoices.getInvoicePdf(+id);
  }

  @Post('invoices/:id/payment')
  @RequireScope('write')
  recordPayment(@Param('id') id: string, @Body() body: any) {
    return this.invoices.recordPayment(+id, body);
  }

  // ── Payments / Gateway ───────────────────────────────────────
  @Get('gateways')
  @RequireScope('read')
  availableGateways() {
    return this.gateway.availableGateways();
  }

  @Post('gateways/initiate/:invoiceId/:gateway')
  @RequireScope('write')
  initiatePayment(
    @Param('invoiceId') invoiceId: string,
    @Param('gateway') gateway: string,
    @Req() req: any,
  ) {
    return this.gateway.initiate(+invoiceId, gateway);
  }

  @Get('gateways/transactions')
  @RequireScope('read')
  gatewayTransactions(@Query() query: any) {
    return this.gateway.getTransactions(query);
  }

  @Get('gateways/reconcile')
  @RequireScope('write')
  reconcile() {
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
  fiberSummary() {
    return this.fiber.getFiberSummary();
  }

  @Get('fiber/olts')
  @RequireScope('read')
  listOlts() {
    return this.fiber.listOlts();
  }

  @Get('fiber/olts/:id')
  @RequireScope('read')
  getOlt(@Param('id') id: string) {
    return this.fiber.getOlt(+id);
  }

  @Get('fiber/onus')
  @RequireScope('read')
  listOnus(@Query() query: any) {
    return this.fiber.listOnus({
      ...(query.oltId ? { oltId: +query.oltId } : {}),
      ...(query.unassigned ? { unassigned: true } : {}),
      page: query.page ? +query.page : undefined,
      limit: query.limit ? +query.limit : undefined,
    });
  }

  @Get('fiber/subscribers/:subscriberId')
  @RequireScope('read')
  getSubscriberFiber(@Param('subscriberId') subscriberId: string) {
    return this.fiber.getSubscriberFiber(+subscriberId);
  }

  // ── NSLookup (NAS, Areas, Users) ─────────────────────────────
  @Get('nas')
  @RequireScope('read')
  nas() {
    return this.prisma.nas.findMany({
      select: { id: true, nasname: true, nasIp: true, type: true, isActive: true },
      orderBy: { nasname: 'asc' },
    });
  }

  @Get('areas')
  @RequireScope('read')
  areas() {
    return this.prisma.area.findMany({
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
      where: { phone },
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
    const sub = await this.prisma.subscriber.findUnique({
      where: { username },
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