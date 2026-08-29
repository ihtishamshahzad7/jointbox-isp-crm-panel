import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AlertsService } from '../notifications/alerts.service';
import { isPrimaryInstance } from '../common/cluster-util';
import { OutageClassifierService } from './outage-classifier.service';

/**
 * What a CUSTOMER is told, per classified cause.
 *
 * The internal labels (POWER_RELATED, FIBER_CUT) are diagnostic; these are the
 * sentences a person reads on the public page while their internet is down.
 * Two rules shaped them:
 *
 *   Say who is fixing it. "Fibre fault" alone invites a support call; "our
 *   technicians are on their way" answers the question they were about to ask.
 *   That call deflection is the entire commercial case for this page.
 *
 *   Never imply a restoration time we cannot honour. A power cut ends when the
 *   grid returns, which is not ours to promise — so the wording points at the
 *   load-shedding schedule instead of inventing an ETA.
 *
 * Urdu is carried alongside English because a large share of subscribers in
 * this market read it more comfortably, and this page is read under stress.
 */
const PUBLIC_CAUSE = {
  OPERATIONAL: {
    en: 'Service is running normally.',
    ur: 'سروس معمول کے مطابق چل رہی ہے۔',
  },
  POWER_RELATED: {
    en: 'A power failure in your area has interrupted service. It will return once power is restored — please check your load-shedding schedule.',
    ur: 'آپ کے علاقے میں بجلی بند ہونے کی وجہ سے سروس متاثر ہے۔ بجلی بحال ہوتے ہی سروس واپس آ جائے گی۔',
  },
  FIBER_CUT: {
    en: 'A fibre fault in your area has interrupted service. Our technicians have been dispatched.',
    ur: 'آپ کے علاقے میں فائبر کی خرابی کے باعث سروس متاثر ہے۔ ہماری ٹیم روانہ ہو چکی ہے۔',
  },
  EQUIPMENT_FAILURE: {
    en: 'Equipment serving your area has failed. Our team is working to restore service.',
    ur: 'آپ کے علاقے کا نیٹ ورک آلہ خراب ہے۔ ہماری ٹیم بحالی پر کام کر رہی ہے۔',
  },
  UPSTREAM_ISP: {
    en: 'An upstream network fault is affecting several areas. We are working with our provider.',
    ur: 'اپ اسٹریم نیٹ ورک کی خرابی کئی علاقوں کو متاثر کر رہی ہے۔ ہم اپنے فراہم کنندہ کے ساتھ کام کر رہے ہیں۔',
  },
  UNKNOWN: {
    en: 'Service in your area is affected. Our team is investigating.',
    ur: 'آپ کے علاقے میں سروس متاثر ہے۔ ہماری ٹیم تحقیقات کر رہی ہے۔',
  },
} as const;

/**
 * OutagesService — tells power cuts apart from network faults.
 *
 * THE PROBLEM THIS SOLVES
 * In Pakistan most "my internet is down" calls are load-shedding, not the ISP.
 * Without a way to distinguish them, support burns hours on faults that aren't
 * yours, technicians get dispatched for nothing, and your uptime figures look
 * far worse than the service you actually delivered.
 *
 * HOW IT WORKS
 * The poller already knows when sessions end. When a large share of ONE area
 * drops inside a short window, that is not coincidence — it is an outage. We
 * then check the published load-shedding timetable:
 *   • inside a scheduled window  → SCHEDULED (WAPDA, expected)
 *   • outside it                 → UNSCHEDULED (WAPDA, unplanned)
 *   • one NAS, many areas        → NETWORK (ours — dispatch someone)
 *
 * The ratio matters more than the count: 8 of 10 customers dropping is an
 * outage; 8 of 800 is eight separate faults.
 */
@Injectable()
export class OutagesService {
  private readonly logger = new Logger(OutagesService.name);

  /** Share of an area that must drop before it counts as an outage. */
  private readonly threshold = Number(process.env.OUTAGE_THRESHOLD_PERCENT || 50) / 100;
  /** Minimum customers — avoids flagging tiny areas on one or two drops. */
  private readonly minAffected = Number(process.env.OUTAGE_MIN_AFFECTED || 3);
  /** How far back a "simultaneous" drop counts. */
  private readonly windowMin = Number(process.env.OUTAGE_WINDOW_MINUTES || 15);

  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
    private notifications: NotificationsService,
    private alerts: AlertsService,
    private classifier: OutageClassifierService,
  ) {}

  // ── Schedules ────────────────────────────────────────────────
  async listSchedules(areaId?: number) {
    return this.prisma.powerSchedule.findMany({
      where: areaId ? { areaId: Number(areaId) } : {},
      include: { area: { select: { id: true, name: true, city: true } } },
      orderBy: [{ areaId: 'asc' }, { startTime: 'asc' }],
    });
  }

  async createSchedule(data: any) {
    if (!data.areaId) throw new BadRequestException('An area is required.');
    if (!this.isTime(data.startTime) || !this.isTime(data.endTime)) {
      throw new BadRequestException('Times must be in HH:MM format, e.g. 18:00.');
    }
    return this.prisma.powerSchedule.create({
      data: {
        areaId: Number(data.areaId),
        dayOfWeek: data.dayOfWeek === '' || data.dayOfWeek === null || data.dayOfWeek === undefined
          ? null : Number(data.dayOfWeek),
        startTime: data.startTime,
        endTime: data.endTime,
        notes: data.notes || null,
      },
    });
  }

  async updateSchedule(id: number, data: any) {
    return this.prisma.powerSchedule.update({
      where: { id },
      data: {
        startTime: data.startTime,
        endTime: data.endTime,
        dayOfWeek: data.dayOfWeek === '' ? null : data.dayOfWeek !== undefined ? Number(data.dayOfWeek) : undefined,
        isActive: data.isActive,
        notes: data.notes,
      },
    });
  }

  async removeSchedule(id: number) {
    await this.prisma.powerSchedule.delete({ where: { id } }).catch(() => null);
    return { deleted: true, id };
  }

  /**
   * Is this area inside a published load-shedding window right now?
   * Handles windows that wrap past midnight (22:00 → 02:00).
   */
  async isAreaScheduledOff(areaId: number, at = new Date()): Promise<boolean> {
    const schedules = await this.prisma.powerSchedule.findMany({
      where: { areaId, isActive: true },
    });
    if (!schedules.length) return false;

    const day = at.getDay();
    const mins = at.getHours() * 60 + at.getMinutes();

    return schedules.some((s) => {
      if (s.dayOfWeek !== null && s.dayOfWeek !== day) return false;
      const start = this.toMinutes(s.startTime);
      const end = this.toMinutes(s.endTime);
      if (start === null || end === null) return false;
      // A window ending before it starts crosses midnight.
      return end >= start ? mins >= start && mins < end : mins >= start || mins < end;
    });
  }

  // ── Detection ────────────────────────────────────────────────
  /**
   * Runs every few minutes. Looks for areas where a large share of customers
   * dropped inside the window and opens an outage if one isn't already open.
   */
  @Cron('*/5 * * * *')
  async detect() {
    // CLUSTER GUARD — background work must run on ONE process only.
    // Without this the cron fired on every pm2 instance (11 web + 1 worker
    // = 12 concurrent runs of the same job), which duplicated side effects
    // and flooded the logs with identical rows.
    if (!isPrimaryInstance()) return;
    if (process.env.OUTAGE_DETECTION === 'false') return;
    try {
      const since = new Date(Date.now() - this.windowMin * 60_000);

      // Recent drops grouped by area, alongside that area's total customer base.
      const rows = await this.prisma.$queryRaw<any[]>`
        SELECT s."areaId"                       AS area_id,
                COUNT(DISTINCT r.username)::int  AS dropped,
                (SELECT COUNT(*)::int FROM "Subscriber" s2
                  WHERE s2."areaId" = s."areaId" AND s2.status = 'ACTIVE') AS area_total,
                COUNT(DISTINCT r.nasipaddress)::int AS nas_count
           FROM radacct r
           JOIN "Subscriber" s ON s.username = r.username
          WHERE r.acctstoptime >= ${since}
            AND s."areaId" IS NOT NULL
          GROUP BY s."areaId"`;

      for (const row of rows) {
        const areaId = Number(row.area_id);
        const dropped = Number(row.dropped);
        const total = Number(row.area_total) || 1;
        const share = dropped / total;

        if (dropped < this.minAffected || share < this.threshold) continue;

        // Already tracking this one?
        const open = await this.prisma.powerOutage.findFirst({
          where: { areaId, endedAt: null },
        });
        if (open) {
          if (dropped > open.affectedCount) {
            await this.prisma.powerOutage.update({
              where: { id: open.id },
              data: { affectedCount: dropped },
            });
          }
          continue;
        }

        const scheduled = await this.isAreaScheduledOff(areaId);
        const type = scheduled ? 'SCHEDULED' : 'UNSCHEDULED';

        /**
         * Score the CAUSE, not just whether it was scheduled.
         *
         * This automates what the old note left to a person — it ended
         * "verify whether this is power or network". The classifier reads the
         * dying-gasp and loss-of-signal states the ONUs already report, which
         * separate a power cut from a fibre fault without anyone driving out
         * to look.
         *
         * Never fatal: an outage detected but unclassified is still far more
         * useful than no outage record at all.
         */
        const verdict = await this.classifier
          .classify(areaId, { scheduled })
          .catch((e: any) => {
            this.logger.warn(`Cause classification failed for area ${areaId}: ${e?.message || e}`);
            return null;
          });

        const outage = await this.prisma.powerOutage.create({
          data: {
            areaId,
            type: type as any,
            source: 'MASS_DISCONNECT',
            affectedCount: dropped,
            areaTotal: total,
            ...(verdict
              ? {
                  cause: verdict.cause as any,
                  causeConfidence: verdict.confidence,
                  causeReasons: verdict.reasons.join('; ').slice(0, 600),
                }
              : {}),
            notes: verdict
              ? this.classifier.describe(verdict)
              : scheduled
                ? 'Matches the published load-shedding timetable.'
                : 'Mass disconnection outside any scheduled window — verify whether this is power or network.',
          },
          include: { area: { select: { name: true } } },
        });

        this.logger.warn(
          `Outage detected in ${outage.area?.name ?? `area ${areaId}`}: ` +
            `${dropped}/${total} customers offline (${Math.round(share * 100)}%) — ${type}` +
            (verdict ? ` · ${verdict.cause} (${Math.round(verdict.confidence * 100)}%)` : ''),
        );

        /**
         * Push to Discord / WhatsApp so the operator knows before customers
         * call — and now knows WHY. The cause is what decides the next
         * action: dispatch a technician, or wait for the grid.
         */
        const CAUSE_ICON: Record<string, string> = {
          POWER_RELATED: '⚡', FIBER_CUT: '✂️', EQUIPMENT_FAILURE: '🖧',
          UPSTREAM_ISP: '🌐', UNKNOWN: '❓',
        };
        this.alerts.send({
          title:
            `${scheduled ? '🟠' : '🔴'} Outage — ${outage.area?.name ?? `area ${areaId}`}` +
            (verdict && verdict.cause !== 'UNKNOWN'
              ? ` · ${CAUSE_ICON[verdict.cause] ?? ''} ${verdict.cause.replace(/_/g, ' ').toLowerCase()}`
              : ''),
          message: verdict
            ? this.classifier.describe(verdict)
            : scheduled
              ? 'Mass disconnection matching the published load-shedding timetable.'
              : 'Mass disconnection outside any scheduled window — verify power or network.',
          level: scheduled ? 'WARN' : 'ERROR',
          fields: {
            Area: outage.area?.name ?? `#${areaId}`,
            Affected: `${dropped}/${total}`,
            Share: `${Math.round(share * 100)}%`,
            Type: type,
            ...(verdict
              ? {
                  Cause: verdict.cause.replace(/_/g, ' '),
                  // Say how sure this is. An operator acting on a 20% guess
                  // needs to know it was a guess.
                  Confidence: `${Math.round(verdict.confidence * 100)}%`,
                }
              : {}),
          },
        }).catch(() => null);
      }

      await this.closeRecovered();
    } catch (e: any) {
      this.logger.warn(`Outage detection failed: ${e?.message || e}`);
    }
  }

  /** Close outages where most of the area is back online. */
  private async closeRecovered() {
    const open = await this.prisma.powerOutage.findMany({ where: { endedAt: null } });
    for (const o of open) {
      if (!o.areaId) continue;
      const rows = await this.prisma.$queryRaw<any[]>`
        SELECT COUNT(DISTINCT r.username)::int AS online
           FROM radacct r JOIN "Subscriber" s ON s.username = r.username
          WHERE s."areaId" = ${o.areaId} AND r.acctstoptime IS NULL
            AND COALESCE(r.acctupdatetime, r.acctstarttime) > NOW() - INTERVAL '15 minutes'`;
      const online = Number(rows?.[0]?.online ?? 0);
      // Back to at least half the area connected → treat as restored.
      if (o.areaTotal > 0 && online / o.areaTotal >= 0.5) {
        await this.prisma.powerOutage.update({
          where: { id: o.id },
          data: { endedAt: new Date() },
        });
        this.logger.log(`Outage in area ${o.areaId} cleared — ${online}/${o.areaTotal} back online`);
      }
    }
  }

  // ── Read ─────────────────────────────────────────────────────
  /**
   * PUBLIC status — what a customer with no login may see.
   *
   * Deliberately a separate method rather than a filter over currentStatus():
   * that one returns exact subscriber counts per area, offline percentages and
   * internal verdicts like "investigate power or network". Published on an open
   * page, the counts hand every competitor a live map of the business, and the
   * verdicts are instructions to staff, not information for customers.
   *
   * This returns only what someone standing in that area actually needs: is my
   * area up, why not, and since when. No counts, no percentages, no notes, no
   * subscriber data, no internal ids beyond the area itself.
   *
   * `since` is coarsened to the minute — the exact second an outage opened
   * reveals the polling cadence and is of no use to a customer.
   */
  async publicStatus() {
    const areas = await this.prisma.area.findMany({
      where: { isActive: true },
      select: { id: true, name: true, city: true },
      orderBy: { name: 'asc' },
    });
    if (!areas.length) return { areas: [], checkedAt: new Date() };

    // One query for every open outage rather than one per area.
    const open = await this.prisma.powerOutage.findMany({
      where: { endedAt: null, areaId: { in: areas.map((a) => a.id) } },
      select: {
        areaId: true, startedAt: true, type: true,
        cause: true, causeConfidence: true,
      },
    });
    const byArea = new Map(open.map((o) => [o.areaId, o]));

    const out = areas.map((a) => {
      const o = byArea.get(a.id);
      if (!o) {
        return {
          area: a.name,
          city: a.city,
          status: 'OPERATIONAL' as const,
          cause: null,
          message: PUBLIC_CAUSE.OPERATIONAL,
          since: null,
        };
      }
      /**
       * Only state a cause the system is actually confident about. Below the
       * threshold a customer is told service is affected and being
       * investigated — which is true — rather than being given a guess they
       * will repeat back to support as fact.
       */
      const confident = (o.causeConfidence ?? 0) >= 0.6;
      const key = confident ? (o.cause ?? 'UNKNOWN') : 'UNKNOWN';
      return {
        area: a.name,
        city: a.city,
        status: 'OUTAGE' as const,
        cause: confident ? o.cause : null,
        message: PUBLIC_CAUSE[key as keyof typeof PUBLIC_CAUSE] ?? PUBLIC_CAUSE.UNKNOWN,
        since: new Date(Math.floor(o.startedAt.getTime() / 60_000) * 60_000),
      };
    });

    return {
      areas: out.sort((a, b) => (a.status === b.status ? 0 : a.status === 'OUTAGE' ? -1 : 1)),
      checkedAt: new Date(),
    };
  }

  /**
   * Recent resolved incidents, for the public page's history strip.
   * Same rule as above: area, cause, and when — nothing else.
   */
  async publicHistory(days = 7) {
    const since = new Date(Date.now() - Math.min(Math.max(days, 1), 30) * 86400_000);
    const rows = await this.prisma.powerOutage.findMany({
      where: { startedAt: { gte: since }, endedAt: { not: null } },
      select: {
        startedAt: true, endedAt: true, cause: true, causeConfidence: true,
        area: { select: { name: true } },
      },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => {
      const confident = (r.causeConfidence ?? 0) >= 0.6;
      const key = confident ? (r.cause ?? 'UNKNOWN') : 'UNKNOWN';
      return {
        area: r.area?.name ?? 'Unknown area',
        cause: confident ? r.cause : null,
        message: PUBLIC_CAUSE[key as keyof typeof PUBLIC_CAUSE] ?? PUBLIC_CAUSE.UNKNOWN,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        minutes: r.endedAt
          ? Math.max(1, Math.round((r.endedAt.getTime() - r.startedAt.getTime()) / 60_000))
          : null,
      };
    });
  }

  async listOutages(actor?: Actor, query: any = {}) {
    const where: any = {};

    // SECURITY: `actor` was accepted and ignored, exposing outages in areas
    // the caller does not serve. Restricted to areas where they actually have
    // customers — which is also the only set that is useful to them.
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      const areas = await this.prisma.subscriber.findMany({
        where: { userId: { in: ids }, areaId: { not: null } },
        select: { areaId: true },
        distinct: ['areaId'],
      });
      const areaIds = areas.map((a) => a.areaId!).filter(Boolean);
      // No areas means no outages are theirs to see — fail closed.
      where.areaId = { in: areaIds.length ? areaIds : [0] };
    }

    if (query.active === 'true') where.endedAt = null;
    if (query.areaId) where.areaId = Number(query.areaId);
    if (query.days) {
      where.startedAt = { gte: new Date(Date.now() - Number(query.days) * 86400_000) };
    }
    return this.prisma.powerOutage.findMany({
      where,
      include: { area: { select: { id: true, name: true, city: true } } },
      orderBy: { startedAt: 'desc' },
      take: Number(query.limit) || 200,
    });
  }

  /**
   * Live view: which areas are dark right now, and whether it's expected.
   * This is what support should look at before dispatching anyone.
   */
  async currentStatus(actor?: Actor) {
    // Scope to the caller's own areas — areas are per-tenant, so an unscoped
    // list leaked every account's area names/cities and live subscriber counts.
    const owned = await this.scope.ownedWhere(actor as any);
    const areas = await this.prisma.area.findMany({
      where: owned && Object.keys(owned).length ? { AND: [owned, { isActive: true }] } : { isActive: true },
      select: { id: true, name: true, city: true },
    });

    const out: any[] = [];
    for (const a of areas) {
      const [counts] = await this.prisma.$queryRaw<any[]>`
        SELECT (SELECT COUNT(*)::int FROM "Subscriber" WHERE "areaId" = ${a.id} AND status = 'ACTIVE') AS total,
                (SELECT COUNT(DISTINCT r.username)::int
                   FROM radacct r JOIN "Subscriber" s ON s.username = r.username
                  WHERE s."areaId" = ${a.id} AND r.acctstoptime IS NULL
                    AND COALESCE(r.acctupdatetime, r.acctstarttime) > NOW() - INTERVAL '15 minutes') AS online`;
      const total = Number(counts?.total ?? 0);
      const online = Number(counts?.online ?? 0);
      if (!total) continue;

      const offlineShare = 1 - online / total;
      const scheduled = await this.isAreaScheduledOff(a.id);
      const openOutage = await this.prisma.powerOutage.findFirst({
        where: { areaId: a.id, endedAt: null },
      });

      out.push({
        areaId: a.id,
        name: a.name,
        city: a.city,
        total,
        online,
        offline: total - online,
        offlinePercent: Math.round(offlineShare * 1000) / 10,
        scheduledOutage: scheduled,
        outageId: openOutage?.id ?? null,
        outageType: openOutage?.type ?? null,
        // What support should actually do.
        verdict: scheduled
          ? 'Load-shedding — expected, no action'
          : offlineShare >= this.threshold
            ? 'Mass outage — investigate power or network'
            : offlineShare > 0.15
              ? 'Elevated faults — monitor'
              : 'Normal',
      });
    }

    return out.sort((a, b) => b.offlinePercent - a.offlinePercent);
  }

  /**
   * Uptime split by cause.
   *
   * The headline number most panels show blames the ISP for every minute a
   * customer was offline — including load-shedding. Separating the two is the
   * difference between "we delivered 94%" and "we delivered 99.2%, WAPDA cost
   * you the rest".
   */
  async uptimeReport(days = 30) {
    const since = new Date(Date.now() - days * 86400_000);
    const outages = await this.prisma.powerOutage.findMany({
      where: { startedAt: { gte: since } },
      include: { area: { select: { name: true } } },
    });

    const minutes = (o: any) =>
      Math.round(((o.endedAt ? new Date(o.endedAt).getTime() : Date.now()) -
        new Date(o.startedAt).getTime()) / 60000);

    const sum = (type: string) =>
      outages.filter((o) => o.type === type).reduce((s, o) => s + minutes(o), 0);

    const power = sum('SCHEDULED') + sum('UNSCHEDULED');
    const network = sum('NETWORK');
    const totalWindow = days * 24 * 60;

    return {
      periodDays: days,
      outages: outages.length,
      scheduledPowerMinutes: sum('SCHEDULED'),
      unscheduledPowerMinutes: sum('UNSCHEDULED'),
      networkMinutes: network,
      // Only network faults count against the ISP.
      ispUptimePercent: Math.round(((totalWindow - network) / totalWindow) * 10000) / 100,
      customerExperiencedUptimePercent:
        Math.round(((totalWindow - network - power) / totalWindow) * 10000) / 100,
      byArea: Object.values(
        outages.reduce((acc: any, o) => {
          const k = o.area?.name || 'Unknown';
          acc[k] ??= { area: k, outages: 0, minutes: 0, power: 0, network: 0 };
          acc[k].outages++;
          acc[k].minutes += minutes(o);
          if (o.type === 'NETWORK') acc[k].network += minutes(o);
          else acc[k].power += minutes(o);
          return acc;
        }, {}),
      ),
    };
  }

  // ── Actions ──────────────────────────────────────────────────
  async classify(id: number, type: string, notes?: string) {
    return this.prisma.powerOutage.update({
      where: { id },
      data: { type: type as any, notes: notes ?? undefined },
    });
  }

  async close(id: number) {
    return this.prisma.powerOutage.update({
      where: { id },
      data: { endedAt: new Date() },
    });
  }

  async createManual(data: any, actor?: Actor) {
    return this.prisma.powerOutage.create({
      data: {
        areaId: data.areaId ? Number(data.areaId) : null,
        type: data.type || 'UNSCHEDULED',
        source: 'MANUAL',
        notes: data.notes || null,
        createdBy: actor ? this.scope.actorId(actor) : null,
      },
    });
  }

  /**
   * Tell the affected customers before they call you.
   *
   * A message saying "power is out in your area, service resumes when it
   * returns" removes most of the inbound calls an outage would otherwise
   * generate — and stops customers believing the ISP is at fault.
   */
  async notifyArea(id: number, message?: string) {
    const outage = await this.prisma.powerOutage.findUnique({
      where: { id },
      include: { area: { select: { id: true, name: true } } },
    });
    if (!outage?.areaId) throw new NotFoundException('Outage or area not found');

    const subs = await this.prisma.subscriber.findMany({
      where: { areaId: outage.areaId, status: 'ACTIVE' },
      select: { id: true, fullName: true, phone: true },
    });

    const text = message ||
      (outage.type === 'SCHEDULED'
        ? `Dear customer, internet in ${outage.area?.name} is affected by scheduled load-shedding. Service resumes automatically when power returns.`
        : `Dear customer, we are aware of an outage affecting ${outage.area?.name} and are working to restore service.`);

    let sent = 0;
    for (const s of subs) {
      if (!s.phone) continue;
      try {
        await this.notifications.send({
          channel: 'SMS',
          recipient: s.phone,
          body: text,
          subscriberId: s.id,
          event: 'OUTAGE',
        });
        sent++;
      } catch { /* keep going */ }
    }

    await this.prisma.powerOutage.update({ where: { id }, data: { notified: true } });
    this.logger.log(`Outage ${id}: notified ${sent}/${subs.length} customers`);
    return { notified: sent, total: subs.length };
  }

  // ── helpers ──────────────────────────────────────────────────
  private isTime(v: string) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
  }
  private toMinutes(v: string): number | null {
    if (!this.isTime(v)) return null;
    const [h, m] = v.split(':').map(Number);
    return h * 60 + m;
  }
}
