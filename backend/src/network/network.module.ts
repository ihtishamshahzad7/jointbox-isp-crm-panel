import { Module } from '@nestjs/common';
import { NetworkService } from './network.service';
import { NetworkController } from './network.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { NasModule } from '../nas/nas.module';
import { CoaService } from './coa.service';
import { ThrottleService } from './throttle.service';

@Module({
  imports: [PrismaModule, NasModule],
  controllers: [NetworkController],
  providers: [NetworkService, CoaService, ThrottleService],
  // Exported so BillingService can kick live sessions on suspension.
  exports: [NetworkService, CoaService, ThrottleService],
})
export class NetworkModule {}
