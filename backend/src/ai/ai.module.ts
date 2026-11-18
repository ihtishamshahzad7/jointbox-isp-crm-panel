import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { AiCrmQueryService } from './crm-query/ai-crm-query.service';
import { AiNarratorService } from './crm-query/ai-narrator.service';
import { FeatureGuard } from '../common/feature.guard';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AiController],
  providers: [AiService, AiCrmQueryService, AiNarratorService, FeatureGuard],
  exports: [AiCrmQueryService],
})
export class AiModule {}
