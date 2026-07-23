import { Module } from '@nestjs/common';
import { OutagesService } from './outages.service';
import { OutagesController } from './outages.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // NotificationsModule is used to warn an affected area before they call in.
  imports: [PrismaModule, NotificationsModule],
  controllers: [OutagesController],
  providers: [OutagesService],
  exports: [OutagesService],
})
export class OutagesModule {}
