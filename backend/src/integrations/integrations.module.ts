import { Module } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { ApiKeysService } from './api-keys.service';
import { ApiKeyGuard } from './api-key.guard';
import { IntegrationsController } from './integrations.controller';
import { PublicApiController } from './public-api.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { SubscribersModule } from '../subscribers/subscribers.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { GatewayModule } from '../gateway/gateway.module';
import { NetworkModule } from '../network/network.module';
import { FiberModule } from '../fiber/fiber.module';
import { PackagesModule } from '../packages/packages.module';

@Module({
  imports: [
    PrismaModule, SubscribersModule, AnalyticsModule,
    InvoicesModule, GatewayModule, NetworkModule, FiberModule, PackagesModule,
  ],
  controllers: [IntegrationsController, PublicApiController],
  providers: [WebhooksService, ApiKeysService, ApiKeyGuard],
  exports: [WebhooksService, ApiKeysService],
})
export class IntegrationsModule {}
