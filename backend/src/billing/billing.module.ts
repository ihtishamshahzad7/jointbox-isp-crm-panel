import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AccountingModule } from '../accounting/accounting.module';
import { NasModule } from '../nas/nas.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NetworkModule } from '../network/network.module';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
  // NetworkModule provides CoA disconnect so suspension takes effect instantly.
  // IntegrationsModule provides outbound webhooks.
  imports: [PrismaModule, AccountingModule, NasModule, NotificationsModule, NetworkModule, IntegrationsModule],
  controllers: [BillingController],
  providers: [BillingService],
})
export class BillingModule {}
