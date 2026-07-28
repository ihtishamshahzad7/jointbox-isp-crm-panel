import {
  Controller, Get, Post, Body, Param, UseGuards,
} from '@nestjs/common';
import { ServiceSettingsService } from './service-settings.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('service-settings')
export class ServiceSettingsController {
  constructor(private readonly serviceSettingsService: ServiceSettingsService) {}

  @Get('subscriber/:subscriberId')
  findBySubscriber(@Param('subscriberId') subscriberId: string) {
    return this.serviceSettingsService.findBySubscriber(+subscriberId);
  }

  /** Effective IPv6 (manual override or auto-allocated) for this subscriber. */
  @Get('subscriber/:subscriberId/ipv6')
  resolveIpv6(@Param('subscriberId') subscriberId: string) {
    return this.serviceSettingsService.resolveIpv6(+subscriberId);
  }

  @Post('subscriber/:subscriberId')
  create(@Param('subscriberId') subscriberId: string, @Body() body: any) {
    return this.serviceSettingsService.create(+subscriberId, body);
  }

  @Post('subscriber/:subscriberId/upsert')
  upsert(@Param('subscriberId') subscriberId: string, @Body() body: any) {
    return this.serviceSettingsService.upsert(+subscriberId, body);
  }
}