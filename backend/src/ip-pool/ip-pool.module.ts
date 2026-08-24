import { Module } from '@nestjs/common';
import { IpPoolController } from './ip-pool.controller';
import { IpPoolService } from './ip-pool.service';
import { PrefixAllocationController } from './prefix-allocation.controller';
import { PrefixAllocationService } from './prefix-allocation.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NasModule } from '../nas/nas.module';
import { CommonModule } from '../common/common.module';

@Module({
  // NasModule provides MikrotikSyncService so pools can be read from the router.
  // CommonModule provides ScopeService for the prefix register's ISP-only guard.
  imports: [PrismaModule, NasModule, CommonModule],
  controllers: [IpPoolController, PrefixAllocationController],
  providers: [IpPoolService, PrefixAllocationService],
  // IpPoolService is exported so PackagesModule can inject it
  // and call checkPoolAvailable() before assigning a pool to a package
  exports: [IpPoolService, PrefixAllocationService],
})
export class IpPoolModule {}