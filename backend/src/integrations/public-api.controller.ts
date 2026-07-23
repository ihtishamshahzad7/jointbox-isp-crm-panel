import { Controller, Get, Post, Body, Param, Query, UseGuards, Req } from '@nestjs/common';
import { ApiKeyGuard, RequireScope } from './api-key.guard';
import { SubscribersService } from '../subscribers/subscribers.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Public API — authenticated with an API key, not a user session.
 *
 * Versioned under /api/v1 from day one: integrators build against a contract,
 * and breaking it silently is how you break other people's software. New
 * behaviour goes in /v2 rather than changing these responses.
 *
 * The key's owner becomes the acting user, so all existing subtree scoping
 * applies unchanged — a reseller's key can only ever see that reseller's data.
 */
@UseGuards(ApiKeyGuard)
@Controller('api/v1')
export class PublicApiController {
  constructor(
    private readonly subscribers: SubscribersService,
    private readonly analytics: AnalyticsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Confirms the key works and shows what it can do. */
  @Get('ping')
  ping(@Req() req: any) {
    return {
      ok: true,
      keyName: req.apiKey?.name,
      scopes: (req.apiKey?.scopes || '').split(','),
      serverTime: new Date().toISOString(),
    };
  }

  // ── Subscribers ─────────────────────────────────────────────
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

  /** Live connection state — the most common integration need. */
  @Get('subscribers/:id/status')
  @RequireScope('read')
  async subscriberStatus(@Param('id') id: string, @Req() req: any) {
    const [sub] = await this.subscribers.attachLiveStatus([
      await this.subscribers.findOne(+id, req.user),
    ]);
    return {
      id: sub.id,
      username: sub.username,
      fullName: sub.fullName,
      billingStatus: sub.status,
      online: sub.liveStatus === 'ONLINE',
      ipAddress: sub.framedIp,
      macAddress: sub.macAddress,
      lastSeenAt: sub.lastSeenAt,
      offlineReason: sub.offlineReason,
      expiryDate: sub.serviceSettings?.expiryDate ?? null,
    };
  }

  // ── Packages & analytics ────────────────────────────────────
  @Get('packages')
  @RequireScope('read')
  packages(@Req() req: any) {
    return this.prisma.package.findMany({
      where: { isActive: true },
      select: {
        id: true, name: true, price: true, duration: true,
        downloadSpeed: true, uploadSpeed: true,
      },
      orderBy: { price: 'asc' },
    });
  }

  @Get('analytics/overview')
  @RequireScope('read')
  overview(@Query('days') days: string, @Req() req: any) {
    return this.analytics.overview(req.user, days ? +days : 30);
  }

  /** Machine-readable health — for an external uptime monitor. */
  @Get('health')
  async health() {
    const [subs, online] = await Promise.all([
      this.prisma.subscriber.count(),
      this.prisma.$queryRawUnsafe<any[]>(
        `SELECT COUNT(*)::int AS n FROM radacct WHERE acctstoptime IS NULL`,
      ).catch(() => [{ n: 0 }]),
    ]);
    return {
      status: 'ok',
      subscribers: subs,
      onlineSessions: Number(online?.[0]?.n ?? 0),
      timestamp: new Date().toISOString(),
    };
  }
}
