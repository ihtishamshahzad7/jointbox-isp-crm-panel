import { Module } from '@nestjs/common';
import { NasService } from './nas.service';
import { NasController } from './nas.controller';
import { RadiusSyncService } from './radius-sync.service';
import { MikrotikSyncService } from './mikrotik-sync.service';
import { TunnelService } from './tunnel.service';
import { TunnelController } from './tunnel.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';

@Module({
  // CommonModule provides ScopeService for NAS ownership / assignment scoping.
  imports: [PrismaModule, CommonModule],
  // ORDER MATTERS. Both controllers are mounted on 'nas', and NasController
  // ends with a catch-all `@Get(':id')`. Nest matches in registration order,
  // so with NasController first a request for /nas/tunnels would be handled as
  // findOne(NaN) — a 404 that reads like a missing feature rather than a
  // routing mistake. TunnelController's literal paths go ahead of it, for the
  // same reason NasController's own comment puts 'stats' before ':id'.
  controllers: [TunnelController, NasController],
  providers: [
    NasService, 
    RadiusSyncService, 
    MikrotikSyncService,
    // WireGuard management tunnels — how the panel reaches a router behind CGNAT.
    TunnelService,
  ],
  // MikrotikSyncService is exported so IpPoolModule can read live pools
  // straight off the router when reconciling.
  exports: [NasService, RadiusSyncService, MikrotikSyncService, TunnelService],
})
export class NasModule {}