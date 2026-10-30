import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';
import { L2tpConfigInput, VpnService, VpnType } from './vpn.service';

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

  @Post('l2tp/preview')
  validateL2tp(@Body() body: L2tpConfigInput, @Req() req: any) {
    this.scope.assertPlatformOwner(req.user);
    return this.vpn.validateL2tpConfig(body);
  }

  /**
   * Per-router client config for a chosen vendor and overlay IP.
   *
   * Allowed for ANY authenticated operator (not platform-owner-only): a company
   * admin needs this to connect their own routers. The output carries no
   * secrets and no tenant data — only the panel's PUBLIC endpoint and WireGuard
   * PUBLIC key (both meant to be handed to routers) plus `<password>` /
   * `<shared-secret>` placeholders the operator fills in themselves. Managing
   * the VPN *server* (overview/setConfig/install) stays platform-owner-only.
   */
  @Get(':type/client')
  client(
    @Param('type') type: string,
    @Query('vendor') vendor: string,
    @Query('name') name: string,
    @Query('ip') ip: string,
    @Req() _req: any,
  ) {
    return {
      vendors: VPN_VENDORS,
      config: this.vpn.clientConfig(type as VpnType, vendor || 'mikrotik', name || 'router', ip || ''),
    };
  }
}

export const VPN_VENDORS = ['mikrotik', 'cisco', 'juniper', 'linux', 'generic'];
