import { Global, Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * Global so any service can inject JobsService and register a handler at
 * startup without a module import cycle (ScopeService/CacheService are already
 * global via CommonModule).
 */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
