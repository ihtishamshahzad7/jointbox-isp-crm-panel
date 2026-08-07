import {
  Controller, Get, Post, Body, Param, Req, UseGuards,
} from '@nestjs/common';
import { ServiceSettingsService } from './service-settings.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('service-settings')
export class ServiceSettingsController {
  constructor(
    private readonly serviceSettingsService: ServiceSettingsService,
    private readonly scope: ScopeService,
  ) {}

  // SECURITY: a subscriber's service settings (speed, IP, quota…) must only be
  // read or written by an account that owns that subscriber. Without this a
  // reseller could read/modify any customer in the ISP by guessing the id.
  private assertOwns(actor: any, subscriberId: number) {
    return this.scope.assertSubscriber(actor, subscriberId);
  }

  @Get('subscriber/:subscriberId')
  async findBySubscriber(@Param('subscriberId') subscriberId: string, @Req() req: any) {
    await this.assertOwns(req.user, +subscriberId);
    return this.serviceSettingsService.findBySubscriber(+subscriberId);
  }

  /** Effective IPv6 (manual override or auto-allocated) for this subscriber. */
  @Get('subscriber/:subscriberId/ipv6')
  async resolveIpv6(@Param('subscriberId') subscriberId: string, @Req() req: any) {
    await this.assertOwns(req.user, +subscriberId);
    return this.serviceSettingsService.resolveIpv6(+subscriberId);
  }

  @Post('subscriber/:subscriberId')
  async create(@Param('subscriberId') subscriberId: string, @Body() body: any, @Req() req: any) {
    await this.assertOwns(req.user, +subscriberId);
    return this.serviceSettingsService.create(+subscriberId, body);
  }

  @Post('subscriber/:subscriberId/upsert')
  async upsert(@Param('subscriberId') subscriberId: string, @Body() body: any, @Req() req: any) {
    await this.assertOwns(req.user, +subscriberId);
    return this.serviceSettingsService.upsert(+subscriberId, body);
  }
}