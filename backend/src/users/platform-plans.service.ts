import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertIsCompany, capOrNull, invalidateCompanyPlan } from '../common/company-plan';
import {
  FEATURE_LABEL,
  GATED_FEATURES,
  PLAN_FEATURES,
  parseFeatureList,
} from '../common/features';
import type { Actor } from '../common/scope.service';

/**
 * PLANS & PRICING, AND COMPANY DETAILS — the platform account's own screens.
 *
 * A plan is a row in the platform's price list: a name, what it costs a
 * company, and the limits it carries. Assigning one to a company copies the
 * limits into company_plan (savePlan), and company_plan is what the panel
 * enforces when a company adds a subscriber, a router or a sub-account. The
 * plan row itself is never read at enforcement time, so editing a plan's
 * price never changes a company's limits behind its back; "Apply to its
 * companies" does that explicitly.
 */

/** The full list lives with the entitlement code (common/features.ts). */
export { PLAN_FEATURES };

const PERIODS = ['MONTHLY', 'YEARLY'] as const;

type PlanBody = Record<string, unknown>;

/** A request value as text; objects and arrays are not text. */
const text = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

const PROFILE_FIELDS = {
  contactFirstName: 80,
  contactLastName: 80,
  contactPhone: 30,
  website: 200,
  addressLine1: 200,
  addressLine2: 200,
  city: 80,
  province: 80,
  postalCode: 20,
  country: 80,
  taxNumber: 40,
} as const;
type ProfileKey = keyof typeof PROFILE_FIELDS;

@Injectable()
export class PlatformPlansService {
  constructor(private readonly prisma: PrismaService) {}

  private platformOnly(actor: Actor) {
    if (actor?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Plans and company details are managed by the platform account.',
      );
    }
  }

  /** Plans with how many companies are on each. */
  async list(actor: Actor) {
    this.platformOnly(actor);
    const plans = await this.prisma.platformPlan.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    const counts = await this.prisma.companyPlan.groupBy({
      by: ['planId'],
      _count: { _all: true },
    });
    const byPlan = new Map(counts.map((c) => [c.planId, c._count._all]));
    return {
      features: PLAN_FEATURES,
      plans: plans.map((p) => ({
        ...p,
        price: Number(p.price),
        companies: byPlan.get(p.id) ?? 0,
      })),
    };
  }

  private parse(body: PlanBody, partial: boolean) {
    const out: Record<string, unknown> = {};
    if (!partial || body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 60)
        throw new BadRequestException(
          'Give the plan a name of up to 60 characters.',
        );
      out.name = name;
    }
    if (body.price !== undefined) {
      const price = Number(body.price);
      if (!Number.isFinite(price) || price < 0 || price > 100_000_000) {
        throw new BadRequestException('Price must be 0 or more.');
      }
      out.price = Math.round(price * 100) / 100;
    }
    if (body.currency !== undefined) {
      const cur = text(body.currency).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(cur))
        throw new BadRequestException(
          'Currency is a 3-letter code such as PKR or USD.',
        );
      out.currency = cur;
    }
    if (body.billingPeriod !== undefined) {
      const per = text(body.billingPeriod).toUpperCase();
      if (!(PERIODS as readonly string[]).includes(per))
        throw new BadRequestException('Billing period is MONTHLY or YEARLY.');
      out.billingPeriod = per;
    }
    for (const [key, label] of [
      ['maxSubscribers', 'Subscribers'],
      ['maxNas', 'Routers'],
      ['maxAccounts', 'Sub-accounts'],
    ] as const) {
      if (body[key] !== undefined) out[key] = capOrNull(body[key], label);
    }
    if (body.features !== undefined) {
      out.features = parseFeatureList(body.features);
    }
    if (body.description !== undefined) {
      out.description = body.description
        ? text(body.description).trim().slice(0, 300)
        : null;
    }
    if (body.sortOrder !== undefined) {
      const n = Number(body.sortOrder);
      if (!Number.isInteger(n))
        throw new BadRequestException('Order must be a whole number.');
      out.sortOrder = n;
    }
    if (body.isActive !== undefined) out.isActive = body.isActive === true;
    return out;
  }

  private async uniqueName(name: unknown, exceptId?: number) {
    if (typeof name !== 'string') return;
    const clash = await this.prisma.platformPlan.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash)
      throw new ConflictException(`A plan called "${name}" already exists.`);
  }

  async create(actor: Actor, body: PlanBody) {
    this.platformOnly(actor);
    const data = this.parse(body, false);
    await this.uniqueName(data.name);
    const row = await this.prisma.platformPlan.create({ data: data as never });
    return { ...row, price: Number(row.price) };
  }

  async update(actor: Actor, id: number, body: PlanBody) {
    this.platformOnly(actor);
    const existing = await this.prisma.platformPlan.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Plan not found');
    const data = this.parse(body, true);
    await this.uniqueName(data.name, id);
    const row = await this.prisma.platformPlan.update({
      where: { id },
      data: data as never,
    });
    return { ...row, price: Number(row.price) };
  }

  /** A plan companies are on cannot be deleted; switch it off instead. */
  async remove(actor: Actor, id: number) {
    this.platformOnly(actor);
    const existing = await this.prisma.platformPlan.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Plan not found');
    const inUse = await this.prisma.companyPlan.count({
      where: { planId: id },
    });
    if (inUse > 0) {
      throw new ConflictException(
        `${inUse} compan${inUse === 1 ? 'y is' : 'ies are'} on ${existing.name}. Move them to another plan or switch this one off instead.`,
      );
    }
    await this.prisma.platformPlan.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Copy a plan's current limits onto every company on it. Explicit, because
   * it can take a company below what it already uses: the company then
   * cannot add more until it is back under the limit (nothing is removed).
   */
  async applyToCompanies(actor: Actor, id: number) {
    this.platformOnly(actor);
    const plan = await this.prisma.platformPlan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');
    const r = await this.prisma.companyPlan.updateMany({
      where: { planId: id },
      data: {
        maxSubscribers: plan.maxSubscribers,
        maxNas: plan.maxNas,
        maxAccounts: plan.maxAccounts,
        features: plan.features ?? [],
      },
    });
    invalidateCompanyPlan();
    return { updated: r.count };
  }

  async getProfile(actor: Actor, companyId: number) {
    this.platformOnly(actor);
    await assertIsCompany(this.prisma, companyId);
    return (
      (await this.prisma.companyProfile.findUnique({
        where: { companyId },
      })) ?? { companyId }
    );
  }

  async saveProfile(
    actor: Actor,
    companyId: number,
    body: Record<string, unknown>,
  ) {
    this.platformOnly(actor);
    await assertIsCompany(this.prisma, companyId);
    const data: Partial<Record<ProfileKey, string | null>> = {};
    for (const [key, max] of Object.entries(PROFILE_FIELDS) as [
      ProfileKey,
      number,
    ][]) {
      if (body[key] === undefined) continue;
      const v = body[key] === null ? '' : text(body[key]).trim();
      if (v.length > max)
        throw new BadRequestException(
          `${key} is longer than ${max} characters.`,
        );
      data[key] = v || null;
    }
    if (data.contactPhone && !/^\+?[0-9 ()-]{7,30}$/.test(data.contactPhone)) {
      throw new BadRequestException(
        'Contact phone may only contain digits, spaces, +, ( ) and -.',
      );
    }
    if (data.website) {
      const w = /^https?:\/\//i.test(data.website)
        ? data.website
        : `https://${data.website}`;
      let ok = false;
      try {
        const u = new URL(w);
        ok = /^https?:$/.test(u.protocol) && u.hostname.includes('.');
      } catch {
        ok = false;
      }
      if (!ok)
        throw new BadRequestException(
          'Website must be a web address such as example.com.',
        );
      data.website = w;
    }
    return this.prisma.companyProfile.upsert({
      where: { companyId },
      update: data,
      create: { companyId, ...data },
    });
  }

  /**
   * One company's sold-separately products (AI Assistant, Advanced CRM).
   * `fromPlan` is what its price-list plan carries, for the screen to show
   * when the company has been switched away from its plan's default.
   */
  async getCompanyFeatures(actor: Actor, companyId: number) {
    this.platformOnly(actor);
    await assertIsCompany(this.prisma, companyId);
    const row = await this.prisma.companyPlan.findUnique({
      where: { companyId },
      select: { features: true, planId: true },
    });
    const tier = row?.planId
      ? await this.prisma.platformPlan.findUnique({
          where: { id: row.planId },
          select: { features: true },
        })
      : null;
    const have = new Set<string>(row?.features ?? []);
    const plan = new Set<string>(tier?.features ?? []);
    return {
      companyId,
      features: GATED_FEATURES.map((key) => ({
        key,
        label: FEATURE_LABEL[key],
        enabled: have.has(key),
        fromPlan: plan.has(key),
      })),
    };
  }

  /**
   * Switch gated features on/off for one company: body `{ "ai-assistant": true }`.
   *
   * One UPDATE with array arithmetic in SQL, so two platform admins saving at
   * once cannot lose each other's change (a read-modify-write in JS would).
   * Descriptive features already on the row are left alone.
   */
  async setCompanyFeatures(
    actor: Actor,
    companyId: number,
    body: Record<string, unknown>,
  ) {
    this.platformOnly(actor);
    await assertIsCompany(this.prisma, companyId);
    const on: string[] = [];
    const off: string[] = [];
    for (const [key, value] of Object.entries(body ?? {})) {
      if (!(GATED_FEATURES as readonly string[]).includes(key))
        throw new BadRequestException(`Unknown feature: ${key}`);
      if (typeof value !== 'boolean')
        throw new BadRequestException(`${key} must be true or false.`);
      (value ? on : off).push(key);
    }
    if (!on.length && !off.length)
      throw new BadRequestException('Nothing to change.');
    await this.prisma.$executeRaw`
      INSERT INTO "company_plan" ("companyId", "features", "updatedById", "updatedAt")
      VALUES (${companyId}, ${on}::text[], ${this.actorIdOf(actor)}, NOW())
      ON CONFLICT ("companyId") DO UPDATE SET
        "features" = ARRAY(
          SELECT DISTINCT f FROM unnest("company_plan"."features" || ${on}::text[]) AS f
          WHERE f <> ALL(${off}::text[])
        ),
        "updatedById" = EXCLUDED."updatedById",
        "updatedAt" = NOW()`;
    invalidateCompanyPlan(companyId);
    await this.prisma.activityLog
      .create({
        data: {
          userId: this.actorIdOf(actor),
          action: 'COMPANY_FEATURES',
          entity: 'User',
          entityId: companyId,
          details: `Enabled: ${on.join(', ') || '—'}; disabled: ${off.join(', ') || '—'}`,
        } as never,
      })
      .catch(() => undefined);
    return this.getCompanyFeatures(actor, companyId);
  }

  private actorIdOf(actor: Actor): number | null {
    const id = Number(actor?.sub ?? actor?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  }
}
