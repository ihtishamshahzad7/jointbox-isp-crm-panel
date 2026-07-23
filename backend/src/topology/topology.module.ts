import { Module } from '@nestjs/common';
import { TopologyService } from './topology.service';
import { DeviceIntelService } from './device-intel.service';
import { TopologyController } from './topology.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TopologyController],
  providers: [TopologyService, DeviceIntelService],
  exports: [TopologyService, DeviceIntelService],
})
export class TopologyModule {}
