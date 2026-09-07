import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { execFile } from 'child_process';
import { PrismaService } from '../prisma/prisma.service';
import { isPrimaryInstance } from '../common/cluster-util';
import { EventsService } from '../common/events.service';
import { NdmSnmpService } from './snmp.service';
import { NdmEventEngine } from './event-engine.service';
import { NdmAlertEngine } from './alert-engine.service';
import { NdmNotificationEngine } from './notification-engine.service';
import { counterDelta, defaultMonitored, CATEGORY_LABELS, isRecoveryEventType, eventOpenSound, parseCondition, type InterfaceCategory, type NdmEventType } from './ndm.constants';

/**
 * Port polling service — the SNMP heart: walks the interface table of every
 * enabled device on its own interval (10/30/60/300 s), computes rates from
 * counter deltas, spots UP/DOWN transitions and lowers events/alerts into the
 * event + alert engines.
 *
 * The "lowers into the engines" wording is deliberate: everything that changes
 * state (port down/up, device lost/rebooted) flows through ONE writer so
 * poll-raised and syslog-raised facts about the same port share the same
 * open event and the same alert (no duplicate alerts).
 *
 * Phases inside one device poll (dbId stability matters for dedup):
 *   1. upsert the interface rows → real interface ids
 *   2. compare snapshots → transitions → events/alerts/history
 *   3. counter deltas → traffic history rows
 *   4. device totals, health metric, DURATION escalations
 */
@Injectable()
export class NdmPortPollingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('NdmPoll');
  /** deviceId → last poll start (ms). */
  private last = new Map<number, number>();
  /** deviceId → previous snapshot (ifIndex → counters+status). */
  private prev = new Map<number, Map<number, any>>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /**
   * Observable state for the Settings → diagnostics panel. Recorded here rather
   * than inferred elsewhere, because "is the poller alive?" is a question only
   * the poller can answer honestly. All start as null so the UI shows "no beat
   * yet" instead of implying a healthy zero.
   */
  private lastBeatAt: Date | null = null;
  private lastSweepDue = 0;
  private sweepCount = 0;

  /**
   * Per-sweep throughput accounting.
   *
   * WHY THESE ARE WORTH RECORDING
   * The old sweep silently fell behind: devices past their interval simply
   * were not polled, and nothing anywhere said so. The dashboard showed the
   * last known state, which looks identical to a healthy "up". `dueCount`
   * versus `polledCount` is the one comparison that distinguishes "everything
   * is fine" from "the poller cannot keep up", and it is the metric to alert
   * on. The duration percentiles turn "polling is slow" into "these devices
   * are slow", which is a problem somebody can actually go and fix.
   */
  private lastSweepPolled = 0;
  private lastSweepSkipped = 0;
  private lastSweepMs = 0;
  private lastDurations: number[] = [];

  /** Snapshot for diagnostics. Never throws; safe to call from a request. */
  get health() {
    const d = [...this.lastDurations].sort((a, b) => a - b);
    const pct = (p: number) => (d.length ? d[Math.min(d.length - 1, Math.floor((d.length * p) / 100))] : 0);
    return {
      // On a web node the sweep returns immediately, so "scheduled" is the
      // honest word — the work belongs to the worker process.
      scheduled: this.timer !== null,
      primary: isPrimaryInstance(),
      running: this.running,
      lastBeat: this.lastBeatAt,
      lastSweepDue: this.lastSweepDue,
      sweeps: this.sweepCount,
      trackedDevices: this.last.size,
      concurrency: this.pollConcurrency,
      lastSweepPolled: this.lastSweepPolled,
      // Non-zero here means the sweep ran out of time budget before it ran out
      // of due devices. Sustained, it is the signal that capacity is short.
      lastSweepSkipped: this.lastSweepSkipped,
      lastSweepMs: this.lastSweepMs,
      pollDurationMs: { p50: pct(50), p95: pct(95), max: d.length ? d[d.length - 1] : 0 },
      // Without this, a backed-off device looks like a device that is simply
      // not being polled, and the next person debugging it has no way to tell
      // the circuit breaker from a bug.
      backedOffDevices: [...this.failures.entries()].filter(([, f]) => f >= 2).length,
      maxBackoffMultiplier: this.breakerMaxMultiplier,
    };
  }

  /**
   * How many device polls may be in flight at once.
   *
   * THE OLD CEILING, AND WHY IT WAS A HARD WALL
   * The sweep took `.slice(0, 40)` of the due devices and processed them in
   * serial batches of 8, on a 5s timer. That is at most 40 devices per tick →
   * 8 devices/second, and only if every poll returns instantly. At 1,000 NAS
   * on a 30s interval the system needs ~33 devices/second sustained simply to
   * visit each device once per interval. It was roughly 4× short before
   * accounting for real SNMP latency over WAN links, so devices fell
   * permanently behind their configured interval and nothing reported it.
   *
   * Worse, `Promise.all` over a batch of 8 waits for the SLOWEST member: one
   * unreachable device burning its full `snmpTimeoutMs` × `snmpRetries` held
   * the other seven hostages. A handful of flaky devices could throttle the
   * entire estate.
   *
   * A pool fixes both. Each slot takes the next device the moment it frees up,
   * so a slow device costs one slot rather than a whole batch, and the ceiling
   * becomes an operator setting instead of a constant in this file.
   */
  private readonly pollConcurrency = Math.max(1, Number(process.env.SNMP_POLL_CONCURRENCY) || 60);

  /**
   * How long one sweep may run before it stops starting new polls.
   *
   * This replaces `.slice(0, 40)` as the safety bound, and it is a better one:
   * the old cap limited the COUNT of devices regardless of how fast they
   * answered, which throttled a healthy fast estate just as hard as a sick
   * slow one. A time budget bounds what actually matters — that one sweep
   * cannot still be running when the next several are due — while letting a
   * responsive network poll as many devices as it can.
   */
  private readonly sweepBudgetMs = Math.max(1_000, Number(process.env.SNMP_SWEEP_BUDGET_MS) || 25_000);

  /**
   * PER-DEVICE CIRCUIT BREAKER.
   *
   * THE PROBLEM IT SOLVES, WHICH THE CONCURRENCY POOL DOES NOT
   * A pool stops one dead device blocking its neighbours, but it does not stop
   * dead devices CONSUMING the pool. An unreachable NAS occupies a slot for
   * its full `snmpTimeoutMs × snmpRetries` — often 5-15 seconds — while a
   * healthy device answers in tens of milliseconds. So a device that is down
   * costs several hundred times more capacity than one that is up, and it goes
   * on costing that on every single sweep, forever.
   *
   * At 1,000 NAS that arithmetic decides whether monitoring works. Fifty dead
   * devices at 10s each is 500 seconds of slot time per sweep cycle spent
   * confirming, over and over, something already known — while the 950 devices
   * that are actually up get polled late.
   *
   * The fix is to poll what is known to be broken LESS often: double the
   * effective interval on each consecutive failure, up to a ceiling. A device
   * that is down is still checked — just every few minutes rather than every
   * thirty seconds — and one successful poll clears the penalty immediately,
   * so recovery is never delayed by more than one backed-off interval.
   *
   * Kept in memory rather than a column deliberately: it is a scheduling hint,
   * not a fact about the device, and it must not survive a restart. After a
   * deploy, every device deserves a fresh look.
   */
  private failures = new Map<number, number>();
  private readonly breakerMaxMultiplier = Math.max(
    1,
    Number(process.env.SNMP_BACKOFF_MAX_MULTIPLIER) || 16,
  );

  /**
   * How long this device's interval should effectively be, given its recent
   * failures. 1× while healthy, doubling per consecutive failure, capped.
   */
  private backoffMultiplier(deviceId: number): number {
    const fails = this.failures.get(deviceId) ?? 0;
    // The first failure must NOT back off. Devices blip; a single timeout is
    // usually noise, and delaying the retry would make the UI slow to notice a
    // real outage — the opposite of what a monitoring system is for.
    if (fails < 2) return 1;
    return Math.min(this.breakerMaxMultiplier, 2 ** (fails - 1));
  }

  /**
   * Record what a poll actually concluded.
   *
   * DRIVEN BY THE VERDICT, NOT BY ELAPSED TIME
   * Timing looks like a tempting proxy — a timed-out device is slow, a healthy
   * one is fast — and it is wrong in both directions. A satellite or
   * VPN-reached NAS legitimately configured with a 10s timeout answers in
   * three seconds and is perfectly healthy; a device on the LAN that fails
   * instantly (connection refused, bad community string) answers in one
   * millisecond and is not. Judging by duration backs off working devices and
   * keeps hammering broken ones — precisely inverted.
   *
   * `markUnreachable` is the single place the poller concludes a device is
   * down, whatever the check type, so the breaker hangs off that instead.
   */
  private recordPollOutcome(deviceId: number, ok: boolean) {
    if (ok) this.failures.delete(deviceId);
    else this.failures.set(deviceId, (this.failures.get(deviceId) ?? 0) + 1);
  }

  constructor(
    private prisma: PrismaService,
    private snmp: NdmSnmpService,
    private eventEngine: NdmEventEngine,
    private alerts: NdmAlertEngine,
    private notify: NdmNotificationEngine,
    private eventsEmitter: EventsService,
  ) {}

  async onModuleInit() {
    // One-time (idempotent) data fix: classify interface rows that predate
    // the classifier (created before this deployment). Runs before the first
    // poll so PPPoE/dynamic links start excluded. `db push` on the server
    // does not execute the prisma/migrations folder, so this is the place the
    // legacy rows actually get fixed.
    await this.backfillLegacyRows();

    // Self-managed loop: cron minutes are too coarse for a 10-second poll;
    // a guarded 5 s beat is the established pattern in this codebase.
    this.timer = setInterval(() => { void this.tick(); }, 5000);
    this.timer.unref?.();
  }

  /** How many interfaces are (not) monitored — cached for export/debug. */
  private monitoredCounts = { total: 0, excluded: 0 };

  /** Idempotent: only touches rows whose category is still NULL. */
  private async backfillLegacyRows() {
    try {
      const n = await this.prisma.$executeRawUnsafe(`
        UPDATE "network_interface" SET
          "interfaceCategory" = CASE
            WHEN LOWER(REPLACE(REPLACE("name", '<', ''), '>', '')) LIKE '%pppoe%' THEN 'PPPOE_SESSION'
            WHEN LOWER(REPLACE(REPLACE("name", '<', ''), '>', '')) ~ '^vlan[0-9.:-]*$' THEN 'VLAN'
            WHEN LOWER(REPLACE(REPLACE("name", '<', ''), '>', '')) ~ '^(lo|loopback[0-9.:-]*)$' THEN 'LOOPBACK'
            WHEN LOWER(REPLACE(REPLACE("name", '<', ''), '>', '')) ~ '^bridge[0-9.:-]*$' THEN 'BRIDGE'
            WHEN LOWER(REPLACE(REPLACE("name", '<', ''), '>', '')) ~ '^bond[0-9.:-]*$' THEN 'BOND'
            WHEN LOWER(REPLACE(REPLACE("name", '<', ''), '>', '')) ~ '^(gre|gre6|eoip|vxlan|ipip|eip|wireguard|tun[0-9.:-]*)$' THEN 'TUNNEL'
            WHEN LOWER(REPLACE(REPLACE("name", '<', ''), '>', '')) ~ '^(ppp|l2tp|sstp|ovpn)[0-9.:-]*$' THEN 'PPP'
            ELSE 'UNKNOWN'
          END,
          "excludedReason" = CASE
            WHEN LOWER(REPLACE(REPLACE("name", '<', ''), '>', '')) LIKE '%pppoe%' THEN 'PPPoE session'
            ELSE "excludedReason"
          END,
          "monitoringEnabled" = CASE
            WHEN "monitoringExplicit" = false AND LOWER(REPLACE(REPLACE("name", '<', ''), '>', '')) LIKE '%pppoe%' THEN false
            ELSE "monitoringEnabled"
          END
        WHERE "interfaceCategory" IS NULL;
      `);
      // Strict allowlist pass over rows classified before this deploy (their
      // monitoringEnabled may predate the PHYSICAL/VLAN-only policy).
      const m = await this.prisma.$executeRawUnsafe(`
        UPDATE "network_interface" SET
          "monitoringEnabled" = false,
          "excludedReason" = CASE "interfaceCategory"
            WHEN 'LOOPBACK' THEN 'Loopback' WHEN 'BRIDGE' THEN 'Bridge' WHEN 'BOND' THEN 'Bond'
            WHEN 'TUNNEL' THEN 'Tunnel' WHEN 'PPP' THEN 'PPP link' WHEN 'PPPOE_SESSION' THEN 'PPPoE session'
            WHEN 'DYNAMIC' THEN 'Dynamic subscriber link' ELSE 'Not a physical/VLAN port' END
        WHERE "monitoringExplicit" = false AND "monitoringEnabled" = true
          AND "interfaceCategory" IS NOT NULL AND "interfaceCategory" NOT IN ('PHYSICAL', 'VLAN');
      `);
      if (n || m) this.log.log(`[BOOT] Reclassified ${n || 0} legacy row(s); excluded ${m || 0} non-physical/VLAN row(s) (PPPoE clean)`);
    } catch (e: any) {
      // Column may not exist yet on a DB that wasn't pushed — retry next boot.
      this.log.warn(`[BOOT] Legacy classification backfill skipped: ${e?.message || e}`);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Internal sweep: devices whose poll interval elapsed, bounded batch. */
  private async tick() {
    if (!isPrimaryInstance() || this.running) return;
    this.running = true;
    this.lastBeatAt = new Date();
    this.sweepCount++;
    try {
      const devices = await this.prisma.networkDevice.findMany({
        where: { enabled: true },
        select: {
          id: true, name: true, ip: true, vendor: true, snmpVersion: true,
          snmpPort: true, pollIntervalSec: true, snmpTimeoutMs: true, snmpRetries: true,
          ownerId: true, syslogEnabled: true, isReachable: true, uptimeSec: true,
          // Without this the branch in pollDevice() cannot see the method and
          // every target would fall back to SNMP again.
          monitorMethod: true, downSince: true,
        },
      });
      const now = Date.now();
      // No artificial cap. Everything genuinely due is a candidate; the time
      // budget below decides how far the sweep actually gets, and reports what
      // it did not reach rather than dropping it silently.
      // The breaker widens the interval for devices that keep failing, so a
      // dead estate cannot crowd out the live one. A healthy device's
      // multiplier is 1, so this is exactly the old predicate for them.
      const due = devices.filter(
        (d) =>
          (this.last.get(d.id) ?? 0) + d.pollIntervalSec * 1000 * this.backoffMultiplier(d.id) <= now,
      );
      this.lastSweepDue = due.length;

      const startedAt = Date.now();
      const deadline = startedAt + this.sweepBudgetMs;
      const durations: number[] = [];
      let polled = 0;
      let index = 0;

      /**
       * One worker slot. Pulls the next due device, polls it, repeats.
       *
       * `index++` is safe without a lock because Node runs this on a single
       * thread and there is no `await` between the read and the increment —
       * each worker takes a distinct index. Deliberately not a `for` loop over
       * chunks: chunking is what made a slow device stall its neighbours.
       */
      const worker = async () => {
        while (index < due.length && Date.now() < deadline) {
          const d = due[index++];
          const t0 = Date.now();
          try {
            await this.pollDevice(d);
          } catch (e: any) {
            this.log.warn(`poll ${d.name}: ${e?.message || e}`);
          }
          durations.push(Date.now() - t0);
          polled++;
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(this.pollConcurrency, due.length) }, () => worker()),
      );

      this.lastSweepPolled = polled;
      this.lastSweepSkipped = due.length - polled;
      this.lastSweepMs = Date.now() - startedAt;
      this.lastDurations = durations;

      // Falling behind is a capacity problem, and it used to be invisible.
      // Said once per sweep, only when it is actually happening.
      if (this.lastSweepSkipped > 0) {
        this.log.warn(
          `poll sweep hit its ${this.sweepBudgetMs}ms budget: polled ${polled}/${due.length}, ` +
            `${this.lastSweepSkipped} device(s) deferred — raise SNMP_POLL_CONCURRENCY (now ${this.pollConcurrency}) or move polling to the worker process`,
        );
      }
    } catch (e: any) {
      this.log.warn(`poll sweep failed: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }

  /** Manual "Check now" — skips the interval gate. */
  async checkNow(deviceId: number) {
    const d = await this.prisma.networkDevice.findUnique({ where: { id: deviceId } });
    if (!d) return { ok: false, error: 'Device not found' };
    await this.pollDevice(d as any, true);
    return { ok: true };
  }

  /**
   * ICMP reachability for targets that are not SNMP devices.
   *
   * 2 packets, 2s deadline — enough to distinguish "answers" from "does not"
   * without holding the sweep open. Returns the latest values only; this page
   * shows CURRENT state, and latency history belongs to the ping-monitor
   * module rather than being duplicated here.
   */
  private ping(host: string): Promise<{ up: boolean; ms: number | null; loss: number }> {
    return new Promise((resolve) => {
      execFile('ping', ['-n', '-c', '2', '-w', '2', host], { timeout: 5000 }, (_err, stdout) => {
        const out = String(stdout || '');
        const lossM = out.match(/([\d.]+)% packet loss/);
        const rttM = out.match(/=\s*[\d.]+\/([\d.]+)\//); // avg
        const loss = lossM ? parseFloat(lossM[1]) : 100;
        resolve({ up: loss < 100, ms: rttM ? Math.round(parseFloat(rttM[1]) * 10) / 10 : null, loss });
      });
    });
  }

  private async pollDevice(device: any, force = false) {
    if (!force) this.last.set(device.id, Date.now());

    /**
     * RUN THE CHECK THE DEVICE IS ACTUALLY CONFIGURED FOR.
     *
     * This used to run SNMP unconditionally, so an internet target with no
     * SNMP agent was reported as "SNMP timeout" — a wrong status AND a
     * misleading reason, on a host that answers ping instantly. HTTP is
     * treated as ICMP for now: reachability is still measured honestly, and
     * the method is recorded so the UI never claims a check it did not run.
     */
    const method = String(device.monitorMethod || 'SNMP').toUpperCase();
    if (method === 'ICMP' || method === 'HTTP') {
      const r = await this.ping(device.ip);
      if (!r.up) {
        await this.markUnreachable(device, 'Ping timeout — no ICMP reply');
        return;
      }
      // Poll succeeded — clear any circuit-breaker penalty so this device
      // returns to its configured interval on the very next sweep.
      this.recordPollOutcome(device.id, true);
      const now = new Date();
      await this.prisma.networkDevice.update({
        where: { id: device.id },
        data: {
          isReachable: true, lastError: null, lastSnmpPollAt: now, lastOkAt: now,
          downSince: null, lastLatencyMs: r.ms, lastLossPct: r.loss,
          // An ICMP target has no interface table — never fabricate port counts.
          interfaceCount: 0, upPorts: 0, downPorts: 0,
        },
      });
      if (device.isReachable === false) {
        const ev = await this.eventEngine.record({
          eventType: 'DEVICE_UP', source: 'POLL', device,
          message: `Device is answering ping again (${r.ms ?? '—'} ms)`,
        });
        await this.alerts.evaluate({ eventId: ev.id, eventType: 'DEVICE_UP', message: ev.message, severity: 'info', device });
        await this.alerts.onRecovery({ eventType: 'DEVICE_UP', deviceId: device.id, deviceName: device.name });
        this.broadcastDevice('up', device.name, null);
      }
      return;
    }

    const table = await this.snmp.readInterfaceTable(device);
    if (!table.reachable || !table.interfaces.length) {
      await this.markUnreachable(device, table.error || 'SNMP timeout');
      return;
    }
    await this.pollInterfaces(device, table, force);
  }

  // ── Reachability ─────────────────────────────────────────────────
  private async markUnreachable(device: any, error: string) {
    // The circuit breaker's failure signal. Every check type (SNMP, ICMP,
    // HTTP) funnels its "this device is down" conclusion through here, so
    // this one line keeps the breaker in step with all of them.
    this.recordPollOutcome(device.id, false);
    // NULL isReachable = never polled: first failure just initializes the
    // flag, it must NOT raise a fake DEVICE_DOWN (first-poll rule).
    const wasUp = device.isReachable === true;
    this.prev.delete(device.id);
    await this.prisma.networkDevice.update({
      where: { id: device.id },
      data: {
        isReachable: false, lastError: String(error).slice(0, 500), lastSnmpPollAt: new Date(),
        // Stamped on the FIRST failure only, so "down for 6m" measures the
        // outage rather than resetting on every poll.
        ...(device.downSince ? {} : { downSince: new Date() }),
      },
    });
    if (wasUp) {
      const ev = await this.eventEngine.record({
        eventType: 'DEVICE_DOWN', source: 'POLL',
        device: { id: device.id, name: device.name },
        message: `Device unreachable via SNMP: ${error}`,
      });
      await this.alerts.evaluate({
        eventId: ev.id, eventType: ev.eventType as NdmEventType, message: ev.message,
        severity: ev.severity, device: { id: device.id, name: device.name, ownerId: device.ownerId },
      });
      this.broadcastDevice('down', device.name, error);
    }
  }

  // ── Main poll: phases 1-4 ───────────────────────────────────────
  private async pollInterfaces(device: any, table: any, force: boolean) {
    const now = new Date();
    const nowMs = Date.now();
    const dev = { id: device.id, name: device.name };
    const devOwner = { id: device.id, name: device.name, ownerId: device.ownerId };

    // ── Phase 0: device reachability + reboot bookkeeping ───────
    // NULL isReachable = never polled → just initialize, no fake DEVICE_UP.
    if (device.isReachable === false) {
      const ev = await this.eventEngine.record({
        eventType: 'DEVICE_UP', source: 'POLL', device: dev,
        message: 'Device is responding to SNMP again',
      });
      await this.alerts.evaluate({ eventId: ev.id, eventType: 'DEVICE_UP', message: ev.message, severity: 'info', device: devOwner });
      await this.alerts.onRecovery({ eventType: 'DEVICE_UP', deviceId: device.id, deviceName: device.name });
      this.broadcastDevice('up', device.name, null);
    }
    // sysUpTime is TimeTicks = 1/100 s. Convert to REAL SECONDS here — the
    // old code stored the raw ticks as "seconds" (~100× inflation: 1179d for
    // an 11d device). The migration rewrites prod rows; this self-heal also
    // catches any row the migration could not touch: when the stored value is
    // still tick-scaled it sits within ~10% of the CURRENT raw ticks, so we
    // recognize it and just overwrite with the corrected seconds (no reboot).
    const sysUpTicksRaw = table.sysUpTicks != null ? Number(table.sysUpTicks) : null;
    const sysUpSeconds = sysUpTicksRaw != null ? Math.round(sysUpTicksRaw / 100) : null;
    let legacyTickRow = false;
    if (!force && sysUpTicksRaw != null && sysUpTicksRaw > 0 && device.uptimeSec != null) {
      const stored = Number(device.uptimeSec);
      if (stored > 0 && stored >= sysUpTicksRaw * 0.9 && stored <= sysUpTicksRaw * 1.1) {
        legacyTickRow = true; // stored is tick-scaled → overwrite below, no reboot
      }
    }
    if (!force && !legacyTickRow && lastUptimeOutran(device.uptimeSec, sysUpSeconds)) {
      const ev = await this.eventEngine.record({
        eventType: 'DEVICE_REBOOT', source: 'POLL', device: dev,
        message: 'Device rebooted (SNMP uptime reset)',
      });
      await this.alerts.evaluate({ eventId: ev.id, eventType: 'DEVICE_REBOOT', message: ev.message, severity: 'warning', device: devOwner });
    }

    // ── Phase 1: upsert interfaces → stable db ids ───────────────
    const idMap = new Map<number, number>();
    const names = new Map<number, string>();
    const mon = new Map<number, boolean>();
    for (const row of table.interfaces) {
      const upserted = await this.prisma.networkInterface.upsert({
        where: { deviceId_ifIndex: { deviceId: device.id, ifIndex: row.ifIndex } },
        update: {
          name: row.name, description: row.description, adminStatus: row.adminStatus ?? 1,
          operStatus: row.operStatus ?? 2, speedMbps: row.speedMbps, duplex: row.duplex,
          mac: row.mac, ifLastChangeTicks: row.ifLastChangeTicks,
          // Classification FACTS refresh every poll; monitoringEnabled is
          // re-applied BELOW from the policy unless manually overridden.
          ifType: row.ifType, interfaceCategory: row.interfaceCategory,
          inOctets: row.inOctets, outOctets: row.outOctets,
          inUcastPkts: row.inUcastPkts, outUcastPkts: row.outUcastPkts,
          inErrors: row.inErrors, outErrors: row.outErrors,
          inDiscards: row.inDiscards, outDiscards: row.outDiscards, crcErrors: row.crcErrors,
          lastPollAt: now, lastSeen: now, updatedAt: now,
        },
        create: {
          deviceId: device.id, ifIndex: row.ifIndex, name: row.name, description: row.description,
          adminStatus: row.adminStatus ?? 1, operStatus: row.operStatus ?? 2,
          speedMbps: row.speedMbps, duplex: row.duplex, mac: row.mac,
          ifLastChangeTicks: row.ifLastChangeTicks,
          ifType: row.ifType, interfaceCategory: row.interfaceCategory,
          monitoringEnabled: row.monitoringEnabled !== false, // classification default
          excludedReason: row.monitoringEnabled === false ? (CATEGORY_LABELS[(row.interfaceCategory as InterfaceCategory) || 'UNKNOWN'] ?? 'Not a physical/VLAN port') : null,
          inOctets: row.inOctets, outOctets: row.outOctets,
          inUcastPkts: row.inUcastPkts, outUcastPkts: row.outUcastPkts,
          inErrors: row.inErrors, outErrors: row.outErrors,
          inDiscards: row.inDiscards, outDiscards: row.outDiscards, crcErrors: row.crcErrors,
          lastPollAt: now, lastSeen: now,
        },
      });
      // Enforce the STRICT ALLOWLIST on every poll: an interface that is not
      // PHYSICAL/VLAN is excluded unless an operator explicitly overrode it.
      // This is what removes already-discovered `<pppoe-*>` sessions — the
      // policy default wins until the operator says otherwise.
      if (!upserted.monitoringExplicit) {
        const cat = (upserted.interfaceCategory || row.interfaceCategory || 'UNKNOWN') as InterfaceCategory;
        const wantMon = defaultMonitored(cat);
        if (upserted.monitoringEnabled !== wantMon) {
          await this.prisma.networkInterface.update({
            where: { id: upserted.id },
            data: {
              monitoringEnabled: wantMon,
              excludedReason: wantMon ? null : (CATEGORY_LABELS[cat] ?? 'Not a physical/VLAN port'),
            },
          }).catch(() => {});
          upserted.monitoringEnabled = wantMon;
        }
      }
      idMap.set(row.ifIndex, upserted.id);
      names.set(row.ifIndex, row.name);
      mon.set(row.ifIndex, upserted.monitoringEnabled !== false);
    }

    const prevSnap = this.prev.get(device.id) || new Map<number, any>();
    const snap = new Map<number, any>();
    const eventsToRaise: { eventType: NdmEventType; ifIndex: number; message: string }[] = [];
    const rateRows: any[] = [];
    let up = 0, down = 0, rxAll = 0, txAll = 0;

    // ── Phase 2+3: transitions + rates per interface ─────────────
    for (const row of table.interfaces) {
      const ifIndex = row.ifIndex;
      const dbId = idMap.get(ifIndex)!;
      const prior = prevSnap.get(ifIndex);
      const monitored = mon.get(ifIndex) ?? true;
      const snapRow: any = {
        oper: row.operStatus, admin: row.adminStatus,
        inOct: row.inOctets, outOct: row.outOctets,
        inPkts: row.inUcastPkts, outPkts: row.outUcastPkts,
        inErr: row.inErrors, outErr: row.outErrors, crc: row.crcErrors,
        inDisc: row.inDiscards, outDisc: row.outDiscards,
      };
      snap.set(ifIndex, snapRow);

      // Excluded interfaces (PPPoE/dynamic sessions…) are tracked but NEVER
      // alerted, counted in totals or written to traffic history.
      if (!monitored) continue;

      const isUpNow = this.snmp.isUp(row.operStatus);
      if (isUpNow) up++; else down++;
      const wasUp = prior ? this.snmp.isUp(prior.oper) : null;

      // Transition detection — on the FIRST poll there is no prior, so no event.
      if (wasUp === true && !isUpNow) {
        eventsToRaise.push({
          eventType: device.syslogEnabled ? 'LINK_DOWN' : 'PORT_DOWN',
          ifIndex,
          message: `Port "${row.name}" went DOWN${device.syslogEnabled ? ' (confirmed by SNMP)' : ''}`,
        });
      } else if (wasUp === false && isUpNow) {
        eventsToRaise.push({
          eventType: device.syslogEnabled ? 'LINK_UP' : 'PORT_UP',
          ifIndex,
          message: `Port "${row.name}" is UP again`,
        });
      }

      // Rates — skip on first poll (no baseline). When the delta is invalid
      // (counter reset / device rebooted between polls) the rate is NULL —
      // never a fake 0 bps.
      const dtSec = force ? 60 : Math.max(6, Math.min(600, (nowMs - (this.last.get(device.id) ?? nowMs - 30000)) / 1000));
      if (prior) {
        const dIn = counterDelta(snapRow.inOct, prior.inOct);
        const dOut = counterDelta(snapRow.outOct, prior.outOct);
        const rx = dIn != null ? (Number(dIn) * 8) / dtSec : null;
        const tx = dOut != null ? (Number(dOut) * 8) / dtSec : null;
        const rxp = counterDelta(snapRow.inPkts, prior.inPkts);
        const txp = counterDelta(snapRow.outPkts, prior.outPkts);
        const err = (counterDelta(snapRow.inErr, prior.inErr) ?? 0n) + (counterDelta(snapRow.outErr, prior.outErr) ?? 0n) +
          (counterDelta(snapRow.crc, prior.crc) ?? 0n) + (counterDelta(snapRow.inDisc, prior.inDisc) ?? 0n) +
          (counterDelta(snapRow.outDisc, prior.outDisc) ?? 0n);
        const errorPerMin = rx == null && tx == null && rxp == null && txp == null ? null : dtSec > 0 ? (Number(err) * 60) / dtSec : 0;
        const rxPps = rxp != null ? Number(rxp) / dtSec : null;
        const txPps = txp != null ? Number(txp) / dtSec : null;

        snapRow.rates = { rx, tx, rxPps, txPps, errorPerMin };
        if (rx != null && rx > 1) rxAll += rx;
        if (tx != null && tx > 1) txAll += tx;

        // A history point only when there is a real rate or the link is down
        // (so graphs show the outage), never a fabricated flat-zero row.
        const hasRate = rx != null || tx != null || rxPps != null || txPps != null || errorPerMin != null;
        const nonzero = (rx ?? 0) > 1 || (tx ?? 0) > 1 || (rxPps ?? 0) > 0 || (txPps ?? 0) > 0 || (errorPerMin ?? 0) > 0;
        if ((hasRate && (nonzero || !isUpNow)) || !isUpNow) {
          rateRows.push({
            deviceId: device.id, interfaceId: dbId, at: now,
            rxRateBps: rx != null ? Math.round(rx) : 0, txRateBps: tx != null ? Math.round(tx) : 0,
            rxPps: rxPps != null ? Math.round(rxPps * 10) / 10 : 0, txPps: txPps != null ? Math.round(txPps * 10) / 10 : 0,
            errorRatePerMin: errorPerMin != null ? Math.round(errorPerMin * 10) / 10 : 0, up: isUpNow, speedMbps: row.speedMbps,
            inOctets: row.inOctets, outOctets: row.outOctets, inErrors: row.inErrors, outErrors: row.outErrors,
            inDiscards: row.inDiscards, outDiscards: row.outDiscards, crcErrors: row.crcErrors,
          });
        }

        // Keep the live table row fresh (rates shown on the Ports page).
        await this.prisma.networkInterface.update({
          where: { id: dbId },
          data: {
            operStatus: row.operStatus ?? 2, adminStatus: row.adminStatus ?? 1,
            rxRateBps: rx != null ? Math.round(rx) : null, txRateBps: tx != null ? Math.round(tx) : null,
            rxPps: rxPps != null ? Math.round(rxPps * 10) / 10 : null, txPps: txPps != null ? Math.round(txPps * 10) / 10 : null,
            errorRatePerMin: errorPerMin != null ? Math.round(errorPerMin * 10) / 10 : null,
            speedMbps: row.speedMbps, inOctets: row.inOctets, outOctets: row.outOctets,
            inErrors: row.inErrors, outErrors: row.outErrors,
            crcErrors: row.crcErrors, lastPollAt: now, updatedAt: now,
          },
        }).catch(() => {});
      }
    }

    // ── Phase 2b: raise transition events (now that dbIds are known) ──
    for (const evt of eventsToRaise) {
      const dbId = idMap.get(evt.ifIndex)!;
      const intf = { id: dbId, name: names.get(evt.ifIndex)! };
      await this.raiseTransition(device, devOwner, intf, evt.eventType, evt.message);
    }

    // ── Phase 3b: append rate history (bounded batches) ──────────
    for (let i = 0; i < rateRows.length; i += 50) {
      await this.prisma.interfaceTrafficHistory.createMany({ data: rateRows.slice(i, i + 50) }).catch(() => {});
    }

    // ── Phase 4: device totals + health metric + escalations ────
    // (rxAll/txAll accumulated in Phase 2+3 — SUM OF THE REAL DELTA RATES of
    // monitored interfaces; the old code summed a field SNMP never fills.)
    // Poll succeeded — clear any circuit-breaker penalty so this device
    // returns to its configured interval on the very next sweep.
    this.recordPollOutcome(device.id, true);
    await this.prisma.networkDevice.update({
      where: { id: device.id },
      data: {
        isReachable: true, lastError: null, lastSnmpPollAt: now,
        // Clear the outage stamp on recovery, and record the last good check so
        // the UI can show "last successful check" without inferring it.
        lastOkAt: now, downSince: null,
        interfaceCount: table.interfaces.length, upPorts: up, downPorts: down,
        uptimeSec: sysUpSeconds, // real seconds (sysUpTime ticks ÷ 100)
      },
    });
    if (sysUpSeconds != null) {
      await this.prisma.deviceHealthMetric.createMany({
        data: [
          { deviceId: device.id, ts: now, metric: 'uptime', value: sysUpSeconds },
          { deviceId: device.id, ts: now, metric: 'rx', value: Math.round(rxAll) },
          { deviceId: device.id, ts: now, metric: 'tx', value: Math.round(txAll) },
        ],
      }).catch(() => {});
    }

    this.prev.set(device.id, snap);

    // DURATION-rule escalation check — once per device per poll.
    await this.runDurationEscalations(device, nowMs);
  }

  /** DURATION rules: sustained incidents re-fire (escalate) every N * fireCount seconds. */
  private async runDurationEscalations(device: any, nowMs: number) {
    const open = await this.prisma.alert.findMany({
      where: { deviceId: device.id, status: 'OPEN' },
      include: { rule: true },
    });
    for (const a of open) {
      const rule = a.rule;
      if (!rule?.enabled) continue;
      const cond = parseCondition(rule.condition);
      if (cond.kind !== 'DURATION') continue;
      const sustainSec = cond.seconds * Math.max(1, a.fireCount);
      if (nowMs - a.openedAt.getTime() >= sustainSec * 1000) {
        const updated = await this.prisma.alert.update({
          where: { id: a.id },
          data: { fireCount: { increment: 1 } },
          include: { rule: true },
        });
        const snd = typeof (rule.channels as any)?.sound === 'boolean' ? (rule.channels as any).sound : eventOpenSound(a.eventType);
        await this.notify.notify({
          alertId: a.id,
          title: `ESCALATED: ${a.title}`,
          message: `${device.name}: ${a.message} (still failing after ${Math.round(sustainSec / 60)} min)`,
          severity: a.severity,
          channels: { ...((rule.channels as any) || {}), sound: snd },
          ownerId: device.ownerId, deviceName: device.name, deviceIp: device.ip,
          event: 'UPGRADE',
        });
        this.broadcastAlert(updated, snd);
      }
    }
  }

  // ── SSE ────────────────────────────────────────────────────────
  /**
   * The ONE transition writer: a real state change (poll) or a synthetic one
   * (dev-test button) flows through the exact same event → alert → notify →
   * SSE pipeline, so a triggered "Test DOWN alert" reproduces a genuine
   * cable-pull end to end.
   */
  private async raiseTransition(device: any, devOwner: { id: number; name: string; ownerId?: number | null }, intf: { id: number; name: string }, eventType: NdmEventType, message: string) {
    const ev = await this.eventEngine.record({
      eventType, source: 'POLL', device: { id: device.id, name: device.name }, interface: intf, message,
    });
    this.log.log(`[EVENT] ${eventType} ${device.name} port=${intf.name} eventId=${ev.id} sev=${ev.severity}${ev.count > 1 ? ` count=${ev.count}` : ''}`);
    if (ev.eventType === 'PORT_UP' || ev.eventType === 'LINK_UP') {
      // RECOVERY FIRST: close + notify the DOWN alert through the recovery
      // rules' sound setting. Evaluating an UP event as a fresh incident would
      // bump the still-open DOWN alert and re-sound it on the recovery poll.
      await this.alerts.onRecovery({ eventType: ev.eventType, deviceId: device.id, interfaceId: intf.id, deviceName: device.name });
    } else if (!isRecoveryEventType(ev.eventType)) {
      await this.alerts.evaluate({
        eventId: ev.id, eventType: ev.eventType, message: ev.message, severity: ev.severity,
        device: devOwner, interface: intf, count: ev.count,
      });
    }
    this.broadcastTransition(device.name, intf.name, String(eventType).endsWith('_UP') ? 'up' : 'down');
    return ev;
  }

  /**
   * Admin/dev-test: force a port DOWN or UP transition through the REAL
   * pipeline (event → rule → alert → notify → SSE → browser sound). The next
   * real SNMP poll immediately corrects the forced state, so this is safe.
   */
  async testPortAlert(deviceId: number, portId: number, direction: 'down' | 'up') {
    const device = await this.prisma.networkDevice.findUnique({ where: { id: deviceId } });
    if (!device) throw new Error('Device not found');
    const port = await this.prisma.networkInterface.findFirst({ where: { id: portId, deviceId } });
    if (!port) throw new Error('Port not found on this device');
    if (port.monitoringEnabled === false) throw new Error(`Port "${port.name}" is excluded from monitoring (${port.excludedReason || 'not physical/VLAN'}) — enable it first`);
    const dbId = port.id;
    const forcedOper = direction === 'down' ? 2 : 1;
    await this.prisma.networkInterface.update({ where: { id: dbId }, data: { operStatus: forcedOper } }).catch(() => {});
    const eventType = (device.syslogEnabled ? (direction === 'down' ? 'LINK_DOWN' : 'LINK_UP') : (direction === 'down' ? 'PORT_DOWN' : 'PORT_UP')) as NdmEventType;
    const ev = await this.raiseTransition(device, { id: device.id, name: device.name, ownerId: device.ownerId }, { id: dbId, name: port.name }, eventType,
      `Test: Port "${port.name}" went ${direction === 'down' ? 'DOWN' : 'UP'} (synthetic) — real SNMP will correct this`);
    return { ok: true, eventType, eventId: ev.id, message: ev.message };
  }

  private broadcastTransition(deviceName: string, portName: string, direction: 'up' | 'down') {
    try {
      this.eventsEmitter.broadcast('ndm:port', {
        deviceName, port: portName, direction, at: new Date().toISOString(),
      });
    } catch { /* best-effort */ }
  }

  private broadcastDevice(state: 'up' | 'down', deviceName: string, error: string | null) {
    try {
      this.eventsEmitter.broadcast('ndm:device', { deviceName, state, error, at: new Date().toISOString() });
    } catch { /* best-effort */ }
  }

  private broadcastAlert(alert: any, sound = false) {
    try {
      this.eventsEmitter.broadcast('ndm:alert', {
        id: alert.id, status: alert.status, eventType: alert.eventType, title: alert.title,
        severity: alert.severity, fireCount: alert.fireCount, deviceId: alert.deviceId,
        interfaceName: alert.interfaceName, openedAt: alert.openedAt, resolvedAt: null, sound,
      });
    } catch { /* best-effort */ }
  }
}

/** True when SNMP uptime went backwards → the device rebooted. */
function lastUptimeOutran(prev: any, cur: number | null): boolean {
  if (prev == null || cur == null || cur <= 0) return false;
  const p = Number(prev);
  return p > 0 && cur < p - 2;
}