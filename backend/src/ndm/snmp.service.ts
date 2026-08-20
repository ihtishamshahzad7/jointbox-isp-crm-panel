import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../common/secrets.service';
import { decField } from '../nas/nas-credentials';
import { NDM_IF, NDM_IF_OPER, NDM_CRC_OIDS, duplexName, classifyInterface, defaultMonitored } from './ndm.constants';

/**
 * SNMP service — the low-level, protocol-facing layer for switch/router
 * monitoring. Sessions come from net-snmp (mature, maintained); we add the
 * credential decryption, timeouts, retries and the promise wrappers so the
 * polling and syslog services never touch the socket layer themselves.
 *
 * Every method is crash-safe: a dead device, wrong community or slow reply
 * resolves with an error string instead of throwing, so callers can degrade
 * gracefully (mark the device down, keep the last data).
 */
@Injectable()
export class NdmSnmpService {
  private readonly log = new Logger('NdmSnmp');
  private snmp: any = null;

  constructor(private prisma: PrismaService, private secrets: SecretsService) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.snmp = require('net-snmp');
    } catch {
      this.log.warn('net-snmp not installed — switches cannot be polled. Run `npm install` in backend/.');
    }
  }

  get available(): boolean {
    return !!this.snmp;
  }

  // ── Credentials ────────────────────────────────────────────────
  /** Decrypt this device's SNMP credential row (never leaves the server). */
  async creds(deviceId: number) {
    if (typeof deviceId !== 'number' || deviceId <= 0) return null;
    const row = await this.prisma.snmpConfiguration.findUnique({ where: { deviceId } });
    if (!row) return null;
    return {
      community: row.communityEnc ? decField(this.secrets, row.communityEnc) : null,
      v3Username: row.v3Username || null,
      v3AuthProto: row.v3AuthProto || null,
      v3AuthKey: row.v3AuthKeyEnc ? decField(this.secrets, row.v3AuthKeyEnc) : null,
      v3PrivProto: row.v3PrivProto || null,
      v3PrivKey: row.v3PrivKeyEnc ? decField(this.secrets, row.v3PrivKeyEnc) : null,
    };
  }

  /** One-shot session for a device (v2c or v3). Call close() afterwards. */
  async sessionFor(device: { id: number; ip: string; snmpVersion: string; snmpPort: number; snmpTimeoutMs?: number; snmpRetries?: number; _creds?: any; vendor?: string }) {
    // Pre-save test/discover bodies carry their own staged credentials.
    const c = device._creds && (device._creds.community || device._creds.v3AuthKey || device._creds.v3PrivKey)
      ? device._creds
      : await this.creds(device.id);
    const timeout = device.snmpTimeoutMs || 5000;
    const retries = device.snmpRetries ?? 1;

    if (String(device.snmpVersion || 'V2C').toUpperCase() === 'V3' && this.snmp) {
      const level = c?.v3AuthKey
        ? (c.v3PrivKey ? this.snmp.SecurityLevel.authPriv : this.snmp.SecurityLevel.authNoPriv)
        : this.snmp.SecurityLevel.noAuthNoPriv;
      return this.snmp.createV3Session(device.ip, {
        name: c?.v3Username || 'snmp',
        level,
        authProtocol: c?.v3AuthProto === 'MD5' ? this.snmp.AuthProtocols.md5 : this.snmp.AuthProtocols.sha,
        authKey: c?.v3AuthKey || '',
        privProtocol: c?.v3PrivProto === 'DES' ? this.snmp.PrivProtocols.des : this.snmp.PrivProtocols.aes,
        privKey: c?.v3PrivKey || '',
      }, { port: device.snmpPort || 161, timeout, retries });
    }
    return this.snmp.createSession(device.ip, c?.community || 'public', {
      port: device.snmpPort || 161,
      version: this.snmp.Version2c,
      timeout,
      retries,
    });
  }

  // ── Promise wrappers (the net-snmp API is callback based) ──────
  /** Walk one OID base → Map(trailing index → raw value). Never hangs. */
  walk(session: any, oid: string, maxReps = 20): Promise<Map<number, any>> {
    return new Promise((resolve) => {
      const out = new Map<number, any>();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(out); } };
      try {
        session.subtree(oid, maxReps, (varbinds: any[]) => {
          for (const vb of varbinds) {
            if (this.snmp.isVarbindError(vb)) continue;
            const idx = Number(String(vb.oid).split('.').pop());
            out.set(idx, vb.value);
          }
        }, finish);
      } catch { finish(); }
      setTimeout(finish, 15_000); // absolute cap — never block the poll cycle
    });
  }

  /** Read scalar OIDs in a single request → Map(oid → value). Never hangs. */
  get(session: any, oids: string[]): Promise<Map<string, any>> {
    return new Promise((resolve) => {
      const out = new Map<string, any>();
      if (!this.snmp || !oids.length) return resolve(out);
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(out); } };
      try {
        session.get(oids, (err: any, vbs: any[]) => {
          if (!err && Array.isArray(vbs)) {
            for (const vb of vbs) {
              if (this.snmp.isVarbindError(vb)) continue;
              out.set(String(vb.oid), vb.value);
            }
          }
          finish();
        });
      } catch { finish(); }
      setTimeout(finish, 15_000);
    });
  }

  // ── Value coercion ─────────────────────────────────────────────
  num(v: any): number | null {
    if (v == null) return null;
    let n: number;
    try {
      if (typeof v === 'bigint') n = Number(v);
      else if (Buffer.isBuffer(v)) n = Number(v.toString('ascii').trim()) || Number(v.toString('ascii'));
      else n = Number(String(v).trim());
    } catch { return null; }
    return Number.isFinite(n) ? n : null;
  }
  big(v: any): bigint | null {
    if (v == null) return null;
    try {
      if (typeof v === 'bigint') return v;
      if (typeof v === 'number') return BigInt(Math.trunc(v));
      return BigInt(Math.trunc(Number(String(v).trim())));
    } catch { return null; }
  }
  str(v: any): string {
    if (v == null) return '';
    if (Buffer.isBuffer(v)) return v.toString('utf8').replace(/^\s+|\s+$/g, '');
    return String(v);
  }
  mac(v: any): string | null {
    if (Buffer.isBuffer(v)) {
      if (v.length === 6) return [...v].map((b) => b.toString(16).padStart(2, '0')).join(':');
      return v.toString('hex').replace(/(.{2})(?=.)/g, '$1:').toUpperCase();
    }
    const s = this.str(v);
    return /^([0-9a-fA-F]{12}|([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})$/.test(s) ? s.toUpperCase() : null;
  }

  // ── High-level operations ──────────────────────────────────────
  /**
   * Confirm SNMP really works on this device (the "Test SNMP" button).
   * Reads system identity + interface count, or returns exactly why it failed.
   */
  async test(device: { id: number; ip: string; snmpVersion: string; snmpPort: number; snmpTimeoutMs?: number; snmpRetries?: number; name?: string; _creds?: any }) {
    if (!this.snmp) return { ok: false, error: 'net-snmp is not installed on the server.' };
    const session = await this.sessionFor(device);
    try {
      const [scalars, oper] = await Promise.all([
        this.get(session, [NDM_IF.sysDescr, NDM_IF.sysName, NDM_IF.sysUpTime]),
        this.walk(session, NDM_IF.operStatus),
      ]);
      const descr = this.str(scalars.get(NDM_IF.sysDescr));
      const name = this.str(scalars.get(NDM_IF.sysName));
      const up = this.num(scalars.get(NDM_IF.sysUpTime));
      const ifCount = oper.size;
      if (ifCount === 0 && !descr && !name) {
        return { ok: false, error: `No SNMP response from ${device.ip}. Check the community/v3 credentials, that SNMP is enabled on the device, and connectivity on UDP/${device.snmpPort || 161}.` };
      }
      return { ok: true, sysDescr: descr || null, sysName: name || null, uptimeTicks: up, interfaceCount: ifCount, port: device.snmpPort || 161 };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'SNMP test failed.' };
    } finally {
      try { session.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Full interface discovery — walks the complete IF-MIB table (names, alias,
   * status, speed, counters). Used both for the "Discover interfaces" step and
   * by the poller for the first seed of a device.
   */
  async readInterfaceTable(device: { id: number; ip: string; snmpVersion: string; snmpPort: number; snmpTimeoutMs?: number; snmpRetries?: number; vendor?: string; _creds?: any }) {
    const t0 = Date.now();
    this.log.log(`[SNMP DISCOVERY] Starting device=${device.ip} version=${device.snmpVersion} port=${device.snmpPort || 161}`);
    const session = await this.sessionFor(device);
    try {
      const reads = [
        this.get(session, [NDM_IF.sysDescr, NDM_IF.sysName, NDM_IF.sysUpTime]),
        this.walk(session, NDM_IF.descr),
        this.walk(session, NDM_IF.ifType),
        this.walk(session, NDM_IF.adminStatus),
        this.walk(session, NDM_IF.operStatus),
        this.walk(session, NDM_IF.lastChange),
        this.walk(session, NDM_IF.inOctets),
        this.walk(session, NDM_IF.outOctets),
        this.walk(session, NDM_IF.inUcastPkts),
        this.walk(session, NDM_IF.outUcastPkts),
        this.walk(session, NDM_IF.inErrors),
        this.walk(session, NDM_IF.outErrors),
        this.walk(session, NDM_IF.inDiscards),
        this.walk(session, NDM_IF.outDiscards),
        this.walk(session, NDM_IF.hcName),
        this.walk(session, NDM_IF.hcInOctets),
        this.walk(session, NDM_IF.hcOutOctets),
        this.walk(session, NDM_IF.hcInUcastPkts),
        this.walk(session, NDM_IF.hcOutUcastPkts),
        this.walk(session, NDM_IF.hcSpeed),
        this.walk(session, NDM_IF.alias),
        this.walk(session, NDM_IF.physAddress),
        this.walk(session, NDM_IF.duplex),
        this.crcWalk(device.vendor as any, session),
      ];
      const [sys, descr, ifType, admin, oper, lastChange, inOct, outOct, inPkts, outPkts,
             inErr, outErr, inDis, outDis, hcName, hcIn, hcOut, hcInPkts, hcOutPkts,
             speed, alias, mac, duplex, crc] = await Promise.all<any>(reads);

      const idxs = new Set<number>([...oper.keys(), ...hcName.keys(), ...descr.keys()]);
      this.log.log(`[SNMP DISCOVERY] IF-MIB walked oid=1.3.6.1.2.1.2.2 (${idxs.size} interface indexes)`);
      const rows = [...idxs].sort((a, b) => a - b).map((ifIndex) => {
        // Prefer HC counters; fall back to 32-bit when absent.
        const octs = hcIn.has(ifIndex) ? hcIn : inOct;
        const oocts = hcOut.has(ifIndex) ? hcOut : outOct;
        const ipkts = hcInPkts.has(ifIndex) ? hcInPkts : inPkts;
        const opkts = hcOutPkts.has(ifIndex) ? hcOutPkts : outPkts;
        return {
          ifIndex,
          name: this.str(hcName.get(ifIndex)) || this.str(descr.get(ifIndex)) || `if${ifIndex}`,
          description: this.str(alias.get(ifIndex)) || null,
          // Classification: what IS this interface + should it be monitored?
          // PPPoE/dynamic links are discovered but excluded by default.
          ifType: this.num(ifType.get(ifIndex)),
          interfaceCategory: classifyInterface(this.num(ifType.get(ifIndex)), this.str(hcName.get(ifIndex)) || this.str(descr.get(ifIndex))),
          monitoringEnabled: defaultMonitored(
            classifyInterface(this.num(ifType.get(ifIndex)), this.str(hcName.get(ifIndex)) || this.str(descr.get(ifIndex))),
          ),
          adminStatus: this.num(admin.get(ifIndex)),
          operStatus: this.num(oper.get(ifIndex)),
          ifLastChangeTicks: this.big(lastChange.get(ifIndex)),
          inOctets: this.big(octs.get(ifIndex)),
          outOctets: this.big(oocts.get(ifIndex)),
          inUcastPkts: this.big(ipkts.get(ifIndex)),
          outUcastPkts: this.big(opkts.get(ifIndex)),
          inErrors: this.big(inErr.get(ifIndex)),
          outErrors: this.big(outErr.get(ifIndex)),
          inDiscards: this.big(inDis.get(ifIndex)),
          outDiscards: this.big(outDis.get(ifIndex)),
          crcErrors: crc?.get(ifIndex) != null ? this.big(crc.get(ifIndex)) : null,
          speedMbps: this.num(speed.get(ifIndex)),
          duplex: duplexName(duplex.get(ifIndex)),
          mac: this.mac(mac.get(ifIndex)),
        };
      }).filter((r) => r.operStatus != null || r.name !== `if${r.ifIndex}`);
      this.log.log(`[SNMP DISCOVERY] Completed interfaces=${rows.length} duration=${Date.now() - t0}ms`);
      return {
        ok: true,
        interfaces: rows,
        reachable: true,
        sysDescr: this.str(sys.get(NDM_IF.sysDescr)) || null,
        sysName: this.str(sys.get(NDM_IF.sysName)) || null,
        sysUpTicks: this.big(sys.get(NDM_IF.sysUpTime)),
      };
    } catch (e: any) {
      this.log.warn(`[SNMP DISCOVERY] ERROR device=${device.ip} duration=${Date.now() - t0}ms error=${e?.message || e}`);
      return { ok: false, interfaces: [], reachable: false, error: e?.message || 'SNMP read failed.' };
    } finally {
      try { session.close(); } catch { /* ignore */ }
    }
  }

  /** CRC-error walk is vendor best-effort — absent OIDs must never break polling. */
  private async crcWalk(vendor: string | undefined, session: any): Promise<Map<number, any> | null> {
    const oid = NDM_CRC_OIDS[String(vendor || '').toUpperCase()];
    if (!oid) return null;
    try { return await this.walk(session, oid); } catch { return null; }
  }

  /** True if the operational status means "link is usable". */
  isUp(operStatus: any): boolean {
    return Number(operStatus) === NDM_IF_OPER.UP;
  }
}