import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

@Injectable()
export class AreasService {
  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  /**
   * Areas this account may see.
   *
   * Previously unscoped, so a dealer in Kahuta had every other dealer's
   * coverage areas in their dropdown. Each account now sees its own and its
   * descendants' — a franchise still oversees its dealers' areas, which is
   * the tree it is responsible for.
   */
  async findAll(actor?: Actor) {
    return this.prisma.area.findMany({
      where: await this.scope.ownedWhere(actor as any),
      orderBy: { createdAt: 'desc' },
      include: {
        subscribers: true,
        owner: { select: { id: true, name: true, role: true } },
        _count: {
          select: { subscribers: true },
        },
      },
    });
  }

  async findOne(id: number) {
    return this.prisma.area.findUnique({
      where: { id },
      include: {
        subscribers: true,
        _count: {
          select: { subscribers: true },
        },
      },
    });
  }

  async create(data: { name: string; city?: string }, actor?: Actor) {
    return this.prisma.area.create({
      data: {
        ...data,
        // Stamp the creator. Without this the area belongs to nobody and
        // falls out of every scoped query, including its creator's.
        ownerId: actor ? this.scope.actorId(actor) : null,
      },
    });
  }

  async update(id: number, data: any) {
    return this.prisma.area.update({ where: { id }, data });
  }

  async remove(id: number) {
    return this.prisma.area.delete({ where: { id } });
  }

  async toggleArea(id: number) {
    const area = await this.prisma.area.findUnique({ where: { id } });
    if (!area) throw new Error('Area not found');

    return this.prisma.area.update({
      where: { id },
      data: { isActive: !area.isActive },
    });
  }

  async getStats(actor?: Actor) {
    // Scope to the caller's own areas (same ownedWhere as findAll) — unscoped it
    // leaked every account's area counts.
    const base = await this.scope.ownedWhere(actor as any);
    const w = (extra: any = {}) => (base && Object.keys(base).length ? { AND: [base, extra] } : extra);
    const total = await this.prisma.area.count({ where: w() });
    const active = await this.prisma.area.count({ where: w({ isActive: true }) });
    const inactive = await this.prisma.area.count({ where: w({ isActive: false }) });
    return { total, active, inactive };
  }
}
