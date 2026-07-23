import { Body, Controller, Get, Ip, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { PortalService } from './portal.service';
import { PortalGuard } from './portal.guard';

@Controller('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Post('login')
  login(@Body() body: { username: string; password: string }, @Ip() ip: string) {
    return this.portal.login(body.username, body.password, ip || '0.0.0.0');
  }

  @UseGuards(PortalGuard)
  @Get('me')
  me(@Request() req: any) {
    return this.portal.me(req.subscriber.id);
  }

  @UseGuards(PortalGuard)
  @Get('usage')
  usage(@Request() req: any) {
    return this.portal.usage(req.subscriber.id);
  }

  @UseGuards(PortalGuard)
  @Get('invoices')
  invoices(@Request() req: any) {
    return this.portal.invoices(req.subscriber.id);
  }

  @UseGuards(PortalGuard)
  @Get('gateways')
  gateways() {
    return this.portal.availableGateways();
  }

  @UseGuards(PortalGuard)
  @Post('invoices/:id/pay/:gateway')
  pay(@Request() req: any, @Param('id') id: string, @Param('gateway') gateway: string) {
    return this.portal.payInvoice(req.subscriber.id, +id, gateway);
  }

  @UseGuards(PortalGuard)
  @Get('tickets')
  tickets(@Request() req: any) {
    return this.portal.tickets(req.subscriber.id);
  }

  @UseGuards(PortalGuard)
  @Post('tickets')
  createTicket(@Request() req: any, @Body() body: any) {
    return this.portal.createTicket(req.subscriber.id, body);
  }

  @UseGuards(PortalGuard)
  @Post('tickets/:id/reply')
  reply(@Request() req: any, @Param('id') id: string, @Body() body: { message: string }) {
    return this.portal.replyTicket(req.subscriber.id, +id, body.message || '');
  }

  // ── Self-service ────────────────────────────────────────────
  /** Change the PPPoE password (also pushed to RADIUS). */
  @UseGuards(PortalGuard)
  @Post('change-password')
  changePassword(
    @Request() req: any,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    return this.portal.changePassword(
      req.subscriber.id,
      body?.currentPassword || '',
      body?.newPassword || '',
    );
  }

  /** Redeem a prepaid scratch-card voucher into the wallet. */
  @UseGuards(PortalGuard)
  @Post('recharge')
  recharge(@Request() req: any, @Body() body: { code: string; pin?: string }) {
    return this.portal.redeemVoucher(req.subscriber.id, body?.code || '', body?.pin || '');
  }

  /** Recent connection history in plain language. */
  @UseGuards(PortalGuard)
  @Get('sessions')
  sessions(@Request() req: any, @Query('limit') limit?: string) {
    return this.portal.sessions(req.subscriber.id, limit ? +limit : 20);
  }
}
