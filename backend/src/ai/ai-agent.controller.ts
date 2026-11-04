import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import {
  ProductEntitlementGuard,
  RequireProductFeature,
} from '../common/product-entitlement.guard';
import { PRODUCT_FEATURES } from '../common/product-entitlement.service';
import type { Actor } from '../common/scope.service';
import { AiAgentService } from './ai-agent.service';

type AuthenticatedRequest = { user: Actor };

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('ai-agent')
export class AiAgentController {
  constructor(private readonly aiAgent: AiAgentService) {}

  @Get('status')
  status(@Req() req: AuthenticatedRequest) {
    return this.aiAgent.status(req.user);
  }

  @Post('chat')
  @RequireProductFeature(PRODUCT_FEATURES[0])
  @UseGuards(ProductEntitlementGuard)
  chat(@Body() body: { question?: unknown }, @Req() req: AuthenticatedRequest) {
    return this.aiAgent.chat(req.user, body?.question);
  }
}
