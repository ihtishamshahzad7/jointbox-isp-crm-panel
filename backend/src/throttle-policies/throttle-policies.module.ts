import { Module } from '@nestjs/common';
import { ThrottlePoliciesController } from './throttle-policies.controller';
import { ThrottlePoliciesService } from './throttle-policies.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [ThrottlePoliciesController],
  providers: [ThrottlePoliciesService],
  exports: [ThrottlePoliciesService],
})
export class ThrottlePoliciesModule {}
