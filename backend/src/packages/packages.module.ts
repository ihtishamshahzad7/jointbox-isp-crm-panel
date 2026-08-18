import { Module } from '@nestjs/common';
import { PackagesController } from './packages.controller';
import { PackagesService } from './packages.service';
import { PrismaModule } from '../prisma/prisma.module';
import { IpPoolModule } from '../ip-pool/ip-pool.module';
// IpPoolModule exports IpPoolService, which PackagesService uses
// to call checkPoolAvailable() — enforcing one-pool-per-package

import { CommonModule } from '../common/common.module';
// RadiusSyncService (radreply preview/connectivity) + NetworkService
// (optional session kicks on the "apply to existing subscribers" flow).
import { NasModule } from '../nas/nas.module';
import { NetworkModule } from '../network/network.module';

@Module({
  // CommonModule provides ScopeService for package assignment scoping.
  imports: [PrismaModule, IpPoolModule, CommonModule, NasModule, NetworkModule],
  controllers: [PackagesController],
  providers: [PackagesService],
  exports: [PackagesService],
})
export class PackagesModule {}