import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, Request, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { AlertsService } from './alerts.service';
import { NotificationFeedService } from './notification-feed.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('communication')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly alerts: AlertsService,
    private readonly feed: NotificationFeedService,
  ) {}

  /**
   * The header bell. Scoped to the caller's own subtree by the service — a
   * dealer must never learn that another dealer signed up a customer.
   */
  @Get('feed')
  notificationFeed(@Request() req: any, @Query('since') since?: string) {
    return this.feed.feed(req.user, since);
  }

  @Get('status')
  async status() {
    return { ...this.notifications.gatewayStatus(), alerts: await this.alerts.status() };
  }

  /** Which alert channels are configured (Discord / WhatsApp), masked. */
  @Get('alerts/status')
  alertStatus() {
    return this.alerts.status();
  }

  /**
   * Save an alert credential from the panel. ISP owner/admin only — a webhook
   * URL is a credential. Stored AES-256-GCM encrypted; never returned in full.
   */
  @Post('alerts/config')
  async setAlertConfig(@Body() body: { key: string; value: string }, @Request() req: any) {
    const role = req?.user?.role;
    if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') {
      throw new ForbiddenException('Only the ISP owner can change alert settings.');
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

  /** Send a test alert so you can confirm the webhook works. */
  @Post('alerts/test')
  async alertTest() {
    const r = await this.alerts.send({
      title: '✅ Jointbox test alert',
      message: 'If you can read this, your alert channel is configured correctly.',
      level: 'OK',
      fields: { Source: 'Manual test', Time: new Date().toLocaleString() },
    });
    return { sent: r, configured: await this.alerts.status() };
  }

  // ── Templates ─────────────────────────────────────────────────
  @Get('templates')
  templates() {
    return this.notifications.getTemplates();
  }

  @Post('templates')
  createTemplate(@Body() body: any) {
    return this.notifications.createTemplate(body);
  }

  @Put('templates/:id')
  updateTemplate(@Param('id') id: string, @Body() body: any) {
    return this.notifications.updateTemplate(+id, body);
  }

  @Delete('templates/:id')
  deleteTemplate(@Param('id') id: string) {
    return this.notifications.deleteTemplate(+id);
  }

  // ── Sending ───────────────────────────────────────────────────
  @Post('send')
  bulkSend(@Body() body: any, @Request() req: any) {
    return this.notifications.bulkSend({ ...body, createdBy: req.user?.sub });
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
  @Get('messages')
  messages(@Query() query: any) {
    return this.notifications.getMessages(query);
  }

  @Post('messages/:id/retry')
  retry(@Param('id') id: string) {
    return this.notifications.retryMessage(+id);
  }
}
