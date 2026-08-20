import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isPrimaryInstance } from '../common/cluster-util';
import { EventsService } from '../common/events.service';
import { NdmSnmpService } from './snmp.service';
import { NdmEventEngine } from './event-engine.service';
import { NdmAlertEngine } from './alert-engine.service';
import { NdmNotificationEngine } from './notification-engine.service';
import { counterDelta, parseCondition, type NdmEventType } from './ndm.constants';

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

  /** Idempotent: only touches rows whose category is still NULL. */
  private async backfillLegacyRows() {
    try {
      const n = await this.prisma.$executeRawUnsafe(`
        UPDATE "network_interface" SET
          "interfaceCategory" = CASE
            WHEN LOWER("name") LIKE 'pppoe-%' OR (LOWER("name") LIKE '%pppoe%' AND "name" ~ '[0-9]') THEN 'PPPOE_SESSION'
            WHEN LOWER("name") ~ '^vlan[0-9.:-]*$' THEN 'VLAN'
            WHEN LOWER("name") ~ '^(lo|loopback[0-9.:-]*)$' THEN 'LOOPBACK'
            WHEN LOWER("name") ~ '^bridge[0-9.:-]*$' THEN 'BRIDGE'
            WHEN LOWER("name") ~ '^bond[0-9.:-]*$' THEN 'BOND'
            WHEN LOWER("name") ~ '^(gre|gre6|eoip|vxlan|ipip|eip|wireguard|tun[0-9.:-]*)$' THEN 'TUNNEL'
            WHEN LOWER("name") ~ '^(ppp|l2tp|sstp|ovpn)[0-9.:-]*$' THEN 'PPP'
            WHEN LOWER("name") ~ '^dynamic' THEN 'DYNAMIC'
            ELSE 'UNKNOWN'
          END,
          "monitoringEnabled" = CASE
            WHEN LOWER("name") LIKE 'pppoe-%' OR (LOWER("name") LIKE '%pppoe%' AND "name" ~ '[0-9]') THEN false
            WHEN LOWER("name") ~ '^dynamic' THEN false
            ELSE "monitoringEnabled"
          END
        WHERE "interfaceCategory" IS NULL;
      `);
      if (n) this.log.log(`Backfilled classification of ${n} legacy interface row(s) (PPPoE excluded by default)`);
    } catch (e: any) {
      // Column may not exist yet on a DB that wasn't pushed — retry next boot.
      this.log.warn(`Legacy classification backfill skipped: ${e?.message || e}`);
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
    try {
      const devices = await this.prisma.networkDevice.findMany({
        where: { enabled: true },
        select: {
          id: true, name: true, ip: true, vendor: true, snmpVersion: true,
          snmpPort: true, pollIntervalSec: true, snmpTimeoutMs: true, snmpRetries: true,
          ownerId: true, syslogEnabled: true, isReachable: true, uptimeSec: true,
        },
      });
      const now = Date.now();
      const due = devices
        .filter((d) => (this.last.get(d.id) ?? 0) + d.pollIntervalSec * 1000 <= now)
        .slice(0, 40);
      const BATCH = 8;
      for (let i = 0; i < due.length; i += BATCH) {
        await Promise.all(
          due.slice(i, i + BATCH).map((d) => this.pollDevice(d).catch((e: any) => this.log.warn(`poll ${d.name}: ${e?.message || e}`))),
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

  private async pollDevice(device: any, force = false) {
    if (!force) this.last.set(device.id, Date.now());
    const table = await this.snmp.readInterfaceTable(device);
    if (!table.reachable || !table.interfaces.length) {
      await this.markUnreachable(device, table.error || 'SNMP timeout');
      return;
    }
    await this.pollInterfaces(device, table, force);
  }

  // ── Reachability ─────────────────────────────────────────────────
  private async markUnreachable(device: any, error: string) {
    // NULL isReachable = never polled: first failure just initializes the
    // flag, it must NOT raise a fake DEVICE_DOWN (first-poll rule).
    const wasUp = device.isReachable === true;
    this.prev.delete(device.id);
    await this.prisma.networkDevice.update({
      where: { id: device.id },
      data: { isReachable: false, lastError: String(error).slice(0, 500), lastSnmpPollAt: new Date() },
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
          // deliberately NOT touched here so a manual per-port toggle sticks.
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
          inOctets: row.inOctets, outOctets: row.outOctets,
          inUcastPkts: row.inUcastPkts, outUcastPkts: row.outUcastPkts,
          inErrors: row.inErrors, outErrors: row.outErrors,
          inDiscards: row.inDiscards, outDiscards: row.outDiscards, crcErrors: row.crcErrors,
          lastPollAt: now, lastSeen: now,
        },
      });
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
      const ev = await this.eventEngine.record({
        eventType: evt.eventType, source: 'POLL', device: dev, interface: intf, message: evt.message,
      });
      await this.alerts.evaluate({
        eventId: ev.id, eventType: ev.eventType, message: ev.message, severity: ev.severity,
        device: devOwner, interface: intf, count: ev.count,
      });
      if (evt.eventType === 'PORT_UP' || evt.eventType === 'LINK_UP') {
        await this.alerts.onRecovery({ eventType: evt.eventType, deviceId: device.id, interfaceId: dbId, deviceName: device.name });
      }
      this.broadcastTransition(device.name, intf.name, evt.eventType.endsWith('_UP') ? 'up' : 'down');
    }

    // ── Phase 3b: append rate history (bounded batches) ──────────
    for (let i = 0; i < rateRows.length; i += 50) {
      await this.prisma.interfaceTrafficHistory.createMany({ data: rateRows.slice(i, i + 50) }).catch(() => {});
    }

    // ── Phase 4: device totals + health metric + escalations ────
    // (rxAll/txAll accumulated in Phase 2+3 — SUM OF THE REAL DELTA RATES of
    // monitored interfaces; the old code summed a field SNMP never fills.)
    await this.prisma.networkDevice.update({
      where: { id: device.id },
      data: {
        isReachable: true, lastError: null, lastSnmpPollAt: now,
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
        await this.notify.notify({
          alertId: a.id,
          title: `ESCALATED: ${a.title}`,
          message: `${device.name}: ${a.message} (still failing after ${Math.round(sustainSec / 60)} min)`,
          severity: a.severity,
          channels: (rule.channels as any) || {},
          ownerId: device.ownerId, deviceName: device.name, deviceIp: device.ip,
          event: 'UPGRADE',
        });
        this.broadcastAlert(updated);
      }
    }
  }

  // ── SSE ────────────────────────────────────────────────────────
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

  private broadcastAlert(alert: any) {
    try {
      this.eventsEmitter.broadcast('ndm:alert', {
        id: alert.id, status: alert.status, eventType: alert.eventType, title: alert.title,
        severity: alert.severity, fireCount: alert.fireCount, deviceId: alert.deviceId,
        interfaceName: alert.interfaceName, openedAt: alert.openedAt, resolvedAt: null,
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