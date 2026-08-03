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
      createdById: req?.user?.id ?? null,
    });
  }

  @Get('active')
  active(@Query('subscriberId') s?: string) {
    return this.svc.active(s ? Number(s) : undefined);
  }

  @Post(':id/revert')
  revert(@Param('id', ParseIntPipe) id: number) {
    return this.svc.revert(id);
  }
}
