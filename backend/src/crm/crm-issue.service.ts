import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { PermissionsGuard } from '../security/permissions.guard';
import { canWrite, canRead } from '../common/permission-check';
import { InvoicesService } from '../invoices/invoices.service';
import { CrmTerminationService } from './crm-termination.service';

/**
 * ADVANCED CRM — EQUIPMENT ISSUED TO CUSTOMERS, AND ITS RECOVERY.
 *
 * Ported in behaviour from the reference CRM (stock issues billed to the
 * customer, crm_customer_ledger.bill_stock_issue; equipment recovery,
 * crm_termination.py) onto Uplinko's own records:
 *
 *   • the unit is the existing InventoryItem, moved IN_STOCK → INSTALLED,
 *     with the move written to the existing InventoryMovement history;
 *   • a charge is raised through the existing InvoicesService, so it gets the
 *     normal invoice number, double-entry posting and customer notification,
 *     and appears on the customer statement like any other invoice;
 *   • recovery moves the unit back (in stock / faulty / lost).
 *
 * Concurrency is settled by the database:
 *   – requestKey is UNIQUE: a double-clicked or retried "Issue" returns the
 *     first result instead of issuing twice;
 *   – one open issue per unit (partial unique index), and the unit is moved
 *     with a conditional UPDATE (must be IN_STOCK) inside the same
 *     transaction, so the same router cannot go to two customers;
 *   – billing is claimed PENDING → BILLING with a conditional UPDATE before
 *     the invoice is raised, so a retry can never raise a second invoice.
 */
const STATUSES_TO_RECOVER = ['EXPIRED', 'SUSPENDED', 'INACTIVE'];
const CONDITIONS = ['IN_STOCK', 'FAULTY', 'LOST'] as const;
type Condition = (typeof CONDITIONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const posInt = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestException(`${what} is not valid.`);
  return n;
};

function parseCharge(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000 || Math.round(n * 100) !== n * 100) {
    throw new BadRequestException('The charge must be zero or more, with at most two decimal places.');
  }
  return n;
}

@Injectable()
export class CrmIssueService {
  private readonly logger = new Logger(CrmIssueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly perms: PermissionsGuard,
    private readonly invoices: InvoicesService,
    private readonly terminations: CrmTerminationService,
  ) {}

  private async need(actor: Actor, kind: 'read' | 'write', resource: string) {
    const ok = kind === 'read' ? await canRead(this.perms, actor, resource) : await canWrite(this.perms, actor, resource);
    if (!ok) throw new ForbiddenException(`Missing permission: ${resource}.${kind}`);
  }

  /** Stock the caller may touch — ScopeService decides (own subtree; demo stock kept out). */
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

  /** The issue, if it belongs to a customer the caller can see. */
  private async issueFor(actor: Actor, id: number) {
    const row = (await this.prisma.crmStockIssue.findUnique({ where: { id } } as never)) as any;
    if (!row) throw new NotFoundException('Issue not found');
    try {
      await this.scope.assertSubscriberVisible(actor, row.subscriberId);
    } catch {
      throw new NotFoundException('Issue not found');
    }
    return row;
  }

  // ── issue ────────────────────────────────────────────────────────────────

  async issue(actor: Actor, body: any) {
    const itemId = posInt(body?.itemId, 'The unit');
    const subscriberId = posInt(body?.subscriberId, 'The customer');
    const charge = parseCharge(body?.charge);
    const requestKey = String(body?.requestKey ?? '');
    if (!UUID.test(requestKey)) throw new BadRequestException('requestKey must be a UUID (one per click).');
    const notes = body?.notes ? String(body.notes).trim().slice(0, 300) : null;

    await this.need(actor, 'write', 'inventory');
    if (charge > 0) await this.need(actor, 'write', 'invoices');
    await this.scope.assertSubscriberVisible(actor, subscriberId);

    const replay = (await this.prisma.crmStockIssue.findUnique({ where: { requestKey } } as never)) as any;
    if (replay) return this.sameRequest(replay, itemId, subscriberId, charge);

    const scope = await this.ownerWhere(actor);
    const by = this.actorId(actor);
    let issue: any;
    try {
      issue = await this.prisma.$transaction(async (tx: any) => {
        const item = await tx.inventoryItem.findFirst({
          where: { id: itemId, ...scope },
          select: { id: true, status: true, ownerId: true, warehouseId: true, serialNumber: true, type: true, model: true },
        });
        if (!item) throw new NotFoundException('That unit is not in your stock.');
        const row = await tx.crmStockIssue.create({
          data: {
            itemId, subscriberId, ownerId: item.ownerId, warehouseId: item.warehouseId, requestKey,
            charge, billing: charge > 0 ? 'PENDING' : 'NONE', notes, issuedById: by,
          },
        });
        const moved = await tx.inventoryItem.updateMany({
          where: { id: itemId, status: 'IN_STOCK', ...scope },
          data: { status: 'INSTALLED', subscriberId, installedAt: new Date() },
        });
        if (moved.count !== 1) {
          throw new ConflictException(`Unit ${item.serialNumber} is not in stock (it is ${String(item.status).toLowerCase().replace('_', ' ')}).`);
        }
        await tx.inventoryMovement.create({
          data: {
            itemId, fromUserId: item.ownerId, toUserId: item.ownerId, subscriberId,
            fromStatus: 'IN_STOCK', toStatus: 'INSTALLED', byUserId: by,
            notes: `Issued to customer (ISS-${row.id})${charge > 0 ? ` · charge ${charge}` : ' · free'}${notes ? ` · ${notes}` : ''}`.slice(0, 500),
          },
        });
        return { ...row, item };
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        const again = (await this.prisma.crmStockIssue.findUnique({ where: { requestKey } } as never)) as any;
        if (again) return this.sameRequest(again, itemId, subscriberId, charge); // concurrent retry won
        throw new ConflictException('That unit is already with a customer.');
      }
      throw e;
    }
    const { item, ...row } = issue;
    if (row.billing === 'PENDING') return this.bill(actor, row.id, item);
    return row;
  }

  private sameRequest(prior: any, itemId: number, subscriberId: number, charge: number) {
    if (prior.itemId !== itemId || prior.subscriberId !== subscriberId || Number(prior.charge) !== charge) {
      throw new ConflictException('This request key was already used for a different issue.');
    }
    return { ...prior, replay: true };
  }

  /**
   * Raise the invoice for a charged issue — once. Claim first (conditional
   * UPDATE), then invoice, then record it. If raising fails the claim is
   * released and the issue says billing PENDING, so it can be retried.
   */
  async bill(actor: Actor, id: number, item?: any) {
    await this.need(actor, 'write', 'invoices');
    const row = await this.issueFor(actor, id);
    const claim = (await this.prisma.crmStockIssue.updateMany({
      where: { id, billing: 'PENDING' },
      data: { billing: 'BILLING' },
    } as never)) as any;
    if (claim.count !== 1) return (await this.prisma.crmStockIssue.findUnique({ where: { id } } as never)) as any;

    const unit =
      item ??
      ((await this.prisma.inventoryItem.findUnique({
        where: { id: row.itemId },
        select: { serialNumber: true, type: true, model: true },
      } as never)) as any);
    const what = `${String(unit?.type ?? 'Equipment')}${unit?.model ? ` ${unit.model}` : ''} · S/N ${unit?.serialNumber ?? row.itemId}`;
    try {
      const invoice: any = await this.invoices.create(
        {
          subscriberId: row.subscriberId,
          amount: Number(row.charge),
          notes: `Equipment issued (ISS-${row.id})`,
          items: [{ description: what.slice(0, 300), quantity: 1, unitPrice: Number(row.charge), total: Number(row.charge) }],
        },
        actor,
      );
      return await this.prisma.crmStockIssue.update({
        where: { id },
        data: { billing: 'BILLED', invoiceId: invoice.id },
      } as never);
    } catch (e: any) {
      await this.prisma.crmStockIssue.updateMany({ where: { id, billing: 'BILLING' }, data: { billing: 'PENDING' } } as never);
      this.logger.warn(`ISS-${id}: invoice not raised (${e?.message ?? e}); left PENDING for retry`);
      const pending = (await this.prisma.crmStockIssue.findUnique({ where: { id } } as never)) as any;
      return { ...pending, billingError: 'The unit was issued, but the invoice could not be raised. Use "Bill now" to try again.' };
    }
  }

  // ── recovery ─────────────────────────────────────────────────────────────

  /** Bring a unit back from the customer: to stock, as faulty, or written off as lost. */
  async recover(actor: Actor, id: number, body: any) {
    const condition = String(body?.condition ?? '') as Condition;
    if (!CONDITIONS.includes(condition)) throw new BadRequestException('Condition must be IN_STOCK, FAULTY or LOST.');
    await this.need(actor, 'write', 'inventory');
    const row = await this.issueFor(actor, id);
    let warehouseId: number | null | undefined;
    if (body?.warehouseId !== undefined && body?.warehouseId !== null && body?.warehouseId !== '') {
      warehouseId = posInt(body.warehouseId, 'The warehouse');
      const w = (await this.prisma.crmWarehouse.findFirst({ where: { id: warehouseId, ...(await this.placeWhere(actor)) } } as never)) as any;
      if (!w) throw new NotFoundException('Warehouse not found');
    }
    const by = this.actorId(actor);
    const notes = body?.notes ? String(body.notes).trim().slice(0, 300) : '';
    const result = await this.prisma.$transaction(async (tx: any) => {
      const closed = await tx.crmStockIssue.updateMany({
        where: { id, status: 'ISSUED' },
        data: { status: condition === 'LOST' ? 'LOST' : 'RECOVERED', recoveredAt: new Date(), recoveredById: by, condition },
      });
      if (closed.count !== 1) throw new ConflictException('This unit has already been recovered.');
      const moved = await tx.inventoryItem.updateMany({
        where: { id: row.itemId, status: 'INSTALLED', subscriberId: row.subscriberId },
        data: {
          status: condition,
          subscriberId: null,
          installedAt: null,
          ...(warehouseId !== undefined ? { warehouseId } : {}),
        },
      });
      if (moved.count !== 1) throw new ConflictException('The unit is no longer recorded at this customer. Check its history.');
      await tx.inventoryMovement.create({
        data: {
          itemId: row.itemId, subscriberId: row.subscriberId, fromStatus: 'INSTALLED', toStatus: condition, byUserId: by,
          fromUserId: row.ownerId, toUserId: row.ownerId,
          notes: `Recovered from customer (ISS-${row.id}) · ${condition}${notes ? ` · ${notes}` : ''}`.slice(0, 500),
        },
      });
      return tx.crmStockIssue.findUnique({ where: { id } });
    });
    // Last unit back from a terminated customer → close the recovery and its ticket.
    await this.terminations.refresh(row.subscriberId).catch((e: any) =>
      this.logger.warn(`ISS-${id}: recovery follow-up not refreshed (${e?.message ?? e})`),
    );
    return result;
  }

  // ── lists ────────────────────────────────────────────────────────────────

  /** Units issued to one customer (open first). */
  async forSubscriber(actor: Actor, subscriberId: number) {
    await this.need(actor, 'read', 'inventory');
    await this.scope.assertSubscriberVisible(actor, subscriberId);
    return this.withItems(
      (await this.prisma.crmStockIssue.findMany({
        where: { subscriberId },
        orderBy: [{ status: 'asc' }, { issuedAt: 'desc' }],
        take: 200,
      } as never)) as any[],
    );
  }

  /**
   * The recovery queue: units still at customers whose service has ended
   * (expired, suspended, inactive). Oldest first.
   */
  async recoveries(actor: Actor) {
    await this.need(actor, 'read', 'inventory');
    const subs = (await this.prisma.subscriber.findMany({
      where: { AND: [await this.scope.subscriberWhere(actor), { status: { in: STATUSES_TO_RECOVER } }] },
      select: { id: true, fullName: true, username: true, status: true },
      take: 5000,
    } as never)) as any[];
    if (!subs.length) return [];
    const byId = new Map(subs.map((s) => [s.id, { ...s, status: String(s.status) }]));
    const rows = (await this.prisma.crmStockIssue.findMany({
      where: { status: 'ISSUED', subscriberId: { in: [...byId.keys()] } },
      orderBy: { issuedAt: 'asc' },
      take: 1000,
    } as never)) as any[];
    return (await this.withItems(rows)).map((r) => ({ ...r, customer: byId.get(r.subscriberId) ?? null }));
  }

  private async withItems(rows: any[]) {
    if (!rows.length) return [];
    const items = new Map<number, any>(
      ((await this.prisma.inventoryItem.findMany({
        where: { id: { in: rows.map((r) => r.itemId) } },
        select: { id: true, serialNumber: true, type: true, model: true, qrCode: true },
      } as never)) as any[]).map((i) => [i.id, { ...i, type: String(i.type) }]),
    );
    return rows.map((r) => ({ ...r, item: items.get(r.itemId) ?? null }));
  }
}
