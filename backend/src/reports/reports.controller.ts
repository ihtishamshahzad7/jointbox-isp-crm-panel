import {
  Controller, Get, Query, Req, UseGuards,
} from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportAnalyticsService } from './report-analytics.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly analytics: ReportAnalyticsService,
  ) {}

  // ── Comparative analytics ───────────────────────────────────
  // Every series carries the preceding window of equal length, so the charts
  // can show change rather than just a shape.

  /** Revenue, growth, package mix and collections in one round trip. */
  @Get('analytics')
  overview(
    @Query('grain') grain: any,
    @Query('points') points: string,
    @Req() req: any,
  ) {
    return this.analytics.overview(req.user, grain || 'day', points ? +points : 30);
  }

  @Get('analytics/revenue')
  revenue(@Query('grain') grain: any, @Query('points') points: string, @Req() req: any) {
    return this.analytics.revenueTrend(req.user, grain || 'day', points ? +points : 30);
  }

  @Get('analytics/growth')
  growth(@Query('grain') grain: any, @Query('points') points: string, @Req() req: any) {
    return this.analytics.growthTrend(req.user, grain || 'month', points ? +points : 12);
  }

  @Get('analytics/packages')
  packages(@Req() req: any) {
    return this.analytics.packageMix(req.user);
  }

  @Get('analytics/collections')
  collections(@Req() req: any) {
    return this.analytics.collections(req.user);
  }

  @Get('dashboard')
  getDashboardStats(@Req() req: any) {
    return this.reportsService.getDashboardStats(req.user);
  }

  @Get('revenue')
  getRevenueReport(
    @Req() req: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reportsService.getRevenueReport(startDate, endDate, req.user);
  }

  @Get('subscribers')
  getSubscriberReport(@Req() req: any) {
    return this.reportsService.getSubscriberReport(req.user);
  }

  @Get('tickets')
  getTicketReport(@Req() req: any) {
    return this.reportsService.getTicketReport(req.user);
  }
}