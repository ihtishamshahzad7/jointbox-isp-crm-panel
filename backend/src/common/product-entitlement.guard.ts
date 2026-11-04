import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Actor } from './scope.service';
import {
  ProductEntitlementService,
  ProductFeatureKey,
} from './product-entitlement.service';

const PRODUCT_FEATURE_METADATA = 'required_product_feature';

export const RequireProductFeature = (feature: ProductFeatureKey) =>
  SetMetadata(PRODUCT_FEATURE_METADATA, feature);

@Injectable()
export class ProductEntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: ProductEntitlementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<ProductFeatureKey>(
      PRODUCT_FEATURE_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!feature) return true;
    const request = context.switchToHttp().getRequest<{ user?: Actor }>();
    if (!request.user)
      throw new ForbiddenException(
        'Authentication is required for this product.',
      );
    await this.entitlements.assertEnabled(request.user, feature);
    return true;
  }
}
