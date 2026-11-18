import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService } from './scope.service';
import { actorHasFeature, featureRefused, GatedFeature } from './features';

export const REQUIRED_FEATURE = 'uplinko:requiredFeature';

/** Refuse the route unless the caller's company holds `feature` (see features.ts). */
export const RequireFeature = (feature: GatedFeature) => SetMetadata(REQUIRED_FEATURE, feature);

/**
 * Use AFTER JwtAuthGuard. Server-side entitlement: hiding a menu item is not
 * a control, this is. Reads the method's metadata first, then the class's.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<GatedFeature | undefined>(REQUIRED_FEATURE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!feature) return true;
    const req = context.switchToHttp().getRequest();
    if (await actorHasFeature(this.prisma, this.scope, req.user, feature)) return true;
    throw featureRefused(feature);
  }
}
