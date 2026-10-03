import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { BoostService } from './boost.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('boost')
export class BoostController {
  constructor(private readonly svc: BoostService) {}

  @Post('apply')
  apply(@Body() b: any, @Req() req: any) {
    return this.svc.apply({
      subscriberId: Number(b?.subscriberId),
      downMbps: Number(b?.downMbps),
      upMbps: Number(b?.upMbps),
      durationHours: b?.durationHours != null ? Number(b.durationHours) : 0,
      reason: b?.reason,
      charge: b?.charge != null ? Number(b.charge) : 0,
      // The JWT carries the user id as `sub`; `id` is never set, so every
      // boost was recorded with no creator.
      createdById: req?.user?.sub ?? req?.user?.id ?? null,
    }, req.user);
  }

  @Get('active')
  active(@Query('subscriberId') s: string | undefined, @Req() req: any) {
    return this.svc.active(s ? Number(s) : undefined, req.user);
  }

  @Post(':id/revert')
  revert(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.svc.revert(id, req.user);
  }
}
