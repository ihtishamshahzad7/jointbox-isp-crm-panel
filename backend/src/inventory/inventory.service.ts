import {
  Injectable, Logger, NotFoundException, BadRequestException, ConflictException, ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

/**
 * InventoryService — hardware stock and its chain of custody.
 *
 * The flow an ISP actually runs:
 *   warehouse → issued to reseller → installed at customer → (faulty) → returned
 *
 * Every hand-off writes an InventoryMovement, so months later you can answer
 * "who had this ONU?" and "is this unit still under warranty?" — the two
 * questions that decide who pays when hardware fails.
 *
 * Visibility follows the same rule as everything else: you see your own stock
 * and your downline's, never a sibling's.
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  // ── Read ─────────────────────────────────────────────────────
  async findAll(actor?: Actor, query: any = {}) {
    const where: any = {};

    if (query.status && query.status !== 'ALL') where.status = query.status;
    if (query.type && query.type !== 'ALL') where.type = query.type;
    if (query.ownerId) where.ownerId = Number(query.ownerId);
    if (query.q) {
      const q = String(query.q).trim();
      where.OR = [
        { serialNumber: { contains: q, mode: 'insensitive' } },
        { macAddress:   { contains: q, mode: 'insensitive' } },
        { model:        { contains: q, mode: 'insensitive' } },
        { brand:        { contains: q, mode: 'insensitive' } },
      ];
    }

    // Scope: own + downline stock. Unassigned stock is ISP-only.
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.ownerId = { in: ids };
    }

    return this.prisma.inventoryItem.findMany({
      where,
      include: {
        owner:      { select: { id: true, name: true, role: true } },
        subscriber: { select: { id: true, fullName: true, username: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: Number(query.limit) || 500,
    });
  }

  async findOne(id: number, actor?: Actor) {
    const item = await this.prisma.inventoryItem.findUnique({
      where: { id },
      include: {
        owner:      { select: { id: true, name: true, role: true } },
        subscriber: { select: { id: true, fullName: true, username: true, phone: true } },
        movements:  { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!item) throw new NotFoundException(`Inventory item ${id} not found`);

    // PRIVACY: a reseller may only read stock it (or its downline) holds.
    // Unowned stock is warehouse inventory and belongs to the ISP alone —
    // previously a null ownerId skipped the check entirely, so any reseller
    // could enumerate the whole warehouse by id.
    if (actor && !this.scope.isAdmin(actor.role)) {
      if (!item.ownerId) {
        throw new ForbiddenException('This item is held in central stock.');
      }
      await this.scope.assertUser(actor, item.ownerId);
    }
    return item;
  }

  /** Stock summary — what's where, and what's actually available to issue. */
  async stats(actor?: Actor) {
    const where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.ownerId = { in: ids };
    }

    const [byStatus, byType, total, warrantyExpiring] = await Promise.all([
      this.prisma.inventoryItem.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.inventoryItem.groupBy({ by: ['type'],   where, _count: { _all: true } }),
      this.prisma.inventoryItem.count({ where }),
      this.prisma.inventoryItem.count({
        where: {
          ...where,
          warrantyUntil: {
            gte: new Date(),
            lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        },
      }),
    ]);

    const statusMap: Record<string, number> = {};
    byStatus.forEach((s) => (statusMap[s.status] = s._count._all));

    return {
      total,
      inStock:   statusMap.IN_STOCK  ?? 0,
      assigned:  statusMap.ASSIGNED  ?? 0,
      installed: statusMap.INSTALLED ?? 0,
      faulty:    statusMap.FAULTY    ?? 0,
      returned:  statusMap.RETURNED  ?? 0,
      lost:      statusMap.LOST      ?? 0,
      warrantyExpiring30d: warrantyExpiring,
      byType: byType.map((t) => ({ type: t.type, count: t._count._all })),
    };
  }

  // ── Write ────────────────────────────────────────────────────
  async create(data: any, actor?: Actor) {
    const serial = String(data.serialNumber || '').trim();
    if (!serial) throw new BadRequestException('Serial number is required.');

    const exists = await this.prisma.inventoryItem.findUnique({ where: { serialNumber: serial } });
    if (exists) {
      throw new ConflictException(`Serial "${serial}" already exists (item #${exists.id}).`);
    }

    const item = await this.prisma.inventoryItem.create({
      data: {
        serialNumber:  serial,
        macAddress:    data.macAddress?.trim() || null,
        type:          data.type  || 'ONU',
        brand:         data.brand || null,
        model:         data.model || null,
        status:        data.ownerId ? 'ASSIGNED' : 'IN_STOCK',
        purchasePrice: data.purchasePrice ? Number(data.purchasePrice) : null,
        purchaseDate:  data.purchaseDate  ? new Date(data.purchaseDate)  : null,
        warrantyUntil: data.warrantyUntil ? new Date(data.warrantyUntil) : null,
        supplier:      data.supplier || null,
        ownerId:       data.ownerId ? Number(data.ownerId) : null,
        notes:         data.notes || null,
      },
    });

    await this.logMovement(item.id, {
      toStatus: item.status,
      toUserId: item.ownerId,
      byUserId: actor ? this.scope.actorId(actor) : null,
      notes: 'Added to inventory',
    });
    return item;
  }

  /** Bulk intake — a delivery of 200 ONUs shouldn't be 200 form submissions. */
  async bulkCreate(rows: any[], actor?: Actor) {
    const results: any[] = [];
    for (const row of rows || []) {
      try {
        results.push({ ok: true, item: await this.create(row, actor) });
      } catch (e: any) {
        results.push({ ok: false, serialNumber: row?.serialNumber, error: e?.message });
      }
    }
    return {
      requested: rows?.length || 0,
      created: results.filter((r) => r.ok).length,
      results,
    };
  }

  async update(id: number, data: any, actor?: Actor) {
    await this.findOne(id, actor); // scope check
    return this.prisma.inventoryItem.update({
      where: { id },
      data: {
        macAddress:    data.macAddress,
        brand:         data.brand,
        model:         data.model,
        type:          data.type,
        purchasePrice: data.purchasePrice !== undefined ? Number(data.purchasePrice) : undefined,
        purchaseDate:  data.purchaseDate  ? new Date(data.purchaseDate)  : undefined,
        warrantyUntil: data.warrantyUntil ? new Date(data.warrantyUntil) : undefined,
        supplier:      data.supplier,
        notes:         data.notes,
      },
    });
  }

  /** Issue stock to a reseller. */
  async assignToUser(id: number, userId: number, actor?: Actor) {
    const item = await this.findOne(id, actor);
    if (item.status === 'INSTALLED') {
      throw new BadRequestException(
        `This unit is installed at ${item.subscriber?.fullName ?? 'a customer'}. Uninstall it first.`,
      );
    }
    if (actor && !this.scope.isAdmin(actor.role)) await this.scope.assertUser(actor, userId);

    const updated = await this.prisma.inventoryItem.update({
      where: { id },
      data: { ownerId: userId, status: 'ASSIGNED', subscriberId: null, installedAt: null },
    });
    await this.logMovement(id, {
      fromUserId: item.ownerId, toUserId: userId,
      fromStatus: item.status, toStatus: 'ASSIGNED',
      byUserId: actor ? this.scope.actorId(actor) : null,
      notes: 'Issued to reseller',
    });
    return updated;
  }

  /** Install at a customer — this is what ties hardware to a subscriber. */
  async installAtSubscriber(id: number, subscriberId: number, actor?: Actor) {
    const item = await this.findOne(id, actor);
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);

    const updated = await this.prisma.inventoryItem.update({
      where: { id },
      data: { subscriberId, status: 'INSTALLED', installedAt: new Date() },
    });
    await this.logMovement(id, {
      fromUserId: item.ownerId, toUserId: item.ownerId, subscriberId,
      fromStatus: item.status, toStatus: 'INSTALLED',
      byUserId: actor ? this.scope.actorId(actor) : null,
      notes: 'Installed at customer',
    });
    return updated;
  }

  /** Take it back — faulty, cancelled customer, or upgrade swap. */
  async returnItem(id: number, status: 'IN_STOCK' | 'FAULTY' | 'RETURNED' | 'LOST', actor?: Actor, notes?: string) {
    const item = await this.findOne(id, actor);
    const updated = await this.prisma.inventoryItem.update({
      where: { id },
      data: {
        status,
        subscriberId: null,
        installedAt: null,
        // Returning to stock releases it from the reseller; faulty/lost stay
        // attributed so the loss is traceable to whoever held it.
        ownerId: status === 'IN_STOCK' ? null : item.ownerId,
      },
    });
    await this.logMovement(id, {
      fromUserId: item.ownerId,
      subscriberId: item.subscriberId,
      fromStatus: item.status, toStatus: status,
      byUserId: actor ? this.scope.actorId(actor) : null,
      notes: notes || `Marked ${status}`,
    });
    return updated;
  }

  async remove(id: number, actor?: Actor) {
    const item = await this.findOne(id, actor);
    if (item.status === 'INSTALLED') {
      throw new BadRequestException('Cannot delete an installed unit — return it first.');
    }
    await this.prisma.inventoryItem.delete({ where: { id } });
    return { deleted: true, id };
  }

  /** Full custody history for one unit. */
  async history(id: number, actor?: Actor) {
    await this.findOne(id, actor);
    const moves = await this.prisma.inventoryMovement.findMany({
      where: { itemId: id },
      orderBy: { createdAt: 'desc' },
    });
    const ids = [...new Set(moves.flatMap((m) => [m.fromUserId, m.toUserId, m.byUserId]).filter(Boolean))] as number[];
    const users = ids.length
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : [];
    const byId = new Map(users.map((u) => [u.id, u.name]));
    return moves.map((m) => ({
      ...m,
      fromUser: m.fromUserId ? byId.get(m.fromUserId) ?? null : null,
      toUser:   m.toUserId   ? byId.get(m.toUserId)   ?? null : null,
      byUser:   m.byUserId   ? byId.get(m.byUserId)   ?? null : null,
    }));
  }

  private async logMovement(itemId: number, data: any) {
    try {
      await this.prisma.inventoryMovement.create({ data: { itemId, ...data } });
    } catch (e: any) {
      this.logger.warn(`Movement log failed for item ${itemId}: ${e?.message || e}`);
    }
  }
}
