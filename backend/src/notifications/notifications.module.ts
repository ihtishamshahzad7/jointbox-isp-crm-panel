import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { AlertsService } from './alerts.service';
import { NotificationFeedService } from './notification-feed.service';
import { NotificationsController } from './notifications.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, AlertsService, NotificationFeedService],
  exports: [NotificationsService, AlertsService, NotificationFeedService],
})
export class NotificationsModule {}
