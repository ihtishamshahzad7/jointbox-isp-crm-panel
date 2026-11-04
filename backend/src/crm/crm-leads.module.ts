import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SubscribersModule } from '../subscribers/subscribers.module';
import { CrmLeadsController } from './crm-leads.controller';
import { CrmLeadsService } from './crm-leads.service';

@Module({
  imports: [PrismaModule, SubscribersModule],
  controllers: [CrmLeadsController],
  providers: [CrmLeadsService],
})
export class CrmLeadsModule {}
