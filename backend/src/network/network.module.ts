import { Module } from '@nestjs/common';
import { NetworkService } from './network.service';
import { NetworkController } from './network.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { NasModule } from '../nas/nas.module';

@Module({
  imports: [PrismaModule, NasModule],
  controllers: [NetworkController],
  providers: [NetworkService],
  // Exported so BillingService can kick live sessions on suspension.
  exports: [NetworkService],
})
export class NetworkModule {}
