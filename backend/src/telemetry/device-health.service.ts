import { Injectable, Logger } from '@nestjs/common';
import { assertSnmpTargetAllowed, normalizeSnmpVersion } from '../nas/nas-snmp-config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { isPrimaryInstance } from '../common/cluster-util';
import { IF, IF_HC, IF_EXTRA, IF_OPER_UP, healthProfileFor, HealthOid } from './oids';
import { SecretsService } from '../common/secrets.service';
import { decField } from '../nas/nas-credentials';

/** How a failed poll is classified. Drives NasSnmpState.status + event type. */
export type SnmpErrorKind = 'timeout' | 'auth_error' | 'config_error' | 'unreachable' | 'error';

/** The outcome of one poll, consumed by SnmpMonitorService. `message` is always
 *  redacted and operator-friendly — it never contains a credential. */
export type SnmpPollResult = {
  ok: boolean;
  kind: 'ok' | SnmpErrorKind;
  message?: string;
  sysDescr?: string | null;
  uptimeSec?: number | null;
  responseMs?: number;
  cpu?: number | null;
  memory?: number | null;
  interfaces?: number;
  interfacesUp?: number;
  interfacesDown?: number;
  downInterfaces?: string[];
  rebooted?: boolean;
};

/**
 * DEVICE HEALTH + INTERFACE RATE COLLECTOR.
 *
 * Separate from SnmpPollerService on purpose: that one drives link alerts and
 * ONT signal, this one builds the historical series behind the graphs. Keeping
 * them apart means a change here can never disturb alerting.
 *
 * WHAT IT STORES, AND WHY IT IS NOT RAW COUNTERS
 * `ifInOctets` is a cumulative counter, not a speed. Graphing it as Mbps is
 * meaningless and it wraps (a 32-bit counter laps every ~34s on a gigabit
 * link). So each poll we take the DELTA against the previous reading and store
 * a real rate:
 *
 *     bps = (current − previous) × 8 ÷ elapsed_seconds
 *
 * with explicit handling for 64-bit counters, 32-bit rollover, and device
 * reboots (sysUpTime going backwards resets counters, so that sample is
 * dropped rather than graphed as a spike).
 */
@Injectable()
export class DeviceHealthService {
  private readonly log = new Logger('DeviceHealth');
  private snmp: any = null;
  /** Previous counter reading per NAS+ifIndex, for the delta. */
  private prev = new Map<string, { name: string; rx: bigint; tx: bigint; inErr: number; outErr: number; inDis: number; outDis: number; at: number }>();
  /** Previous uptime per NAS, to detect a reboot (counters reset). */
  private prevUptime = new Map<number, number>();

  constructor(private prisma: PrismaService, private secrets: SecretsService) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.snmp = require('net-snmp');
    } catch {
      this.log.warn('net-snmp not installed — health collection disabled.');
    }
  }

  /**
   * STAGE 2: scheduling moved to SnmpMonitorService, which owns per-NAS
   * intervals, bounded concurrency, backoff and single-flight. This service is
   * now the stateless COLLECTOR — it polls one device and returns a classified
   * result. It no longer runs its own 30-second global sweep (which polled every
   * enabled NAS on a fixed interval with no backoff). `snmpAvailable()` lets the
   * monitor skip entirely when net-snmp is missing.
   */
  snmpAvailable(): boolean { return !!this.snmp; }

  /** The NAS columns a poll needs. Shared so the monitor selects the same set. */
  static readonly POLL_SELECT = {
    id: true, nasname: true, nasIp: true, deviceType: true,
    snmpCommunity: true, snmpPort: true, snmpVersion: true, monitoredPorts: true,
    snmpTimeoutMs: true, snmpRetries: true,
    snmpV3User: true, snmpV3SecLevel: true, snmpV3AuthProto: true,
    snmpV3AuthPass: true, snmpV3PrivProto: true, snmpV3PrivPass: true,
  } as const;

  // ── SNMP plumbing ────────────────────────────────────────────
  private host(nas: any) { return String(nas.nasIp || '').trim(); }

  private session(nas: any) {
    const host = this.host(nas);
    const port = nas.snmpPort ?? 161;
    assertSnmpTargetAllowed(host, port);
    const opts = {
      port,
      timeout: nas.snmpTimeoutMs || 4000,
      retries: nas.snmpRetries ?? 1,
    };
    const version = normalizeSnmpVersion(nas.snmpVersion);
    // ── SNMPv3 (USM) ──────────────────────────────────────────────────────
    // Preferred for real deployments: per-user auth + privacy, no shared
    // community on the wire. We NEVER silently downgrade — the security level
    // is exactly what the operator configured, and authPriv requires both
    // passphrases to be present (validated at save time).
    if (version === 'V3') {
      const level = this.v3Level(nas.snmpV3SecLevel);
      const user: any = { name: nas.snmpV3User || '', level };
      if (level !== this.snmp.SecurityLevel.noAuthNoPriv) {
        user.authProtocol = (nas.snmpV3AuthProto || 'SHA').toUpperCase() === 'MD5'
          ? this.snmp.AuthProtocols.md5 : this.snmp.AuthProtocols.sha;
        user.authKey = decField(this.secrets, nas.snmpV3AuthPass);
      }
      if (level === this.snmp.SecurityLevel.authPriv) {
        user.privProtocol = (nas.snmpV3PrivProto || 'AES').toUpperCase() === 'DES'
          ? this.snmp.PrivProtocols.des : this.snmp.PrivProtocols.aes;
        user.privKey = decField(this.secrets, nas.snmpV3PrivPass);
      }
      return this.snmp.createV3Session(this.host(nas), user, { ...opts, version: this.snmp.Version3 });
    }
    // ── SNMPv1 / v2c ──────────────────────────────────────────────────────
    // The community is encrypted at rest; decField() also passes legacy
    // plaintext values through unchanged.
    const community = decField(this.secrets, nas.snmpCommunity);
    if (!community) throw new Error('SNMP community is not configured.');
    return this.snmp.createSession(
      host,
      community,
      { ...opts, version: version === 'V1' ? this.snmp.Version1 : this.snmp.Version2c },
    );
  }

  /** Map our stored security-level string to net-snmp's enum. */
  private v3Level(level?: string | null) {
    switch (String(level || '').trim()) {
      case 'authPriv': return this.snmp.SecurityLevel.authPriv;
      case 'authNoPriv': return this.snmp.SecurityLevel.authNoPriv;
      case 'noAuthNoPriv': return this.snmp.SecurityLevel.noAuthNoPriv;
      // No configured level → the safest that still works with just a username
      // is noAuthNoPriv; config validation steers operators to authPriv.
      default: return this.snmp.SecurityLevel.noAuthNoPriv;
    }
  }

  /** Walk one OID base → Map(trailing index → value). */
  private walk(session: any, oid: string): Promise<Map<number, any>> {
    return new Promise((resolve) => {
      const out = new Map<number, any>();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(out); } };
      try {
        session.subtree(oid, 20, (vbs: any[]) => {
          for (const vb of vbs) {
            if (this.snmp.isVarbindError(vb)) continue;
            out.set(Number(vb.oid.split('.').pop()), vb.value);
          }
        }, finish);
      } catch { finish(); }
      setTimeout(finish, 12_000); // never hang the cycle
    });
  }

  /** Read scalar OIDs in one request. */
  private get(session: any, oids: string[]): Promise<Map<string, any>> {
    return new Promise((resolve) => {
      const out = new Map<string, any>();
      if (!oids.length) return resolve(out);
      try {
        session.get(oids, (err: any, vbs: any[]) => {
          if (!err && Array.isArray(vbs)) {
            for (const vb of vbs) {
              if (this.snmp.isVarbindError(vb)) continue;
              out.set(String(vb.oid), vb.value);
            }
          }
          resolve(out);
        });
      } catch { resolve(out); }
    });
  }

  private num(v: any): number | null {
    if (v == null) return null;
    const n = typeof v === 'bigint' ? Number(v) : Number(v.toString?.() ?? v);
    return Number.isFinite(n) ? n : null;
  }
  private big(v: any): bigint | null {
    if (v == null) return null;
    try { return typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v.toString?.() ?? v))); }
    catch { return null; }
  }

  // ── Health metrics (CPU / memory / uptime / temperature) ─────
  private async readHealth(session: any, deviceType: string | null): Promise<Record<string, number>> {
    const p = healthProfileFor(deviceType);
    const out: Record<string, number> = {};

    const scalarOids: string[] = [];
    const push = (h?: HealthOid) => {
      if (!h) return;
      if (h.kind === 'gauge' && !h.walkAvg) scalarOids.push(h.oid);
      else if (h.kind === 'ticks') scalarOids.push(h.oid);
      else if (h.kind === 'ratio') scalarOids.push(h.usedOid, h.totalOid);
    };
    push(p.cpu); push(p.memory); push(p.uptime); push(p.temperature);
    const scalars = await this.get(session, [...new Set(scalarOids)]);

    const readOne = async (h: HealthOid | undefined): Promise<number | null> => {
      if (!h) return null;
      if (h.kind === 'ticks') {
        const t = this.num(scalars.get(h.oid));
        return t == null ? null : Math.round(t / 100); // ticks (1/100s) → seconds
      }
      if (h.kind === 'ratio') {
        const used = this.num(scalars.get(h.usedOid));
        const total = this.num(scalars.get(h.totalOid));
        if (used == null || total == null || total <= 0) return null;
        return Math.round((used / total) * 1000) / 10;
      }
      // gauge
      if (h.walkAvg) {
        const m = await this.walk(session, h.oid);
        const vals = [...m.values()].map((v) => this.num(v)).filter((n): n is number => n != null);
        if (!vals.length) return null;
        return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
      }
      const v = this.num(scalars.get(h.oid));
      return v == null ? null : Math.round(v * (h.scale ?? 1) * 10) / 10;
    };

    const [cpu, memory, uptime, temperature] = await Promise.all([
      readOne(p.cpu), readOne(p.memory), readOne(p.uptime), readOne(p.temperature),
    ]);
    if (cpu != null && cpu >= 0 && cpu <= 100) out.cpu = cpu;
    if (memory != null && memory >= 0 && memory <= 100) out.memory = memory;
    if (uptime != null && uptime >= 0) out.uptime = uptime;
    if (temperature != null && temperature > -50 && temperature < 150) out.temperature = temperature;
    return out;
  }

  /**
   * HISTORY for the graphs — aggregated in SQL, never row-by-row in Node.
   *
   * A year of 30-second samples is ~1M rows per metric; shipping those to a
   * browser would be unusable. Postgres buckets them by an interval chosen from
   * the range (raw for short windows, 5-minute / hourly / daily for long ones)
   * so every range returns a couple of hundred points and stays fast.
   */
  async history(nasId: number, opts: { range?: string; metrics?: string[] } = {}) {
    const RANGES: Record<string, { ms: number; bucketSec: number }> = {
      '5m':  { ms: 5 * 60_000,        bucketSec: 30 },
      '15m': { ms: 15 * 60_000,       bucketSec: 60 },
      '1h':  { ms: 3600_000,          bucketSec: 60 },
      '6h':  { ms: 6 * 3600_000,      bucketSec: 300 },
      '24h': { ms: 24 * 3600_000,     bucketSec: 300 },
      '7d':  { ms: 7 * 86400_000,     bucketSec: 1800 },
      '30d': { ms: 30 * 86400_000,    bucketSec: 3600 },
      '90d': { ms: 90 * 86400_000,    bucketSec: 21600 },
      '1y':  { ms: 365 * 86400_000,   bucketSec: 86400 },
    };
    const r = RANGES[opts.range || '1h'] ?? RANGES['1h'];
    const from = new Date(Date.now() - r.ms);
    const wanted = opts.metrics?.length ? opts.metrics : ['cpu', 'memory', 'temperature', 'snmpMs'];

    // Device metrics, bucketed + averaged.
    const rows = await this.prisma.$queryRawUnsafe<Array<{ bucket: Date; metric: string; avg: number; max: number }>>(
      `SELECT to_timestamp(floor(extract(epoch from "ts") / $1) * $1) AS bucket,
              "metric",
              AVG("value")::float AS avg,
              MAX("value")::float AS max
         FROM "device_metric"
        WHERE "nasId" = $2 AND "ts" >= $3 AND "metric" = ANY($4)
        GROUP BY bucket, "metric"
        ORDER BY bucket ASC`,
      r.bucketSec, nasId, from, wanted,
    );

    const series: Record<string, Array<{ t: string; v: number }>> = {};
    for (const row of rows) {
      (series[row.metric] ||= []).push({ t: new Date(row.bucket).toISOString(), v: Math.round(Number(row.avg) * 10) / 10 });
    }

    // Latest values + min/avg/max per metric, for the stat row above each chart.
    const stats: Record<string, { current: number | null; min: number; avg: number; max: number }> = {};
    for (const [metric, pts] of Object.entries(series)) {
      const vals = pts.map((p) => p.v);
      stats[metric] = {
        current: vals.length ? vals[vals.length - 1] : null,
        min: vals.length ? Math.min(...vals) : 0,
        avg: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0,
        max: vals.length ? Math.max(...vals) : 0,
      };
    }
    return { range: opts.range || '1h', from, bucketSec: r.bucketSec, series, stats };
  }

  /** Per-interface traffic/error history, same bucketing. */
  async interfaceHistory(nasId: number, ifIndex: number, range = '1h') {
    const RANGES: Record<string, { ms: number; bucketSec: number }> = {
      '5m': { ms: 300_000, bucketSec: 30 }, '15m': { ms: 900_000, bucketSec: 60 },
      '1h': { ms: 3600_000, bucketSec: 60 }, '6h': { ms: 21600_000, bucketSec: 300 },
      '24h': { ms: 86400_000, bucketSec: 300 }, '7d': { ms: 604800_000, bucketSec: 1800 },
      '30d': { ms: 2592000_000, bucketSec: 3600 }, '90d': { ms: 7776000_000, bucketSec: 21600 },
      '1y': { ms: 31536000_000, bucketSec: 86400 },
    };
    const r = RANGES[range] ?? RANGES['1h'];
    const from = new Date(Date.now() - r.ms);
    const rows = await this.prisma.$queryRawUnsafe<Array<any>>(
      `SELECT to_timestamp(floor(extract(epoch from "ts") / $1) * $1) AS bucket,
              AVG("rxBps")::float AS rx, AVG("txBps")::float AS tx,
              MAX("rxBps")::float AS rxpeak, MAX("txBps")::float AS txpeak,
              AVG("inErrors")::float AS inerr, AVG("outErrors")::float AS outerr,
              AVG("inDiscards")::float AS indis, AVG("outDiscards")::float AS outdis
         FROM "interface_metric"
        WHERE "nasId" = $2 AND "ifIndex" = $3 AND "ts" >= $4
        GROUP BY bucket ORDER BY bucket ASC`,
      r.bucketSec, nasId, ifIndex, from,
    );
    const points = rows.map((x) => ({
      t: new Date(x.bucket).toISOString(),
      rx: Math.round(Number(x.rx)), tx: Math.round(Number(x.tx)),
      inErrors: Math.round(Number(x.inerr) * 100) / 100,
      outErrors: Math.round(Number(x.outerr) * 100) / 100,
      inDiscards: Math.round(Number(x.indis) * 100) / 100,
      outDiscards: Math.round(Number(x.outdis) * 100) / 100,
    }));
    const rxs = points.map((p) => p.rx), txs = points.map((p) => p.tx);
    return {
      range, from, points,
      stats: {
        rxCurrent: rxs.at(-1) ?? 0, txCurrent: txs.at(-1) ?? 0,
        rxAvg: rxs.length ? Math.round(rxs.reduce((a, b) => a + b, 0) / rxs.length) : 0,
        txAvg: txs.length ? Math.round(txs.reduce((a, b) => a + b, 0) / txs.length) : 0,
        rxPeak: rows.length ? Math.round(Math.max(...rows.map((x) => Number(x.rxpeak)))) : 0,
        txPeak: rows.length ? Math.round(Math.max(...rows.map((x) => Number(x.txpeak)))) : 0,
      },
    };
  }

  /** Current interface list with the latest sample for each. */
  async interfaces(nasId: number) {
    const rows = await this.prisma.$queryRawUnsafe<Array<any>>(
      `SELECT DISTINCT ON ("ifIndex") "ifIndex", "name", "rxBps", "txBps", "up",
              "speedMbps", "inErrors", "outErrors", "ts"
         FROM "interface_metric"
        WHERE "nasId" = $1 AND "ts" >= NOW() - INTERVAL '30 minutes'
        ORDER BY "ifIndex", "ts" DESC`,
      nasId,
    );
    return rows.map((r) => ({
      ifIndex: Number(r.ifIndex), name: r.name, up: r.up,
      rxBps: Math.round(Number(r.rxBps)), txBps: Math.round(Number(r.txBps)),
      speedMbps: r.speedMbps ? Number(r.speedMbps) : null,
      inErrors: Number(r.inErrors), outErrors: Number(r.outErrors),
      lastSeen: r.ts,
    }));
  }

  /**
   * RETENTION — monitoring data must not grow without bound. Raw samples are
   * kept for a short window (they are only needed for recent, high-resolution
   * graphs); longer ranges are served by SQL bucketing over what remains.
   */
  @Cron('40 3 * * *')
  async prune() {
    // DELIBERATELY NOT gated on snmpEnabled(). Turning SNMP off stops new
    // metrics being written; it must not strand the ones already stored. If
    // this returned early, the existing DeviceMetric/InterfaceMetric rows would
    // sit in the database for ever, which is the opposite of what switching a
    // feature off should cost you.
    if (!isPrimaryInstance()) return;
    const days = Number(process.env.METRIC_RETENTION_DAYS || 30);
    const cutoff = new Date(Date.now() - days * 86400_000);
    const [dm, im] = await Promise.all([
      this.prisma.deviceMetric.deleteMany({ where: { ts: { lt: cutoff } } }),
      this.prisma.interfaceMetric.deleteMany({ where: { ts: { lt: cutoff } } }),
    ]);
    if (dm.count || im.count) {
      this.log.log(`Retention: pruned ${dm.count} device and ${im.count} interface samples older than ${days}d.`);
    }

    // Monitoring EVENTS are kept on their OWN, longer window — they are
    // low-volume (state transitions only) and useful for incident review well
    // after the high-frequency metrics have aged out. Separate knob.
    const eventDays = Number(process.env.EVENT_RETENTION_DAYS || 90);
    const ev = await this.prisma.nasEvent.deleteMany({ where: { ts: { lt: new Date(Date.now() - eventDays * 86400_000) } } }).catch(() => ({ count: 0 }));
    if (ev.count) this.log.log(`Retention: pruned ${ev.count} NAS events older than ${eventDays}d.`);
  }

  /**
   * TEST SNMP — a real probe, not a config check. Contacts the device now and
   * reports what actually came back (or precisely why it didn't), so the
   * operator can fix community/firewall/service without guessing.
   */
  async testSnmp(nasId: number): Promise<any> {
    const nas = await this.prisma.nas.findUnique({
      where: { id: nasId },
      select: {
        id: true, nasname: true, nasIp: true, deviceType: true, snmpEnabled: true,
        snmpCommunity: true, snmpPort: true, snmpVersion: true,
        snmpTimeoutMs: true, snmpRetries: true,
        snmpV3User: true, snmpV3SecLevel: true, snmpV3AuthProto: true,
        snmpV3AuthPass: true, snmpV3PrivProto: true, snmpV3PrivPass: true,
      },
    });
    if (!nas) return { ok: false, error: 'NAS not found.' };
    if (!this.snmp) return { ok: false, error: 'net-snmp is not installed on the server.' };
    if (!this.host(nas)) return { ok: false, error: 'This NAS has no IP address configured.' };

    const started = Date.now();
    let session: any;
    try {
      session = this.session(nas);
      const scalars = await this.get(session, [IF.sysUpTime, IF.sysDescr]);
      const responseMs = Date.now() - started;
      const ticks = this.num(scalars.get(IF.sysUpTime));

      if (ticks == null) {
        return {
          ok: false,
          target: `${this.host(nas)}:${nas.snmpPort || 161}`,
          version: nas.snmpVersion,
          error: 'No SNMP reply (timeout).',
          check: [
            'The community string matches the device',
            'SNMP is enabled on the device',
            'UDP 161 is open from this server to the device',
            'The device allows this server’s IP in its SNMP ACL',
          ],
        };
      }

      const [oper, health] = await Promise.all([
        this.walk(session, IF.operStatus),
        this.readHealth(session, nas.deviceType),
      ]);
      const upSecs = Math.round(ticks / 100);
      return {
        ok: true,
        device: nas.nasname,
        target: `${this.host(nas)}:${nas.snmpPort || 161}`,
        version: nas.snmpVersion,
        responseMs,
        sysDescr: String(scalars.get(IF.sysDescr) ?? '').slice(0, 160) || null,
        uptimeSeconds: upSecs,
        uptimeText: `${Math.floor(upSecs / 86400)}d ${Math.floor((upSecs % 86400) / 3600)}h`,
        interfaces: oper.size,
        cpu: health.cpu ?? null,
        memory: health.memory ?? null,
        temperature: health.temperature ?? null,
        note: nas.snmpEnabled ? undefined : 'SNMP answered, but polling is disabled for this NAS — enable it to collect history.',
      };
    } catch (e: any) {
      return {
        ok: false,
        target: `${this.host(nas)}:${nas.snmpPort || 161}`,
        error: this.classifyError(e).message,
      };
    } finally {
      try { session?.close(); } catch { /* already closed */ }
    }
  }

  // ── One device ───────────────────────────────────────────────
  /**
   * Poll ONE device and persist its metrics. Returns a classified result so the
   * monitor can record state and raise events without re-probing. A failed
   * probe writes NO metrics (so missing data is never recorded as zero) and
   * returns a redacted, operator-friendly reason — never the credential.
   */
  async collectOne(nas: any): Promise<SnmpPollResult> {
    if (!this.snmp) return { ok: false, kind: 'error', message: 'net-snmp is not installed on the server.' };
    if (!this.host(nas)) return { ok: false, kind: 'config_error', message: 'This NAS has no IP address configured.' };
    let session: any;
    const startedAt = Date.now();
    try {
      session = this.session(nas);
      // Reachability + auth probe FIRST. Classifies timeout vs auth vs config
      // before we attempt the full walk, and confirms the device actually
      // answered — so we never fabricate metrics for an unreachable NAS.
      const probe = await this.probe(session, [IF.sysUpTime, IF.sysDescr]);
      if (!probe.ok) return { ok: false, ...this.classifyError(probe.err) };

      const sysDescr = String(probe.values.get(IF.sysDescr) ?? '').slice(0, 300) || null;
      const probeTicks = this.num(probe.values.get(IF.sysUpTime));
      const sysUptimeSec = probeTicks == null ? null : Math.round(probeTicks / 100);

      const health = await this.readHealth(session, nas.deviceType);
      const snmpMs = Date.now() - startedAt;

      // A reboot resets every counter — detect it before computing any rate.
      const rebooted = health.uptime != null
        && (this.prevUptime.get(nas.id) ?? 0) > health.uptime;
      if (health.uptime != null) this.prevUptime.set(nas.id, health.uptime);

      // Interface table. Prefer 64-bit HC counters; fall back to 32-bit.
      const [oper, hcIn, hcOut, in32, out32, names, descr, speed, inErr, outErr, inDis, outDis] = await Promise.all([
        this.walk(session, IF.operStatus),
        this.walk(session, IF_HC.inOctets),
        this.walk(session, IF_HC.outOctets),
        this.walk(session, IF.inOctets),
        this.walk(session, IF.outOctets),
        this.walk(session, IF_HC.name),
        this.walk(session, IF.descr),
        this.walk(session, IF_HC.speed),
        this.walk(session, IF.inErrors),
        this.walk(session, IF.outErrors),
        this.walk(session, IF_EXTRA.inDiscards),
        this.walk(session, IF_EXTRA.outDiscards),
      ]);

      // Only the ports the operator registered, when they registered any.
      let allowed: Set<string> | null = null;
      try {
        const arr = JSON.parse(nas.monitoredPorts || '[]');
        if (Array.isArray(arr) && arr.length) allowed = new Set(arr.map((s: any) => String(s).toLowerCase()));
      } catch { /* monitor everything */ }

      const now = Date.now();
      const rows: any[] = [];
      let ifUp = 0, ifDown = 0;
      const downInterfaces: string[] = [];

      for (const [ifIndex, status] of oper) {
        const name = String(names.get(ifIndex) ?? descr.get(ifIndex) ?? `if${ifIndex}`);
        if (allowed && !allowed.has(String(ifIndex).toLowerCase()) && !allowed.has(name.toLowerCase())) continue;
        if (Number(status) === IF_OPER_UP) ifUp++; else { ifDown++; downInterfaces.push(name.slice(0, 96)); }

        const use64 = hcIn.has(ifIndex) || hcOut.has(ifIndex);
        const rx = this.big(use64 ? hcIn.get(ifIndex) : in32.get(ifIndex));
        const tx = this.big(use64 ? hcOut.get(ifIndex) : out32.get(ifIndex));
        const key = `${nas.id}:${ifIndex}`;
        const before = this.prev.get(key);
        const spd = this.num(speed.get(ifIndex));

        let rxBps = 0, txBps = 0, inErrRate = 0, outErrRate = 0, inDisRate = 0, outDisRate = 0;
        if (rx == null || tx == null) continue;
        if (before && before.name === name && !rebooted) {
          const secs = Math.max((now - before.at) / 1000, 1);
          rxBps = this.rate(before.rx, rx, use64, secs);
          txBps = this.rate(before.tx, tx, use64, secs);
          const d = (cur: number | null, prv: number) => (cur == null || cur < prv ? 0 : (cur - prv) / secs);
          inErrRate = d(this.num(inErr.get(ifIndex)), before.inErr);
          outErrRate = d(this.num(outErr.get(ifIndex)), before.outErr);
          inDisRate = d(this.num(inDis.get(ifIndex)), before.inDis);
          outDisRate = d(this.num(outDis.get(ifIndex)), before.outDis);

          // Sanity: a rate above the port's line speed is a bad read, not traffic.
          if (spd && spd > 0) {
            const capBps = spd * 1_000_000 * 1.2;
            if (rxBps > capBps) rxBps = 0;
            if (txBps > capBps) txBps = 0;
          }
        }
        this.prev.set(key, {
          name, rx, tx, at: now,
          inErr: this.num(inErr.get(ifIndex)) ?? 0,
          outErr: this.num(outErr.get(ifIndex)) ?? 0,
          inDis: this.num(inDis.get(ifIndex)) ?? 0,
          outDis: this.num(outDis.get(ifIndex)) ?? 0,
        });

        // First poll, reboot, or changed interface identity has no valid baseline.
        if (!before || before.name !== name || rebooted) continue;

        rows.push({
          nasId: nas.id, ifIndex, name: name.slice(0, 96),
          rxBps: Math.round(rxBps), txBps: Math.round(txBps),
          inErrors: Math.round(inErrRate * 100) / 100,
          outErrors: Math.round(outErrRate * 100) / 100,
          inDiscards: Math.round(inDisRate * 100) / 100,
          outDiscards: Math.round(outDisRate * 100) / 100,
          up: Number(status) === IF_OPER_UP,
          speedMbps: spd && spd > 0 ? Math.round(spd) : null,
        });
      }

      // Persist health + interfaces.
      const metricRows = Object.entries({ ...health, snmpMs })
        .map(([metric, value]) => ({ nasId: nas.id, metric, value: Number(value) }));
      if (metricRows.length) await this.prisma.deviceMetric.createMany({ data: metricRows });
      if (rows.length) await this.prisma.interfaceMetric.createMany({ data: rows });

      if (rebooted) this.log.warn(`${nas.nasname}: uptime went backwards — device rebooted, counter baseline reset.`);
      return {
        ok: true, kind: 'ok',
        sysDescr, uptimeSec: health.uptime ?? sysUptimeSec,
        responseMs: snmpMs,
        cpu: health.cpu ?? null, memory: health.memory ?? null,
        interfacesUp: ifUp, interfacesDown: ifDown, interfaces: ifUp + ifDown,
        downInterfaces,
        rebooted,
      };
    } catch (e: any) {
      return { ok: false, ...this.classifyError(e) };
    } finally {
      try { session?.close(); } catch { /* already closed */ }
    }
  }

  /**
   * A reachability probe that SURFACES the error (unlike get(), which swallows
   * it), so the monitor can tell timeout from auth from config failure.
   */
  private probe(session: any, oids: string[]): Promise<{ ok: boolean; err?: any; values: Map<string, any> }> {
    return new Promise((resolve) => {
      const values = new Map<string, any>();
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const done = (ok: boolean, err?: any) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ ok, err, values });
      };
      try {
        session.get(oids, (err: any, vbs: any[]) => {
          if (err) return done(false, err);
          if (Array.isArray(vbs)) for (const vb of vbs) { if (!this.snmp.isVarbindError(vb)) values.set(String(vb.oid), vb.value); }
          done(values.size > 0, values.size ? undefined : new Error('empty SNMP response'));
        });
      } catch (e) { done(false, e); }
      timer = setTimeout(() => done(false, new Error('probe timed out')), 15_000);
      timer.unref?.();
    });
  }

  /**
   * Map a net-snmp error to a stable kind + a FIXED, operator-friendly message.
   * The message is never built from the raw error text or the credential, so a
   * reason stored on NasSnmpState or shown in the UI can never leak a secret.
   */
  private classifyError(err: any): { kind: SnmpErrorKind; message: string } {
    const sig = `${err?.name || ''} ${String(err?.message || err || '')}`;
    if (/SNMP_ALLOWED_CIDRS|SNMP target|SNMP port|Unsupported SNMP version|SNMP community is not configured/i.test(sig)) {
      return { kind: 'config_error', message: 'SNMP target or configuration is not authorized or incomplete.' };
    }
    if (/TimedOut|timed out|timeout/i.test(sig)) {
      return { kind: 'timeout', message: 'No SNMP reply (timeout). Check the device is reachable, SNMP is enabled, and UDP is open to this server.' };
    }
    if (/Authentication|security|engine|usmStats|RequestFailed|AuthError|not in time window|wrong digest/i.test(sig)) {
      return { kind: 'auth_error', message: 'SNMP authentication failed. Check the community or SNMPv3 username, passphrases and security level.' };
    }
    if (/empty SNMP response/i.test(sig)) {
      return { kind: 'unreachable', message: 'The device did not return the expected SNMP data. Check the SNMP service and view/ACL configuration.' };
    }
    return { kind: 'error', message: 'SNMP poll failed.' };
  }

  /**
   * Counter delta → bits per second, handling wrap.
   *
   * A decreasing counter means it wrapped (or the device reset it). For 32-bit
   * counters we add the wrap point; 64-bit counters realistically never wrap, so
   * a decrease there is a genuine reset and the sample is dropped (0) instead of
   * graphing a false spike.
   */
  private rate(prev: bigint, cur: bigint, use64: boolean, secs: number): number {
    let delta: bigint;
    if (cur >= prev) delta = cur - prev;
    else if (use64) return 0;                         // reset, not a wrap
    else delta = (1n << 32n) - prev + cur;            // 32-bit rollover
    const bits = Number(delta) * 8;
    const bps = bits / secs;
    return Number.isFinite(bps) && bps >= 0 ? bps : 0;
  }
}
