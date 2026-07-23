import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PortalService } from './portal.service';
import { PortalController } from './portal.controller';
import { PortalGuard } from './portal.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { GatewayModule } from '../gateway/gateway.module';
import { NasModule } from '../nas/nas.module';
import { VouchersModule } from '../vouchers/vouchers.module';

@Module({
  imports: [
    PrismaModule,
    GatewayModule,
    // NasModule → RadiusSyncService (password changes must reach RADIUS)
    // VouchersModule → prepaid scratch-card top-ups
    NasModule,
    VouchersModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-super-secret-key-change-this-in-production',
    }),
  ],
  controllers: [PortalController],
  providers: [PortalService, PortalGuard],
})
export class PortalModule {}
