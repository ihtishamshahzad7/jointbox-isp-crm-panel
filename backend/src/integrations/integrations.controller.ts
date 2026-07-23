import {
  Controller, Get, Post, Put, Delete,
  Body, Param, Query, UseGuards, Req,
} from '@nestjs/common';
import { WebhooksService, WEBHOOK_EVENTS } from './webhooks.service';
import { ApiKeysService } from './api-keys.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

/**
 * Management of integration credentials and endpoints.
 * These routes are for logged-in humans — the public API itself is separate.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly apiKeys: ApiKeysService,
  ) {}

  // ── Webhooks ────────────────────────────────────────────────
  /** The list of events an endpoint can subscribe to. */
  @Get('webhooks/events')
  events() {
    return { events: WEBHOOK_EVENTS };
  }

  @Get('webhooks')
  listWebhooks(@Req() req: any) {
    return this.webhooks.list(req.user);
  }

  @Post('webhooks')
  createWebhook(@Body() body: { name: string; url: string; events?: string[] }, @Req() req: any) {
    return this.webhooks.create(body, req.user);
  }

  @Put('webhooks/:id')
  updateWebhook(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.webhooks.update(+id, body, req.user);
  }

  @Delete('webhooks/:id')
  deleteWebhook(@Param('id') id: string, @Req() req: any) {
    return this.webhooks.remove(+id, req.user);
  }

  /** Delivery attempts — how you debug a failing integration. */
  @Get('webhooks/:id/deliveries')
  deliveries(@Param('id') id: string, @Query('limit') limit: string, @Req() req: any) {
    return this.webhooks.deliveries(+id, req.user, limit ? +limit : 50);
  }

  /** Fire a sample payload so an integrator can verify their endpoint. */
  @Post('webhooks/:id/test')
  testWebhook(@Param('id') id: string, @Req() req: any) {
    return this.webhooks.test(+id, req.user);
  }

  // ── API keys ────────────────────────────────────────────────
  @Get('api-keys')
  listKeys(@Req() req: any) {
    return this.apiKeys.list(req.user);
  }

  /** The plaintext key is returned ONCE here and never again. */
  @Post('api-keys')
  createKey(
    @Body() body: { name: string; scopes?: string[]; expiresInDays?: number },
    @Req() req: any,
  ) {
    return this.apiKeys.create(body, req.user);
  }

  @Delete('api-keys/:id')
  revokeKey(@Param('id') id: string, @Req() req: any) {
    return this.apiKeys.revoke(+id, req.user);
  }
}
