import { Module } from '@nestjs/common';
import { KycService } from './kyc.service';
import { FupService } from './fup.service';
import { ComplianceController } from './compliance.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { NasModule } from '../nas/nas.module';
import { NetworkModule } from '../network/network.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // NasModule → RadiusSyncService (rewrite the rate limit)
  // NetworkModule → CoA disconnect so a new speed applies immediately
  imports: [PrismaModule, NasModule, NetworkModule, NotificationsModule],
  controllers: [ComplianceController],
  providers: [KycService, FupService],
  exports: [KycService, FupService],
})
export class ComplianceModule {}
