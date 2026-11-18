import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { PermissionsGuard } from '../security/permissions.guard';
import { canRead, canWrite } from '../common/permission-check';
import { TicketSlaService } from '../tickets/ticket-sla.service';

/**
 * ADVANCED CRM — TICKET TURNAROUND (TAT) TARGETS.
 *
 * Uplinko already stamps response/resolution deadlines on every ticket and
 * sweeps for breaches (TicketSlaService). Its targets are installation-wide
 * (.env) and per priority only. Ported from the reference CRM (crm_tat.py):
 *
 *   • a company's own targets per category × priority (crm_tat_setting),
 *     applied by TicketSlaService.dueDatesFor() when a ticket is created;
 *   • changing ONE ticket's turnaround (1–720 hours from when it was opened),
 *     which sales staff may not do — as the reference CRM keeps technicians
 *     from moving their own deadline.
 *
 * Deadlines already on tickets are never rewritten by a settings change
 * (history stays honest); breach flags already raised are kept.
 */
export const TICKET_CATEGORIES = ['TECHNICAL', 'BILLING', 'COMPLAINT', 'INSTALLATION', 'DISCONNECTION', 'OTHER'] as const;
export const TICKET_PRIORITIES = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'] as const;
const MAX_MINUTES = 43_200; // 30 days

const minutes = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_MINUTES) throw new BadRequestException(`${what} must be a whole number of minutes from 1 to ${MAX_MINUTES}.`);
  return n;
};

@Injectable()
export class CrmTatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly perms: PermissionsGuard,
    private readonly sla: TicketSlaService,
  ) {}

  private actorId(actor: Actor): number | null {
    const id = Number(actor?.sub ?? actor?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  private async company(actor: Actor): Promise<number> {
    const c = await this.scope.companyRootId(this.scope.actorId(actor));
    if (c == null) throw new ForbiddenException('Turnaround targets belong to a company account.');
    return c;
  }

  /** Every category × priority: the company's target if set, else the default. */
  async grid(actor: Actor) {
    if (!(await canRead(this.perms, actor, 'tickets'))) throw new ForbiddenException('Missing permission: tickets.read');
    const companyId = await this.company(actor);
    const rows = (await this.prisma.crmTatSetting.findMany({ where: { companyId }, take: 100 } as never)) as any[];
    const out: Array<{ category: string; priority: string; responseMinutes: number; resolutionMinutes: number; custom: boolean }> = [];
    for (const category of TICKET_CATEGORIES) {
      for (const priority of TICKET_PRIORITIES) {
        const own = rows.find((r) => r.category === category && r.priority === priority);
        const def = this.sla.defaultTargets(priority);
        out.push({
          category,
          priority,
          responseMinutes: own ? own.responseMinutes : def.response,
          resolutionMinutes: own ? own.resolutionMinutes : def.resolution,
          custom: !!own,
        });
      }
    }
    return out;
  }

  /** Company owner only: one category × priority target (an atomic upsert). */
  async set(actor: Actor, body: any) {
    if (!this.scope.isOwner(actor?.role)) throw new ForbiddenException('Only the company owner can change turnaround targets.');
    if (!(await canWrite(this.perms, actor, 'tickets'))) throw new ForbiddenException('Missing permission: tickets.write');
    const category = String(body?.category ?? '');
    const priority = String(body?.priority ?? '');
    if (!(TICKET_CATEGORIES as readonly string[]).includes(category)) throw new BadRequestException('Unknown ticket category.');
    if (!(TICKET_PRIORITIES as readonly string[]).includes(priority)) throw new BadRequestException('Unknown priority.');
    const responseMinutes = minutes(body?.responseMinutes, 'Response target');
    const resolutionMinutes = minutes(body?.resolutionMinutes, 'Resolution target');
    if (responseMinutes > resolutionMinutes) throw new BadRequestException('The response target cannot be longer than the resolution target.');
    const companyId = await this.company(actor);
    const data = { responseMinutes, resolutionMinutes, updatedById: this.actorId(actor), updatedAt: new Date() };
    return this.prisma.crmTatSetting.upsert({
      where: { companyId_category_priority: { companyId, category, priority } },
      update: data,
      create: { companyId, category, priority, ...data },
    } as never);
  }

  /** Back to the installation default for that category × priority. */
  async reset(actor: Actor, body: any) {
    if (!this.scope.isOwner(actor?.role)) throw new ForbiddenException('Only the company owner can change turnaround targets.');
    const companyId = await this.company(actor);
    const r = (await this.prisma.crmTatSetting.deleteMany({
      where: { companyId, category: String(body?.category ?? ''), priority: String(body?.priority ?? '') },
    } as never)) as any;
    return { reset: r.count };
  }

  /**
   * Change ONE open ticket's turnaround: resolution due = opened + hours.
   * Sales staff may not (the person working a ticket does not move its own
   * deadline). Conditional on the ticket still being open.
   */
  async setTicketTat(actor: Actor, ticketId: number, body: any) {
    if (actor?.role === 'SALES') throw new ForbiddenException('Ask a manager to change the ticket turnaround.');
    if (!(await canWrite(this.perms, actor, 'tickets'))) throw new ForbiddenException('Missing permission: tickets.write');
    const hours = Number(body?.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new BadRequestException('Turnaround must be a whole number of hours from 1 to 720.');
    const t = (await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { id: true, subscriberId: true, createdAt: true } } as never)) as any;
    if (!t) throw new NotFoundException('Ticket not found');
    try {
      await this.scope.assertSubscriberVisible(actor, t.subscriberId);
    } catch {
      throw new NotFoundException('Ticket not found');
    }
    const due = new Date(new Date(t.createdAt).getTime() + hours * 3_600_000);
    const r = (await this.prisma.ticket.updateMany({
      where: { id: ticketId, status: { notIn: ['RESOLVED', 'CLOSED'] } },
      data: { resolutionDueAt: due },
    } as never)) as any;
    if (r.count !== 1) throw new ConflictException('This ticket is already resolved or closed.');
    await this.prisma.activityLog
      .create({
        data: { userId: this.actorId(actor), action: 'TICKET_TAT', entity: 'Ticket', entityId: ticketId, details: `Turnaround set to ${hours} h (due ${due.toISOString()})` },
      } as never)
      .catch(() => undefined);
    return { id: ticketId, hours, resolutionDueAt: due };
  }
}
