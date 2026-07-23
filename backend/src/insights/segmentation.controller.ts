import { Controller, Get, Param, Query, UseGuards, Req } from '@nestjs/common';
import { SegmentationService } from './segmentation.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('segments')
export class SegmentationController {
  constructor(private readonly segments: SegmentationService) {}

  /**
   * Every dimension at once — router, VLAN, area, reseller, package and auth
   * method — each with counts, live online share and a health flag.
   */
  @Get()
  overview(@Req() req: any) {
    return this.segments.overview(req.user);
  }

  /**
   * Everything the analytics command centre needs, in one call — status split,
   * every dimension with its own status breakdown, hierarchy counts, tickets
   * and billing. Declared before ':dimension/:key' so that route can't claim it.
   */
  @Get('command')
  command(@Req() req: any) {
    return this.segments.command(req.user);
  }

  /** The customers behind one slice, with live status and last disconnect. */
  @Get(':dimension/:key')
  drilldown(
    @Param('dimension') dimension: string,
    @Param('key') key: string,
    @Req() req: any,
  ) {
    return this.segments.drilldown(dimension, key, req.user);
  }
}
