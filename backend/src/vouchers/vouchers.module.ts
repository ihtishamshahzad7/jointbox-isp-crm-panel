import { Module } from '@nestjs/common';
import { VouchersController } from './vouchers.controller';
import { HotspotController } from './hotspot.controller';
import { VouchersService } from './vouchers.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NasModule } from '../nas/nas.module';

@Module({
  // NasModule provides RadiusSyncService: a hotspot card is redeemed by an
  // anonymous customer, so the card itself has to become a RADIUS credential.
  imports: [PrismaModule, NasModule],
  controllers: [VouchersController, HotspotController],
  providers: [VouchersService],
  exports: [VouchersService],
})
export class VouchersModule {}