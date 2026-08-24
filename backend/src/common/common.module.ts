import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CacheService } from './cache.service';
import { QueueService } from './queue.service';
import { ScopeService } from './scope.service';
import { AuditInterceptor } from './audit.interceptor';
import { DatabaseSetupService } from './database-setup.service';
import { BackupService } from './backup.service';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { SecretsService } from './secrets.service';
import { CronGuardService } from './cron-guard.service';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * Global infrastructure: cache + queues + hierarchy scoping + automatic audit
 * trail + database setup (indexes, FreeRADIUS columns, archival) applied on
 * every boot so a fresh clone comes up correctly configured.
 */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [EventsController],
  providers: [
    CacheService,
    QueueService,
    ScopeService,
    DatabaseSetupService,
    BackupService,
    EventsService,
    SecretsService,
    // Runs at bootstrap on every process: strips scheduled jobs from non-primary
    // instances so an unguarded @Cron cannot duplicate itself across the cluster.
    CronGuardService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [CacheService, QueueService, ScopeService, DatabaseSetupService, BackupService, EventsService, SecretsService],
})
export class CommonModule {}
