import { Module } from '@nestjs/common';
import { OutagesService } from './outages.service';
import { OutageClassifierService } from './outage-classifier.service';
import { OutagesController } from './outages.controller';
import { PublicStatusController } from './public-status.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // NotificationsModule is used to warn an affected area before they call in.
  imports: [PrismaModule, NotificationsModule],
  controllers: [OutagesController, PublicStatusController],
  providers: [OutagesService, OutageClassifierService],
  exports: [OutagesService, OutageClassifierService],
})
export class OutagesModule {}
