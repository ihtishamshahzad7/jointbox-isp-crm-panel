import { Global, Module } from '@nestjs/common';
import { SecurityService } from './security.service';
import { SecurityController } from './security.controller';
import { PermissionsGuard } from './permissions.guard';
import { PrismaModule } from '../prisma/prisma.module';

/** Global so PermissionsGuard is injectable from every feature module. */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [SecurityController],
  providers: [SecurityService, PermissionsGuard],
  exports: [SecurityService, PermissionsGuard],
})
export class SecurityModule {}
