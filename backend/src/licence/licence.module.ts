import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
import { LicenceService } from './licence.service';
import { LicenceController } from './licence.controller';
import { LicenceGuard } from './licence.guard';
import { LicenceCountsService } from './licence-counts.service';

/**
 * Licence enforcement.
 *
 * Global so any service can inject LicenceService to gate a feature
 * (`hasFeature('olt')`) without importing this module.
 *
 * The guard is registered via APP_GUARD, which makes it run on every HTTP
 * route. That is only safe because the guard itself is narrow — reads always
 * pass, RADIUS and public paths are exempt, and an unreachable agent fails
 * open. See licence.guard.ts for the reasoning and licence.guard.spec.ts for
 * the tests that hold it to that.
 */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [LicenceController],
  providers: [
    LicenceService,
    LicenceCountsService,
    { provide: APP_GUARD, useClass: LicenceGuard },
  ],
  exports: [LicenceService],
})
export class LicenceModule {}
