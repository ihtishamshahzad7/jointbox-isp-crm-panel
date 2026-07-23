import { Body, Controller, Delete, Get, Param, Post, Put, Query, Request, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('communication')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('status')
  status() {
    return this.notifications.gatewayStatus();
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
