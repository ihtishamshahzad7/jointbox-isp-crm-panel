import { Module } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { ApiKeysService } from './api-keys.service';
import { ApiKeyGuard } from './api-key.guard';
import { IntegrationsController } from './integrations.controller';
import { PublicApiController } from './public-api.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { SubscribersModule } from '../subscribers/subscribers.module';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
  imports: [PrismaModule, SubscribersModule, AnalyticsModule],
  controllers: [IntegrationsController, PublicApiController],
  providers: [WebhooksService, ApiKeysService, ApiKeyGuard],
  // WebhooksService is exported so any module can emit events.
  exports: [WebhooksService, ApiKeysService],
})
export class IntegrationsModule {}
