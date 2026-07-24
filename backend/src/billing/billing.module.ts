import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AccountingModule } from '../accounting/accounting.module';
import { NasModule } from '../nas/nas.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NetworkModule } from '../network/network.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ProrationService } from './proration.service';

@Module({
  imports: [PrismaModule, AccountingModule, NasModule, NotificationsModule, NetworkModule, IntegrationsModule],
  controllers: [BillingController],
  providers: [BillingService, ProrationService],
  exports: [ProrationService],
})
export class BillingModule {}
