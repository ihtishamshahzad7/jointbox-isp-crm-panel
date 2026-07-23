import { Module } from '@nestjs/common';
import { ServiceSettingsController } from './service-settings.controller';
import { ServiceSettingsService } from './service-settings.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ServiceSettingsController],
  providers: [ServiceSettingsService],
  exports: [ServiceSettingsService],
})
export class ServiceSettingsModule {}