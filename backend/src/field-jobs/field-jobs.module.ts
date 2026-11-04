import { Module } from '@nestjs/common';
import { FieldJobsService } from './field-jobs.service';
import { FieldJobsController } from './field-jobs.controller';
import { FieldJobSchedulesService } from './field-job-schedules.service';
import { FieldJobReportsService } from './field-job-reports.service';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryModule } from '../inventory/inventory.module';
import { TicketsModule } from '../tickets/tickets.module';

@Module({
  // ScopeService comes from the global CommonModule.
  imports: [PrismaModule, InventoryModule, TicketsModule],
  controllers: [FieldJobsController],
  providers: [FieldJobsService, FieldJobSchedulesService, FieldJobReportsService],
  exports: [FieldJobsService, FieldJobSchedulesService, FieldJobReportsService],
})
export class FieldJobsModule {}
