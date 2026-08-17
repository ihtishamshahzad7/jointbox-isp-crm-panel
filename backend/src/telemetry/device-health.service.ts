import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { isPrimaryInstance } from '../common/cluster-util';
import { IF, IF_HC, IF_EXTRA, IF_OPER_UP, healthProfileFor, HealthOid } from './oids';
import { SecretsService } from '../common/secrets.service';
import { decField } from '../nas/nas-credentials';

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
  private busy = false;
  /** Previous counter reading per NAS+ifIndex, for the delta. */
  private prev = new Map<string, { rx: bigint; tx: bigint; inErr: number; outErr: number; inDis: number; outDis: number; at: number }>();
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

  @Cron(CronExpression.EVERY_30_SECONDS)
  async tick() {
    if (!this.snmp || this.busy || !isPrimaryInstance()) return;
    this.busy = true;
    try {
      const list = await this.prisma.nas.findMany({
        where: { snmpEnabled: true, isActive: true },
        select: {
          id: true, nasname: true, nasIp: true, deviceType: true,
          snmpCommunity: true, snmpPort: true, snmpVersion: true, monitoredPorts: true,
          snmpTimeoutMs: true, snmpRetries: true,
        },
      });
      for (const nas of list) {
        await this.collect(nas).catch((e) =>
          this.log.warn(`Health poll failed for ${nas.nasname}: ${e?.message || e}`));
      }
    } finally {
      this.busy = false;
    }
  }

  // ── SNMP plumbing ────────────────────────────────────────────
  private host(nas: any) { return String(nas.nasIp || '').trim(); }

  private session(nas: any) {
    const version = nas.snmpVersion === 'V1' ? this.snmp.Version1 : this.snmp.Version2c;
    // The community is encrypted at rest; decField() also passes legacy
    // plaintext values through unchanged.
    const community = decField(this.secrets, nas.snmpCommunity) || 'public';
    return this.snmp.createSession(this.host(nas), community, {
      port: nas.snmpPort || 161, version,
      timeout: nas.snmpTimeoutMs || 4000, retries: nas.snmpRetries ?? 1,
    });
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
      },
    });
    if (!nas) return { ok: false, error: 'NAS not found.' };
    if (!this.snmp) return { ok: false, error: 'net-snmp is not installed on the server.' };
    if (!this.host(nas)) return { ok: false, error: 'This NAS has no IP address configured.' };

    const started = Date.now();
    const session = this.session(nas);
    try {
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
      return { ok: false, target: `${this.host(nas)}:${nas.snmpPort || 161}`, error: e?.message || 'SNMP test failed.' };
    } finally {
      try { session.close(); } catch { /* already closed */ }
    }
  }

  // ── One device ───────────────────────────────────────────────
  private async collect(nas: any) {
    if (!this.host(nas)) return;
    const session = this.session(nas);
    const startedAt = Date.now();
    try {
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

      for (const [ifIndex, status] of oper) {
        const name = String(names.get(ifIndex) ?? descr.get(ifIndex) ?? `if${ifIndex}`);
        if (allowed && !allowed.has(String(ifIndex).toLowerCase()) && !allowed.has(name.toLowerCase())) continue;

        const use64 = hcIn.has(ifIndex) || hcOut.has(ifIndex);
        const rx = this.big(use64 ? hcIn.get(ifIndex) : in32.get(ifIndex));
        const tx = this.big(use64 ? hcOut.get(ifIndex) : out32.get(ifIndex));
        const key = `${nas.id}:${ifIndex}`;
        const before = this.prev.get(key);
        const spd = this.num(speed.get(ifIndex));

        let rxBps = 0, txBps = 0, inErrRate = 0, outErrRate = 0, inDisRate = 0, outDisRate = 0;
        if (rx != null && tx != null) {
          if (before && !rebooted) {
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
            rx, tx, at: now,
            inErr: this.num(inErr.get(ifIndex)) ?? 0,
            outErr: this.num(outErr.get(ifIndex)) ?? 0,
            inDis: this.num(inDis.get(ifIndex)) ?? 0,
            outDis: this.num(outDis.get(ifIndex)) ?? 0,
          });
        }

        // First poll after a restart has no baseline — record status only.
        if (!before || rebooted) continue;

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
    } finally {
      try { session.close(); } catch { /* already closed */ }
    }
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
