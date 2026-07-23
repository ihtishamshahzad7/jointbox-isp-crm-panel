import { Module } from '@nestjs/common';
import { IpPoolController } from './ip-pool.controller';
import { IpPoolService } from './ip-pool.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NasModule } from '../nas/nas.module';

@Module({
  // NasModule provides MikrotikSyncService so pools can be read from the router.
  imports: [PrismaModule, NasModule],
  controllers: [IpPoolController],
  providers: [IpPoolService],
  // IpPoolService is exported so PackagesModule can inject it
  // and call checkPoolAvailable() before assigning a pool to a package
  exports: [IpPoolService],
})
export class IpPoolModule {}