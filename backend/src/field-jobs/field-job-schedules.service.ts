import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FieldJobType, Prisma, TicketPriority } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { isPrimaryInstance } from '../common/cluster-util';
import { QueueService } from '../common/queue.service';
import { Actor, ScopeService } from '../common/scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateFieldJobScheduleDto } from './field-job-schedule.dto';

const TYPES: FieldJobType[] = ['INSTALLATION', 'FAULT_REPAIR', 'MAINTENANCE', 'DISCONNECTION', 'SURVEY', 'UPGRADE', 'RELOCATION'];
const PRIORITIES: TicketPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
const SCHEDULE_STATUSES = ['ACTIVE', 'PAUSED', 'CANCELLED'] as const;

type ScheduleInput = Record<string, unknown>;
type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, Number(part.value)]));
  return {
    year: values.get('year')!,
    month: values.get('month')!,
    day: values.get('day')!,
    hour: values.get('hour')!,
    minute: values.get('minute')!,
    second: values.get('second')!,
  };
}

function sameParts(left: LocalParts, right: LocalParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}

function wallTimeToUtc(parts: LocalParts, timeZone: string): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let candidate = target;
  for (let attempt = 0; attempt < 8; attempt++) {
    const observed = localParts(new Date(candidate), timeZone);
    if (sameParts(observed, parts)) return new Date(candidate);
    const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    candidate += target - observedAsUtc;
  }
  // A local time may not exist during a daylight-saving transition. Resolve to
  // the first real minute after the requested wall time rather than shifting it
  // silently to an earlier instant.
  for (let minute = 1; minute <= 180; minute++) {
    const after = new Date(candidate + minute * 60_000);
    const observed = localParts(after, timeZone);
    const observedValue = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    if (observedValue >= target) return after;
  }
  throw new BadRequestException('The schedule time could not be resolved in its time zone.');
}

function nextOccurrence(
  occurrence: Date,
  frequency: typeof FREQUENCIES[number],
  interval: number,
  timeZone: string,
  monthlyDay: number,
): Date {
  const current = localParts(occurrence, timeZone);
  const date = new Date(Date.UTC(current.year, current.month - 1, current.day));
  if (frequency === 'DAILY') date.setUTCDate(date.getUTCDate() + interval);
  else if (frequency === 'WEEKLY') date.setUTCDate(date.getUTCDate() + interval * 7);
  else {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + interval);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(monthlyDay, lastDay));
  }
  return wallTimeToUtc({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: current.hour,
    minute: current.minute,
    second: current.second,
  }, timeZone);
}

function followingRun(
  schedule: { frequency: string; interval: number; timeZone: string; startAt: Date; endAt: Date | null },
  occurrenceAt: Date,
): Date | null {
  const frequency = schedule.frequency as typeof FREQUENCIES[number];
  if (!FREQUENCIES.includes(frequency) || schedule.interval < 1) {
    throw new BadRequestException('Recurring schedule settings are invalid.');
  }
  const monthlyDay = localParts(schedule.startAt, schedule.timeZone).day;
  const following = nextOccurrence(occurrenceAt, frequency, schedule.interval, schedule.timeZone, monthlyDay);
  return schedule.endAt && following > schedule.endAt ? null : following;
}

function parseLocalDateTime(value: unknown, timeZone: string): Date | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) return null;
  return wallTimeToUtc({ year, month, day, hour, minute, second: 0 }, timeZone);
}

function nextRunAfterEdit(
  schedule: { frequency: string; interval: number; timeZone: string; startAt: Date; endAt: Date | null },
  now: Date,
): Date | null {
  const frequency = schedule.frequency as typeof FREQUENCIES[number];
  if (!FREQUENCIES.includes(frequency) || !Number.isSafeInteger(schedule.interval) ||
    schedule.interval < 1 || schedule.interval > 365) {
    throw new BadRequestException('Recurring schedule settings are invalid.');
  }
  if (schedule.startAt >= now) return schedule.endAt && schedule.startAt > schedule.endAt ? null : schedule.startAt;

  const start = localParts(schedule.startAt, schedule.timeZone);
  const current = localParts(now, schedule.timeZone);
  const startDay = Date.UTC(start.year, start.month - 1, start.day) / 86_400_000;
  const currentDay = Date.UTC(current.year, current.month - 1, current.day) / 86_400_000;
  const elapsedDays = Math.max(0, currentDay - startDay);
  const elapsedMonths = Math.max(0, (current.year - start.year) * 12 + current.month - start.month);
  const period = frequency === 'DAILY' ? schedule.interval
    : frequency === 'WEEKLY' ? schedule.interval * 7
      : schedule.interval;
  let step = Math.max(0, Math.ceil((frequency === 'MONTHLY' ? elapsedMonths : elapsedDays) / period));
  const monthlyDay = start.day;
  let candidate = step === 0
    ? schedule.startAt
    : nextOccurrence(
      schedule.startAt,
      frequency,
      schedule.interval * step,
      schedule.timeZone,
      monthlyDay,
    );
  if (candidate < now) {
    step += 1;
    candidate = nextOccurrence(
      schedule.startAt,
      frequency,
      schedule.interval * step,
      schedule.timeZone,
      monthlyDay,
    );
  }
  return schedule.endAt && candidate > schedule.endAt ? null : candidate;
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

@Injectable()
export class FieldJobSchedulesService {
  private readonly logger = new Logger(FieldJobSchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly queue: QueueService,
  ) {
    this.queue.registerProcessor('field-job-recurring-occurrence', async (data) => {
      const scheduleId = Number(data?.scheduleId);
      if (!Number.isSafeInteger(scheduleId) || scheduleId < 1) {
        throw new BadRequestException('Recurring work queue received an invalid schedule ID.');
      }
      const claimToken = typeof data?.claimToken === 'string' ? data.claimToken : '';
      if (!/^[0-9a-f-]{36}$/i.test(claimToken)) {
        throw new BadRequestException('Recurring work queue received an invalid claim token.');
      }
      await this.generateOne(scheduleId, new Date(), claimToken);
    });
  }

  private actorId(actor: Actor): number {
    const id = this.scope.actorId(actor);
    if (!Number.isSafeInteger(id) || id < 1) throw new ForbiddenException('Your account has no user identity.');
    return id;
  }

  private async companyId(actor: Actor): Promise<number> {
    if (!actor || actor.role === 'SUPER_ADMIN') {
      throw new ForbiddenException('Use a company account to manage recurring field work.');
    }
    const companyId = await this.scope.companyRootId(this.actorId(actor));
    if (!companyId) throw new ForbiddenException('A company scope is required.');
    return companyId;
  }

  private async requirePermission(actor: Actor, permission: string) {
    if (actor?.role === 'SUPER_ADMIN' || actor?.role === 'ADMIN') return;
    const userId = this.actorId(actor);
    const ancestors = await this.scope.ancestorIds(userId);
    const denied = await this.prisma.userPermission.findFirst({
      where: { userId: { in: ancestors }, permission: { in: [permission, '*', 'field-jobs.*'] }, allowed: false },
      select: { id: true },
    });
    if (denied) throw new ForbiddenException('You do not have permission to manage recurring field work.');
    const grant = await this.prisma.rolePermission.findFirst({
      where: { role: actor?.role ?? '', permission: { in: [permission, '*', 'field-jobs.*'] } },
      select: { id: true },
    });
    if (!grant) throw new ForbiddenException('You do not have permission to manage recurring field work.');
  }

  async list(actor: Actor) {
    await this.requirePermission(actor, 'field-jobs.read');
    const companyId = await this.companyId(actor);
    return this.prisma.fieldJobSchedule.findMany({
      where: { companyId },
      orderBy: [{ status: 'asc' }, { nextRunAt: 'asc' }, { id: 'desc' }],
      take: 200,
      include: {
        occurrences: {
          orderBy: { occurrenceAt: 'desc' },
          take: 20,
          include: { fieldJob: { select: { id: true, jobNo: true, status: true } } },
        },
      },
    });
  }

  async create(input: ScheduleInput, actor: Actor) {
    await this.requirePermission(actor, 'field-jobs.schedules');
    const companyId = await this.companyId(actor);
    const type = String(input.type ?? 'MAINTENANCE') as FieldJobType;
    const priority = String(input.priority ?? 'MEDIUM') as TicketPriority;
    const frequency = String(input.frequency ?? '') as typeof FREQUENCIES[number];
    if (!TYPES.includes(type)) throw new BadRequestException('Unknown field-job type.');
    if (!PRIORITIES.includes(priority)) throw new BadRequestException('Unknown field-job priority.');
    if (!FREQUENCIES.includes(frequency)) throw new BadRequestException('Frequency must be daily, weekly, or monthly.');
    const interval = Number(input.interval ?? 1);
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 365) {
      throw new BadRequestException('Recurrence interval must be between 1 and 365.');
    }
    const timeZone = typeof input.timeZone === 'string' ? input.timeZone.trim() : '';
    if (!timeZone || timeZone.length > 100) throw new BadRequestException('An IANA time zone is required.');
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    } catch {
      throw new BadRequestException('Enter a valid IANA time zone.');
    }
    const parseLocal = (value: unknown) => {
      if (typeof value !== 'string') return null;
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
      if (!match) return null;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const hour = Number(match[4]);
      const minute = Number(match[5]);
      const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
      if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month ||
        check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) return null;
      return wallTimeToUtc({ year, month, day, hour, minute, second: 0 }, timeZone);
    };
    const startAt = parseLocal(input.startAtLocal) ?? new Date(String(input.startAt ?? ''));
    if (!Number.isFinite(startAt.getTime())) throw new BadRequestException('A valid schedule start date is required.');
    const endAt = input.endAtLocal == null || input.endAtLocal === ''
      ? input.endAt == null || input.endAt === '' ? null : new Date(String(input.endAt))
      : parseLocal(input.endAtLocal);
    if (input.endAtLocal && !endAt) throw new BadRequestException('The schedule end time is not valid for this time zone.');
    if (endAt && (!Number.isFinite(endAt.getTime()) || endAt < startAt)) {
      throw new BadRequestException('The schedule end must be on or after its start.');
    }
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description || description.length > 5000) throw new BadRequestException('Description is required and must be 5000 characters or fewer.');
    const workInstructions = typeof input.workInstructions === 'string' ? input.workInstructions.trim() : '';
    const address = typeof input.address === 'string' ? input.address.trim() : '';
    const subscriberId = input.subscriberId == null || input.subscriberId === '' ? null : Number(input.subscriberId);
    const ticketId = input.ticketId == null || input.ticketId === '' ? null : Number(input.ticketId);
    const leadId = input.leadId == null || input.leadId === '' ? null : Number(input.leadId);
    if ([subscriberId, ticketId, leadId].some((id) => id != null && (!Number.isSafeInteger(id) || id < 1))) {
      throw new BadRequestException('Related record IDs must be positive integers.');
    }
    if (ticketId && (subscriberId || leadId)) throw new BadRequestException('A schedule can link to one subscriber, ticket, or lead.');
    if (leadId && subscriberId) throw new BadRequestException('A schedule can link to one subscriber, ticket, or lead.');
    if (subscriberId) await this.scope.assertSubscriber(actor, subscriberId);
    let ticketSubscriberId: number | null = null;
    if (ticketId) {
      const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { subscriberId: true } });
      if (!ticket) throw new NotFoundException('Ticket not found.');
      await this.scope.assertSubscriber(actor, ticket.subscriberId);
      ticketSubscriberId = ticket.subscriberId;
    }
    if (leadId) {
      const lead = await this.prisma.crmLead.findFirst({ where: { id: leadId, companyId }, select: { id: true } });
      if (!lead) throw new NotFoundException('CRM lead not found in this company.');
    }
    const linkedSubscriberId = subscriberId ?? ticketSubscriberId;
    const createdById = this.actorId(actor);
    return this.prisma.$transaction(async (tx) => {
      const schedule = await tx.fieldJobSchedule.create({
        data: {
          companyId,
          createdById,
          subscriberId: linkedSubscriberId,
          ticketId,
          leadId,
          type,
          priority,
          description,
          workInstructions: workInstructions.slice(0, 5000) || null,
          address: address.slice(0, 500) || null,
          frequency,
          interval,
          timeZone,
          startAt,
          endAt,
          nextRunAt: startAt,
        },
      });
      await tx.activityLog.create({
        data: {
          userId: createdById,
          action: 'FIELD_JOB_SCHEDULE.CREATED',
          entity: 'FieldJobSchedule',
          entityId: schedule.id,
          details: `Created ${frequency.toLowerCase()} recurring ${type.toLowerCase()} schedule in ${timeZone}.`,
        },
      });
      return schedule;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async update(id: number, input: UpdateFieldJobScheduleDto, actor: Actor) {
    await this.requirePermission(actor, 'field-jobs.schedules');
    const companyId = await this.companyId(actor);
    const actorUserId = this.actorId(actor);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException('A schedule update object is required.');
    }
    const allowedFields = new Set([
      'type', 'priority', 'description', 'workInstructions', 'address',
      'frequency', 'interval', 'timeZone', 'startAtLocal', 'endAtLocal',
      'subscriberId', 'ticketId', 'leadId',
    ]);
    const suppliedFields = Object.keys(input);
    if (suppliedFields.some((field) => !allowedFields.has(field))) {
      throw new BadRequestException('The schedule update contains an unsupported field.');
    }
    if (suppliedFields.length === 0) throw new BadRequestException('Provide at least one schedule field to update.');
    const has = (field: string) => Object.prototype.hasOwnProperty.call(input, field);

    return this.prisma.$transaction(async (tx) => {
      const schedule = await tx.fieldJobSchedule.findFirst({ where: { id, companyId } });
      if (!schedule) throw new NotFoundException('Recurring schedule not found.');
      if (schedule.status === 'CANCELLED') throw new ConflictException('A cancelled schedule cannot be edited.');

      const now = new Date();
      if (schedule.lockedUntil && schedule.lockedUntil > now) {
        throw new ConflictException('A worker currently holds this schedule claim. Retry the edit after its lease expires.');
      }

      const data: Prisma.FieldJobScheduleUncheckedUpdateManyInput = {};
      const changedFields: string[] = [];
      const markChanged = (field: string, changed: boolean) => {
        if (changed) changedFields.push(field);
      };

      if (has('type')) {
        if (typeof input.type !== 'string' || !TYPES.includes(input.type as FieldJobType)) {
          throw new BadRequestException('Choose a supported field-job type.');
        }
        data.type = input.type as FieldJobType;
        markChanged('type', data.type !== schedule.type);
      }
      if (has('priority')) {
        if (typeof input.priority !== 'string' || !PRIORITIES.includes(input.priority as TicketPriority)) {
          throw new BadRequestException('Choose a supported field-job priority.');
        }
        data.priority = input.priority as TicketPriority;
        markChanged('priority', data.priority !== schedule.priority);
      }
      if (has('description')) {
        if (typeof input.description !== 'string' || !input.description.trim() || input.description.trim().length > 5000) {
          throw new BadRequestException('Description is required and must be 5000 characters or fewer.');
        }
        data.description = input.description.trim();
        markChanged('description', data.description !== schedule.description);
      }
      if (has('workInstructions')) {
        if (input.workInstructions != null && typeof input.workInstructions !== 'string') {
          throw new BadRequestException('Work instructions must be text.');
        }
        const workInstructions = typeof input.workInstructions === 'string' ? input.workInstructions.trim() : '';
        if (workInstructions.length > 5000) {
          throw new BadRequestException('Work instructions must be 5000 characters or fewer.');
        }
        data.workInstructions = workInstructions || null;
        markChanged('workInstructions', data.workInstructions !== schedule.workInstructions);
      }
      if (has('address')) {
        if (input.address != null && typeof input.address !== 'string') {
          throw new BadRequestException('Service address must be text.');
        }
        const address = typeof input.address === 'string' ? input.address.trim() : '';
        if (address.length > 500) throw new BadRequestException('Service address must be 500 characters or fewer.');
        data.address = address || null;
        markChanged('address', data.address !== schedule.address);
      }

      let frequency = schedule.frequency as typeof FREQUENCIES[number];
      let interval = schedule.interval;
      let timeZone = schedule.timeZone;
      let startAt = schedule.startAt;
      let endAt = schedule.endAt;
      const recurrenceFields = ['frequency', 'interval', 'timeZone', 'startAtLocal', 'endAtLocal'];
      const recurrenceChanged = recurrenceFields.some((field) => has(field));

      if (has('frequency')) {
        if (typeof input.frequency !== 'string' || !FREQUENCIES.includes(input.frequency as typeof FREQUENCIES[number])) {
          throw new BadRequestException('Frequency must be daily, weekly, or monthly.');
        }
        frequency = input.frequency as typeof FREQUENCIES[number];
        data.frequency = frequency;
        markChanged('frequency', frequency !== schedule.frequency);
      }
      if (has('interval')) {
        const rawInterval = input.interval;
        if (!(typeof rawInterval === 'number' || (typeof rawInterval === 'string' && /^\d+$/.test(rawInterval)))) {
          throw new BadRequestException('Recurrence interval must be a whole number between 1 and 365.');
        }
        interval = Number(rawInterval);
        if (!Number.isSafeInteger(interval) || interval < 1 || interval > 365) {
          throw new BadRequestException('Recurrence interval must be between 1 and 365.');
        }
        data.interval = interval;
        markChanged('interval', interval !== schedule.interval);
      }
      if (has('timeZone')) {
        if (typeof input.timeZone !== 'string' || !input.timeZone.trim() || input.timeZone.trim().length > 100) {
          throw new BadRequestException('An IANA time zone is required.');
        }
        timeZone = input.timeZone.trim();
        try {
          new Intl.DateTimeFormat('en-US', { timeZone }).format(now);
        } catch {
          throw new BadRequestException('Enter a valid IANA time zone.');
        }
        data.timeZone = timeZone;
        markChanged('timeZone', timeZone !== schedule.timeZone);
      }
      if (has('startAtLocal')) {
        const parsedStartAt = parseLocalDateTime(input.startAtLocal, timeZone);
        if (!parsedStartAt) throw new BadRequestException('A valid start date and time in the selected timezone is required.');
        startAt = parsedStartAt;
        data.startAt = startAt;
        markChanged('startAt', !sameDate(startAt, schedule.startAt));
      }
      if (has('endAtLocal')) {
        if (input.endAtLocal == null || input.endAtLocal === '') {
          endAt = null;
        } else {
          endAt = parseLocalDateTime(input.endAtLocal, timeZone);
          if (!endAt) throw new BadRequestException('The schedule end time is not valid for this time zone.');
        }
        data.endAt = endAt;
        markChanged('endAt', !sameDate(endAt, schedule.endAt));
      }
      if (endAt && endAt < startAt) {
        throw new BadRequestException('The schedule end must be on or after its start.');
      }

      const hasRelatedRecord = ['subscriberId', 'ticketId', 'leadId'].some(has);
      if (hasRelatedRecord) {
        const relatedId = (field: 'subscriberId' | 'ticketId' | 'leadId') => {
          if (!has(field) || input[field] == null || input[field] === '') return null;
          const value = input[field];
          if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) {
            throw new BadRequestException('Related record IDs must be positive integers.');
          }
          const parsed = Number(value);
          if (!Number.isSafeInteger(parsed) || parsed < 1) {
            throw new BadRequestException('Related record IDs must be positive integers.');
          }
          return parsed;
        };
        const subscriberId = relatedId('subscriberId');
        const ticketId = relatedId('ticketId');
        const leadId = relatedId('leadId');
        if ([subscriberId, ticketId, leadId].filter((value) => value != null).length > 1) {
          throw new BadRequestException('A schedule can link to one subscriber, ticket, or lead.');
        }
        if (subscriberId) await this.scope.assertSubscriber(actor, subscriberId);
        let linkedSubscriberId: number | null = subscriberId;
        if (ticketId) {
          const ticket = await tx.ticket.findUnique({ where: { id: ticketId }, select: { subscriberId: true } });
          if (!ticket) throw new NotFoundException('Ticket not found.');
          await this.scope.assertSubscriber(actor, ticket.subscriberId);
          linkedSubscriberId = ticket.subscriberId;
        }
        if (leadId) {
          const lead = await tx.crmLead.findFirst({ where: { id: leadId, companyId }, select: { id: true } });
          if (!lead) throw new NotFoundException('CRM lead not found in this company.');
        }
        data.subscriberId = linkedSubscriberId;
        data.ticketId = ticketId;
        data.leadId = leadId;
        markChanged('subscriberId', linkedSubscriberId !== schedule.subscriberId);
        markChanged('ticketId', ticketId !== schedule.ticketId);
        markChanged('leadId', leadId !== schedule.leadId);
      }

      if (recurrenceChanged && recurrenceFields.some((field) => changedFields.includes(
        field === 'startAtLocal' ? 'startAt' : field === 'endAtLocal' ? 'endAt' : field,
      ))) {
        const nextRunAt = nextRunAfterEdit({ frequency, interval, timeZone, startAt, endAt }, now);
        data.nextRunAt = nextRunAt;
        markChanged('nextRunAt', !sameDate(nextRunAt, schedule.nextRunAt));
      }
      if (changedFields.length === 0) throw new BadRequestException('The schedule already has these values.');

      if (schedule.lockToken || schedule.lockedUntil) {
        data.lockToken = null;
        data.lockedUntil = null;
      }
      const updated = await tx.fieldJobSchedule.updateMany({
        where: {
          id,
          companyId,
          status: schedule.status,
          updatedAt: schedule.updatedAt,
          lockToken: schedule.lockToken,
          lockedUntil: schedule.lockedUntil,
        },
        data,
      });
      if (updated.count !== 1) {
        throw new ConflictException('The schedule or its worker claim changed during the edit. Reload it and try again.');
      }

      await tx.activityLog.create({
        data: {
          userId: actorUserId,
          action: 'FIELD_JOB_SCHEDULE.UPDATED',
          entity: 'FieldJobSchedule',
          entityId: id,
          details: `Updated future configuration for schedule ${id}; changed fields: ${changedFields.join(', ')}.`,
          createdAt: now,
        },
      });
      return tx.fieldJobSchedule.findUniqueOrThrow({
        where: { id },
        include: {
          occurrences: {
            orderBy: { occurrenceAt: 'desc' },
            take: 20,
            include: { fieldJob: { select: { id: true, jobNo: true, status: true } } },
          },
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async setStatus(id: number, status: string, actor: Actor) {
    await this.requirePermission(actor, 'field-jobs.schedules');
    if (!SCHEDULE_STATUSES.includes(status as typeof SCHEDULE_STATUSES[number])) {
      throw new BadRequestException('Schedule status must be active, paused, or cancelled.');
    }
    const companyId = await this.companyId(actor);
    const actorUserId = this.actorId(actor);
    return this.prisma.$transaction(async (tx) => {
      const schedule = await tx.fieldJobSchedule.findFirst({ where: { id, companyId } });
      if (!schedule) throw new NotFoundException('Recurring schedule not found.');
      if (schedule.status === 'CANCELLED') throw new ConflictException('A cancelled schedule cannot be changed.');
      if (schedule.lockedUntil && schedule.lockedUntil > new Date()) {
        throw new ConflictException('A worker currently holds this schedule claim. Retry the status change after its lease expires.');
      }
      if (status === 'ACTIVE' && schedule.nextRunAt == null) {
        throw new ConflictException('This schedule has no future occurrence remaining and cannot be resumed.');
      }
      const updated = await tx.fieldJobSchedule.updateMany({
        where: {
          id,
          companyId,
          status: schedule.status,
          updatedAt: schedule.updatedAt,
          lockToken: schedule.lockToken,
          lockedUntil: schedule.lockedUntil,
        },
        data: {
          status,
          nextRunAt: schedule.nextRunAt,
          lockedUntil: null,
          lockToken: null,
        },
      });
      if (updated.count !== 1) throw new ConflictException('Schedule changed while it was being updated.');
      await tx.activityLog.create({
        data: {
          userId: actorUserId,
          action: `FIELD_JOB_SCHEDULE.${status}`,
          entity: 'FieldJobSchedule',
          entityId: id,
          details: `Recurring field-job schedule ${id} set to ${status}.`,
        },
      });
      return tx.fieldJobSchedule.findUniqueOrThrow({ where: { id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async generateDueOccurrences() {
    if (!isPrimaryInstance()) return;
    const now = new Date();
    const due = await this.prisma.fieldJobSchedule.findMany({
      where: {
        status: 'ACTIVE',
        nextRunAt: { lte: now },
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      orderBy: { nextRunAt: 'asc' },
      take: 50,
    });
    for (const schedule of due) {
      const claimToken = randomUUID();
      try {
        const claimed = await this.prisma.fieldJobSchedule.updateMany({
          where: {
            id: schedule.id,
            status: 'ACTIVE',
            nextRunAt: schedule.nextRunAt,
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
          },
          data: { lockToken: claimToken, lockedUntil: new Date(now.getTime() + 10 * 60_000) },
        });
        if (claimed.count !== 1) continue;
        await this.queue.add('field-job-recurring-occurrence', { scheduleId: schedule.id, claimToken });
      } catch (error) {
        try {
          await this.prisma.fieldJobSchedule.updateMany({
            where: { id: schedule.id, lockToken: claimToken },
            data: { lockToken: null, lockedUntil: null },
          });
        } catch (releaseError) {
          this.logger.error(`Could not release recurring schedule claim ${schedule.id}: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
        }
        this.logger.error(`Could not enqueue occurrence for schedule ${schedule.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async generateOne(scheduleId: number, now: Date, claimToken: string) {
    await this.prisma.$transaction(async (tx) => {
      const schedule = await tx.fieldJobSchedule.findUnique({ where: { id: scheduleId } });
      if (!schedule || schedule.status !== 'ACTIVE' || schedule.lockToken !== claimToken ||
        !schedule.nextRunAt || schedule.nextRunAt > now) return;
      const occurrenceAt = schedule.nextRunAt;
      const existing = await tx.fieldJobOccurrence.findUnique({
        where: { scheduleId_occurrenceAt: { scheduleId, occurrenceAt } },
        select: { id: true },
      });
      if (existing) {
        const changed = await tx.fieldJobSchedule.updateMany({
          where: { id: scheduleId, status: 'ACTIVE', nextRunAt: occurrenceAt, lockToken: claimToken },
          data: { nextRunAt: followingRun(schedule, occurrenceAt), lockedUntil: null, lockToken: null },
        });
        if (changed.count !== 1) throw new ConflictException('Schedule claim changed while reconciling an existing occurrence.');
        return;
      }

      const createdById = schedule.createdById ?? schedule.companyId;
      const placeholder = `FJ-TMP-${randomUUID()}`;
      const job = await tx.fieldJob.create({
        data: {
          jobNo: placeholder,
          type: schedule.type,
          priority: schedule.priority,
          status: 'PENDING',
          subscriberId: schedule.subscriberId,
          ticketId: schedule.ticketId,
          leadId: schedule.leadId,
          description: schedule.description,
          workInstructions: schedule.workInstructions,
          address: schedule.address,
          scheduledAt: occurrenceAt,
          createdById,
        },
      });
      const jobNo = `FJ-${occurrenceAt.getFullYear()}-${String(job.id).padStart(6, '0')}`;
      await tx.fieldJob.update({ where: { id: job.id }, data: { jobNo } });
      await tx.fieldJobOccurrence.create({ data: { scheduleId, fieldJobId: job.id, occurrenceAt } });
      await tx.fieldJobActivity.create({
        data: {
          fieldJobId: job.id,
          actorUserId: createdById,
          action: 'RECURRING_GENERATED',
          detail: `Generated from recurring schedule ${scheduleId} for ${occurrenceAt.toISOString()}.`,
        },
      });
      await tx.activityLog.create({
        data: {
          userId: createdById,
          action: 'FIELD_JOB.RECURRING_GENERATED',
          entity: 'FieldJob',
          entityId: job.id,
          details: `Generated ${jobNo} from recurring schedule ${scheduleId}.`,
        },
      });

      const nextRunAt = followingRun(schedule, occurrenceAt);
      const changed = await tx.fieldJobSchedule.updateMany({
        where: { id: scheduleId, status: 'ACTIVE', nextRunAt: occurrenceAt, lockToken: claimToken },
        data: { nextRunAt, lockedUntil: null, lockToken: null },
      });
      if (changed.count !== 1) throw new ConflictException('Schedule claim changed during occurrence generation.');
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
