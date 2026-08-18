import { Module } from '@nestjs/common';
import { ServiceSettingsController } from './service-settings.controller';
import { ServiceSettingsService } from './service-settings.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SubscribersModule } from '../subscribers/subscribers.module';

@Module({
  // SubscribersModule provides syncToRadius, so changing ipType/ipAddress here
  // actually reaches RADIUS instead of only updating the app's own DB.
  imports: [PrismaModule, SubscribersModule],
  controllers: [ServiceSettingsController],
  providers: [ServiceSettingsService],
  exports: [ServiceSettingsService],
})
export class ServiceSettingsModule {}