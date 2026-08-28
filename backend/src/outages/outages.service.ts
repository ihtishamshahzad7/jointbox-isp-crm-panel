import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AlertsService } from '../notifications/alerts.service';
import { isPrimaryInstance } from '../common/cluster-util';

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

        const outage = await this.prisma.powerOutage.create({
          data: {
            areaId,
            type: type as any,
            source: 'MASS_DISCONNECT',
            affectedCount: dropped,
            areaTotal: total,
            notes: scheduled
              ? 'Matches the published load-shedding timetable.'
              : 'Mass disconnection outside any scheduled window — verify whether this is power or network.',
          },
          include: { area: { select: { name: true } } },
        });

        this.logger.warn(
          `Outage detected in ${outage.area?.name ?? `area ${areaId}`}: ` +
            `${dropped}/${total} customers offline (${Math.round(share * 100)}%) — ${type}`,
        );

        // Push to Discord / WhatsApp so the operator knows before customers call.
        this.alerts.send({
          title: `${scheduled ? '🟠' : '🔴'} Outage — ${outage.area?.name ?? `area ${areaId}`}`,
          message: scheduled
            ? 'Mass disconnection matching the published load-shedding timetable.'
            : 'Mass disconnection outside any scheduled window — verify power or network.',
          level: scheduled ? 'WARN' : 'ERROR',
          fields: {
            Area: outage.area?.name ?? `#${areaId}`,
            Affected: `${dropped}/${total}`,
            Share: `${Math.round(share * 100)}%`,
            Type: type,
          },
        }).catch(() => null);

        // Outage Intelligence: correlate device-level signals now and persist a
        // root-cause attribution, so the operator sees *why* before dispatching.
        await this.attribute(outage.id).catch((e) =>
          this.logger.warn(`Attribution for outage ${outage.id} failed: ${e?.message || e}`));
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
      include: {
        area: { select: { id: true, name: true, city: true } },
        attribution: true,
      },
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
    const updated = await this.prisma.powerOutage.update({
      where: { id },
      data: { type: type as any, notes: notes ?? undefined },
    });
    // Re-run attribution so evidence/confidence reflect the classified window.
    await this.attribute(id).catch(() => null);
    return updated;
  }

  async close(id: number) {
    const updated = await this.prisma.powerOutage.update({
      where: { id },
      data: { endedAt: new Date() },
    });
    // Final attribution over the complete window.
    await this.attribute(id).catch(() => null);
    return updated;
  }

  async createManual(data: any, actor?: Actor) {
    const outage = await this.prisma.powerOutage.create({
      data: {
        areaId: data.areaId ? Number(data.areaId) : null,
        type: data.type || 'UNSCHEDULED',
        source: 'MANUAL',
        notes: data.notes || null,
        createdBy: actor ? this.scope.actorId(actor) : null,
      },
    });
    await this.attribute(outage.id).catch(() => null);
    return outage;
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

  // ── Outage Intelligence (root-cause attribution) ─────────────
  //
  // Outages are detected at AREA level from subscriber disconnects; the NDM
  // layer records device-level signals on NetworkDevice (POWER_FAILURE /
  // DEVICE_DOWN / PORT_DOWN / LINK_DOWN events + alerts). No foreign key joins
  // the two, so we bridge by TIME + TENANT: within [startedAt, endedAt || now]
  // we scan the operator's OWN core boxes (Area.ownerId → NetworkDevice.ownerId
  // — the same tenant the area belongs to) for critical coincident signals,
  // preferring devices whose IP matches a NAS serving the affected area.
  //
  // This never claims certainty — it surfaces evidence the operator confirms —
  // but it turns "45% of Area 3 dropped" into "NAS-CCR-01 unreachable since
  // 09:42, coincident with the outage." Signals, strongest first:
  //   POWER_FAILURE     → POWER           (a device reports power went out)
  //   DEVICE_DOWN / unreachable → NETWORK_DEVICE (core box dropped → our fault)
  //   PORT_DOWN/LINK_DOWN → PORT          (a link dropped on a device)
  //   nothing above      → POWER or ACCESS (load-shedding, or subscriber side)
  private async inferAttribution(outage: any): Promise<{
    cause: string; confidence: number; summary: string; evidence: any[]; deviceIds: number[];
  }> {
    const start = new Date(outage.startedAt);
    const end = outage.endedAt ?? new Date();

    // Tenant scope — the operator who owns the affected area.
    let ownerId: number | null = null;
    if (outage.areaId) {
      const area = await this.prisma.area.findUnique({
        where: { id: outage.areaId },
        select: { ownerId: true },
      });
      ownerId = area?.ownerId ?? null;
    }

    // NAS IPs serving the affected area → strong device matches.
    const servingNasIps = new Set<string>();
    if (outage.areaId) {
      const subs = await this.prisma.subscriber.findMany({
        where: { areaId: outage.areaId },
        select: { nasId: true },
        distinct: ['nasId'],
      });
      const nasIds = subs.map((s) => s.nasId).filter((n): n is number => n != null);
      if (nasIds.length) {
        const nases = await this.prisma.nas.findMany({
          where: { id: { in: nasIds } },
          select: { nasIp: true },
        });
        nases.forEach((n) => n.nasIp && servingNasIps.add(n.nasIp));
      }
    }

    // Candidate core boxes: the area owner's, or all enabled if owner unknown.
    const devices = await this.prisma.networkDevice.findMany({
      where: ownerId ? { enabled: true, ownerId } : { enabled: true },
      select: {
        id: true, name: true, ip: true,
        isReachable: true, downSince: true, lastError: true,
      },
    });
    const deviceById = new Map(devices.map((d) => [d.id, d]));
    const inArea = (d: any) => !!(d?.ip && servingNasIps.has(d.ip));

    const evidence: any[] = [];
    const seen = new Set<string>();

    const push = (sig: any) => {
      const key = `${sig.eventType}|${sig.deviceId}|${new Date(sig.at).getTime()}`;
      if (seen.has(key)) return;
      seen.add(key);
      const d = sig.deviceId != null ? deviceById.get(sig.deviceId) : null;
      evidence.push({ ...sig, nasAreaMatch: d ? inArea(d) : false });
    };

    // 1) Unreachable core boxes that went down inside the window.
    for (const d of devices) {
      if (d.isReachable === false && d.downSince) {
        const ds = new Date(d.downSince);
        if (ds >= start && ds <= end) {
          push({
            eventType: 'DEVICE_DOWN', deviceId: d.id, deviceName: d.name,
            severity: 'critical', at: d.downSince,
            message: d.lastError || `Device unreachable since ${ds.toISOString()}`,
          });
        }
      }
    }

    // 2) NDM events in the window on the candidate boxes.
    if (devices.length) {
      const evs = await this.prisma.networkEvent.findMany({
        where: {
          deviceId: { in: devices.map((d) => d.id) },
          createdAt: { gte: start, lte: end },
          eventType: {
            in: ['POWER_FAILURE', 'DEVICE_DOWN', 'PORT_DOWN', 'LINK_DOWN', 'LINK_FLAP', 'DEVICE_REBOOT'],
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 60,
      });
      for (const e of evs) {
        push({
          eventType: e.eventType, deviceId: e.deviceId, interfaceName: e.interfaceName,
          deviceName: e.deviceId != null ? deviceById.get(e.deviceId)?.name : null,
          severity: e.severity, at: e.createdAt, message: e.message,
        });
      }
    }

    // 3) Alerts OPENED in the window on the candidate boxes.
    if (devices.length) {
      const alerts = await this.prisma.alert.findMany({
        where: {
          deviceId: { in: devices.map((d) => d.id) },
          openedAt: { gte: start, lte: end },
          eventType: {
            in: ['POWER_FAILURE', 'DEVICE_DOWN', 'PORT_DOWN', 'LINK_DOWN', 'LINK_FLAP', 'PORT_ERROR'],
          },
        },
        orderBy: { openedAt: 'asc' },
        take: 60,
      });
      for (const a of alerts) {
        push({
          eventType: a.eventType, deviceId: a.deviceId, interfaceName: a.interfaceName,
          deviceName: a.deviceId != null ? deviceById.get(a.deviceId)?.name : null,
          severity: a.severity, at: a.openedAt, message: a.message, fireCount: a.fireCount,
        });
      }
    }

    // Implicated device ids (deduped, area-matched first).
    const areaHits = new Set<number>();
    const deviceIds: number[] = [];
    for (const e of evidence) {
      if (e.deviceId == null) continue;
      if (e.nasAreaMatch) areaHits.add(e.deviceId);
      if (!deviceIds.includes(e.deviceId)) deviceIds.push(e.deviceId);
    }
    deviceIds.sort((a, b) =>
      (areaHits.has(b) ? 1 : 0) - (areaHits.has(a) ? 1 : 0));

    // 4) Infer a cause.
    const power = evidence.filter((e) => e.eventType === 'POWER_FAILURE');
    const deviceDown = evidence.filter(
      (e) => e.eventType === 'DEVICE_DOWN' || e.eventType === 'DEVICE_REBOOT');
    const portDown = evidence.filter(
      (e) => ['PORT_DOWN', 'LINK_DOWN', 'LINK_FLAP', 'PORT_ERROR'].includes(e.eventType));

    const areaEvidenceCount = evidence.filter((e) => e.nasAreaMatch).length;
    const scheduled = outage.areaId ? await this.isAreaScheduledOff(outage.areaId, start) : false;

    let cause: string;
    let confidence: number;
    let summary: string;

    if (power.length >= (power.some((p) => p.nasAreaMatch) ? 1 : 2)) {
      cause = 'POWER';
      confidence = Math.min(95, 55 + power.filter((p) => p.nasAreaMatch).length * 12);
      const p = power.find((x) => x.nasAreaMatch) || power[0];
      summary = `${p.deviceName || 'A device'} reported power failure — WAPDA/access power, not our core.`;
    } else if (deviceDown.some((d) => d.nasAreaMatch) || deviceDown.length >= 2) {
      cause = 'NETWORK_DEVICE';
      confidence = 75;
      const dd = deviceDown.find((x) => x.nasAreaMatch) || deviceDown[0];
      const t = dd.at ? new Date(dd.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
      summary = `${dd.deviceName || 'A core device'} down since ${t} — our network, dispatch.`;
    } else if (portDown.some((d) => d.nasAreaMatch) || portDown.length >= 2) {
      cause = 'PORT';
      confidence = 65;
      const pd = portDown.find((x) => x.nasAreaMatch) || portDown[0];
      summary = `Link/port drop on ${pd.deviceName || 'a device'}${pd.interfaceName ? ' (' + pd.interfaceName + ')' : ''} — device-side fault.`;
    } else if (scheduled) {
      cause = 'POWER';
      confidence = 80;
      summary = 'Matches the published load-shedding timetable — scheduled power cut.';
    } else if (evidence.length) {
      cause = 'ACCESS';
      confidence = 45;
      summary = 'No core device offline in the window — consistent with subscriber/antenna/feeder side fault.';
    } else {
      cause = 'UNKNOWN';
      confidence = 0;
      summary = 'No coincident device signal found in the outage window.';
    }

    evidence.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    return {
      cause, confidence,
      summary,
      evidence: evidence.slice(0, 30),
      deviceIds,
    };
  }

  /**
   * Compute (or recompute) root-cause attribution for an outage and persist it.
   * Public entry point — also used by the refresh endpoint.
   */
  async attribute(id: number) {
    const outage = await this.prisma.powerOutage.findUnique({
      where: { id },
      include: { area: { select: { name: true } } },
    });
    if (!outage) throw new NotFoundException('Outage not found');

    const a = await this.inferAttribution(outage);

    const att = await this.prisma.outageAttribution.upsert({
      where: { outageId: id },
      create: {
        outageId: id,
        cause: a.cause as any,
        confidence: a.confidence,
        summary: a.summary,
        evidence: a.evidence,
        deviceIds: a.deviceIds,
      },
      update: {
        cause: a.cause as any,
        confidence: a.confidence,
        summary: a.summary,
        evidence: a.evidence,
        deviceIds: a.deviceIds,
      },
    });

    if (outage.type === 'UNKNOWN' && a.cause !== 'UNKNOWN') {
      // A conclusive attribution can triage a still-unknown outage automatically:
      // network faults count against uptime; power/access do not.
      const suggested = a.cause === 'NETWORK_DEVICE' || a.cause === 'PORT' ? 'NETWORK' : null;
      if (suggested) {
        await this.prisma.powerOutage.update({ where: { id }, data: { type: suggested as any } }).catch(() => null);
      }
    }

    this.logger.log(`Outage ${id} attributed → ${a.cause} (${a.confidence}%) from ${a.evidence.length} signal(s)`);
    return att;
  }

  /** Operator confirms (or corrects) the persisted attribution. */
  async confirmAttribution(id: number, cause?: string) {
    const data: any = { confirmed: true, updatedAt: new Date() };
    if (cause) data.cause = cause;
    return this.prisma.outageAttribution.update({ where: { outageId: id }, data });
  }

  /** Read the persisted attribution, computing it first if absent. */
  async getAttribution(id: number) {
    const existing = await this.prisma.outageAttribution.findUnique({
      where: { outageId: id },
    });
    if (existing) return existing;
    return this.attribute(id);
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
