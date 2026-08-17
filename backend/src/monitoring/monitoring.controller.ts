import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('monitoring')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get('targets')
  list(@Req() req: any) {
    return this.monitoring.list(req.user);
  }

  @Post('targets')
  create(@Body() body: any, @Req() req: any) {
    return this.monitoring.create(body, req.user);
  }

  @Put('targets/:id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.monitoring.update(+id, body, req.user);
  }

  @Delete('targets/:id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.monitoring.remove(+id, req.user);
  }

  @Post('targets/:id/check')
  check(@Param('id') id: string, @Req() req: any) {
    return this.monitoring.checkTarget(+id, req.user);
  }

  @Post('groups/rename')
  renameGroup(@Body() body: { from: string; to: string }, @Req() req: any) {
    return this.monitoring.renameGroup(body.from, body.to, req.user);
  }
}
