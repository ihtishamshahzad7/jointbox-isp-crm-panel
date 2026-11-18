import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { PermissionsGuard } from '../security/permissions.guard';
import { canRead, canWrite } from '../common/permission-check';
import { SubscribersService } from '../subscribers/subscribers.service';
import { TicketsService } from '../tickets/tickets.service';
import { CrmStaffService } from './crm-staff.service';

/**
 * ADVANCED CRM — TERMINATION AND EQUIPMENT RECOVERY FOLLOW-UP.
 *
 * Ported in behaviour from the reference CRM (crm_termination.py). What
 * Uplinko already does is NOT redone here: the disconnect is the existing
 * SubscribersService.deactivateAndRelease (status INACTIVE, router secret and
 * RADIUS credentials removed, live session cut, static IP released — with its
 * own `subscribers.disconnect` permission check). This adds what was missing:
 *
 *   • an audit row: reason, who, when, and the monthly revenue lost;
 *   • when equipment is still at the customer, a recovery ticket through the
 *     existing TicketsService (normal ticket number, SLA clock, assignee);
 *   • when the last unit comes back (CrmIssueService.recover), the recovery is
 *     marked RECOVERED and its ticket resolved automatically.
 *
 * A retried "Terminate" returns the open recovery instead of opening a second
 * one (partial unique index: one RECOVERY_PENDING per customer).
 */
@Injectable()
export class CrmTerminationService {
  private readonly logger = new Logger(CrmTerminationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly perms: PermissionsGuard,
    private readonly subscribers: SubscribersService,
    private readonly tickets: TicketsService,
    private readonly staff: CrmStaffService,
  ) {}

  private actorId(actor: Actor): number | null {
    const id = Number(actor?.sub ?? actor?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  async terminate(actor: Actor, subscriberId: number, body: any) {
    if (!Number.isInteger(subscriberId) || subscriberId <= 0) throw new NotFoundException('Customer not found');
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!reason || reason.length > 2000) throw new BadRequestException('Enter a termination reason (up to 2000 characters).');
    const assignTo = body?.assignTo === undefined || body?.assignTo === null || body?.assignTo === '' ? null : Number(body.assignTo);
    if (assignTo !== null && (!Number.isInteger(assignTo) || assignTo <= 0)) throw new BadRequestException('Choose a valid person for the recovery.');

    await this.scope.assertSubscriberVisible(actor, subscriberId);
    if (assignTo !== null && (await this.staff.isOnLeave(assignTo))) {
      throw new BadRequestException('That person is on leave. Choose someone available for the recovery.');
    }
    const open = (await this.prisma.crmTermination.findFirst({
      where: { subscriberId, status: 'RECOVERY_PENDING' },
    } as never)) as any;
    if (open) return { ...open, replay: true };

    const pending = (await this.prisma.crmStockIssue.findMany({
      where: { subscriberId, status: 'ISSUED' },
      select: { id: true, itemId: true },
      take: 500,
    } as never)) as any[];
    // A recovery ticket needs ticket rights — check BEFORE disconnecting, so we
    // never leave a customer cut off with nobody told to collect the router.
    if (pending.length && !(await canWrite(this.perms, actor, 'tickets'))) {
      throw new ForbiddenException('Missing permission: tickets.write (needed to open the equipment-recovery ticket).');
    }

    const sub = (await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, fullName: true, username: true, package: { select: { price: true } } },
    } as never)) as any;
    if (!sub) throw new NotFoundException('Customer not found');

    // 1. Uplinko's own disconnect (checks subscribers.disconnect itself).
    const released = await this.subscribers.deactivateAndRelease(subscriberId, actor, reason);

    // 2. The audit row (+ recovery follow-up when equipment is out).
    let row: any;
    try {
      row = await this.prisma.crmTermination.create({
        data: {
          subscriberId,
          reason,
          terminatedById: this.actorId(actor),
          monthlyRevenueLoss: Math.round((Number(sub.package?.price) || 0) * 100) / 100,
          status: pending.length ? 'RECOVERY_PENDING' : 'NO_EQUIPMENT',
        },
      } as never);
    } catch (e: any) {
      if (e?.code === 'P2002') {
        const again = (await this.prisma.crmTermination.findFirst({ where: { subscriberId, status: 'RECOVERY_PENDING' } } as never)) as any;
        if (again) return { ...again, replay: true };
      }
      throw e;
    }

    if (pending.length) {
      const items = (await this.prisma.inventoryItem.findMany({
        where: { id: { in: pending.map((p) => p.itemId) } },
        select: { id: true, serialNumber: true, type: true, model: true },
      } as never)) as any[];
      const lines = pending.map((p) => {
        const i = items.find((x) => x.id === p.itemId);
        return `ISS-${p.id}: ${i ? `${String(i.type)}${i.model ? ` ${i.model}` : ''} · S/N ${i.serialNumber}` : `unit #${p.itemId}`}`;
      });
      try {
        const ticket: any = await this.tickets.create(
          {
            subscriberId,
            category: 'DISCONNECTION',
            priority: 'MEDIUM',
            subject: `Recover equipment — ${sub.fullName}`.slice(0, 200),
            description: `Customer ${sub.fullName} (${sub.username}) was terminated.\nReason: ${reason}\n\nRecover:\n${lines.join('\n')}`,
            assignedTo: assignTo,
          },
          actor,
        );
        row = await this.prisma.crmTermination.update({ where: { id: row.id }, data: { ticketId: ticket.id } } as never);
      } catch (e: any) {
        // The customer is already disconnected; say so rather than hide it.
        this.logger.warn(`Termination #${row.id}: recovery ticket not opened (${e?.message ?? e})`);
        return { ...row, released, ticketError: `The customer was terminated, but the recovery ticket could not be opened: ${e?.message ?? e}` };
      }
    }
    return { ...row, released, pendingUnits: pending.length };
  }

  /**
   * Called after a unit comes back. When none are left with the customer, the
   * open recovery is closed and its ticket resolved — each a conditional
   * UPDATE, so two recoveries finishing together close it exactly once.
   */
  async refresh(subscriberId: number): Promise<void> {
    const left = await this.prisma.crmStockIssue.count({ where: { subscriberId, status: 'ISSUED' } } as never);
    if (left > 0) return;
    const open = (await this.prisma.crmTermination.findMany({
      where: { subscriberId, status: 'RECOVERY_PENDING' },
      select: { id: true, ticketId: true },
    } as never)) as any[];
    for (const t of open) {
      const done = (await this.prisma.crmTermination.updateMany({
        where: { id: t.id, status: 'RECOVERY_PENDING' },
        data: { status: 'RECOVERED', recoveredAt: new Date() },
      } as never)) as any;
      if (done.count === 1 && t.ticketId) {
        await this.prisma.ticket.updateMany({
          where: { id: t.ticketId, status: { notIn: ['RESOLVED', 'CLOSED'] } },
          data: { status: 'RESOLVED', resolvedAt: new Date(), resolution: 'All equipment recovered and returned to inventory.' },
        } as never);
      }
    }
  }

  /** Terminations in the caller's account, newest first, with the revenue lost. */
  async list(actor: Actor, query: { status?: string } = {}) {
    if (!(await canRead(this.perms, actor, 'subscribers'))) throw new ForbiddenException('Missing permission: subscribers.read');
    const status = query.status && ['RECOVERY_PENDING', 'NO_EQUIPMENT', 'RECOVERED'].includes(query.status) ? query.status : undefined;
    const subs = (await this.prisma.subscriber.findMany({
      where: await this.scope.subscriberWhere(actor),
      select: { id: true },
      take: 200_000,
    } as never)) as any[];
    if (!subs.length) return { rows: [], monthlyRevenueLoss: 0 };
    const where = { subscriberId: { in: subs.map((s) => s.id) }, ...(status ? { status } : {}) };
    const [rows, agg] = await Promise.all([
      this.prisma.crmTermination.findMany({ where, orderBy: { terminatedAt: 'desc' }, take: 500 } as never) as Promise<any[]>,
      this.prisma.crmTermination.aggregate({ where, _sum: { monthlyRevenueLoss: true } } as never) as Promise<any>,
    ]);
    const names = new Map<number, any>(
      ((await this.prisma.subscriber.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.subscriberId))] } },
        select: { id: true, fullName: true, username: true },
      } as never)) as any[]).map((s) => [s.id, s]),
    );
    return {
      rows: rows.map((r) => ({ ...r, customer: names.get(r.subscriberId) ?? null })),
      monthlyRevenueLoss: Math.round((Number(agg?._sum?.monthlyRevenueLoss) || 0) * 100) / 100,
    };
  }
}
