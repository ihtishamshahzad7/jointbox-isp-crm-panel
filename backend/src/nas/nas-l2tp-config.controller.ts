import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { NasL2tpConfigService } from './nas-l2tp-config.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('nas')
export class NasL2tpConfigController {
  constructor(private readonly service: NasL2tpConfigService) {}

  @Get(':id/l2tp-config')
  async get(@Param('id') id: string, @Req() req: any) {
    return this.service.getForNas(Number(id), req.user);
  }

  @Put(':id/l2tp-config')
  async saveDraft(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.service.saveDraft(Number(id), body, req.user);
  }

  @Post(':id/l2tp-config/validate')
  async validate(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.service.validateForNas(Number(id), body, req.user);
  }

  @Post(':id/l2tp-config/preview')
  async preview(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.service.previewChanges(Number(id), body, req.user);
  }

  @Post(':id/l2tp-config/approve')
  async approve(@Param('id') id: string, @Req() req: any) {
    return this.service.approveForNas(Number(id), req.user);
  }

  @Post(':id/l2tp-config/apply')
  async apply(@Param('id') id: string, @Req() req: any) {
    return this.service.applyApproved(Number(id), req.user);
  }

  @Post(':id/l2tp-config/rollback')
  async rollback(@Param('id') id: string, @Req() req: any) {
    return this.service.rollback(Number(id), req.user);
  }
}
