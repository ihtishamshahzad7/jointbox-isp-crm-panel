import { Module } from '@nestjs/common';
import { FiberService } from './fiber.service';
import { FiberController } from './fiber.controller';
import { OnuProvisionService } from './onu-provision.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TopologyModule } from '../topology/topology.module';

@Module({
  imports: [PrismaModule, TopologyModule],
  controllers: [FiberController],
  providers: [FiberService, OnuProvisionService],
  exports: [FiberService, OnuProvisionService],
})
export class FiberModule {}