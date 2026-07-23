import { Module } from '@nestjs/common';
import { PackagesController } from './packages.controller';
import { PackagesService } from './packages.service';
import { PrismaModule } from '../prisma/prisma.module';
import { IpPoolModule } from '../ip-pool/ip-pool.module';
// IpPoolModule exports IpPoolService, which PackagesService uses
// to call checkPoolAvailable() — enforcing one-pool-per-package

import { CommonModule } from '../common/common.module';

@Module({
  // CommonModule provides ScopeService for package assignment scoping.
  imports: [PrismaModule, IpPoolModule, CommonModule],
  controllers: [PackagesController],
  providers: [PackagesService],
})
export class PackagesModule {}