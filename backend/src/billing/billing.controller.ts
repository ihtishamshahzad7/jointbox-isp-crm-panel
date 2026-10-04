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

  // SECURITY: billing runs invoice, renew and suspend customers. The ISP
  // company's own account runs them for ITS customers only; the platform
  // account for the whole installation (the nightly run does the same).
  // Never a reseller, even one with a billing permission key.
  private async companyFor(actor: any): Promise<number | null> {
    if (this.scope.isAdmin(actor?.role)) return null;
    if (!this.scope.isOwner(actor?.role)) {
      throw new ForbiddenException('Billing runs are available to the ISP owner / admin only.');
    }
    const company = await this.scope.companyRootId(this.scope.actorId(actor));
    if (company == null) throw new ForbiddenException('Billing runs are available to the ISP owner / admin only.');
    return company;
  }

  /** Manually trigger a billing job. Add ?dryRun=1 to preview without changing anything. */
  @Post('run/:type')
  async run(@Param('type') type: string, @Req() req: any, @Query('dryRun') dryRun?: string) {
    const company = await this.companyFor(req.user);
    if (!['auto-invoice', 'auto-renewal', 'suspension'].includes(type)) {
      return { error: 'type must be auto-invoice | auto-renewal | suspension' };
    }
    return this.billing.trigger(type as any, dryRun === '1' || dryRun === 'true', company);
  }

  /** Run history with per-run counts + details (🔍). */
  @Get('runs')
  async runs(@Req() req: any) {
    return this.billing.getRuns(await this.companyFor(req.user));
  }
}
