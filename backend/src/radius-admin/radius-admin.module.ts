import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RadiusAdminController } from './radius-admin.controller';
import { RadiusAdminService } from './radius-admin.service';

@Module({
  imports: [PrismaModule],
  controllers: [RadiusAdminController],
  providers: [RadiusAdminService],
})
export class RadiusAdminModule {}
