import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { isPrimaryInstance } from '../common/cluster-util';

/**
 * TopologyService — learns and traces the transmission path.
 *
 * THE PROBLEM
 * When a customer says "no internet", the useful question is never "is this
 * customer down" — it is "is it ONLY this customer". One person down on a
 * splitter is a drop cable or an ONU. Sixteen down on the same splitter is the
 * fibre. Every splitter on an OLT is the OLT or its uplink. Same symptom,
 * three completely different responses, and dispatching the wrong one costs a
 * day.
 *
 * HOW THE PATH IS LEARNED
 * If the OLT runs PPPoE Intermediate Agent it stamps a Circuit-ID into the
 * session, which FreeRADIUS stores in radacct.nasportid. That string carries
 * the OLT name, slot, PON port and ONU index — the network describing its own
 * shape. This service parses it, creates the OLT / port / ONU records the
 * first time it sees them, and links the subscriber.
 *
 * HONEST LIMITS
 *  • No intermediate agent on the OLT means no circuit-id, and the path must
 *    be entered by hand. The service degrades to whatever it does know.
 *  • Optical power (Rx/Tx dBm) is NOT in RADIUS. Those fields exist on the ONU
 *    model but stay null until something polls the OLT over SNMP or telnet.
 *    Null means "not measured", which is deliberately distinct from "bad".
 *  • Circuit-ID formats differ per vendor, so parsing is a set of patterns
 *    with a raw fallback rather than one rule.
 */

export type ParsedCircuit = {
  oltName?: string;
  slot?: string;
  port?: string;
  onuIndex?: string;
  vlan?: number;
  portName?: string;
  raw: string;
  matched: boolean;
  vendorGuess?: string;
};

@Injectable()
export class TopologyService {
  private readonly logger = new Logger(TopologyService.name);

  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  /**
   * Parse a Circuit-ID / NAS-Port-Id into path parts.
   *
   * Patterns are ordered most-specific first. Each is a real format seen in
   * the field; the raw string is always kept so an operator can see what the
   * OLT actually said when a parse looks wrong.
   */
  parseCircuitId(raw?: string | null): ParsedCircuit {
    const s = String(raw ?? '').trim();
    const out: ParsedCircuit = { raw: s, matched: false };
    if (!s) return out;

    // Huawei / common GPON: "OLT-NAME 0/1/2:5" or "OLT01 gpon 0/1/2:5"
    let m = /^(\S+)\s+(?:gpon[\s-]*)?(\d+)\/(\d+)\/(\d+)[:\/](\d+)/i.exec(s);
    if (m) {
      return {
        raw: s, matched: true, vendorGuess: 'huawei',
        oltName: m[1], slot: m[2], port: `${m[3]}/${m[4]}`, onuIndex: m[5],
        portName: `${m[2]}/${m[3]}/${m[4]}`,
      };
    }

    // ZTE: "gpon-onu_1/2/3:4"
    m = /^gpon-onu[_\-](\d+)\/(\d+)\/(\d+)[:\/](\d+)/i.exec(s);
    if (m) {
      return {
        raw: s, matched: true, vendorGuess: 'zte',
        slot: m[1], port: `${m[2]}/${m[3]}`, onuIndex: m[4],
        portName: `${m[1]}/${m[2]}/${m[3]}`,
      };
    }

    // BDCOM / VSOL: "EPON0/1:12" or "epon 0/1:12"
    m = /^e?pon\s*(\d+)\/(\d+)[:\/](\d+)/i.exec(s);
    if (m) {
      return {
        raw: s, matched: true, vendorGuess: 'bdcom',
        slot: m[1], port: m[2], onuIndex: m[3], portName: `${m[1]}/${m[2]}`,
      };
    }

    // DSL-Forum style: "OLT-NAME eth 1/2/3:100.200" — trailing pair is VLAN.
    m = /^(\S+)\s+eth\s+(\d+)\/(\d+)\/(\d+)(?::(\d+))?/i.exec(s);
    if (m) {
      return {
        raw: s, matched: true, vendorGuess: 'dslforum',
        oltName: m[1], slot: m[2], port: `${m[3]}/${m[4]}`,
        vlan: m[5] ? Number(m[5]) : undefined,
        portName: `${m[2]}/${m[3]}/${m[4]}`,
      };
    }

    // Slash-separated fallback: "1/2/3" — enough to group by port even when
    // the OLT name is absent.
    m = /^(\d+)\/(\d+)\/(\d+)$/.exec(s);
    if (m) {
      return {
        raw: s, matched: true, vendorGuess: 'generic',
        slot: m[1], port: `${m[2]}/${m[3]}`, portName: s,
      };
    }

    // Bare VLAN — no path information, but still worth recording.
    m = /vlan[^0-9]*(\d{1,4})/i.exec(s);
    if (m) return { raw: s, matched: false, vlan: Number(m[1]) };

    return out;
  }

  /**
   * Learn topology from live and recent sessions.
   *
   * Runs on a cycle rather than on demand because the path is only visible
   * while a session exists — a customer who dialled in at 3am and dropped
   * still told us where they are, and that is worth keeping.
   */
  @Cron('0 */10 * * * *')
  async learnFromSessions() {
    // CLUSTER GUARD — background work must run on ONE process only.
    // Without this the cron fired on every pm2 instance (11 web + 1 worker
    // = 12 concurrent runs of the same job), which duplicated side effects
    // and flooded the logs with identical rows.
    if (!isPrimaryInstance()) return;
    if (process.env.TOPOLOGY_AUTODETECT === 'false') return;
    try {
      // Latest session per user carrying a port id, over the last week.
      const rows = await this.prisma.$queryRaw<any[]>`
        SELECT DISTINCT ON (username)
                username,
                COALESCE(nasportid,'') AS nasportid,
                nasipaddress::text     AS nasip,
                callingstationid
           FROM radacct
          WHERE username IS NOT NULL
            AND nasportid IS NOT NULL AND nasportid <> ''
            AND acctstarttime > NOW() - INTERVAL '7 days'
          ORDER BY username, acctstarttime DESC`
      .catch(() => [] as any[]);

      if (!rows.length) return;

      const subs = await this.prisma.subscriber.findMany({
        where: { username: { in: rows.map((r) => r.username) } },
        select: { id: true, username: true, areaId: true, nasId: true },
      });
      const byName = new Map(subs.map((s) => [s.username, s]));

      let learnedOlts = 0, learnedPorts = 0, learnedOnus = 0;

      for (const r of rows) {
        const sub = byName.get(r.username);
        if (!sub) continue;

        const p = this.parseCircuitId(r.nasportid);
        if (!p.matched || !p.portName) continue;

        // OLT name is not always in the circuit-id. Falling back to the BRAS
        // keeps ports grouped under something real rather than inventing one.
        const oltName = p.oltName || `OLT via ${r.nasip?.split('/')[0] ?? 'unknown'}`;

        const olt = await this.prisma.olt.upsert({
          where: { name: oltName },
          update: {},
          create: {
            name: oltName,
            vendor: p.vendorGuess,
            nasId: sub.nasId ?? null,
            areaId: sub.areaId ?? null,
            autoDetected: true,
          },
        });
        if (olt.createdAt.getTime() > Date.now() - 60_000) learnedOlts++;

        const port = await this.prisma.ponPort.upsert({
          where: { oltId_portName: { oltId: olt.id, portName: p.portName } },
          update: {},
          create: {
            oltId: olt.id, portName: p.portName,
            slot: p.slot ?? null, port: p.port ?? null, autoDetected: true,
          },
        });
        if (port.createdAt.getTime() > Date.now() - 60_000) learnedPorts++;

        const existing = await this.prisma.onu.findUnique({ where: { subscriberId: sub.id } });
        if (existing) {
          // A changed circuit-id means the customer physically moved — a new
          // ONU, a re-patch, or a splitter change. Follow it rather than
          // leaving the record pointing at where they used to be.
          if (existing.circuitId !== p.raw) {
            await this.prisma.onu.update({
              where: { id: existing.id },
              data: {
                oltId: olt.id, ponPortId: port.id,
                onuIndex: p.onuIndex ?? null, circuitId: p.raw,
                macAddress: r.callingstationid ?? existing.macAddress,
              },
            });
            this.logger.log(`${r.username} moved: ${existing.circuitId ?? 'unknown'} → ${p.raw}`);
          }
        } else {
          await this.prisma.onu.create({
            data: {
              oltId: olt.id, ponPortId: port.id,
              onuIndex: p.onuIndex ?? null, circuitId: p.raw,
              macAddress: r.callingstationid ?? null,
              subscriberId: sub.id, autoDetected: true,
            },
          });
          learnedOnus++;
        }
      }

      if (learnedOlts || learnedPorts || learnedOnus) {
        this.logger.log(
          `Topology learned: ${learnedOlts} OLT(s), ${learnedPorts} PON port(s), ${learnedOnus} ONU(s)`,
        );
      }
    } catch (e: any) {
      this.logger.warn(`Topology learning failed: ${e?.message || e}`);
    }
  }

  /** Usernames with a live session right now. */
  private async onlineSet(): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT DISTINCT username FROM radacct WHERE acctstoptime IS NULL AND username IS NOT NULL
        AND COALESCE(acctupdatetime, acctstarttime) > NOW() - INTERVAL '15 minutes'`
    .catch(() => [] as any[]);
    return new Set(rows.map((r) => r.username));
  }

  /**
   * Trace one subscriber's full path with health at every hop.
   *
   * The verdict is the point: it names the most likely fault location by
   * comparing how much of each hop is down, so nobody has to infer it.
   */
  async traceSubscriber(subscriberId: number, actor?: Actor) {
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      include: {
        area: { select: { id: true, name: true, city: true } },
        nas: { select: { id: true, nasname: true, nasIp: true } },
        serviceSettings: { select: { vlanId: true } },
        onu: { include: { olt: { include: { nas: true, area: true } }, ponPort: true } },
      },
    });
    if (!sub) return null;

    const online = await this.onlineSet();
    const isUp = !!(sub.username && online.has(sub.username));

    const onu = sub.onu;
    const port = onu?.ponPort;
    const olt = onu?.olt;

    // Peers at each level — the comparison that turns a symptom into a cause.
    const [portPeers, oltPeers, nasPeers] = await Promise.all([
      port ? this.prisma.onu.findMany({
        where: { ponPortId: port.id, subscriberId: { not: null } },
        include: { subscriber: { select: { id: true, username: true, fullName: true, status: true } } },
      }) : Promise.resolve([]),
      olt ? this.prisma.onu.findMany({
        where: { oltId: olt.id, subscriberId: { not: null } },
        include: { subscriber: { select: { username: true, status: true } } },
      }) : Promise.resolve([]),
      sub.nasId ? this.prisma.subscriber.findMany({
        where: { nasId: sub.nasId, status: 'ACTIVE' },
        select: { username: true },
      }) : Promise.resolve([]),
    ]);

    const tally = (list: Array<{ username?: string | null; status?: string }>) => {
      const active = list.filter((x) => !x.status || x.status === 'ACTIVE');
      const up = active.filter((x) => x.username && online.has(x.username)).length;
      return { total: active.length, up, down: active.length - up,
        upPercent: active.length ? Math.round((up / active.length) * 100) : null };
    };

    const portHealth = tally(portPeers.map((o) => o.subscriber!).filter(Boolean));
    const oltHealth = tally(oltPeers.map((o) => o.subscriber!).filter(Boolean));
    const nasHealth = tally(nasPeers);

    return {
      subscriber: {
        id: sub.id, name: sub.fullName, username: sub.username,
        status: sub.status, online: isUp,
      },
      path: [
        {
          hop: 'CPE / ONU',
          name: onu?.onuIndex ? `ONU ${onu.onuIndex}` : (onu?.serialNumber || 'Not detected'),
          detail: onu?.circuitId ?? 'No circuit-id reported by the OLT',
          mac: onu?.macAddress ?? null,
          rxPower: onu?.rxPower ?? null,
          txPower: onu?.txPower ?? null,
          known: !!onu,
          online: isUp,
          peers: null,
        },
        {
          hop: 'PON port / splitter',
          name: port ? `Port ${port.portName}` : 'Not detected',
          detail: port?.splitterLocation ?? (port?.splitRatio ? `1:${port.splitRatio} splitter` : 'Location not recorded'),
          known: !!port,
          online: portHealth.up > 0,
          peers: port ? portHealth : null,
        },
        {
          hop: 'OLT',
          name: olt?.name ?? 'Not detected',
          detail: [olt?.vendor, olt?.model, olt?.mgmtIp].filter(Boolean).join(' · ') || 'Details not recorded',
          known: !!olt,
          online: oltHealth.up > 0,
          peers: olt ? oltHealth : null,
        },
        {
          hop: 'BRAS / NAS',
          name: sub.nas?.nasname ?? 'Not assigned',
          detail: sub.nas?.nasIp ?? '',
          known: !!sub.nas,
          online: nasHealth.up > 0,
          peers: sub.nasId ? nasHealth : null,
        },
      ],
      context: {
        area: sub.area?.name ?? null,
        city: sub.area?.city ?? null,
        vlan: sub.serviceSettings?.vlanId ?? null,
        autoDetected: onu?.autoDetected ?? false,
      },
      verdict: this.verdict(isUp, portHealth, oltHealth, nasHealth, !!onu),
    };
  }

  /**
   * Name the most likely fault location.
   *
   * Read from the top of the network downwards: the widest failure wins,
   * because a dead OLT also makes every splitter beneath it look dead, and
   * dispatching a technician to a customer's house in that case wastes a day.
   */
  private verdict(
    subscriberUp: boolean,
    port: { total: number; up: number; down: number; upPercent: number | null },
    olt: { total: number; up: number; down: number; upPercent: number | null },
    nas: { total: number; up: number; down: number; upPercent: number | null },
    haveTopology: boolean,
  ) {
    if (subscriberUp) {
      return {
        level: 'ok', title: 'Connection is up',
        detail: 'This subscriber has a live session. Any complaint is likely speed or Wi-Fi rather than link.',
        action: 'Check the data allowance and the customer’s own router before dispatching anyone.',
      };
    }

    if (!haveTopology) {
      return {
        level: 'unknown', title: 'Offline — transmission path not known',
        detail: 'No circuit-id has been seen for this subscriber, so the ONU, splitter and OLT cannot be identified.',
        action: 'Enable PPPoE Intermediate Agent on the OLT so it stamps a circuit-id, or record the path manually on this subscriber.',
      };
    }

    if (nas.total >= 5 && nas.upPercent !== null && nas.upPercent < 20) {
      return {
        level: 'critical', title: 'The BRAS is down',
        detail: `Only ${nas.up} of ${nas.total} customers on this router are online. This is not a customer fault.`,
        action: 'Check the router and its upstream link. Do not dispatch to customers.',
      };
    }

    if (olt.total >= 4 && olt.upPercent !== null && olt.upPercent < 25) {
      return {
        level: 'critical', title: 'The OLT or its uplink is down',
        detail: `Only ${olt.up} of ${olt.total} customers on this OLT are online, across multiple PON ports.`,
        action: 'Check OLT power, its uplink fibre and the switch it feeds into. A site visit to one customer will find nothing.',
      };
    }

    if (port.total >= 3 && port.upPercent !== null && port.upPercent < 34) {
      return {
        level: 'critical', title: 'The PON port or splitter is down',
        detail: `${port.down} of ${port.total} customers on this splitter are offline. A shared fault, not this customer's equipment.`,
        action: 'Check the feeder fibre and the splitter. One truck roll fixes everyone on this port.',
      };
    }

    if (port.total >= 3 && port.down > 1) {
      return {
        level: 'warning', title: 'Several customers down on the same splitter',
        detail: `${port.down} of ${port.total} on this PON port are offline — more than chance, less than a full break.`,
        action: 'Inspect the splitter and drop cables before treating these as separate faults.',
      };
    }

    return {
      level: 'warning', title: 'Only this customer is down',
      detail: port.total > 1
        ? `Everyone else on this splitter (${port.up} of ${port.total}) is online, so the shared path is healthy.`
        : 'No peers on this splitter to compare against, but nothing upstream looks wrong.',
      action: 'Fault is at the customer end — drop cable, ONU power, or a fibre bend. Dispatch to the premises.',
    };
  }

  /** Everything currently broken, grouped by where the fault actually sits. */
  async faults(actor?: Actor) {
    const online = await this.onlineSet();

    const ports = await this.prisma.ponPort.findMany({
      where: { isActive: true },
      include: {
        olt: { select: { id: true, name: true, area: { select: { name: true } } } },
        onus: {
          where: { subscriberId: { not: null } },
          include: { subscriber: { select: { id: true, username: true, fullName: true, phone: true, status: true, userId: true } } },
        },
      },
    });

    const allowed = actor && !this.scope.isAdmin(actor.role)
      ? new Set(await this.scope.descendantIds(await this.scope.rootId(actor)))
      : null;

    const out: any[] = [];
    for (const p of ports) {
      const subs = p.onus
        .map((o) => o.subscriber!)
        .filter((s) => s && s.status === 'ACTIVE')
        .filter((s) => !allowed || (s.userId != null && allowed.has(s.userId)));
      if (subs.length < 2) continue; // a single customer is not a shared fault

      const down = subs.filter((s) => !s.username || !online.has(s.username));
      const pct = Math.round((down.length / subs.length) * 100);
      if (pct < 50) continue;

      out.push({
        ponPortId: p.id,
        portName: p.portName,
        olt: p.olt?.name,
        area: p.olt?.area?.name ?? null,
        splitterLocation: p.splitterLocation,
        total: subs.length,
        down: down.length,
        downPercent: pct,
        severity: pct === 100 ? 'critical' : 'warning',
        affected: down.slice(0, 20).map((s) => ({
          id: s.id, name: s.fullName, username: s.username, phone: s.phone,
        })),
      });
    }

    return out.sort((a, b) => b.downPercent - a.downPercent || b.down - a.down);
  }

  /**
   * The whole tree, for the topology screen.
   *
   * SECURITY: this method previously accepted `actor` and then ignored it,
   * which meant any dealer could read the ISP's entire fibre plant — every
   * OLT, every splitter, and the customer counts on them, including other
   * dealers' customers. Counts are now built only from subscribers inside the
   * caller's own subtree, and OLTs with nothing of theirs on them drop out.
   */
  async tree(actor?: Actor) {
    const online = await this.onlineSet();
    const allowed = actor && !this.scope.isAdmin(actor.role)
      ? new Set(await this.scope.descendantIds(await this.scope.rootId(actor)))
      : null;

    const olts = await this.prisma.olt.findMany({
      include: {
        nas: { select: { id: true, nasname: true } },
        area: { select: { id: true, name: true } },
        ports: {
          include: {
            onus: {
              where: { subscriberId: { not: null } },
              include: {
                subscriber: {
                  select: { id: true, username: true, fullName: true, status: true, userId: true },
                },
              },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const visible = olts.map((o) => {
      const ports = o.ports.map((p) => {
        const subs = p.onus
          .map((x) => x.subscriber!)
          .filter((s) => s?.status === 'ACTIVE')
          .filter((s) => !allowed || (s.userId != null && allowed.has(s.userId)));
        const up = subs.filter((s) => s.username && online.has(s.username)).length;
        return {
          id: p.id, portName: p.portName, splitRatio: p.splitRatio,
          splitterLocation: p.splitterLocation, autoDetected: p.autoDetected,
          total: subs.length, up, down: subs.length - up,
          upPercent: subs.length ? Math.round((up / subs.length) * 100) : null,
        };
      });
      const total = ports.reduce((s, p) => s + p.total, 0);
      const up = ports.reduce((s, p) => s + p.up, 0);
      return {
        id: o.id, name: o.name, vendor: o.vendor, model: o.model,
        // Management IP is infrastructure detail and stays ISP-only. A dealer
        // has no reason to know how to reach the OLT.
        mgmtIp: allowed ? null : o.mgmtIp,
        nas: o.nas?.nasname ?? null, area: o.area?.name ?? null,
        autoDetected: o.autoDetected,
        total, up, down: total - up,
        upPercent: total ? Math.round((up / total) * 100) : null,
        // Ports with nothing of the caller's on them are noise to them, and
        // leak how many customers a sibling dealer has on that splitter.
        ports: ports
          .filter((p) => !allowed || p.total > 0)
          .sort((a, b) => a.portName.localeCompare(b.portName)),
      };
    });

    // An OLT carrying none of the caller's customers is not theirs to see.
    return allowed ? visible.filter((o) => o.total > 0) : visible;
  }
}
