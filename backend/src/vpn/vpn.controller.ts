import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';
import { VpnService, VpnType } from './vpn.service';

/**
 * Panel VPN servers. Platform owner only: a VPN server is standing inbound
 * access to the panel host and serves every company's routers, so only the
 * operator who runs the installation may see or change it.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('vpn')
export class VpnController {
  constructor(
    private readonly vpn: VpnService,
    private readonly scope: ScopeService,
  ) {}

  @Get()
  overview(@Req() req: any) {
    this.scope.assertPlatformOwner(req.user);
    return this.vpn.overview();
  }

  @Put()
  setConfig(@Body() body: Record<string, unknown>, @Req() req: any) {
    this.scope.assertPlatformOwner(req.user);
    return this.vpn.setConfig(body);
  }

  @Get(':type/install')
  install(@Param('type') type: string, @Req() req: any) {
    this.scope.assertPlatformOwner(req.user);
    return this.vpn.install(type as VpnType);
  }
}
