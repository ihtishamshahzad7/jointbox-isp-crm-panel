import { Module } from '@nestjs/common';
import { NasService } from './nas.service';
import { NasController } from './nas.controller';
import { RadiusSyncService } from './radius-sync.service';
import { MikrotikSyncService } from './mikrotik-sync.service';
import { TunnelService } from './tunnel.service';
import { TunnelController } from './tunnel.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { RadiusClientVaultService } from './radius-client-vault.service';
import { NasL2tpConfigController } from './nas-l2tp-config.controller';
import { NasL2tpConfigService } from './nas-l2tp-config.service';
import { NasL2tpClientController } from './nas-l2tp-client.controller';
import { NasL2tpClientService } from './nas-l2tp-client.service';
import { L2tpClientDialer } from './l2tp-client-dialer.service';
import { PlatformVpnSettingsService } from './platform-vpn-settings.service';
import { PlatformVpnSettingsController } from './platform-vpn-settings.controller';
import { VpnModule } from '../vpn/vpn.module';

@Module({
  // CommonModule provides ScopeService for NAS ownership / assignment scoping.
  imports: [PrismaModule, CommonModule, VpnModule],
  // ORDER MATTERS. Both controllers are mounted on 'nas', and NasController
  // ends with a catch-all `@Get(':id')`. Nest matches in registration order,
  // so with NasController first a request for /nas/tunnels would be handled as
  // findOne(NaN) — a 404 that reads like a missing feature rather than a
  // routing mistake. TunnelController's literal paths go ahead of it, for the
  // same reason NasController's own comment puts 'stats' before ':id'.
  controllers: [TunnelController, NasController, NasL2tpConfigController, NasL2tpClientController, PlatformVpnSettingsController],
  providers: [
    NasService,
    NasL2tpConfigService,
    // NAS management VPN: Uplinko host = L2TP/IPsec client (strongSwan + xl2tpd + pppd).
    NasL2tpClientService,
    L2tpClientDialer,
    // Web settings for the management VPN (Settings → NAS management VPN).
    PlatformVpnSettingsService,
    RadiusSyncService,
    RadiusClientVaultService,
    MikrotikSyncService,
    // WireGuard management tunnels — how the panel reaches a router behind CGNAT.
    TunnelService,
  ],
  // MikrotikSyncService is exported so IpPoolModule can read live pools
  // straight off the router when reconciling.
  exports: [NasService, RadiusSyncService, RadiusClientVaultService, MikrotikSyncService, TunnelService],
})
export class NasModule {}