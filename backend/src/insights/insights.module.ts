import { Module } from '@nestjs/common';
import { InsightsService } from './insights.service';
import { SegmentationService } from './segmentation.service';
import { InsightsController } from './insights.controller';
import { SegmentationController } from './segmentation.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [InsightsController, SegmentationController],
  providers: [InsightsService, SegmentationService],
  exports: [SegmentationService],
})
export class InsightsModule {}
