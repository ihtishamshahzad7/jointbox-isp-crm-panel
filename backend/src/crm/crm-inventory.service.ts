import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { PermissionsGuard } from '../security/permissions.guard';
import { canRead, canWrite } from '../common/permission-check';

/**
 * ADVANCED CRM — WAREHOUSES, QR LABELS AND QR STOCK COUNTS.
 *
 * Ported in behaviour from the reference CRM (crm_warehouses.py,
 * crm_inventory_qr.py) onto Uplinko's OWN inventory: the units are the
 * existing InventoryItem rows and every move is written to the existing
 * InventoryMovement history. Nothing here keeps a second stock list.
 *
 *   Warehouses — named places stock sits in, per account.
 *   QR labels  — one opaque code per unit, issued once, unique.
 *   Transfers  — in-stock units moved between warehouses, all or nothing.
 *   Stocktake  — open a count (the expected units are frozen then), scan QR
 *                codes, close it: what is missing, what turned up unexpected.
 *
 * Safeguards are in the database, not in the order of JS statements: a QR
 * code is set only where none exists (conditional UPDATE), a transfer moves
 * exactly the units asked for or rolls back, only one count may be open per
 * warehouse (partial unique index), and closing is a conditional UPDATE so
 * a late scan cannot land in a closed count.
 */
const MAX_BATCH = 500;
const QR_PREFIX = 'UPL-';

const toInt = (v: unknown, what: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestException(`${what} is not valid.`);
  return n;
};

const idList = (v: unknown, what = 'items'): number[] => {
  if (!Array.isArray(v) || v.length === 0) throw new BadRequestException(`Choose the ${what}.`);
  if (v.length > MAX_BATCH) throw new BadRequestException(`At most ${MAX_BATCH} ${what} at a time.`);
  return [...new Set(v.map((x) => toInt(x, 'An item id')))];
};

@Injectable()
export class CrmInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly perms: PermissionsGuard,
  ) {}

  // ── access ────────────────────────────────────────────────────────────────

  private async read(actor: Actor) {
    if (!(await canRead(this.perms, actor, 'inventory'))) throw new ForbiddenException('Missing permission: inventory.read');
  }

  private async write(actor: Actor) {
    if (!(await canWrite(this.perms, actor, 'inventory'))) throw new ForbiddenException('Missing permission: inventory.write');
  }

  /** Stock/warehouses the caller may touch — ScopeService decides (own subtree; demo stock kept out). */
  private ownerWhere(actor: Actor) {
    return this.scope.ownedWhere(actor);
  }
  /**
   * Warehouses and counts have no `owner` relation, so they cannot use
   * ownedWhere()'s relation filter: own subtree for a company; for the
   * platform, everything except the demo sandbox's accounts.
   */
  private async placeWhere(actor: Actor) {
    if (!this.scope.isAdmin(actor?.role)) {
      return { ownerId: { in: await this.scope.descendantIds(await this.scope.rootId(actor)) } };
    }
    const demo = [...(await this.scope.demoUserIds())];
    return demo.length ? { ownerId: { notIn: demo } } : {};
  }


  private actorId(actor: Actor): number | null {
    const id = Number(actor?.sub ?? actor?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  private async warehouse(actor: Actor, id: number) {
    const w = (await this.prisma.crmWarehouse.findFirst({ where: { id, ...(await this.placeWhere(actor)) } } as never)) as any;
    if (!w) throw new NotFoundException('Warehouse not found');
    return w;
  }

  // ── warehouses ────────────────────────────────────────────────────────────

  async listWarehouses(actor: Actor) {
    await this.read(actor);
    const where = await this.ownerWhere(actor);
    const rows = (await this.prisma.crmWarehouse.findMany({ where: await this.placeWhere(actor), orderBy: { name: 'asc' }, take: 500 } as never)) as any[];
    if (!rows.length) return [];
    const counts = (await this.prisma.inventoryItem.groupBy({
      by: ['warehouseId', 'status'],
      where: { ...where, warehouseId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    } as never)) as unknown as Array<{ warehouseId: number; status: string; _count: { _all: number } }>;
    return rows.map((w) => {
      const mine = counts.filter((c) => c.warehouseId === w.id);
      return {
        ...w,
        inStock: mine.filter((c) => c.status === 'IN_STOCK').reduce((n, c) => n + c._count._all, 0),
        total: mine.reduce((n, c) => n + c._count._all, 0),
      };
    });
  }

  private parseWarehouse(body: any, partial: boolean) {
    const out: Record<string, unknown> = {};
    if (!partial || body?.name !== undefined) {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 80) throw new BadRequestException('Give the warehouse a name of up to 80 characters.');
      out.name = name;
    }
    if (body?.address !== undefined) out.address = body.address ? String(body.address).trim().slice(0, 300) : null;
    if (partial && body?.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean') throw new BadRequestException('isActive must be true or false.');
      out.isActive = body.isActive;
    }
    return out;
  }

  async createWarehouse(actor: Actor, body: any) {
    await this.write(actor);
    const data = this.parseWarehouse(body, false);
    const ownerId = await this.scope.rootId(actor);
    try {
      return await this.prisma.crmWarehouse.create({ data: { ...data, ownerId } } as never);
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException(`A warehouse called "${data.name}" already exists.`);
      throw e;
    }
  }

  async updateWarehouse(actor: Actor, id: number, body: any) {
    await this.write(actor);
    await this.warehouse(actor, id);
    const data = this.parseWarehouse(body, true);
    if (!Object.keys(data).length) throw new BadRequestException('Nothing to change.');
    try {
      return await this.prisma.crmWarehouse.update({ where: { id }, data } as never);
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException(`A warehouse called "${data.name}" already exists.`);
      throw e;
    }
  }

  // ── QR labels ─────────────────────────────────────────────────────────────

  private newCode(): string {
    // 16 base32 chars ≈ 80 bits: unguessable, short enough to print.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(16);
    let s = '';
    for (const b of bytes) s += alphabet[b & 31];
    return QR_PREFIX + s;
  }

  /**
   * Give each unit a QR code if it has none. Existing codes are kept — a
   * printed label must never stop matching. Returns every unit's code.
   */
  async issueQr(actor: Actor, body: any) {
    await this.write(actor);
    const ids = idList(body?.itemIds);
    const scope = await this.ownerWhere(actor);
    const items = (await this.prisma.inventoryItem.findMany({
      where: { id: { in: ids }, ...scope },
      select: { id: true, qrCode: true },
    } as never)) as any[];
    if (items.length !== ids.length) throw new NotFoundException('One or more items were not found in your stock.');
    for (const it of items.filter((i) => !i.qrCode)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Conditional: only where still unlabelled, so two printers cannot relabel a unit.
          await this.prisma.inventoryItem.updateMany({ where: { id: it.id, qrCode: null }, data: { qrCode: this.newCode() } } as never);
          break;
        } catch (e: any) {
          if (e?.code !== 'P2002' || attempt === 2) throw e; // code collision: try another
        }
      }
    }
    const rows = (await this.prisma.inventoryItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, qrCode: true, serialNumber: true, type: true, brand: true, model: true },
      orderBy: { id: 'asc' },
    } as never)) as any[];
    return rows.map((r) => ({ ...r, type: String(r.type) }));
  }

  /** What a scanned label is: the unit, where it sits and who holds it. */
  async scan(actor: Actor, code: string) {
    await this.read(actor);
    const qr = String(code || '').trim().toUpperCase();
    if (!/^UPL-[A-Z0-9]{16}$/.test(qr)) throw new NotFoundException('Unknown label');
    const item = (await this.prisma.inventoryItem.findFirst({
      where: { qrCode: qr, ...(await this.ownerWhere(actor)) },
      select: {
        id: true, qrCode: true, serialNumber: true, macAddress: true, type: true, brand: true, model: true,
        status: true, warehouseId: true, ownerId: true, subscriberId: true,
        subscriber: { select: { id: true, fullName: true, username: true } },
      },
    } as never)) as any;
    if (!item) throw new NotFoundException('Unknown label'); // also for another company's label
    const warehouse = item.warehouseId
      ? ((await this.prisma.crmWarehouse.findUnique({ where: { id: item.warehouseId }, select: { id: true, name: true } } as never)) as any)
      : null;
    return { ...item, type: String(item.type), status: String(item.status), warehouse };
  }

  // ── transfers ─────────────────────────────────────────────────────────────

  /**
   * Move in-stock units into a warehouse. All or nothing: inside one
   * transaction the UPDATE is conditioned on scope and status and must touch
   * exactly the units asked for — otherwise it rolls back, so a unit issued to
   * a customer a moment ago can never be "transferred" from the shelf.
   */
  async transfer(actor: Actor, body: any) {
    await this.write(actor);
    const ids = idList(body?.itemIds);
    const to = await this.warehouse(actor, toInt(body?.toWarehouseId, 'The destination warehouse'));
    if (!to.isActive) throw new BadRequestException(`${to.name} is switched off.`);
    const notes = body?.notes ? String(body.notes).trim().slice(0, 300) : '';
    const scope = await this.ownerWhere(actor);
    const by = this.actorId(actor);

    return this.prisma.$transaction(async (tx: any) => {
      const before = (await tx.inventoryItem.findMany({
        where: { id: { in: ids }, ...scope },
        select: { id: true, warehouseId: true, status: true },
      })) as any[];
      if (before.length !== ids.length) throw new NotFoundException('One or more items were not found in your stock.');
      const moving = before.filter((b) => b.warehouseId !== to.id);
      if (!moving.length) return { moved: 0, toWarehouseId: to.id };
      const r = await tx.inventoryItem.updateMany({
        where: { id: { in: moving.map((m) => m.id) }, status: 'IN_STOCK', ...scope, OR: [{ warehouseId: null }, { warehouseId: { not: to.id } }] },
        data: { warehouseId: to.id },
      });
      if (r.count !== moving.length) {
        throw new ConflictException('Only units that are in stock can be transferred. Some of these are installed, issued or were changed just now — refresh and try again.');
      }
      const names = new Map<number, string>(
        ((await tx.crmWarehouse.findMany({ where: { id: { in: moving.map((m) => m.warehouseId).filter(Boolean) } }, select: { id: true, name: true } })) as any[]).map(
          (w) => [w.id, w.name],
        ),
      );
      await tx.inventoryMovement.createMany({
        data: moving.map((m) => ({
          itemId: m.id,
          fromStatus: 'IN_STOCK',
          toStatus: 'IN_STOCK',
          byUserId: by,
          notes: `Warehouse transfer: ${m.warehouseId ? names.get(m.warehouseId) ?? `#${m.warehouseId}` : 'unassigned'} → ${to.name}${notes ? ` · ${notes}` : ''}`.slice(0, 500),
        })),
      });
      return { moved: moving.length, toWarehouseId: to.id };
    });
  }

  // ── stock counts ──────────────────────────────────────────────────────────

  async openStocktake(actor: Actor, body: any) {
    await this.write(actor);
    const w = await this.warehouse(actor, toInt(body?.warehouseId, 'The warehouse'));
    const scope = await this.ownerWhere(actor);
    try {
      return await this.prisma.$transaction(async (tx: any) => {
        const st = await tx.crmStocktake.create({
          data: { warehouseId: w.id, ownerId: w.ownerId, createdById: this.actorId(actor) },
        });
        const expected = (await tx.inventoryItem.findMany({
          where: { warehouseId: w.id, status: 'IN_STOCK', ...scope },
          select: { id: true },
        })) as any[];
        if (expected.length) {
          await tx.crmStocktakeLine.createMany({ data: expected.map((e) => ({ stocktakeId: st.id, itemId: e.id, expected: true })) });
        }
        return { ...st, expected: expected.length };
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException(`A count of ${w.name} is already in progress. Finish or close it first.`);
      throw e;
    }
  }

  private async stocktake(actor: Actor, id: number) {
    const st = (await this.prisma.crmStocktake.findFirst({ where: { id, ...(await this.placeWhere(actor)) } } as never)) as any;
    if (!st) throw new NotFoundException('Count not found');
    return st;
  }

  /** Record one scanned label. Idempotent: scanning the same unit twice is harmless. */
  async scanIntoStocktake(actor: Actor, id: number, body: any) {
    await this.write(actor);
    const st = await this.stocktake(actor, id);
    if (st.status !== 'OPEN') throw new ConflictException('This count is closed.');
    const item = await this.scan(actor, body?.code);
    const by = this.actorId(actor);
    // One statement: mark an expected line found, or add an unexpected one —
    // and only while the count is still OPEN (a close racing this scan wins cleanly).
    const n = await this.prisma.$executeRaw`
      INSERT INTO "crm_stocktake_line" ("stocktakeId", "itemId", "expected", "scannedAt", "scannedById")
      SELECT ${st.id}, ${item.id}, false, NOW(), ${by}
      WHERE EXISTS (SELECT 1 FROM "crm_stocktake" WHERE "id" = ${st.id} AND "status" = 'OPEN')
      ON CONFLICT ("stocktakeId", "itemId") DO UPDATE
        SET "scannedAt" = COALESCE("crm_stocktake_line"."scannedAt", EXCLUDED."scannedAt"),
            "scannedById" = COALESCE("crm_stocktake_line"."scannedById", EXCLUDED."scannedById")`;
    if (!n) throw new ConflictException('This count is closed.');
    const line = (await this.prisma.crmStocktakeLine.findUnique({
      where: { stocktakeId_itemId: { stocktakeId: st.id, itemId: item.id } },
    } as never)) as any;
    return {
      item: { id: item.id, qrCode: item.qrCode, serialNumber: item.serialNumber, type: item.type, status: item.status, warehouse: item.warehouse },
      expected: !!line?.expected,
      note: line?.expected ? 'Found' : item.warehouse?.id === st.warehouseId ? 'Not in stock when the count started' : 'Belongs to another warehouse',
    };
  }

  async closeStocktake(actor: Actor, id: number) {
    await this.write(actor);
    const st = await this.stocktake(actor, id);
    const r = (await this.prisma.crmStocktake.updateMany({
      where: { id: st.id, status: 'OPEN' },
      data: { status: 'CLOSED', closedAt: new Date() },
    } as never)) as any;
    if (r.count !== 1) throw new ConflictException('This count is already closed.');
    return this.report(actor, id);
  }

  async report(actor: Actor, id: number) {
    await this.read(actor);
    const st = await this.stocktake(actor, id);
    const lines = (await this.prisma.crmStocktakeLine.findMany({ where: { stocktakeId: st.id }, take: 20_000 } as never)) as any[];
    const ids = lines.map((l) => l.itemId);
    const items = new Map<number, any>(
      ((await this.prisma.inventoryItem.findMany({
        where: { id: { in: ids } },
        select: { id: true, qrCode: true, serialNumber: true, type: true, brand: true, model: true, status: true },
      } as never)) as any[]).map((i) => [i.id, { ...i, type: String(i.type), status: String(i.status) }]),
    );
    const pick = (f: (l: any) => boolean) => lines.filter(f).map((l) => items.get(l.itemId) ?? { id: l.itemId });
    const found = pick((l) => l.expected && l.scannedAt);
    const missing = pick((l) => l.expected && !l.scannedAt);
    const unexpected = pick((l) => !l.expected);
    return {
      id: st.id,
      warehouseId: st.warehouseId,
      status: st.status,
      createdAt: st.createdAt,
      closedAt: st.closedAt,
      counts: { expected: found.length + missing.length, found: found.length, missing: missing.length, unexpected: unexpected.length },
      missing,
      unexpected,
    };
  }
}
