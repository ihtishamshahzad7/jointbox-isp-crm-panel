import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { InsightsService } from './insights.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  /** Global trace search — paste any phone/username/invoice#/name/id. */
  @Get('search')
  search(@Query('q') q: string, @Req() req: any) {
    return this.insights.globalSearch(q || '', req.user);
  }

  /** Unified subscriber timeline. */
  @Get('timeline/:subscriberId')
  timeline(@Param('subscriberId') subscriberId: string, @Req() req: any) {
    return this.insights.timeline(+subscriberId, req.user);
  }
}
