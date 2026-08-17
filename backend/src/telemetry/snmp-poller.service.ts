import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { isPrimaryInstance } from '../common/cluster-util';
import { LinkAggregatorService } from './link-aggregator.service';
import { IF, IF_OPER_UP, ONT_RX_POWER, signalStatus } from './oids';
import { SecretsService } from '../common/secrets.service';
import { decField } from '../nas/nas-credentials';

/**
 * SNMP poller — the "works on ANY device" collector.
 *
 * Every `snmpPollSec` (per NAS, default 30s) it reads the standard interface
 * table (up/down, errors, traffic) from each SNMP-ENABLED NAS, and for OLTs it
 * additionally walks the vendor ONT Rx-power OID. Everything it learns is handed
 * to the aggregator, which decides what is an alert.
 *
 * Optional per NAS: a device with `snmpEnabled = false` is never contacted.
 * The whole poller is a no-op if the `net-snmp` package isn't installed, so the
 * app still boots on a server that hasn't run `npm install` for it yet.
 */
@Injectable()
export class SnmpPollerService {
  private readonly log = new Logger('SnmpPoller');
  private snmp: any = null;
  private busy = false;
  /** last poll time per NAS id, to honour each NAS's own interval */
  private lastPoll = new Map<number, number>();
  /** previous ifInErrors per NAS+ifIndex, to derive errors-per-minute */
  private prevErrors = new Map<string, { errors: number; at: number }>();

  constructor(
    private prisma: PrismaService,
    private aggregator: LinkAggregatorService,
    private secrets: SecretsService,
  ) {
    try {
      // Lazy require so a missing optional dep can't crash startup.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.snmp = require('net-snmp');
    } catch {
      this.log.warn('net-snmp not installed — SNMP polling disabled. Run `npm install` in backend/.');
    }
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async tick() {
    if (!this.snmp || this.busy || !isPrimaryInstance()) return;
    this.busy = true;
    try {
      const list = await this.prisma.nas.findMany({
        where: { snmpEnabled: true, isActive: true },
        select: {
          id: true, nasname: true, nasIp: true, snmpPort: true, snmpCommunity: true,
          snmpVersion: true, snmpPollSec: true, deviceType: true, monitoredPorts: true,
        },
      });
      const now = Date.now();
      for (const nas of list) {
        const due = (this.lastPoll.get(nas.id) || 0) + (nas.snmpPollSec || 30) * 1000;
        if (now < due) continue;
        this.lastPoll.set(nas.id, now);
        await this.pollNas(nas).catch((e) =>
          this.log.debug(`SNMP poll failed for ${nas.nasname}: ${e?.message || e}`),
        );
      }
    } finally {
      this.busy = false;
    }
  }

  private host(nas: any): string | null {
    return nas.nasIp || (nas.nasname && /^\d+\.\d+\.\d+\.\d+$/.test(nas.nasname) ? nas.nasname : null);
  }

  /**
   * One-off SNMP walk to list a NAS's interfaces (name + ifIndex + up/down), so
   * the operator can pick which ports to register for monitoring instead of
   * typing names by hand.
   */
  async discoverInterfaces(nasId: number): Promise<{ ok: boolean; interfaces: Array<{ ifIndex: number; name: string; up: boolean }>; error?: string }> {
    const nas = await this.prisma.nas.findUnique({
      where: { id: nasId },
      select: { nasname: true, nasIp: true, snmpPort: true, snmpCommunity: true, snmpVersion: true },
    });
    if (!nas || !this.host(nas)) return { ok: false, interfaces: [], error: 'NAS has no IP address.' };
    const session = this.session(nas);
    try {
      const [descr, oper] = await Promise.all([this.walk(session, IF.descr), this.walk(session, IF.operStatus)]);
      if (descr.size === 0 && oper.size === 0) {
        return { ok: false, interfaces: [], error: 'No SNMP response — check SNMP is enabled, the community string, and reachability on UDP/161.' };
      }
      const interfaces = [...descr.entries()].map(([ifIndex, d]) => ({
        ifIndex,
        name: d?.toString?.() || `if${ifIndex}`,
        up: Number(oper.get(ifIndex)) === IF_OPER_UP,
      })).sort((a, b) => a.ifIndex - b.ifIndex);
      return { ok: true, interfaces };
    } catch (e: any) {
      return { ok: false, interfaces: [], error: e?.message || 'SNMP walk failed.' };
    } finally {
      try { session.close(); } catch { /* ignore */ }
    }
  }

  private session(nas: any) {
    const version =
      nas.snmpVersion === 'V1' ? this.snmp.Version1 : this.snmp.Version2c;
    // Community is encrypted at rest (legacy plaintext still passes through).
    return this.snmp.createSession(this.host(nas), decField(this.secrets, nas.snmpCommunity) || 'public', {
      port: nas.snmpPort || 161,
      version,
      retries: 1,
      timeout: 4000,
    });
  }

  /** Promise wrapper around net-snmp subtree (walk of one OID base). */
  private walk(session: any, oid: string): Promise<Map<number, any>> {
    return new Promise((resolve) => {
      const out = new Map<number, any>();
      session.subtree(
        oid,
        20,
        (varbinds: any[]) => {
          for (const vb of varbinds) {
            if (this.snmp.isVarbindError(vb)) continue;
            const idx = Number(vb.oid.split('.').pop());
            out.set(idx, vb.value);
          }
        },
        () => resolve(out),
      );
    });
  }

  private async pollNas(nas: any) {
    if (!this.host(nas)) return;
    const session = this.session(nas);
    try {
      const [descr, oper, inErr] = await Promise.all([
        this.walk(session, IF.descr),
        this.walk(session, IF.operStatus),
        this.walk(session, IF.inErrors),
      ]);

      if (oper.size === 0) {
        // No answer at all → device unreachable over SNMP.
        await this.aggregator.onNasUnreachable(nas);
        return;
      }
      await this.aggregator.onNasReachable(nas);

      // Only monitor the interfaces/ports registered on this NAS. When
      // monitoredPorts is set we poll ONLY those (matched by interface name or
      // ifIndex); when empty/null we fall back to monitoring every interface.
      let allowed: Set<string> | null = null;
      if (nas.monitoredPorts) {
        try {
          const list = JSON.parse(nas.monitoredPorts);
          if (Array.isArray(list) && list.length) {
            allowed = new Set(list.map((x: any) => String(x).trim().toLowerCase()));
          }
        } catch { /* not JSON — treat as unset */ }
      }
      const isAllowed = (ifIndex: any, portName: string) =>
        !allowed || allowed.has(String(ifIndex).toLowerCase()) || allowed.has(portName.toLowerCase());

      for (const [ifIndex, status] of oper) {
        const portName = descr.get(ifIndex)?.toString?.() || `if${ifIndex}`;
        if (!isAllowed(ifIndex, portName)) continue; // skip unregistered ports
        const up = Number(status) === IF_OPER_UP;
        await this.aggregator.onInterfaceStatus(nas, ifIndex, portName, up);

        // errors-per-minute
        const errRaw = inErr.get(ifIndex);
        if (errRaw != null) {
          const errors = Number(errRaw);
          const key = `${nas.id}:${ifIndex}`;
          const prev = this.prevErrors.get(key);
          const nowT = Date.now();
          if (prev && errors >= prev.errors) {
            const perMin = ((errors - prev.errors) / Math.max(1, (nowT - prev.at) / 60000));
            await this.aggregator.onPortErrors(nas, ifIndex, portName, perMin);
          }
          this.prevErrors.set(key, { errors, at: nowT });
        }
      }

      // OLT ONT optical Rx power (vendor-specific; skipped if unknown/empty).
      const ont = ONT_RX_POWER[nas.deviceType];
      if (ont) {
        const rx = await this.walk(session, ont.oid);
        for (const [ifIndex, raw] of rx) {
          const dbm = Number(raw) * ont.scale;
          if (!isFinite(dbm) || dbm === 0) continue;
          await this.aggregator.onSignal(nas, {
            kind: 'ONT_RX',
            ifIndex,
            port: `ont${ifIndex}`,
            dbm,
            status: signalStatus(dbm),
          });
        }
      }
    } finally {
      try { session.close(); } catch { /* ignore */ }
    }
  }
}
