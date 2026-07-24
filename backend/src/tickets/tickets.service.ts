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
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.subscriber = { userId: { in: ids } };
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

  async findOne(id: number) {
    return this.prisma.ticket.findUnique({
      where: { id },
      include: {
        subscriber:  true,
        assignedUser: true,
        messages:    true,
      },
    });
  }

  async findBySubscriber(subscriberId: number) {
    return this.prisma.ticket.findMany({
      where: { subscriberId },
      orderBy: { createdAt: 'desc' },
      include: { messages: true },
    });
  }

  async getStats() {
    const total      = await this.prisma.ticket.count();
    const open       = await this.prisma.ticket.count({ where: { status: 'OPEN' } });
    const inProgress = await this.prisma.ticket.count({ where: { status: 'IN_PROGRESS' } });
    const resolved   = await this.prisma.ticket.count({ where: { status: 'RESOLVED' } });
    const closed     = await this.prisma.ticket.count({ where: { status: 'CLOSED' } });

    const byCategory = await this.prisma.ticket.groupBy({
      by:    ['category'],
      _count: { _all: true },
    });

    return { total, open, inProgress, resolved, closed, byCategory };
  }

  async generateTicketNo() {
    const count = await this.prisma.ticket.count();
    return `TKT-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;
  }

  async create(data: any) {
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

  async update(id: number, data: any) {
    return this.prisma.ticket.update({
      where: { id },
      data: {
        category:   data.category,
        priority:   data.priority,
        status:     data.status,
        assignedTo: data.assignedTo ? Number(data.assignedTo) : null,
        resolution: data.resolution,
        resolvedAt: data.status === 'RESOLVED' ? new Date() : undefined,
      },
    });
  }

  async addMessage(ticketId: number, data: any) {
    const msg = await this.prisma.ticketMessage.create({
      data: {
        ticketId:      Number(ticketId),
        message:       data.message,
        attachmentUrl: data.attachmentUrl,
        sentBy:        Number(data.sentBy),
        sentByType:    data.sentByType || 'STAFF',
      },
    });
    // A reply from staff stops the response clock. Customer replies don't —
    // otherwise a customer chasing for an update would clear our own SLA.
    if ((data.sentByType || 'STAFF') === 'STAFF') {
      void this.sla.markFirstResponse(Number(ticketId)).catch((e) => { this.logger?.warn?.('markFirstResponse: ' + (e?.message || e)); });
    }
    return msg;
  }

  async delete(id: number) {
    return this.prisma.ticket.delete({ where: { id } });
  }
}
