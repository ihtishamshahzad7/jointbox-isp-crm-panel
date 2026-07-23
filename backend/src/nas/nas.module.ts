import { Module } from '@nestjs/common';
import { NasService } from './nas.service';
import { NasController } from './nas.controller';
import { RadiusSyncService } from './radius-sync.service';
import { MikrotikSyncService } from './mikrotik-sync.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';

@Module({
  // CommonModule provides ScopeService for NAS ownership / assignment scoping.
  imports: [PrismaModule, CommonModule],
  controllers: [NasController],
  providers: [
    NasService, 
    RadiusSyncService, 
    MikrotikSyncService,  // ← Add this
  ],
  // MikrotikSyncService is exported so IpPoolModule can read live pools
  // straight off the router when reconciling.
  exports: [NasService, RadiusSyncService, MikrotikSyncService],
})
export class NasModule {}