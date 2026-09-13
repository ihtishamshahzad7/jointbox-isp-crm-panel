import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { CacheService } from './cache.service';
import { QueueService } from './queue.service';
import { ScopeService } from './scope.service';
import { AuditInterceptor } from './audit.interceptor';
import { DatabaseSetupService } from './database-setup.service';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { SseAuthGuard } from './sse-auth.guard';
import { SecretsService } from './secrets.service';
import { CronGuardService } from './cron-guard.service';
import { CurrencyService } from './currency.service';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * Global infrastructure: cache + queues + hierarchy scoping + automatic audit
 * trail + database setup (indexes, FreeRADIUS columns, archival) applied on
 * every boot so a fresh clone comes up correctly configured.
 */
@Global()
@Module({
  imports: [
    PrismaModule,
    // Registered here, not imported from AuthModule: CommonModule is @Global
    // and loads before the feature modules, and SseAuthGuard must verify
    // tokens without dragging the whole auth graph (and its circular-import
    // risk) into global scope. Same secret, same signature.
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-super-secret-key-change-this-in-production',
    }),
  ],
  controllers: [EventsController, BackupController],
  providers: [
    CacheService,
    QueueService,
    ScopeService,
    DatabaseSetupService,
    BackupService,
    EventsService,
    SseAuthGuard,
    SecretsService,
    // The single authority on what currency money is in. Global, so every
    // money-writing service can stamp without a module import.
    CurrencyService,
    // Runs at bootstrap on every process: strips scheduled jobs from non-primary
    // instances so an unguarded @Cron cannot duplicate itself across the cluster.
    CronGuardService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [CacheService, QueueService, ScopeService, DatabaseSetupService, BackupService, EventsService, SecretsService, CurrencyService],
})
export class CommonModule {}
