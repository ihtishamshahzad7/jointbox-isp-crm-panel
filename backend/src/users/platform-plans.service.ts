import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertIsCompany, capOrNull } from '../common/company-plan';
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

export const PLAN_FEATURES = [
  'subscribers',
  'billing',
  'accounting',
  'monitoring',
  'fiber',
  'hotspot',
  'api',
  'white-label',
] as const;

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
      if (!Array.isArray(body.features))
        throw new BadRequestException('Features must be a list.');
      const allowed = new Set<string>(PLAN_FEATURES);
      const feats = [...new Set(body.features.map((f) => String(f)))];
      const unknown = feats.filter((f) => !allowed.has(f));
      if (unknown.length)
        throw new BadRequestException(`Unknown feature: ${unknown.join(', ')}`);
      out.features = feats;
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
      },
    });
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
}
