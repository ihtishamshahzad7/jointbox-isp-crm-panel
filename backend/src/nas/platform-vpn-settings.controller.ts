import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { PlatformVpnSettingsService } from './platform-vpn-settings.service';

/** Settings → NAS management VPN. Platform account only (checked in the service). */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('platform')
export class PlatformVpnSettingsController {
  constructor(private readonly service: PlatformVpnSettingsService) {}

  @Get('vpn-settings')
  get(@Req() req: any) {
    return this.service.get(req.user);
  }

  @Put('vpn-settings')
  update(@Body() body: any, @Req() req: any) {
    return this.service.update(req.user, body);
  }
}
