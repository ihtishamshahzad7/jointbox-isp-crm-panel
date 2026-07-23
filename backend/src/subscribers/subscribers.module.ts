import { Module } from '@nestjs/common';
import { SubscribersController } from './subscribers.controller';
import { SubscribersService } from './subscribers.service';
import { RenewalService } from './renewal.service';
import { ExportService } from './export.service';
import { LifecycleService } from './lifecycle.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NasModule } from '../nas/nas.module'; // ← Import NasModule to use RadiusSyncService
import { AccountingModule } from '../accounting/accounting.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrganizationModule } from '../organization/organization.module';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  imports: [PrismaModule, NasModule, AccountingModule, NotificationsModule, OrganizationModule, InvoicesModule],
  controllers: [SubscribersController],
  providers: [SubscribersService, RenewalService, ExportService, LifecycleService],
  // Exported so the public API can serve subscriber data under an API key.
  exports: [SubscribersService, RenewalService, ExportService, LifecycleService],
})
export class SubscribersModule {}