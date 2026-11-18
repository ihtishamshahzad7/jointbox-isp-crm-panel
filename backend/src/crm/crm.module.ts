import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FeatureGuard } from '../common/feature.guard';
import { CrmController } from './crm.controller';
import { CrmLedgerService } from './crm-ledger.service';
import { CrmInventoryService } from './crm-inventory.service';
import { CrmIssueService } from './crm-issue.service';
import { InvoicesModule } from '../invoices/invoices.module';
import { SubscribersModule } from '../subscribers/subscribers.module';
import { TicketsModule } from '../tickets/tickets.module';
import { CrmTerminationService } from './crm-termination.service';
import { CrmTatService } from './crm-tat.service';
import { CrmStaffService } from './crm-staff.service';
import { CrmCostsService } from './crm-costs.service';
import { CrmReportsService } from './crm-reports.service';
import { AccountingModule } from '../accounting/accounting.module';

/** Advanced CRM modules, all behind the `crm-advanced` entitlement. */
@Module({
  imports: [PrismaModule, InvoicesModule, SubscribersModule, TicketsModule, AccountingModule],
  controllers: [CrmController],
  providers: [CrmLedgerService, CrmInventoryService, CrmIssueService, CrmTerminationService, CrmTatService, CrmStaffService, CrmCostsService, CrmReportsService, FeatureGuard],
})
export class CrmModule {}
