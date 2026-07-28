import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TraceMiddleware } from './common/trace.middleware';
import { CommonModule } from './common/common.module';
import { AccountingModule } from './accounting/accounting.module';
import { BillingModule } from './billing/billing.module';
import { NotificationsModule } from './notifications/notifications.module';
import { GatewayModule } from './gateway/gateway.module';
import { PortalModule } from './portal/portal.module';
import { SecurityModule } from './security/security.module';
import { OrganizationModule } from './organization/organization.module';
import { NetworkModule } from './network/network.module';
import { InsightsModule } from './insights/insights.module';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { SubscribersModule } from './subscribers/subscribers.module';
import { PackagesModule } from './packages/packages.module';
import { AreasModule } from './areas/areas.module';
import { NasModule } from './nas/nas.module';
import { InvoicesModule } from './invoices/invoices.module';
import { VouchersModule } from './vouchers/vouchers.module';
import { UsersModule } from './users/users.module';
import { LogsModule } from './logs/logs.module';
import { PaymentsModule } from './payments/payments.module';
import { TicketsModule } from './tickets/tickets.module';
import { ReportsModule } from './reports/reports.module';
import { IpPoolModule } from './ip-pool/ip-pool.module';
import { ServiceSettingsModule } from './service-settings/service-settings.module';
import { UploadsModule } from './uploads/uploads.module';
import { InventoryModule } from './inventory/inventory.module';
import { FieldJobsModule } from './field-jobs/field-jobs.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { StaticIpModule } from './static-ip/static-ip.module';
import { OutagesModule } from './outages/outages.module';
import { ComplianceModule } from './compliance/compliance.module';
import { TopologyModule } from './topology/topology.module';
import { SetupModule } from './setup/setup.module';
import { ConsoleModule } from './console/console.module';
import { NotesModule } from './notes/notes.module';
import { JobsModule } from './jobs/jobs.module';
import { AiModule } from './ai/ai.module';
import { FiberModule } from './fiber/fiber.module';
import { GroupsModule } from './groups/groups.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    CommonModule,
    SecurityModule,
    OrganizationModule,
    NetworkModule,
    InsightsModule,
    AccountingModule,
    BillingModule,
    NotificationsModule,
    GatewayModule,
    PortalModule,
    AuthModule,
    PrismaModule,
    SubscribersModule,
    PackagesModule,
    AreasModule,
    NasModule,
    InvoicesModule,
    VouchersModule,
    UsersModule,
    LogsModule,
    PaymentsModule,
    TicketsModule,
    ReportsModule,
    IpPoolModule,
    ServiceSettingsModule,
    UploadsModule,
    InventoryModule,
    FieldJobsModule,
    AnalyticsModule,
    IntegrationsModule,
    StaticIpModule,
    OutagesModule,
    ComplianceModule,
    TopologyModule,
    SetupModule,
    ConsoleModule,
    NotesModule,
    JobsModule,
    AiModule,
    FiberModule,
    GroupsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
