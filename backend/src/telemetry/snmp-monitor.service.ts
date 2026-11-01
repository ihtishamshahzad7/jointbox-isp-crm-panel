import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from '../common/events.service';
import { isPrimaryInstance } from '../common/cluster-util';
import { NON_DEMO_OWNED } from '../common/scope.service';
import { mapLimit, withTimeout } from '../common/concurrency';
import { DeviceHealthService, SnmpPollResult } from './device-health.service';

/**
 * PER-NAS SNMP MONITOR (Stage 2).
 *
 * Owns the SCHEDULING that device-health.service used to do in a fixed 30-second
 * global sweep. The problems that got SNMP switched off — every device polled on
 * one interval, no backoff, demo routers probed, a CRITICAL alert on every
 * failed packet — are fixed here:
 *
 *   • opt-in PER NAS (snmpEnabled) and demo routers excluded in the query;
 *   • each NAS has its OWN interval (snmpPollSec), tracked by nextPollAt;
 *   • bounded worker concurrency + a hard per-NAS timeout, so one slow or
 *     unreachable device never stalls the others;
 *   • single-flight: a NAS already being polled is skipped, and nextPollAt is
 *     claimed optimistically so overlapping ticks can't double-poll it;
 *   • exponential backoff on repeated failure, so a dead NAS is tried less and
 *     less often instead of every cycle;
 *   • events are written on STATE TRANSITIONS only (reachable↔unreachable, …)
 *     and resource thresholds have a cooldown, so there is no alert storm.
 *
 * Runs on the primary instance only (isPrimaryInstance), so the cluster polls
 * each device once. Disable entirely with SNMP_MONITOR=off.
 */
@Injectable()
export class SnmpMonitorService {
  private readonly log = new Logger('SnmpMonitor');
  /** NAS ids currently being polled in THIS process (single-flight guard). */
  private readonly inFlight = new Set<number>();
  /** Last operationally-down interface set per NAS, for interface_down/up. */
  private readonly prevDown = new Map<number, Set<string>>();
  private dispatching = false;

  constructor(
    private prisma: PrismaService,
    private health: DeviceHealthService,
    private events: EventsService,
  ) {}

  private enabled(): boolean {
    return String(process.env.SNMP_MONITOR ?? '').toLowerCase() === 'on';
  }
  private concurrency(): number {
    return Math.max(1, Number(process.env.SNMP_MONITOR_CONCURRENCY) || 10);
  }
  private maxBackoffSec(): number {
    return Math.max(60, Number(process.env.SNMP_MONITOR_MAX_BACKOFF_SEC) || 900);
  }
  private cpuHigh(): number {
    return Math.max(1, Number(process.env.SNMP_CPU_HIGH_PCT) || 90);
  }
  /** Memory is stored as % USED; "low available" means used ≥ this. */
  private memHigh(): number {
    return Math.max(1, Number(process.env.SNMP_MEM_HIGH_PCT) || 90);
  }
  private thresholdCooldownMs(): number {
    return Math.max(60_000, Number(process.env.SNMP_ALERT_COOLDOWN_SEC || 1800) * 1000);
  }

  /**
   * Light dispatcher — runs often, but only polls the NAS that are actually DUE
   * (nextPollAt ≤ now), so each device keeps its own cadence.
   */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async dispatch(): Promise<void> {
    if (!this.enabled() || !this.health.snmpAvailable() || !isPrimaryInstance()) return;
    if (this.dispatching) return; // never overlap dispatch runs
    this.dispatching = true;
    try {
      const due = await this.selectDue();
      if (!due.length) return;
      await mapLimit(due, this.concurrency(), (nas) => this.pollNas(nas));
    } catch (e: any) {
      this.log.warn(`SNMP dispatch failed: ${e?.message || e}`);
    } finally {
      this.dispatching = false;
    }
  }

  /** NAS that are enabled, real (not demo), active, and due (or never polled). */
  private async selectDue(): Promise<any[]> {
    const now = new Date();
    const rows = await this.prisma.nas.findMany({
      where: {
        AND: [
          { snmpEnabled: true, isActive: true },
          NON_DEMO_OWNED,
          { OR: [{ snmpState: { is: null } }, { snmpState: { nextPollAt: null } }, { snmpState: { nextPollAt: { lte: now } } }] },
        ],
      },
      select: { ...DeviceHealthService.POLL_SELECT, snmpPollSec: true, ownerId: true },
    });
    // Skip any NAS a previous tick is still polling.
    return rows.filter((n) => !this.inFlight.has(n.id));
  }

  /** Poll one NAS, update its state, and raise events on transitions. */
  private async pollNas(nas: any): Promise<void> {
    if (this.inFlight.has(nas.id)) return;
    this.inFlight.add(nas.id);
    const intervalSec = Math.max(10, Number(nas.snmpPollSec) || 30);
    // Claim the next slot BEFORE polling so an overlapping tick won't re-pick it
    // even if this poll runs long. Backoff may push it further out on failure.
    await this.claimNextPoll(nas.id, intervalSec);

    const prev = await this.prisma.nasSnmpState.findUnique({ where: { nasId: nas.id } }).catch(() => null);
    const prevStatus: string = prev?.status ?? 'unknown';

    let result: SnmpPollResult;
    try {
      // Hard ceiling over the whole poll: covers the full interface walk, not
      // just one request's timeout, so a half-answering device still releases
      // the worker slot.
      const budgetMs = ((nas.snmpTimeoutMs || 4000) * ((nas.snmpRetries ?? 1) + 1)) + 25_000;
      result = await withTimeout(this.health.collectOne(nas), budgetMs, `snmp ${nas.nasname}`);
    } catch (e: any) {
      result = { ok: false, kind: 'timeout', message: 'SNMP poll exceeded its time budget.' };
    } finally {
      this.inFlight.delete(nas.id);
    }

    const newStatus = result.ok ? 'ok' : result.kind;
    await this.writeState(nas, result, newStatus, intervalSec);
    await this.raiseEvents(nas, prevStatus, newStatus, result);
  }

  /** Optimistically push nextPollAt out by one interval (single-flight claim). */
  private async claimNextPoll(nasId: number, intervalSec: number): Promise<void> {
    const next = new Date(Date.now() + intervalSec * 1000);
    await this.prisma.nasSnmpState.upsert({
      where: { nasId },
      create: { nasId, nextPollAt: next },
      update: { nextPollAt: next },
    }).catch(() => undefined);
  }

  private async writeState(nas: any, r: SnmpPollResult, status: string, intervalSec: number): Promise<void> {
    const now = new Date();
    const failures = r.ok ? 0 : ((await this.prisma.nasSnmpState.findUnique({ where: { nasId: nas.id }, select: { consecutiveFailures: true } }).catch(() => null))?.consecutiveFailures ?? 0) + 1;
    // Backoff: on failure, wait interval·2^(failures-1), capped. On success, the
    // normal interval. (claimNextPoll already set the normal interval; we only
    // need to push it further on failure.)
    let nextPollAt: Date;
    if (r.ok) {
      nextPollAt = new Date(now.getTime() + intervalSec * 1000);
    } else {
      const backoff = Math.min(intervalSec * Math.pow(2, Math.max(0, failures - 1)), this.maxBackoffSec());
      nextPollAt = new Date(now.getTime() + backoff * 1000);
    }
    const common = {
      status,
      lastPollAt: now,
      consecutiveFailures: failures,
      nextPollAt,
      ...(r.ok
        ? { lastSuccessAt: now, lastError: null, sysDescr: r.sysDescr ?? null, uptimeSec: r.uptimeSec ?? null }
        : { lastErrorAt: now, lastError: (r.message ?? 'SNMP poll failed.').slice(0, 300) }),
    };
    await this.prisma.nasSnmpState.upsert({
      where: { nasId: nas.id },
      create: { nasId: nas.id, ...common },
      update: common,
    }).catch((e) => this.log.warn(`State write failed for ${nas.nasname}: ${e?.message || e}`));
  }

  /** Create events for state transitions + resource thresholds (deduped). */
  private async raiseEvents(nas: any, prevStatus: string, newStatus: string, r: SnmpPollResult): Promise<void> {
    // ── Reachability transition ──────────────────────────────────────────
    if (newStatus !== prevStatus) {
      if (newStatus === 'ok' && prevStatus !== 'unknown') {
        await this.emit(nas, 'poll_recovered', 'info', `${nas.nasname} is answering SNMP again.`, { sysDescr: r.sysDescr ?? null });
      } else if (newStatus !== 'ok') {
        const map: Record<string, { type: string; sev: string; msg: string }> = {
          timeout: { type: 'timeout', sev: 'warning', msg: `${nas.nasname} is not responding to SNMP (timeout).` },
          unreachable: { type: 'unreachable', sev: 'critical', msg: `${nas.nasname} is unreachable over SNMP.` },
          auth_error: { type: 'auth_error', sev: 'critical', msg: `SNMP authentication is failing for ${nas.nasname}.` },
          config_error: { type: 'config_error', sev: 'warning', msg: `${nas.nasname} SNMP is misconfigured.` },
          error: { type: 'poll_failed', sev: 'warning', msg: `SNMP polling failed for ${nas.nasname}.` },
        };
        const e = map[newStatus] ?? map.error;
        await this.emit(nas, e.type, e.sev, e.msg, { reason: r.message ?? null });
      }
    }
    if (!r.ok) return; // thresholds only make sense on a good read

    // ── Resource thresholds (cooldown-deduped) ───────────────────────────
    if (r.cpu != null && r.cpu >= this.cpuHigh()) {
      await this.emitThrottled(nas, 'cpu_high', 'warning', `${nas.nasname} CPU at ${Math.round(r.cpu)}%.`, { cpu: r.cpu, threshold: this.cpuHigh() });
    }
    if (r.memory != null && r.memory >= this.memHigh()) {
      await this.emitThrottled(nas, 'memory_low', 'warning', `${nas.nasname} memory ${Math.round(r.memory)}% used.`, { memoryUsedPct: r.memory, threshold: this.memHigh() });
    }

    // ── Interface up/down transitions (per-interface, deduped by set diff) ─
    const down = new Set((r.downInterfaces ?? []).map((n) => String(n)));
    const before = this.prevDown.get(nas.id) ?? new Set<string>();
    const newlyDown = [...down].filter((n) => !before.has(n));
    const newlyUp = [...before].filter((n) => !down.has(n));
    if (newlyDown.length) {
      await this.emit(nas, 'interface_down', 'warning', `${nas.nasname}: ${newlyDown.length} interface(s) went down.`, { interfaces: newlyDown.slice(0, 50) });
    }
    if (newlyUp.length) {
      await this.emit(nas, 'interface_up', 'info', `${nas.nasname}: ${newlyUp.length} interface(s) came back up.`, { interfaces: newlyUp.slice(0, 50) });
    }
    this.prevDown.set(nas.id, down);
  }

  /** Emit only if no same-type event for this NAS within the cooldown. */
  private async emitThrottled(nas: any, type: string, severity: string, message: string, details: any): Promise<void> {
    const since = new Date(Date.now() - this.thresholdCooldownMs());
    const recent = await this.prisma.nasEvent.findFirst({
      where: { nasId: nas.id, type, ts: { gte: since } }, select: { id: true },
    }).catch(() => null);
    if (recent) return;
    await this.emit(nas, type, severity, message, details);
  }

  // ── Read API (tenant scope is enforced by the controller via assertNas) ───

  /**
   * Operational status for the NAS monitoring panel: state + latest metrics +
   * interface up/down counts. Returns NO credentials — only non-secret fields.
   */
  async getStatus(nasId: number) {
    const [state, metrics, ifaces] = await Promise.all([
      this.prisma.nasSnmpState.findUnique({ where: { nasId } }).catch(() => null),
      this.prisma.$queryRawUnsafe<Array<{ metric: string; value: number; ts: Date }>>(
        `SELECT DISTINCT ON (metric) metric, value, ts
           FROM device_metric WHERE "nasId" = $1 AND ts >= NOW() - INTERVAL '1 hour'
          ORDER BY metric, ts DESC`, nasId).catch(() => []),
      this.prisma.$queryRawUnsafe<Array<{ up: boolean; n: number }>>(
        `SELECT up, COUNT(*)::int AS n FROM (
            SELECT DISTINCT ON ("ifIndex") "ifIndex", up FROM interface_metric
             WHERE "nasId" = $1 AND ts >= NOW() - INTERVAL '30 minutes'
             ORDER BY "ifIndex", ts DESC
          ) s GROUP BY up`, nasId).catch(() => []),
    ]);
    const latest: Record<string, { value: number; ts: Date }> = {};
    for (const m of metrics) latest[m.metric] = { value: Number(m.value), ts: m.ts };
    let ifUp = 0, ifDown = 0;
    for (const r of ifaces) { if (r.up) ifUp = Number(r.n); else ifDown = Number(r.n); }
    return {
      status: state?.status ?? 'unknown',
      lastPollAt: state?.lastPollAt ?? null,
      lastSuccessAt: state?.lastSuccessAt ?? null,
      lastErrorAt: state?.lastErrorAt ?? null,
      lastError: state?.lastError ?? null,
      consecutiveFailures: state?.consecutiveFailures ?? 0,
      nextPollAt: state?.nextPollAt ?? null,
      sysDescr: state?.sysDescr ?? null,
      uptimeSec: state?.uptimeSec ?? null,
      metrics: {
        cpu: latest.cpu?.value ?? null,
        memory: latest.memory?.value ?? null,
        uptime: latest.uptime?.value ?? null,
        temperature: latest.temperature?.value ?? null,
        snmpMs: latest.snmpMs?.value ?? null,
        updatedAt: latest.snmpMs?.ts ?? latest.cpu?.ts ?? null,
      },
      interfaces: { up: ifUp, down: ifDown, total: ifUp + ifDown },
    };
  }

  /** Paginated NAS events (cursor by id desc, bounded page size). */
  async listEvents(nasId: number, opts: { limit?: number; cursor?: number; type?: string; acknowledged?: boolean } = {}) {
    const take = Math.min(Math.max(Number(opts.limit) || 25, 1), 100);
    const where: any = { nasId };
    if (opts.type) where.type = opts.type;
    if (opts.acknowledged !== undefined) where.acknowledged = opts.acknowledged;
    if (opts.cursor) where.id = { lt: Number(opts.cursor) };
    const rows = await this.prisma.nasEvent.findMany({ where, orderBy: { id: 'desc' }, take: take + 1 });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null, pageSize: take };
  }

  /** Acknowledge one event (must belong to the given NAS). */
  async ackEvent(nasId: number, eventId: number, userId?: number) {
    const ev = await this.prisma.nasEvent.findFirst({ where: { id: eventId, nasId }, select: { id: true } });
    if (!ev) throw new NotFoundException('Event not found.');
    return this.prisma.nasEvent.update({
      where: { id: eventId },
      data: { acknowledged: true, acknowledgedAt: new Date(), acknowledgedBy: userId ?? null },
    });
  }

  /** Persist a NasEvent and push it to the live feed, scoped to the NAS owner. */
  async emit(nas: any, type: string, severity: string, message: string, details?: any): Promise<void> {
    try {
      await this.prisma.nasEvent.create({
        data: { nasId: nas.id, type, severity, message: message.slice(0, 400), details: details ?? undefined, ownerId: nas.ownerId ?? null },
      });
      // Reuse the existing live-feed/notification channel — NOT a second alerting
      // system. Scoped so only the owner and accounts above it receive it.
      this.events.broadcast('nas-event', { nasId: nas.id, type, severity, message, ownerUserId: nas.ownerId ?? undefined });
    } catch (e: any) {
      this.log.warn(`Event write failed for ${nas.nasname}: ${e?.message || e}`);
    }
  }
}
