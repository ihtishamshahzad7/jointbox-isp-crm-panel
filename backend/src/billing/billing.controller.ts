import { Controller, Get, Param, Post, Query, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import { BillingService } from './billing.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly scope: ScopeService,
  ) {}

  // SECURITY: billing runs act on EVERY subscriber in the ISP (invoicing,
  // renewals, suspensions). Only the ISP owner / admin may trigger or view them
  // — never a reseller, even one with a billing permission key.
  private assertAdmin(actor: any) {
    if (!this.scope.isAdmin(actor?.role)) {
      throw new ForbiddenException('Billing runs are available to the ISP owner / admin only.');
    }
  }

  /** Manually trigger a billing job. Add ?dryRun=1 to preview without changing anything. */
  @Post('run/:type')
  run(@Param('type') type: string, @Req() req: any, @Query('dryRun') dryRun?: string) {
    this.assertAdmin(req.user);
    if (!['auto-invoice', 'auto-renewal', 'suspension'].includes(type)) {
      return { error: 'type must be auto-invoice | auto-renewal | suspension' };
    }
    return this.billing.trigger(type as any, dryRun === '1' || dryRun === 'true');
  }

  /** Run history with per-run counts + details (🔍). */
  @Get('runs')
  runs(@Req() req: any) {
    this.assertAdmin(req.user);
    return this.billing.getRuns();
  }
}
