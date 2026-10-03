import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, Request, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { AlertsService } from './alerts.service';
import { NotificationFeedService } from './notification-feed.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('communication')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly alerts: AlertsService,
    private readonly feed: NotificationFeedService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * The header bell. Scoped to the caller's own subtree by the service — a
   * dealer must never learn that another dealer signed up a customer.
   */
  @Get('feed')
  notificationFeed(@Request() req: any, @Query('since') since?: string) {
    return this.feed.feed(req.user, since);
  }

  /**
   * SMS/email gateway state ("configured" / "simulated") is harmless and the
   * Communication page header shows it to every account. The `alerts` block is
   * the installation's own alert credentials (masked hints of the webhook URL,
   * phone and keys) — one set for every company — so only the platform owner
   * gets it. Tenants get the gateway part alone; the page reads `alerts` with
   * optional chaining.
   */
  @Get('status')
  async status(@Request() req: any) {
    const gateway = this.notifications.gatewayStatus();
    if (!this.scope.isPlatformOwner(req.user)) return gateway;
    return { ...gateway, alerts: await this.alerts.status() };
  }

  /**
   * Which alert channels are configured (Discord / WhatsApp), masked.
   * PLATFORM OWNER ONLY — these are the installation's shared alert
   * credentials, same as POST alerts/config below.
   */
  @Get('alerts/status')
  alertStatus(@Request() req: any) {
    this.scope.assertPlatformOwner(req.user);
    return this.alerts.status();
  }

  /**
   * Save an alert credential from the panel. ISP owner/admin only — a webhook
   * URL is a credential. Stored AES-256-GCM encrypted; never returned in full.
   */
  @Post('alerts/config')
  async setAlertConfig(@Body() body: { key: string; value: string }, @Request() req: any) {
    // PLATFORM OWNER ONLY. These are the installation's outbound alert
    // credentials — one Telegram bot token, one webhook, shared by every
    // company on the panel. A tenant editing them does not reconfigure its own
    // alerting, it redirects or silences everyone's, including ours. There is
    // no per-tenant copy of this setting to offer instead yet.
    const role = req?.user?.role;
    if (role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Alert settings are managed by the platform owner.');
    }
    await this.alerts.setSecret(body?.key, body?.value ?? '', req?.user?.sub);
    return this.alerts.status();
  }

  // ── Per-account alert channels (any user, their own only) ──────
  /** My own alert channels (masked). */
  @Get('alerts/my-channels')
  myChannels(@Request() req: any) {
    return this.alerts.userChannels(req?.user?.sub);
  }

  /** Save/clear MY own Discord or WhatsApp alert destination. */
  @Post('alerts/my-channels')
  async setMyChannel(
    @Body() body: { kind: 'DISCORD' | 'WHATSAPP'; value: string; provider?: string; extra?: string },
    @Request() req: any,
  ) {
    const kind = body?.kind === 'WHATSAPP' ? 'WHATSAPP' : 'DISCORD';
    // A user may only ever write their OWN channel — the id comes from the JWT.
    await this.alerts.setUserChannel(req?.user?.sub, kind, body?.value ?? '', {
      provider: body?.provider, extra: body?.extra,
    });
    return this.alerts.userChannels(req?.user?.sub);
  }

  /** Test MY own channel. */
  @Post('alerts/my-channels/test')
  async testMyChannel(@Request() req: any) {
    const sent = await this.alerts.sendToUser(req?.user?.sub, {
      title: '✅ Jointbox test alert',
      message: 'Your personal alert channel is configured correctly.',
      level: 'OK',
      fields: { Account: req?.user?.name || req?.user?.email || '—', Time: new Date().toLocaleString() },
    });
    return { sent };
  }

  /**
   * Send a test alert so you can confirm the webhook works. PLATFORM OWNER
   * ONLY: it fires the installation's single shared channel, not the caller's
   * own (that is alerts/my-channels/test).
   */
  @Post('alerts/test')
  async alertTest(@Request() req: any) {
    this.scope.assertPlatformOwner(req.user);
    const r = await this.alerts.send({
      title: '✅ Jointbox test alert',
      message: 'If you can read this, your alert channel is configured correctly.',
      level: 'OK',
      fields: { Source: 'Manual test', Time: new Date().toLocaleString() },
    });
    return { sent: r, configured: await this.alerts.status() };
  }

  // ── Templates ─────────────────────────────────────────────────
  // Templates: platform defaults (edited by the platform owner) plus each
  // company's own (edited by that company's administrator). A company's own
  // template for an event replaces the default for its customers — see
  // NotificationsService.templatesFor().
  @Get('templates')
  templates(@Request() req: any) {
    return this.notifications.getTemplates(req.user);
  }

  @Post('templates')
  createTemplate(@Body() body: any, @Request() req: any) {
    return this.notifications.createTemplate(body, req.user);
  }

  @Put('templates/:id')
  updateTemplate(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.notifications.updateTemplate(+id, body, req.user);
  }

  @Delete('templates/:id')
  deleteTemplate(@Param('id') id: string, @Request() req: any) {
    return this.notifications.deleteTemplate(+id, req.user);
  }

  // ── Sending ───────────────────────────────────────────────────
  @Post('send')
  bulkSend(@Body() body: any, @Request() req: any) {
    // The actor decides the AUDIENCE: a company's bulk SMS reaches its own
    // customers only. Before this, "send to all" texted every company's
    // customers on the installation.
    return this.notifications.bulkSend({ ...body, createdBy: req.user?.sub, actor: req.user });
  }

  @Post('test')
  test(@Body() body: { channel: 'SMS' | 'EMAIL'; recipient: string; message: string }, @Request() req: any) {
    return this.notifications.send({
      channel: body.channel,
      recipient: body.recipient,
      body: body.message,
      event: 'TEST',
      createdBy: req.user?.sub,
    });
  }
  @Get('latest')
  latest(@Request() req: any) {
    return this.notifications.getLatestNotice(req.user);
  }
  // ── Log ───────────────────────────────────────────────────────
  /** Scoped by the service to the caller's subscribers (and its own test sends). */
  @Get('messages')
  messages(@Query() query: any, @Request() req: any) {
    return this.notifications.getMessages(query, req.user);
  }

  @Post('messages/:id/retry')
  retry(@Param('id') id: string, @Request() req: any) {
    return this.notifications.retryMessage(+id, req.user);
  }
}
