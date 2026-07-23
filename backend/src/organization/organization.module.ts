import { Module } from '@nestjs/common';
import { OrganizationService } from './organization.service';
import { ResellerPricingService } from './reseller-pricing.service';
import { OrganizationController } from './organization.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [PrismaModule, AccountingModule],
  controllers: [OrganizationController],
  providers: [OrganizationService, ResellerPricingService],
  exports: [OrganizationService, ResellerPricingService],
})
export class OrganizationModule {}
