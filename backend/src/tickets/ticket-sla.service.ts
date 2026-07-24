import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * TicketSlaService — response/resolution targets and escalation.
 *
 * A ticket queue without deadlines quietly becomes a backlog: everything is
 * "open", nothing is late, and nobody knows what to work on next. SLA turns
 * that into an ordered list with a clock.
 *
 * Targets are written onto the ticket when it is created rather than computed
 * on read, because policy changes over time and history must stay honest — a
 * ticket raised under a 4-hour policy should still be judged against 4 hours.
 *
 * Tune per priority in .env, e.g.
 *   SLA_URGENT_RESPONSE_MIN=15   SLA_URGENT_RESOLVE_MIN=240
 */
@Injectable()
export class TicketSlaService {
  private readonly logger = new Logger(TicketSlaService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  /** Minutes allowed, by priority. Sensible ISP defaults. */
  private targets(priority: string): { response: number; resolution: number } {
    const n = (key: string, fallback: number) => Number(process.env[key] || fallback);
    switch (priority) {
      case 'URGENT': // whole area down, business customer offline
        return { response: n('SLA_URGENT_RESPONSE_MIN', 15),  resolution: n('SLA_URGENT_RESOLVE_MIN', 240) };
      case 'HIGH':   // single customer hard down
        return { response: n('SLA_HIGH_RESPONSE_MIN', 60),    resolution: n('SLA_HIGH_RESOLVE_MIN', 480) };
      case 'MEDIUM': // degraded service, slow speeds
        return { response: n('SLA_MEDIUM_RESPONSE_MIN', 240), resolution: n('SLA_MEDIUM_RESOLVE_MIN', 1440) };
      default:       // LOW — billing questions, requests
        return { response: n('SLA_LOW_RESPONSE_MIN', 480),    resolution: n('SLA_LOW_RESOLVE_MIN', 2880) };
    }
  }

  /** Deadlines for a new ticket — call this from ticket creation. */
  computeDueDates(priority: string, from = new Date()) {
    const t = this.targets(priority);
    return {
      responseDueAt:   new Date(from.getTime() + t.response   * 60_000),
      resolutionDueAt: new Date(from.getTime() + t.resolution * 60_000),
    };
  }

  /** Stamp the first staff reply — stops the response clock. */
  async markFirstResponse(ticketId: number) {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { firstResponseAt: true },
    });
    if (t && !t.firstResponseAt) {
      await this.prisma.ticket.update({
        where: { id: ticketId },
        data: { firstResponseAt: new Date() },
      });
    }
  }

  /**
   * Breach sweep — every 5 minutes.
   *
   * Two kinds of breach:
   *   • no first response by responseDueAt
   *   • still unresolved past resolutionDueAt
   *
   * A breached ticket is flagged, escalated to the assignee's parent, and a
   * notification fired. Only flagged once, so it can't spam.
   */
  @Cron('*/5 * * * *')
  async checkBreaches() {
    if (process.env.SLA_ENABLED === 'false') return;
    const now = new Date();

    try {
      const atRisk = await this.prisma.ticket.findMany({
        where: {
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          slaBreached: false,
          OR: [
            { firstResponseAt: null, responseDueAt: { lt: now } },
            { resolutionDueAt: { lt: now } },
          ],
        },
        include: {
          subscriber:   { select: { id: true, fullName: true, phone: true, userId: true } },
          assignedUser: { select: { id: true, name: true, parentId: true } },
        },
        take: 200,
      });

      if (!atRisk.length) return;

      for (const t of atRisk) {
        const noResponse = !t.firstResponseAt && t.responseDueAt && t.responseDueAt < now;
        const reason = noResponse ? 'no first response' : 'not resolved in time';

        // Escalate upward: the assignee's parent, else the subscriber's owner.
        const escalateTo = t.assignedUser?.parentId ?? t.subscriber?.userId ?? null;

        await this.prisma.ticket.update({
          where: { id: t.id },
          data: {
            slaBreached: true,
            breachedAt: now,
            status: 'ESCALATED',
            escalatedAt: now,
            escalatedTo: escalateTo,
          },
        });

        this.logger.warn(
          `SLA breach: ticket ${t.ticketNo} (${t.priority}) — ${reason}` +
            (escalateTo ? ` → escalated to user #${escalateTo}` : ''),
        );

        void this.notifications
          .fireEvent('TICKET_SLA_BREACH', t.subscriber, {
            ticketNo: t.ticketNo,
            priority: t.priority,
            reason,
          })
          .catch((e) => { this.logger?.warn?.('sendNotification: ' + (e?.message || e)); });
      }

      this.logger.log(`SLA sweep: ${atRisk.length} ticket(s) breached and escalated`);
    } catch (e: any) {
      this.logger.error(`SLA sweep failed: ${e?.message || e}`);
    }
  }

  /**
   * Live SLA picture for the dashboard: what's late, what's about to be, and
   * how the team is actually performing.
   */
  async slaReport(days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const soon = new Date(Date.now() + 60 * 60 * 1000); // next hour

    const [open, breached, dueSoon, resolved, breachedInPeriod] = await Promise.all([
      this.prisma.ticket.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      this.prisma.ticket.count({ where: { slaBreached: true, status: { notIn: ['CLOSED', 'RESOLVED'] } } }),
      this.prisma.ticket.count({
        where: {
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          slaBreached: false,
          resolutionDueAt: { gte: new Date(), lte: soon },
        },
      }),
      this.prisma.ticket.count({ where: { resolvedAt: { gte: since } } }),
      this.prisma.ticket.count({ where: { breachedAt: { gte: since } } }),
    ]);

    // Average hours to resolve, over the window.
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT AVG(EXTRACT(EPOCH FROM ("resolvedAt" - "createdAt")) / 3600)::numeric(10,2) AS avg_hours
         FROM "Ticket"
        WHERE "resolvedAt" IS NOT NULL AND "resolvedAt" >= ${since}`
    .catch(() => [] as any[]);

    const compliance = resolved + breachedInPeriod > 0
      ? Math.round((resolved / (resolved + breachedInPeriod)) * 1000) / 10
      : 100;

    return {
      periodDays: days,
      openTickets: open,
      breachedOpen: breached,
      dueWithinHour: dueSoon,
      resolvedInPeriod: resolved,
      breachedInPeriod,
      avgResolutionHours: Number(rows?.[0]?.avg_hours ?? 0),
      slaCompliancePercent: compliance,
    };
  }

  /** Backfill targets for tickets created before SLA existed. */
  async backfill() {
    const missing = await this.prisma.ticket.findMany({
      where: { responseDueAt: null },
      select: { id: true, priority: true, createdAt: true },
      take: 1000,
    });
    for (const t of missing) {
      const due = this.computeDueDates(t.priority, t.createdAt);
      await this.prisma.ticket.update({ where: { id: t.id }, data: due }).catch((e) => { this.logger?.warn?.('backfill: ' + (e?.message || e)); });
    }
    if (missing.length) this.logger.log(`Backfilled SLA targets on ${missing.length} ticket(s)`);
    return { backfilled: missing.length };
  }
}
