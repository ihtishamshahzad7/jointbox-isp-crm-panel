import {
  Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

/**
 * FieldJobsService — dispatch and track work on the ground.
 *
 * Bridges the office and the field: a ticket says "internet is down", a job
 * says "Ali is attending at 2pm with an ONU". It makes three questions
 * answerable that otherwise live in phone calls:
 *   • how many installations are pending?
 *   • what is each technician doing today?
 *   • who actually completes work, and how fast?
 *
 * Scoped like the rest of the system — you see jobs for your own subscribers
 * and your downline's, never another branch's.
 */
@Injectable()
export class FieldJobsService {
  private readonly logger = new Logger(FieldJobsService.name);

  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  private async generateJobNo() {
    const y = new Date().getFullYear();
    const count = await this.prisma.fieldJob.count();
    return `JOB-${y}-${String(count + 1).padStart(5, '0')}`;
  }

  /** Restrict to the caller's subtree unless they're the ISP. */
  private async scopedWhere(actor?: Actor, base: any = {}) {
    if (!actor || this.scope.isAdmin(actor.role)) return base;
    const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
    return {
      AND: [
        base,
        {
          OR: [
            { subscriber: { userId: { in: ids } } }, // jobs for my customers
            { assignedTo: { in: ids } },             // jobs my people are doing
            { createdById: { in: ids } },
          ],
        },
      ],
    };
  }

  // ── Read ─────────────────────────────────────────────────────
  async findAll(actor?: Actor, query: any = {}) {
    const base: any = {};
    if (query.status && query.status !== 'ALL') base.status = query.status;
    if (query.type && query.type !== 'ALL') base.type = query.type;
    if (query.assignedTo) base.assignedTo = Number(query.assignedTo);
    if (query.subscriberId) base.subscriberId = Number(query.subscriberId);

    if (query.date) {
      // Everything scheduled on a given day.
      const from = new Date(query.date); from.setHours(0, 0, 0, 0);
      const to = new Date(from); to.setDate(to.getDate() + 1);
      base.scheduledAt = { gte: from, lt: to };
    }

    return this.prisma.fieldJob.findMany({
      where: await this.scopedWhere(actor, base),
      include: {
        subscriber: { select: { id: true, fullName: true, phone: true, address: true, username: true } },
        technician: { select: { id: true, name: true, phone: true } },
        ticket:     { select: { id: true, ticketNo: true, subject: true } },
      },
      orderBy: [{ status: 'asc' }, { scheduledAt: 'asc' }, { id: 'desc' }],
      take: Number(query.limit) || 300,
    });
  }

  async findOne(id: number, actor?: Actor) {
    const job = await this.prisma.fieldJob.findUnique({
      where: { id },
      include: {
        subscriber: true,
        technician: { select: { id: true, name: true, phone: true, email: true } },
        ticket:     { select: { id: true, ticketNo: true, subject: true, status: true } },
      },
    });
    if (!job) throw new NotFoundException(`Job ${id} not found`);

    // PRIVACY: readable only if it concerns your customer, is assigned to
    // someone in your branch, or you raised it. A job with no subscriber
    // previously bypassed every check, exposing other branches' work — and the
    // customer address it carries.
    if (actor && !this.scope.isAdmin(actor.role)) {
      const me = await this.scope.rootId(actor);
      const mine = await this.scope.descendantIds(me);
      const allowed =
        (job.subscriberId && (await this.canSee(actor, job.subscriberId))) ||
        (job.assignedTo && mine.includes(job.assignedTo)) ||
        (job.createdById && mine.includes(job.createdById));
      if (!allowed) throw new ForbiddenException('This job belongs to another branch.');
    }
    return job;
  }

  /** Subscriber visibility without throwing — used to combine access rules. */
  private async canSee(actor: Actor, subscriberId: number) {
    try {
      await this.scope.assertSubscriber(actor, subscriberId);
      return true;
    } catch {
      return false;
    }
  }

  /** A technician's own worklist — the mobile/field view. */
  async myJobs(actor: Actor, includeCompleted = false) {
    const me = this.scope.actorId(actor);
    const statuses: any[] = includeCompleted
      ? ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED']
      : ['ASSIGNED', 'IN_PROGRESS'];

    return this.prisma.fieldJob.findMany({
      where: { assignedTo: me, status: { in: statuses } },
      include: {
        subscriber: { select: { id: true, fullName: true, phone: true, address: true, latitude: true, longitude: true } },
        ticket:     { select: { ticketNo: true, subject: true } },
      },
      orderBy: [{ scheduledAt: 'asc' }],
      take: 100,
    });
  }

  /** Dispatch board numbers. */
  async stats(actor?: Actor) {
    const where = await this.scopedWhere(actor);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

    const [byStatus, scheduledToday, overdue, unassigned, completed30d] = await Promise.all([
      this.prisma.fieldJob.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.fieldJob.count({
        where: { AND: [where, { scheduledAt: { gte: today, lt: tomorrow } }] },
      }),
      // Scheduled in the past and still not finished — the list that matters.
      this.prisma.fieldJob.count({
        where: {
          AND: [where, {
            scheduledAt: { lt: new Date() },
            status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] },
          }],
        },
      }),
      this.prisma.fieldJob.count({ where: { AND: [where, { status: 'PENDING', assignedTo: null }] } }),
      this.prisma.fieldJob.count({
        where: {
          AND: [where, {
            status: 'COMPLETED',
            completedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          }],
        },
      }),
    ]);

    const m: Record<string, number> = {};
    byStatus.forEach((s) => (m[s.status] = s._count._all));

    return {
      pending:     m.PENDING     ?? 0,
      assigned:    m.ASSIGNED    ?? 0,
      inProgress:  m.IN_PROGRESS ?? 0,
      completed:   m.COMPLETED   ?? 0,
      failed:      m.FAILED      ?? 0,
      cancelled:   m.CANCELLED   ?? 0,
      scheduledToday,
      overdue,
      unassigned,
      completedLast30Days: completed30d,
    };
  }

  /** Per-technician performance — completion counts and average duration. */
  async technicianPerformance(actor?: Actor, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT u.id, u.name,
              COUNT(*) FILTER (WHERE j.status = 'COMPLETED')::int AS completed,
              COUNT(*) FILTER (WHERE j.status = 'FAILED')::int    AS failed,
              COUNT(*) FILTER (WHERE j.status IN ('ASSIGNED','IN_PROGRESS'))::int AS open,
              ROUND(AVG(EXTRACT(EPOCH FROM (j."completedAt" - j."startedAt"))/60)
                    FILTER (WHERE j."completedAt" IS NOT NULL AND j."startedAt" IS NOT NULL)::numeric, 0) AS avg_minutes
         FROM "FieldJob" j
         JOIN "User" u ON u.id = j."assignedTo"
        WHERE j."createdAt" >= $1
        GROUP BY u.id, u.name
        ORDER BY completed DESC`,
      since,
    ).catch(() => [] as any[]);

    return rows.map((r) => ({
      technicianId: Number(r.id),
      name: r.name,
      completed: Number(r.completed || 0),
      failed: Number(r.failed || 0),
      open: Number(r.open || 0),
      avgMinutesOnSite: r.avg_minutes ? Number(r.avg_minutes) : null,
    }));
  }

  // ── Write ────────────────────────────────────────────────────
  async create(data: any, actor?: Actor) {
    if (!data.description?.trim()) {
      throw new BadRequestException('A description of the work is required.');
    }
    if (data.subscriberId && actor) {
      await this.scope.assertSubscriber(actor, Number(data.subscriberId));
    }

    // Default the address from the subscriber so the technician has somewhere
    // to go without anyone retyping it.
    let address = data.address ?? null;
    let latitude = data.latitude ? Number(data.latitude) : null;
    let longitude = data.longitude ? Number(data.longitude) : null;
    if (data.subscriberId && (!address || latitude === null)) {
      const sub = await this.prisma.subscriber.findUnique({
        where: { id: Number(data.subscriberId) },
        select: { address: true, latitude: true, longitude: true },
      });
      address ??= sub?.address ?? null;
      latitude ??= sub?.latitude ?? null;
      longitude ??= sub?.longitude ?? null;
    }

    const job = await this.prisma.fieldJob.create({
      data: {
        jobNo: await this.generateJobNo(),
        type: data.type || 'INSTALLATION',
        priority: data.priority || 'MEDIUM',
        status: data.assignedTo ? 'ASSIGNED' : 'PENDING',
        subscriberId: data.subscriberId ? Number(data.subscriberId) : null,
        ticketId: data.ticketId ? Number(data.ticketId) : null,
        assignedTo: data.assignedTo ? Number(data.assignedTo) : null,
        assignedById: data.assignedTo && actor ? this.scope.actorId(actor) : null,
        assignedAt: data.assignedTo ? new Date() : null,
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
        address, latitude, longitude,
        description: data.description.trim(),
        createdById: actor ? this.scope.actorId(actor) : null,
      },
      include: { subscriber: { select: { fullName: true, phone: true } } },
    });

    this.logger.log(`Field job ${job.jobNo} created (${job.type})`);
    return job;
  }

  async assign(id: number, technicianId: number, actor?: Actor, scheduledAt?: string) {
    await this.findOne(id, actor);
    if (actor && !this.scope.isAdmin(actor.role)) {
      await this.scope.assertUser(actor, technicianId);
    }
    return this.prisma.fieldJob.update({
      where: { id },
      data: {
        assignedTo: technicianId,
        assignedById: actor ? this.scope.actorId(actor) : null,
        assignedAt: new Date(),
        status: 'ASSIGNED',
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt) } : {}),
      },
    });
  }

  /** Technician taps "start" on arrival — this is the on-site timestamp. */
  async start(id: number, actor?: Actor) {
    const job = await this.findOne(id, actor);
    if (job.status === 'COMPLETED') throw new BadRequestException('This job is already completed.');
    return this.prisma.fieldJob.update({
      where: { id },
      data: { status: 'IN_PROGRESS', startedAt: job.startedAt ?? new Date() },
    });
  }

  /**
   * Close the job. `success: false` records a failed attempt with a reason —
   * important, because "attended but customer absent" is not the same as
   * "not attended", and only one of them is the technician's problem.
   */
  async complete(
    id: number,
    body: { success?: boolean; notes?: string; failureReason?: string; photoUrls?: string[] },
    actor?: Actor,
  ) {
    const job = await this.findOne(id, actor);
    const success = body.success !== false;

    const updated = await this.prisma.fieldJob.update({
      where: { id },
      data: {
        status: success ? 'COMPLETED' : 'FAILED',
        completedAt: new Date(),
        startedAt: job.startedAt ?? new Date(),
        completionNotes: body.notes ?? null,
        failureReason: success ? null : (body.failureReason ?? 'Not specified'),
        photoUrls: body.photoUrls?.length ? body.photoUrls.join(',') : job.photoUrls,
      },
    });

    // A completed fault job closes its ticket — otherwise the office has to
    // remember to close it manually, and tickets pile up looking unresolved.
    if (success && job.ticketId) {
      await this.prisma.ticket
        .update({
          where: { id: job.ticketId },
          data: {
            status: 'RESOLVED',
            resolvedAt: new Date(),
            resolution: body.notes || `Resolved on site (job ${job.jobNo})`,
          },
        })
        .catch(() => {});
    }

    this.logger.log(`Field job ${job.jobNo} ${success ? 'completed' : 'FAILED'}`);
    return updated;
  }

  async cancel(id: number, reason: string, actor?: Actor) {
    await this.findOne(id, actor);
    return this.prisma.fieldJob.update({
      where: { id },
      data: { status: 'CANCELLED', failureReason: reason || 'Cancelled' },
    });
  }

  async update(id: number, data: any, actor?: Actor) {
    await this.findOne(id, actor);
    return this.prisma.fieldJob.update({
      where: { id },
      data: {
        type: data.type,
        priority: data.priority,
        description: data.description,
        address: data.address,
        latitude: data.latitude !== undefined ? Number(data.latitude) : undefined,
        longitude: data.longitude !== undefined ? Number(data.longitude) : undefined,
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
      },
    });
  }

  async remove(id: number, actor?: Actor) {
    await this.findOne(id, actor);
    await this.prisma.fieldJob.delete({ where: { id } });
    return { deleted: true, id };
  }

  /** Raise a job straight from a support ticket. */
  async fromTicket(ticketId: number, data: any, actor?: Actor) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, ticketNo: true, subject: true, subscriberId: true, priority: true },
    });
    if (!ticket) throw new NotFoundException(`Ticket ${ticketId} not found`);

    return this.create(
      {
        ...data,
        ticketId,
        subscriberId: ticket.subscriberId,
        priority: data.priority || ticket.priority,
        type: data.type || 'FAULT_REPAIR',
        description: data.description || `${ticket.ticketNo}: ${ticket.subject}`,
      },
      actor,
    );
  }
}
