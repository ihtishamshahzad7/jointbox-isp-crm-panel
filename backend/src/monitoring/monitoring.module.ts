import { Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { DiagnosticsService } from './diagnostics.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [MonitoringController],
  providers: [MonitoringService, DiagnosticsService],
})
export class MonitoringModule {}
