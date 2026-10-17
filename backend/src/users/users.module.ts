import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PlatformPlansController } from './platform-plans.controller';
import { PlatformPlansService } from './platform-plans.service';
import { PrismaModule } from '../prisma/prisma.module';
import { OrganizationModule } from '../organization/organization.module';

@Module({
  imports: [PrismaModule, OrganizationModule],
  controllers: [UsersController, PlatformPlansController],
  providers: [UsersService, PlatformPlansService],
  exports: [UsersService],
})
export class UsersModule {}