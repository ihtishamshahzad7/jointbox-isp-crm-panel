import {
  Injectable, Logger, NotFoundException, BadRequestException, ConflictException, ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
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

    // Tenant-owned legacy stock remains visible after its current holder is
    // cleared; null-company central stock is never included in this branch.
    if (actor && !this.scope.isAdmin(actor.role)) {
      const companyId = await this.scope.rootId(actor);
      const ids = await this.scope.descendantIds(companyId);
      where.AND = [...(where.AND || []), {
        OR: [{ companyId }, { companyId: null, ownerId: { in: ids } }],
      }];
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
      const companyId = await this.scope.rootId(actor);
      if (item.companyId != null && item.companyId !== companyId) {
        throw new ForbiddenException('This item belongs to another company.');
      }
      if (item.companyId === companyId) {
        if (item.ownerId) await this.scope.assertUser(actor, item.ownerId);
        return item;
      }
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
      const companyId = await this.scope.rootId(actor);
      const ids = await this.scope.descendantIds(companyId);
      where.OR = [{ companyId }, { companyId: null, ownerId: { in: ids } }];
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

    /**
     * Stock is held by an account in the caller's own tree. The holder id was
     * taken from the body unchecked, so a dealer could put items into another
     * company's inventory; and an item with no holder landed in a shared
     * "unassigned" pool no company can see. Unassigned now means the caller's
     * own store.
     */
    let ownerId: number | null = data.ownerId ? Number(data.ownerId) : null;
    let companyId: number | null = null;
    if (actor && !this.scope.isAdmin(actor.role)) {
      if (ownerId) await this.scope.assertUser(actor, ownerId);
      else ownerId = await this.scope.rootId(actor);
      companyId = await this.scope.rootId(actor);
    }
    const price = data.purchasePrice != null && data.purchasePrice !== '' ? Number(data.purchasePrice) : null;
    if (price != null && (!Number.isFinite(price) || price < 0)) throw new BadRequestException('Purchase price must be zero or more.');

    const item = await this.prisma.inventoryItem.create({
      data: {
        serialNumber:  serial,
        macAddress:    data.macAddress?.trim() || null,
        type:          data.type  || 'ONU',
        brand:         data.brand || null,
        model:         data.model || null,
        status:        data.ownerId ? 'ASSIGNED' : 'IN_STOCK',
        purchasePrice: price,
        purchaseDate:  data.purchaseDate  ? new Date(data.purchaseDate)  : null,
        warrantyUntil: data.warrantyUntil ? new Date(data.warrantyUntil) : null,
        supplier:      data.supplier || null,
        ownerId,
        companyId,
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
    if (item.fieldJobId || item.reservedForFieldJobId) {
      throw new ConflictException('This item is reserved or issued for a field job.');
    }
    if (item.status === 'INSTALLED') {
      throw new BadRequestException(
        `This unit is installed at ${item.subscriber?.fullName ?? 'a customer'}. Uninstall it first.`,
      );
    }
    if (actor && !this.scope.isAdmin(actor.role)) await this.scope.assertUser(actor, userId);

    const companyId = (await this.scope.companyRootId(userId)) ?? item.companyId;
    const updated = await this.prisma.inventoryItem.updateMany({
      where: {
        id,
        ownerId: item.ownerId,
        status: item.status,
        fieldJobId: null,
        reservedForFieldJobId: null,
      },
      data: { ownerId: userId, companyId, status: 'ASSIGNED', subscriberId: null, installedAt: null },
    });
    if (updated.count !== 1) throw new ConflictException('Inventory item changed during assignment. Refresh and retry.');
    await this.logMovement(id, {
      fromUserId: item.ownerId, toUserId: userId,
      fromStatus: item.status, toStatus: 'ASSIGNED',
      byUserId: actor ? this.scope.actorId(actor) : null,
      notes: 'Issued to reseller',
    });
    return this.prisma.inventoryItem.findUniqueOrThrow({ where: { id } });
  }

  /** Install at a customer — this is what ties hardware to a subscriber. */
  async installAtSubscriber(id: number, subscriberId: number, actor?: Actor) {
    const item = await this.findOne(id, actor);
    if (item.fieldJobId || item.reservedForFieldJobId) {
      throw new ConflictException('This item is reserved or issued for a field job.');
    }
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);

    const updated = await this.prisma.inventoryItem.updateMany({
      where: {
        id,
        ownerId: item.ownerId,
        status: item.status,
        fieldJobId: null,
        reservedForFieldJobId: null,
      },
      data: { subscriberId, status: 'INSTALLED', installedAt: new Date() },
    });
    if (updated.count !== 1) throw new ConflictException('Inventory item changed during installation. Refresh and retry.');
    await this.logMovement(id, {
      fromUserId: item.ownerId, toUserId: item.ownerId, subscriberId,
      fromStatus: item.status, toStatus: 'INSTALLED',
      byUserId: actor ? this.scope.actorId(actor) : null,
      notes: 'Installed at customer',
    });
    return this.prisma.inventoryItem.findUniqueOrThrow({ where: { id } });
  }

  /** Take it back — faulty, cancelled customer, or upgrade swap. */
  async returnItem(id: number, status: 'IN_STOCK' | 'FAULTY' | 'RETURNED' | 'LOST', actor?: Actor, notes?: string) {
    const item = await this.findOne(id, actor);
    if (item.fieldJobId || item.reservedForFieldJobId) {
      throw new ConflictException('Return field-job materials through the linked field job.');
    }
    const updated = await this.prisma.inventoryItem.updateMany({
      where: {
        id,
        ownerId: item.ownerId,
        status: item.status,
        fieldJobId: null,
        reservedForFieldJobId: null,
      },
      data: {
        status,
        subscriberId: null,
        installedAt: null,
        // Returning to stock releases it from the reseller; faulty/lost stay
        // attributed so the loss is traceable to whoever held it.
        ownerId: status === 'IN_STOCK' ? null : item.ownerId,
      },
    });
    if (updated.count !== 1) throw new ConflictException('Inventory item changed during return. Refresh and retry.');
    await this.logMovement(id, {
      fromUserId: item.ownerId,
      subscriberId: item.subscriberId,
      fromStatus: item.status, toStatus: status,
      byUserId: actor ? this.scope.actorId(actor) : null,
      notes: notes || `Marked ${status}`,
    });
    return this.prisma.inventoryItem.findUniqueOrThrow({ where: { id } });
  }

  async fieldJobMovements(actor: Actor, fieldJobId: number) {
    await this.assertFieldJobScope(actor, fieldJobId);
    const rows = await this.prisma.inventoryMovement.findMany({
      where: { fieldJobId },
      include: {
        item: { select: { id: true, serialNumber: true, type: true, brand: true, model: true, status: true } },
        employee: { select: { id: true, name: true, designation: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows;
  }

  async legacyUnowned(actor: Actor) {
    if (actor?.role !== 'ADMIN') {
      throw new ForbiddenException('Only a company administrator can reconcile legacy stock ownership.');
    }
    const companyId = await this.scope.companyRootId(this.scope.actorId(actor));
    if (!companyId) throw new ForbiddenException('A company scope is required.');
    const userIds = await this.scope.descendantIds(companyId);
    return this.prisma.inventoryItem.findMany({
      where: {
        companyId: null,
        ownerId: null,
        status: 'IN_STOCK',
        fieldJobId: null,
        reservedForFieldJobId: null,
        movements: {
          some: {
            OR: [
              { byUserId: { in: userIds } },
              { fromUserId: { in: userIds } },
              { toUserId: { in: userIds } },
            ],
          },
        },
      },
      select: {
        id: true,
        serialNumber: true,
        type: true,
        brand: true,
        model: true,
        status: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }

  async reconcileLegacyOwnership(itemId: number, reason: string, actor: Actor) {
    if (actor?.role !== 'ADMIN') {
      throw new ForbiddenException('Only a company administrator can reconcile legacy stock ownership.');
    }
    if (!Number.isSafeInteger(itemId) || itemId < 1) throw new BadRequestException('A valid inventory item is required.');
    const note = typeof reason === 'string' ? reason.trim() : '';
    if (!note || note.length > 500) throw new BadRequestException('A reconciliation reason of up to 500 characters is required.');
    const actorUserId = this.scope.actorId(actor);
    const companyId = await this.scope.companyRootId(actorUserId);
    if (!companyId) throw new ForbiddenException('A company scope is required.');
    const userIds = await this.scope.descendantIds(companyId);

    return this.prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findFirst({
        where: {
          id: itemId,
          companyId: null,
          ownerId: null,
          status: 'IN_STOCK',
          fieldJobId: null,
          reservedForFieldJobId: null,
          movements: {
            some: {
              OR: [
                { byUserId: { in: userIds } },
                { fromUserId: { in: userIds } },
                { toUserId: { in: userIds } },
              ],
            },
          },
        },
      });
      if (!item) throw new NotFoundException('No eligible legacy stock with custody evidence was found for this company.');
      const changed = await tx.inventoryItem.updateMany({
        where: {
          id: item.id,
          companyId: null,
          ownerId: null,
          status: 'IN_STOCK',
          fieldJobId: null,
          reservedForFieldJobId: null,
        },
        data: { companyId, ownerId: companyId },
      });
      if (changed.count !== 1) throw new ConflictException('Inventory ownership changed during reconciliation.');
      await tx.inventoryMovement.create({
        data: {
          itemId: item.id,
          fromUserId: null,
          toUserId: companyId,
          fromStatus: item.status,
          toStatus: item.status,
          byUserId: actorUserId,
          movementType: 'OWNERSHIP_RECONCILED',
          idempotencyKey: `legacy-stock-reconcile-${item.id}-${randomUUID()}`,
          notes: note,
        },
      });
      await tx.activityLog.create({
        data: {
          userId: actorUserId,
          action: 'INVENTORY.OWNERSHIP_RECONCILED',
          entity: 'InventoryItem',
          entityId: item.id,
          details: `Reconciled legacy serialized item ${item.serialNumber} to company ${companyId}: ${note}`,
        },
      });
      return tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async applyFieldJobMovement(
    actor: Actor,
    fieldJobId: number,
    input: { itemId: number; action: string; idempotencyKey: string; notes?: string },
  ) {
    const { companyId, job } = await this.assertFieldJobScope(actor, fieldJobId);
    const companyUserIds = await this.scope.descendantIds(companyId);
    const actorUserId = this.scope.actorId(actor);
    const itemId = Number(input.itemId);
    const action = String(input.action || '').toUpperCase();
    const key = String(input.idempotencyKey || '').trim();
    const note = typeof input.notes === 'string' ? input.notes.trim().slice(0, 1000) : '';
    const actions = ['RESERVE', 'UNRESERVE', 'ISSUE', 'CONSUME', 'RETURN', 'DAMAGED', 'LOST'];
    if (!Number.isSafeInteger(itemId) || itemId < 1) throw new BadRequestException('A valid inventory item is required.');
    if (!actions.includes(action)) throw new BadRequestException('Unknown field-job material operation.');
    if (key.length < 8 || key.length > 120) {
      throw new BadRequestException('An idempotency key between 8 and 120 characters is required.');
    }

    return this.prisma.$transaction(async (tx) => {
      const prior = await tx.inventoryMovement.findUnique({
        where: { idempotencyKey: key },
        include: {
          item: { select: { id: true, serialNumber: true, type: true, status: true } },
          employee: { select: { id: true, name: true } },
        },
      });
      if (prior) {
        if (prior.fieldJobId !== fieldJobId || prior.itemId !== itemId || prior.movementType !== action) {
          throw new ConflictException('This idempotency key was already used for a different inventory movement.');
        }
        return prior;
      }

      const currentJob = await tx.fieldJob.findUnique({
        where: { id: fieldJobId },
        select: { status: true, assignedTo: true, subscriberId: true },
      });
      if (!currentJob || currentJob.assignedTo !== job.assignedTo) {
        throw new ConflictException('Field-job assignment changed during this operation. Refresh and retry.');
      }
      if (['RESERVE', 'ISSUE'].includes(action) && !['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(currentJob.status)) {
        throw new ConflictException('Materials cannot be reserved or issued for a closed field job.');
      }
      if (action === 'CONSUME' && !['IN_PROGRESS', 'PENDING_REVIEW'].includes(currentJob.status)) {
        throw new ConflictException('Materials can only be recorded as consumed while work is in progress or awaiting review.');
      }
      if (action === 'CONSUME' && !currentJob.subscriberId) {
        throw new ConflictException('Link this field job to a subscriber before recording installed materials as consumed.');
      }
      const needsActiveEmployee = ['RESERVE', 'ISSUE'].includes(action);
      const employee = currentJob.assignedTo
        ? await tx.employeeProfile.findFirst({
            where: {
              companyId,
              userId: currentJob.assignedTo,
              ...(needsActiveEmployee ? { status: 'ACTIVE' } : {}),
            },
            select: { id: true },
          })
        : null;
      if (needsActiveEmployee && !employee) {
        throw new BadRequestException('Assign an active employee before reserving or issuing materials.');
      }

      const item = await tx.inventoryItem.findUnique({ where: { id: itemId } });
      if (!item) throw new NotFoundException('Inventory item not found.');
      if ((item.companyId != null && item.companyId !== companyId) ||
        (item.companyId == null && (!item.ownerId || !companyUserIds.includes(item.ownerId)))) {
        throw new NotFoundException('Inventory item is not available in this company.');
      }

      let data: Prisma.InventoryItemUncheckedUpdateManyInput;
      let fromStatus = item.status;
      let toStatus = item.status;
      let toUserId: number | null = item.ownerId;
      let subscriberId: number | null = null;
      switch (action) {
        case 'RESERVE':
          if (item.fieldJobId || item.reservedForFieldJobId) {
            throw new ConflictException('This item is already issued or reserved for another job.');
          }
          if (!['IN_STOCK', 'ASSIGNED'].includes(item.status)) {
            throw new ConflictException(`Items in ${item.status} status cannot be reserved.`);
          }
          data = { reservedForFieldJobId: fieldJobId };
          break;
        case 'UNRESERVE':
          if (item.reservedForFieldJobId !== fieldJobId || item.fieldJobId) {
            throw new ConflictException('Only a material reserved for this job can be released.');
          }
          data = { reservedForFieldJobId: null };
          break;
        case 'ISSUE':
          if (item.fieldJobId === fieldJobId && item.status === 'ASSIGNED') {
            throw new ConflictException('This item has already been issued to this job.');
          }
          if (item.fieldJobId || (item.reservedForFieldJobId && item.reservedForFieldJobId !== fieldJobId)) {
            throw new ConflictException('This item is already issued or reserved for another job.');
          }
          if (!['IN_STOCK', 'ASSIGNED'].includes(item.status)) {
            throw new ConflictException(`Items in ${item.status} status cannot be issued.`);
          }
          data = {
            status: 'ASSIGNED',
            ownerId: job.assignedTo,
            fieldJobId,
            reservedForFieldJobId: null,
            subscriberId: null,
            installedAt: null,
          };
          toStatus = 'ASSIGNED';
          toUserId = job.assignedTo;
          break;
        case 'CONSUME':
          if (item.fieldJobId !== fieldJobId || item.status !== 'ASSIGNED') {
            throw new ConflictException('Only an item issued to this job can be recorded as consumed.');
          }
          data = {
            status: 'INSTALLED',
            subscriberId: currentJob.subscriberId,
            installedAt: new Date(),
            fieldJobId: null,
            reservedForFieldJobId: null,
          };
          toStatus = 'INSTALLED';
          subscriberId = currentJob.subscriberId;
          break;
        case 'RETURN':
        case 'DAMAGED':
        case 'LOST':
          if (item.fieldJobId !== fieldJobId || item.status !== 'ASSIGNED') {
            throw new ConflictException('Only an item issued to this job can be returned or reported.');
          }
          toStatus = action === 'RETURN' ? 'IN_STOCK' : action === 'DAMAGED' ? 'FAULTY' : 'LOST';
          data = {
            status: toStatus,
            ownerId: action === 'RETURN' ? companyId : item.ownerId,
            subscriberId: null,
            installedAt: null,
            fieldJobId: null,
            reservedForFieldJobId: null,
          };
          toUserId = action === 'RETURN' ? companyId : item.ownerId;
          break;
        default:
          throw new BadRequestException('Unknown field-job material operation.');
      }

      const changed = await tx.inventoryItem.updateMany({
        where: {
          id: item.id,
          status: item.status,
          ownerId: item.ownerId,
          fieldJobId: item.fieldJobId,
          reservedForFieldJobId: item.reservedForFieldJobId,
        },
        data,
      });
      if (changed.count !== 1) {
        throw new ConflictException('Inventory item changed during this operation. Refresh and retry.');
      }

      const movement = await tx.inventoryMovement.create({
        data: {
          itemId: item.id,
          fromUserId: item.ownerId,
          toUserId,
          subscriberId,
          fromStatus,
          toStatus,
          byUserId: actorUserId,
          fieldJobId,
          employeeId: employee?.id ?? null,
          movementType: action,
          idempotencyKey: key,
          notes: note || `Field job ${job.jobNo}: ${action.toLowerCase()}`,
        },
        include: {
          item: { select: { id: true, serialNumber: true, type: true, status: true } },
          employee: { select: { id: true, name: true } },
        },
      });
      await tx.fieldJobActivity.create({
        data: {
          fieldJobId,
          actorUserId,
          action: 'MATERIAL',
          detail: `${action} inventory item ${item.serialNumber}${note ? `: ${note}` : ''}`,
        },
      });
      await tx.activityLog.create({
        data: {
          userId: actorUserId,
          action: `FIELD_JOB.MATERIAL_${action}`,
          entity: 'FieldJob',
          entityId: fieldJobId,
          details: `${action} inventory item ${item.serialNumber} for job ${job.jobNo}.`,
        },
      });
      return movement;
    }, { isolationLevel: 'Serializable' }).catch(async (error) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          const prior = await this.prisma.inventoryMovement.findUnique({
            where: { idempotencyKey: key },
            include: {
              item: { select: { id: true, serialNumber: true, type: true, status: true } },
              employee: { select: { id: true, name: true } },
            },
          });
          if (prior) {
            if (prior.fieldJobId !== fieldJobId || prior.itemId !== itemId || prior.movementType !== action) {
              throw new ConflictException('This idempotency key was already used for a different inventory movement.');
            }
            return prior;
          }
        }
        if (error.code === 'P2034') {
          throw new ConflictException('Inventory changed concurrently. Refresh and retry the movement.');
        }
      }
      throw error;
    });
  }

  private async assertFieldJobScope(actor: Actor, fieldJobId: number) {
    const job = await this.prisma.fieldJob.findUnique({
      where: { id: fieldJobId },
      select: {
        id: true,
        jobNo: true,
        status: true,
        subscriberId: true,
        assignedTo: true,
        createdById: true,
        subscriber: { select: { userId: true } },
        lead: { select: { companyId: true } },
      },
    });
    if (!job) throw new NotFoundException('Field job not found.');

    const candidateUserIds = [job.subscriber?.userId, job.assignedTo, job.createdById].filter(
      (id): id is number => id != null,
    );
    let companyId = job.lead?.companyId ?? null;
    for (const candidate of candidateUserIds) {
      companyId ??= await this.scope.companyRootId(candidate);
      if (companyId != null) break;
    }
    if (companyId == null) throw new NotFoundException('Field job not found.');
    if (actor?.role !== 'SUPER_ADMIN') {
      const actorCompanyId = await this.scope.companyRootId(this.scope.actorId(actor));
      const visibleUsers = await this.scope.descendantIds(await this.scope.rootId(actor));
      const visible =
        actorCompanyId === companyId &&
        (visibleUsers.includes(job.assignedTo ?? -1) ||
          visibleUsers.includes(job.createdById ?? -1) ||
          (job.subscriber?.userId != null && visibleUsers.includes(job.subscriber.userId)));
      if (!visible) throw new NotFoundException('Field job not found.');
    }
    return { companyId, job };
  }

  async remove(id: number, actor?: Actor) {
    const item = await this.findOne(id, actor);
    if (item.fieldJobId || item.reservedForFieldJobId) {
      throw new ConflictException('This item is reserved or issued for a field job.');
    }
    if (item.status === 'INSTALLED') {
      throw new BadRequestException('Cannot delete an installed unit — return it first.');
    }
    const deleted = await this.prisma.inventoryItem.deleteMany({
      where: { id, status: { not: 'INSTALLED' }, fieldJobId: null, reservedForFieldJobId: null },
    });
    if (deleted.count !== 1) throw new ConflictException('Inventory item changed before it could be deleted.');
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
