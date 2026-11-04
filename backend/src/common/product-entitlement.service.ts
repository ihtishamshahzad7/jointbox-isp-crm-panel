import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, type Actor } from './scope.service';

export const PRODUCT_FEATURES = ['ai-assistant', 'crm-advanced'] as const;
export type ProductFeatureKey = (typeof PRODUCT_FEATURES)[number];
export const isProductFeatureKey = (
  value: string,
): value is ProductFeatureKey =>
  (PRODUCT_FEATURES as readonly string[]).includes(value);

export interface CompanyProductState {
  companyId: number;
  enabled: boolean;
  planId: number | null;
  features: string[];
  expiresAt: Date | null;
  aiAssistantMonthlyRequestLimit: number | null;
  aiAssistantMonthlyTokenLimit: number | null;
}

@Injectable()
export class ProductEntitlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  private platformOnly(actor: Actor): void {
    if (actor?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Product switches are managed by the platform account.',
      );
    }
  }

  async listGlobal(actor: Actor) {
    this.platformOnly(actor);
    const rows = await this.prisma.productFeature.findMany({
      where: { key: { in: [...PRODUCT_FEATURES] } },
    });
    const enabled = new Map(rows.map((row) => [row.key, row.enabled]));
    return PRODUCT_FEATURES.map((key) => ({
      key,
      enabled: enabled.get(key) ?? false,
    }));
  }

  async setGlobal(actor: Actor, key: ProductFeatureKey, enabled: boolean) {
    this.platformOnly(actor);
    const updatedById = this.scope.actorId(actor);
    return this.prisma.productFeature.upsert({
      where: { key },
      update: { enabled, updatedById },
      create: { key, enabled, updatedById },
    });
  }

  async companyState(
    actor: Actor,
    key: ProductFeatureKey,
  ): Promise<CompanyProductState | null> {
    if (!actor || actor.role === 'SUPER_ADMIN') return null;
    const companyId = await this.scope.companyRootId(this.scope.actorId(actor));
    if (companyId == null) return null;

    const [global, companyPlan] = await Promise.all([
      this.prisma.productFeature.findUnique({
        where: { key },
        select: { enabled: true },
      }),
      this.prisma.companyPlan.findUnique({
        where: { companyId },
        select: {
          planId: true,
          features: true,
          expiresAt: true,
          aiAssistantMonthlyRequestLimit: true,
          aiAssistantMonthlyTokenLimit: true,
        },
      }),
    ]);

    const features = companyPlan?.features ?? [];
    const enabled =
      global?.enabled === true &&
      companyPlan?.planId != null &&
      features.includes(key) &&
      (companyPlan.expiresAt == null ||
        companyPlan.expiresAt.getTime() >= Date.now());
    return {
      companyId,
      enabled,
      planId: companyPlan?.planId ?? null,
      features,
      expiresAt: companyPlan?.expiresAt ?? null,
      aiAssistantMonthlyRequestLimit:
        companyPlan?.aiAssistantMonthlyRequestLimit ?? null,
      aiAssistantMonthlyTokenLimit:
        companyPlan?.aiAssistantMonthlyTokenLimit ?? null,
    };
  }

  async assertEnabled(
    actor: Actor,
    key: ProductFeatureKey,
  ): Promise<CompanyProductState> {
    const state = await this.companyState(actor, key);
    if (!state?.enabled) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PRODUCT_FEATURE_DISABLED',
        message: `The ${key} product is not enabled for this company.`,
      });
    }
    return state;
  }

  async assertEnabledForTransaction(
    tx: Prisma.TransactionClient,
    companyId: number,
    key: ProductFeatureKey,
  ): Promise<void> {
    const companyRows = await tx.$queryRaw<Array<{ companyId: number }>>`
      SELECT "companyId" FROM "company_plan"
      WHERE "companyId" = ${companyId}
      FOR SHARE`;
    const featureRows = await tx.$queryRaw<Array<{ enabled: boolean }>>`
      SELECT "enabled" FROM "product_feature"
      WHERE "key" = ${key}
      FOR SHARE`;
    const plan = await tx.companyPlan.findUnique({
      where: { companyId },
      select: { planId: true, features: true, expiresAt: true },
    });
    if (
      !companyRows.length ||
      featureRows[0]?.enabled !== true ||
      !plan?.planId ||
      !plan.features.includes(key) ||
      (plan.expiresAt != null && plan.expiresAt.getTime() < Date.now())
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PRODUCT_FEATURE_DISABLED',
        message: `The ${key} product is not enabled for this company.`,
      });
    }
  }
}
