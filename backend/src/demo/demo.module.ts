import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';
import { DemoDataService } from './demo-data.service';
import { DemoHierarchyService } from './demo-hierarchy.service';

@Module({
  imports: [PrismaModule],
  controllers: [DemoController],
  providers: [DemoService, DemoDataService, DemoHierarchyService],
})
export class DemoModule {}
