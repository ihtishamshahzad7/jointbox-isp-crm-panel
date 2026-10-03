import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TicketSlaService } from './ticket-sla.service';
import { ScopeService, Actor } from '../common/scope.service';

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private prisma: PrismaService,
    private sla: TicketSlaService,
    private scope: ScopeService,
  ) {}

  /**
   * Tickets this account may see. Was unscoped — every dealer read every
   * other dealer's complaints, including customer names and phone numbers.
   */
  async findAll(actor?: Actor) {
    const where: any = {};
    // Delegated to ScopeService: the ISP branch must exclude the demo
    // sandbox too, and a rule restated here stops matching the rest of the app.
    {
      const _sub = await this.scope.subscriberWhere(actor);
      if (Object.keys(_sub).length) where.subscriber = _sub;
    }
    return this.prisma.ticket.findMany({
      where,
      include: {
        subscriber:  { select: { id: true, fullName: true, phone: true } },
        assignedUser: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: number, actor?: Actor) {
    const t = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        subscriber:  true,
        assignedUser: true,
        messages:    true,
      },
    });
    // IDOR guard — a reseller can't open another tenant's ticket by id.
    if (t && actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      if ((t as any).subscriber?.userId == null || !ids.includes((t as any).subscriber.userId)) return null;
    }
    return t;
  }

  async findBySubscriber(subscriberId: number, actor?: Actor) {
    if (actor && !this.scope.isPlatformOwner(actor)) {
      if (!Number.isInteger(subscriberId)) throw new NotFoundException('Subscriber not found');
      await this.scope.assertSubscriberVisible(actor, subscriberId);
    }
    return this.prisma.ticket.findMany({
      where: { subscriberId },
      orderBy: { createdAt: 'desc' },
      include: { messages: true },
    });
  }

  async getStats(actor?: Actor) {
    // Scope to the caller's subtree (same as findAll) — unscoped, every dealer
    // saw the whole ISP's ticket counts.
    const scope: any = {};
    // Delegated to ScopeService: the ISP branch must exclude the demo
    // sandbox too, and a rule restated here stops matching the rest of the app.
    {
      const _sub = await this.scope.subscriberWhere(actor);
      if (Object.keys(_sub).length) scope.subscriber = _sub;
    }
    const w = (extra: any = {}) => (Object.keys(scope).length ? { AND: [scope, extra] } : extra);

    const total      = await this.prisma.ticket.count({ where: w() });
    const open       = await this.prisma.ticket.count({ where: w({ status: 'OPEN' }) });
    const inProgress = await this.prisma.ticket.count({ where: w({ status: 'IN_PROGRESS' }) });
    const resolved   = await this.prisma.ticket.count({ where: w({ status: 'RESOLVED' }) });
    const closed     = await this.prisma.ticket.count({ where: w({ status: 'CLOSED' }) });

    const byCategory = await this.prisma.ticket.groupBy({
      by:    ['category'],
      _count: { _all: true },
      where: w(),
    });

    return { total, open, inProgress, resolved, closed, byCategory };
  }

  async generateTicketNo() {
    const count = await this.prisma.ticket.count();
    return `TKT-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;
  }

  /**
   * Ticket.subscriberId is required, so there is no subscriber-less ticket to
   * allow: a tenant may only open one for its own subscriber, and only assign
   * it to an account in its own tree.
   */
  async create(data: any, actor?: Actor) {
    if (actor && !this.scope.isPlatformOwner(actor)) {
      const sid = Number(data?.subscriberId);
      if (!Number.isInteger(sid) || sid <= 0) throw new NotFoundException('Subscriber not found');
      await this.scope.assertSubscriberVisible(actor, sid);
      await this.assertAssignee(actor, data?.assignedTo);
    }
    const ticketNo = await this.generateTicketNo();

    // SLA deadlines are stamped at creation from the priority, so the ticket
    // carries its own clock and history stays honest if policy changes later.
    const priority = data.priority || 'MEDIUM';
    const due = this.sla.computeDueDates(priority);

    return this.prisma.ticket.create({
      data: {
        ticketNo,
        subscriberId: Number(data.subscriberId),
        category:     data.category,
        priority,
        subject:      data.subject,
        description:  data.description,
        assignedTo:   data.assignedTo ? Number(data.assignedTo) : null,
        status:       'OPEN',
        responseDueAt:   due.responseDueAt,
        resolutionDueAt: due.resolutionDueAt,
      },
      include: { subscriber: true },
    });
  }

  async update(id: number, data: any, actor?: Actor) {
    if (actor) {
      await this.assertTicket(actor, id);
      await this.assertAssignee(actor, data?.assignedTo);
    }
    return this.prisma.ticket.update({
      where: { id },
      data: {
        category:   data.category,
        priority:   data.priority,
        status:     data.status,
        // Absent means "leave it": the complaints board sends only {status},
        // and every status change used to wipe the assignee.
        assignedTo:
          data.assignedTo === undefined ? undefined : data.assignedTo ? Number(data.assignedTo) : null,
        resolution: data.resolution,
        resolvedAt: data.status === 'RESOLVED' ? new Date() : undefined,
      },
    });
  }

  async addMessage(ticketId: number, data: any, actor?: Actor) {
    if (actor) await this.assertTicket(actor, Number(ticketId));
    const msg = await this.prisma.ticketMessage.create({
      data: {
        ticketId:      Number(ticketId),
        message:       data.message,
        attachmentUrl: data.attachmentUrl,
        // From the operator API the sender IS the caller — the body used to
        // name it, so a reply could be posted as any user or as the customer.
        sentBy:        actor ? this.scope.actorId(actor) : Number(data.sentBy),
        sentByType:    actor ? 'STAFF' : data.sentByType || 'STAFF',
      },
    });
    // A reply from staff stops the response clock. Customer replies don't —
    // otherwise a customer chasing for an update would clear our own SLA.
    if ((actor ? 'STAFF' : data.sentByType || 'STAFF') === 'STAFF') {
      void this.sla.markFirstResponse(Number(ticketId)).catch((e) => { this.logger?.warn?.('markFirstResponse: ' + (e?.message || e)); });
    }
    return msg;
  }

  async delete(id: number, actor?: Actor) {
    if (actor) await this.assertTicket(actor, id);
    return this.prisma.ticket.delete({ where: { id } });
  }

  /**
   * By-id guard: the ticket's subscriber must be the caller's. 404 for a
   * ticket in another company (or one that does not exist), so ids cannot be
   * enumerated. The platform owner passes untouched.
   */
  private async assertTicket(actor: Actor, id: number): Promise<void> {
    if (this.scope.isPlatformOwner(actor)) return;
    const t = Number.isInteger(id)
      ? await this.prisma.ticket.findUnique({ where: { id }, select: { subscriberId: true } })
      : null;
    await this.scope.assertViaSubscriber(actor, t?.subscriberId ?? null, 'Ticket');
  }

  /** An assignee named in the body must be an account in the caller's own tree. */
  private async assertAssignee(actor: Actor, assignedTo: any): Promise<void> {
    if (!assignedTo || this.scope.isPlatformOwner(actor)) return;
    const uid = Number(assignedTo);
    if (!Number.isInteger(uid) || !(await this.scope.canAccessUser(actor, uid))) {
      throw new NotFoundException('User not found');
    }
  }
}
