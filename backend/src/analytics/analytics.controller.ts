import { Controller, Get, Query, UseGuards, Req } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** Headline KPIs: ARPU, churn, LTV, growth, revenue vs previous period. */
  @Get('overview')
  overview(@Query('days') days: string, @Req() req: any) {
    return this.analytics.overview(req.user, days ? +days : 30);
  }

  /** 12 months of revenue, signups, losses and net growth. */
  @Get('trend')
  trend(@Query('months') months: string, @Req() req: any) {
    return this.analytics.monthlyTrend(req.user, months ? +months : 12);
  }

  /** Reseller league table, ranked on revenue and active customers. */
  @Get('leaderboard')
  leaderboard(@Query('days') days: string, @Req() req: any) {
    return this.analytics.resellerLeaderboard(req.user, days ? +days : 30);
  }

  /** Full org tree — every account with direct and rolled-up metrics. */
  @Get('hierarchy')
  hierarchy(@Query('days') days: string, @Req() req: any) {
    return this.analytics.hierarchy(req.user, days ? +days : 30);
  }

  /** Subscribers and MRR per package. */
  @Get('packages')
  packages(@Req() req: any) {
    return this.analytics.byPackage(req.user);
  }

  /** Area performance — where you grow and where you leak. */
  @Get('areas')
  areas(@Req() req: any) {
    return this.analytics.byArea(req.user);
  }

  /** Customers expiring soon — the call list. */
  @Get('at-risk')
  atRisk(@Query('days') days: string, @Req() req: any) {
    return this.analytics.atRisk(req.user, days ? +days : 7);
  }
}
