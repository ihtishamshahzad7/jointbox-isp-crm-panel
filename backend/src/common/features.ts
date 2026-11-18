import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ScopeService, Actor } from './scope.service';
import { planFor } from './company-plan';

/**
 * WHAT A COMPANY IS ENTITLED TO USE.
 *
 * Every feature name a plan may carry. Most of them are descriptive (they are
 * shown on the price list) and the panel does not switch anything off for
 * them. The GATED ones are products sold separately: the backend refuses
 * their routes for a company that does not hold them, whatever the UI shows.
 *
 * Where the entitlement lives: company_plan.features. It is copied from the
 * price-list plan when the platform assigns one (or presses "Apply to its
 * companies") and the platform may then switch features on or off for one
 * company. Like the caps, the plan row itself is never read at enforcement
 * time — editing a plan never changes what a company has behind its back.
 */
export const PLAN_FEATURES = [
  'subscribers',
  'billing',
  'accounting',
  'monitoring',
  'fiber',
  'hotspot',
  'api',
  'white-label',
  // Sold separately and enforced server-side:
  'ai-assistant',
  'crm-advanced',
] as const;

export type PlanFeature = (typeof PLAN_FEATURES)[number];

/** Features the backend enforces. Anything else on a plan is descriptive. */
export const GATED_FEATURES = ['ai-assistant', 'crm-advanced'] as const;
export type GatedFeature = (typeof GATED_FEATURES)[number];

export const FEATURE_LABEL: Record<GatedFeature, string> = {
  'ai-assistant': 'AI Assistant',
  'crm-advanced': 'Advanced CRM',
};

/** Validate a feature list from a request body (unique, known names only). */
export function parseFeatureList(v: unknown, field = 'Features'): string[] {
  if (!Array.isArray(v)) throw new BadRequestException(`${field} must be a list.`);
  const allowed = new Set<string>(PLAN_FEATURES);
  const feats = [...new Set(v.map((f) => String(f)))];
  const unknown = feats.filter((f) => !allowed.has(f));
  if (unknown.length) throw new BadRequestException(`Unknown feature: ${unknown.join(', ')}`);
  return feats;
}

/**
 * The company's entitlements. FAIL CLOSED: no plan row, an unmigrated table or
 * a read error all mean "nothing gated is enabled" — unlike the caps, where a
 * missing row means "no limit". Selling a product by default is not a safe
 * failure; refusing it is.
 */
export async function companyFeatures(prisma: any, companyId: number | null): Promise<Set<string>> {
  if (!companyId) return new Set();
  try {
    const row: any = await planFor(prisma, companyId);
    const list = Array.isArray(row?.features) ? row.features : [];
    return new Set(list.map(String));
  } catch {
    return new Set();
  }
}

/**
 * Does this signed-in operator's company hold `feature`?
 *
 * The platform account (SUPER_ADMIN) is not a company and is never refused.
 * Anyone else is resolved to their company root; an account that resolves to
 * no company holds nothing.
 */
export async function actorHasFeature(
  prisma: any,
  scope: Pick<ScopeService, 'isAdmin' | 'actorId' | 'companyRootId'>,
  actor: Actor,
  feature: GatedFeature,
): Promise<boolean> {
  if (!actor) return false;
  if (scope.isAdmin(actor.role)) return true;
  let company: number | null = null;
  try {
    company = await scope.companyRootId(scope.actorId(actor));
  } catch {
    return false;
  }
  return (await companyFeatures(prisma, company)).has(feature);
}

/** The gated features this operator may use (for the UI to show/hide; the backend still enforces). */
export async function actorFeatures(
  prisma: any,
  scope: Pick<ScopeService, 'isAdmin' | 'actorId' | 'companyRootId'>,
  actor: Actor,
): Promise<GatedFeature[]> {
  const out: GatedFeature[] = [];
  for (const f of GATED_FEATURES) if (await actorHasFeature(prisma, scope, actor, f)) out.push(f);
  return out;
}

export function featureRefused(feature: GatedFeature): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    code: 'FEATURE_NOT_ENABLED',
    feature,
    message: `${FEATURE_LABEL[feature]} is not enabled for your company. Ask the platform owner to enable it on your plan.`,
  });
}
