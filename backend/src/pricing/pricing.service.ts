import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

@Injectable()
export class PricingService {
  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
  ) {}

  // ─── EXTRA FEES ───────────────────────────────────────────────────────

  /**
   * The fee catalogue is shared, but the packages a fee is attached to are
   * not: for anyone but the platform owner, only the caller's own (or
   * assigned) packages are counted and listed. null = no narrowing.
   */
  private async feePackageWhere(actor?: Actor): Promise<any | null> {
    if (!actor || this.scope.isPlatformOwner(actor)) return null;
    return { package: await this.scope.packageWhere(actor) };
  }

  // Fees: platform defaults plus each company's own (ScopeService config rules).
  async listFees(query: any, actor?: Actor) {
    const pkgWhere = await this.feePackageWhere(actor);
    const own = actor ? await this.scope.configReadWhere(actor) : {};
    const rows = await this.prisma.extraFee.findMany({
      where: {
        AND: [
          own,
          query?.isActive ? { isActive: query.isActive === 'true' } : {},
          query?.type ? { type: query.type } : {},
          query?.q ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { description: { contains: query.q, mode: 'insensitive' } },
            ],
          } : {},
        ],
      },
      orderBy: { name: 'asc' },
      include: { _count: { select: { packages: pkgWhere ? { where: pkgWhere } : true } } },
    });
    return rows.map((r: any) => ({ ...r, scope: r.ownerId == null ? 'PLATFORM' : 'COMPANY' }));
  }

  async feeOptions(actor?: Actor) {
    const own = actor ? await this.scope.configReadWhere(actor) : {};
    return this.prisma.extraFee.findMany({
      where: { isActive: true, ...own },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, type: true, value: true, isRecurring: true },
    });
  }

  async getFee(id: number, actor?: Actor) {
    const pkgWhere = await this.feePackageWhere(actor);
    const f = await this.prisma.extraFee.findUnique({
      where: { id },
      include: {
        packages: {
          ...(pkgWhere ? { where: pkgWhere } : {}),
          include: { package: { select: { id: true, name: true, price: true } } },
        },
      },
    });
    if (!f) throw new NotFoundException(`Fee ${id} not found`);
    if (actor) await this.scope.assertConfigReadable(actor, f, `Fee ${id}`);
    return f;
  }

  async createFee(body: any, actor: any) {
    // Platform owner: a platform default. Company administrator: its own fee.
    const ownerId = actor ? await this.scope.configOwnerForCreate(actor) : null;
    if (!body?.name) throw new BadRequestException('name is required');
    if (!body?.type) throw new BadRequestException('type is required (FIXED | PERCENT)');
    return this.prisma.extraFee.create({
      data: {
        ownerId,
        name: body.name,
        type: body.type,
        value: +body.value || 0,
        description: body.description ?? null,
        isRecurring: body.isRecurring === true,
        isActive: body.isActive !== false,
      },
    });
  }

  async updateFee(id: number, body: any, actor: any) {
    const existing = await this.prisma.extraFee.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Fee ${id} not found`);
    if (actor) await this.scope.assertConfigWritable(actor, existing, 'Fee');
    return this.prisma.extraFee.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.type ? { type: body.type } : {}),
        ...(body.value !== undefined ? { value: +body.value } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(typeof body.isRecurring === 'boolean' ? { isRecurring: body.isRecurring } : {}),
        ...(typeof body.isActive === 'boolean' ? { isActive: body.isActive } : {}),
      },
    });
  }

  async removeFee(id: number, actor: any) {
    const existing = await this.prisma.extraFee.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Fee ${id} not found`);
    if (actor) await this.scope.assertConfigWritable(actor, existing, 'Fee');
    await this.prisma.extraFee.delete({ where: { id } });
    return { ok: true };
  }

  // ─── SUBSCRIBER DISCOUNTS ─────────────────────────────────────────────

  /**
   * Discount ids belonging to the caller's subscribers, or null = all
   * (platform owner, or an internal call with no actor).
   *
   * SubscriberDiscount has no Prisma relation to Subscriber, so the owner
   * filter cannot be a relation where. A join on the subscriber's owner keeps
   * the parameter list to the caller's ACCOUNTS (a handful) instead of every
   * subscriber id they have; what comes back is only their discounts.
   */
  private async visibleDiscountIds(actor?: Actor): Promise<number[] | null> {
    if (!actor || this.scope.isPlatformOwner(actor)) return null;
    const owners = (await this.scope.visibleUserIds(actor)) ?? [];
    if (!owners.length) return [];
    const rows = await this.prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
      SELECT d.id FROM subscriber_discount d
      JOIN "Subscriber" s ON s.id = d."subscriberId"
      WHERE s."userId" = ANY(${owners}::int[])`);
    return rows.map((r) => Number(r.id));
  }

  async listDiscounts(query: any, actor?: Actor) {
    const visible = await this.visibleDiscountIds(actor);
    return this.prisma.subscriberDiscount.findMany({
      where: {
        ...(query?.subscriberId ? { subscriberId: +query.subscriberId } : {}),
        ...(query?.isActive ? { isActive: query.isActive === 'true' } : {}),
        ...(query?.type ? { type: query.type } : {}),
        ...(visible ? { id: { in: visible } } : {}),
      },
      orderBy: { id: 'desc' },
    });
  }

  async getDiscount(id: number, actor?: Actor) {
    const d = await this.prisma.subscriberDiscount.findUnique({
      where: { id },
    });
    if (!d) throw new NotFoundException(`Discount ${id} not found`);
    // Belongs to a subscriber — theirs, or "not found" (same words as above,
    // so a probe cannot tell the two apart).
    if (actor) {
      try {
        await this.scope.assertViaSubscriber(actor, d.subscriberId, 'Discount');
      } catch (e) {
        if (e instanceof NotFoundException) throw new NotFoundException(`Discount ${id} not found`);
        throw e;
      }
    }
    return d;
  }

  async createDiscount(body: any, actor: any) {
    if (!body?.subscriberId) throw new BadRequestException('subscriberId is required');
    if (!body?.type) throw new BadRequestException('type is required (PERCENT | FIXED)');
    if (!body?.value) throw new BadRequestException('value is required');
    // A discount is money off a customer's bill: the customer must be the
    // caller's own.
    if (actor) await this.scope.assertSubscriberVisible(actor, +body.subscriberId);
    return this.prisma.subscriberDiscount.create({
      data: {
        subscriberId: +body.subscriberId,
        type: body.type,
        value: +body.value,
        reason: body.reason ?? null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        isActive: body.isActive !== false,
      },
    });
  }

  async updateDiscount(id: number, body: any, actor: any) {
    const existing = await this.prisma.subscriberDiscount.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Discount ${id} not found`);
    if (actor) await this.scope.assertViaSubscriber(actor, existing.subscriberId, `Discount ${id}`);
    if (actor && body?.subscriberId != null) await this.scope.assertSubscriberVisible(actor, +body.subscriberId);
    return this.prisma.subscriberDiscount.update({
      where: { id },
      data: {
        ...(body.type ? { type: body.type } : {}),
        ...(body.value !== undefined ? { value: +body.value } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt ? new Date(body.expiresAt) : null } : {}),
        ...(typeof body.isActive === 'boolean' ? { isActive: body.isActive } : {}),
      },
    });
  }

  async removeDiscount(id: number, actor: any) {
    const existing = await this.prisma.subscriberDiscount.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Discount ${id} not found`);
    if (actor) await this.scope.assertViaSubscriber(actor, existing.subscriberId, `Discount ${id}`);
    await this.prisma.subscriberDiscount.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Returns the effective discount for a subscriber RIGHT NOW. Picks the
   * highest priority active discount (PERCENT wins over FIXED on ties; expired
   * are filtered out).
   */
  async effectiveDiscountFor(subscriberId: number): Promise<{ type: 'PERCENT' | 'FIXED'; value: number; reason: string | null } | null> {
    const now = new Date();
    const all = await this.prisma.subscriberDiscount.findMany({
      where: {
        subscriberId, isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    if (all.length === 0) return null;
    // Prefer PERCENT when both exist (more valuable in the common case).
    const percent = all.filter((d) => d.type === 'PERCENT').sort((a, b) => b.value - a.value)[0];
    if (percent) return { type: 'PERCENT', value: percent.value, reason: percent.reason };
    const fixed = all.filter((d) => d.type === 'FIXED').sort((a, b) => b.value - a.value)[0];
    if (fixed) return { type: 'FIXED', value: fixed.value, reason: fixed.reason };
    return null;
  }
}
