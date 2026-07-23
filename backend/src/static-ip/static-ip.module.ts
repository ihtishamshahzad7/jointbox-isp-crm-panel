import { Module } from '@nestjs/common';
import { StaticIpService } from './static-ip.service';
import { StaticIpController } from './static-ip.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { SubscribersModule } from '../subscribers/subscribers.module';
import { NetworkModule } from '../network/network.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NasModule } from '../nas/nas.module';

@Module({
  // SubscribersModule provides syncToRadius so an allocation actually reaches
  // the network, not just the database.
  // NetworkModule provides the CoA disconnect — a customer who is already
  // online keeps their pool address until the session is rebuilt.
  // NotificationsModule tells the customer their IP charge is due.
  // NasModule provides MikrotikSyncService — used to clear a pinned secret
  // address and to force a disconnect when CoA doesn't land.
  imports: [PrismaModule, SubscribersModule, NetworkModule, NotificationsModule, NasModule],
  controllers: [StaticIpController],
  providers: [StaticIpService],
  exports: [StaticIpService],
})
export class StaticIpModule {}
