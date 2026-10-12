import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NasModule } from '../nas/nas.module';
import { RadiusAdminController } from './radius-admin.controller';
import { RadiusAdminService } from './radius-admin.service';

@Module({
  // NasModule: the router vault (shared lock, re-sync after an edit that
  // changes where FreeRADIUS reads routers from).
  imports: [PrismaModule, NasModule],
  controllers: [RadiusAdminController],
  providers: [RadiusAdminService],
})
export class RadiusAdminModule {}
