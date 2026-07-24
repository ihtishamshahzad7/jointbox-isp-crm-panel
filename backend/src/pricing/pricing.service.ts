import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService } from '../common/scope.service';

@Injectable()
export class PricingService {
  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
  ) {}

  // ─── EXTRA FEES ───────────────────────────────────────────────────────

  async listFees(query: any) {
    return this.prisma.extraFee.findMany({
      where: {
        ...(query?.isActive ? { isActive: query.isActive === 'true' } : {}),
        ...(query?.type ? { type: query.type } : {}),
        ...(query?.q ? {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' } },
            { description: { contains: query.q, mode: 'insensitive' } },
          ],
        } : {}),
      },
      orderBy: { name: 'asc' },
      include: { _count: { select: { packages: true } } },
    });
  }

  async feeOptions() {
    return this.prisma.extraFee.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, type: true, value: true, isRecurring: true },
    });
  }

  async getFee(id: number) {
    const f = await this.prisma.extraFee.findUnique({
      where: { id },
      include: { packages: { include: { package: { select: { id: true, name: true, price: true } } } } },
    });
    if (!f) throw new NotFoundException(`Fee ${id} not found`);
    return f;
  }

  async createFee(body: any, actor: any) {
    if (!body?.name) throw new BadRequestException('name is required');
    if (!body?.type) throw new BadRequestException('type is required (FIXED | PERCENT)');
    return this.prisma.extraFee.create({
      data: {
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
    await this.prisma.extraFee.delete({ where: { id } });
    return { ok: true };
  }

  // ─── SUBSCRIBER DISCOUNTS ─────────────────────────────────────────────

  async listDiscounts(query: any) {
    return this.prisma.subscriberDiscount.findMany({
      where: {
        ...(query?.subscriberId ? { subscriberId: +query.subscriberId } : {}),
        ...(query?.isActive ? { isActive: query.isActive === 'true' } : {}),
        ...(query?.type ? { type: query.type } : {}),
      },
      orderBy: { id: 'desc' },
    });
  }

  async getDiscount(id: number) {
    const d = await this.prisma.subscriberDiscount.findUnique({
      where: { id },
    });
    if (!d) throw new NotFoundException(`Discount ${id} not found`);
    return d;
  }

  async createDiscount(body: any, actor: any) {
    if (!body?.subscriberId) throw new BadRequestException('subscriberId is required');
    if (!body?.type) throw new BadRequestException('type is required (PERCENT | FIXED)');
    if (!body?.value) throw new BadRequestException('value is required');
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
