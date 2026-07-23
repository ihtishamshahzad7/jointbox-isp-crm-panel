import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { BillingService } from './billing.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Manually trigger a billing job. Add ?dryRun=1 to preview without changing anything. */
  @Post('run/:type')
  run(@Param('type') type: string, @Query('dryRun') dryRun?: string) {
    if (!['auto-invoice', 'auto-renewal', 'suspension'].includes(type)) {
      return { error: 'type must be auto-invoice | auto-renewal | suspension' };
    }
    return this.billing.trigger(type as any, dryRun === '1' || dryRun === 'true');
  }

  /** Run history with per-run counts + details (🔍). */
  @Get('runs')
  runs() {
    return this.billing.getRuns();
  }
}
