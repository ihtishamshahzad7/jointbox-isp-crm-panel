import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NetworkModule } from '../network/network.module';
import { BoostController } from './boost.controller';
import { BoostService } from './boost.service';

@Module({
  imports: [PrismaModule, NetworkModule],
  controllers: [BoostController],
  providers: [BoostService],
})
export class BoostModule {}
