import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { SecretsService } from '../common/secrets.service';
import { encField, isMask } from '../nas/nas-credentials';
import { NdmSnmpService } from './snmp.service';
import { NdmAlertEngine } from './alert-engine.service';
import { NdmPortPollingService } from './port-polling.service';
import { NdmSyslogReceiverService } from './syslog-receiver.service';
import { NdmNotificationEngine } from './notification-engine.service';
import { POLL_INTERVALS, EVENT_LABELS } from './ndm.constants';

/**
 * Network device monitoring — the REST-facing business layer. Everything the
 * browser can do to a switch/router (add, test SNMP, edit, check now, rules,
 * alerts, feeds, listener settings) lives here, scoped exactly like the rest
 * of the panel: SUPER_ADMIN sees all, an admin sees their subtree, a child
 * user sees only what they own.
 *
 * Security invariants:
 *  • credentials are never returned — the SnmpConfiguration row stores only
 *    encrypted values, and list/get responses carry `hasX` flags instead;
 *  • a "mask" value sent back from the form means "unchanged" — saving can
 *    never overwrite a real secret with bullet characters (isMask);
 *  • every read endpoint filters through deviceScopeWhere(actor).
 */
@Injectable()
export class NdmService {
  private readonly log = new Logger('Ndm');

  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
    private secrets: SecretsService,
    private snmp: NdmSnmpService,
    private alerts: NdmAlertEngine,
    private poller: NdmPortPollingService,
    private receiver: NdmSyslogReceiverService,
    private notify: NdmNotificationEngine,
  ) {}

  // ── Scope ─────────────────────────────────────────────────────
  /** {} for SUPER_ADMIN; { ownerId: { in: subtree } } otherwise. */
  private async deviceScopeWhere(actor?: Actor) {
    if (!actor || this.scope.isAdmin(actor.role)) return {};
    const root = await this.scope.rootId(actor);
    const ids = await this.scope.descendantIds(root);
    return { ownerId: { in: ids.length ? ids : [-1] } };
  }

  private async assertDevice(id: number, actor?: Actor) {
    const d = await this.prisma.networkDevice.findUnique({ where: { id } });
    if (!d) throw new NotFoundException(`Network device ${id} not found`);
    if (actor && !this.scope.isAdmin(actor.role)) {
      const root = await this.scope.rootId(actor);
      const ids = await this.scope.descendantIds(root);
      if (d.ownerId == null || !ids.includes(d.ownerId)) throw new NotFoundException(`Network device ${id} not found`);
    }
    return d;
  }

  private canManageSettings(actor?: Actor) {
    if (!actor || !this.scope.isAdmin(actor.role)) {
      throw new NotFoundException('Not found'); // never leak existence to non-admins
    }
  }

  // ── Devices ───────────────────────────────────────────────────
  async list(actor?: Actor) {
    const where = await this.deviceScopeWhere(actor);
    const rows = await this.prisma.networkDevice.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      include: { _count: { select: { interfaces: true, alerts: { where: { status: 'OPEN' } } } } },
    });
    return rows.map((r) => ({
      id: r.id, name: r.name, ip: r.ip, vendor: r.vendor, deviceType: r.deviceType,
      groupName: r.groupName, location: r.location, enabled: r.enabled, isReachable: r.isReachable,
      uptimeSec: r.uptimeSec, interfaceCount: r.interfaceCount, upPorts: r.upPorts, downPorts: r.downPorts,
      lastSnmpPollAt: r.lastSnmpPollAt, lastSyslogAt: r.lastSyslogAt, lastError: r.lastError,
      openAlerts: r._count?.alerts ?? 0, portCount: r._count?.interfaces ?? 0,
      createdAt: r.createdAt,
    }));
  }

  async getOne(id: number, actor?: Actor) {
    const d = await this.assertDevice(id, actor);
    const creds = await this.prisma.snmpConfiguration.findUnique({ where: { deviceId: id } });
    const ports = await this.prisma.networkInterface.findMany({ where: { deviceId: id }, orderBy: { ifIndex: 'asc' } });
    return {
      ...d,
      credentialStatus: creds ? {
        v2: !!creds.communityEnc, v3: !!creds.v3AuthKeyEnc || !!creds.v3PrivKeyEnc,
        community: creds.hasCommunity, v3Username: creds.v3Username, v3Auth: creds.hasAuthKey, v3Priv: creds.hasPrivKey,
      } : { v2: false, v3: false, community: false, v3Username: null, v3Auth: false, v3Priv: false },
      ports: ports.map((p) => ({
        id: p.id, ifIndex: p.ifIndex, name: p.name, description: p.description,
        adminStatus: p.adminStatus, operStatus: p.operStatus, speedMbps: p.speedMbps, duplex: p.duplex,
        rxRateBps: p.rxRateBps, txRateBps: p.txRateBps, rxPps: p.rxPps, txPps: p.txPps,
        errorRatePerMin: p.errorRatePerMin, mac: p.mac, ifLastChangeTicks: p.ifLastChangeTicks,
        lastStateChangeAt: p.lastStateChangeAt, firstSeen: p.firstSeen, lastSeen: p.lastSeen,
      })),
    };
  }

  /** "Test SNMP" — no persistence, just prove the credentials work. */
  async testDevice(body: NdmTestBody) {
    if (!this.snmp.available) throw new BadRequestException('SNMP is not available on this server.');
    const ip = String(body.ip || '').trim();
    const ver = String(body.snmpVersion || 'V2C').toUpperCase();
    if (!ip) throw new BadRequestException('Device IP is required.');
    if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$|^[a-zA-Z0-9.-]{1,253}$/.test(ip)) {
      throw new BadRequestException('That IP/hostname looks invalid.');
    }
    const result = await this.snmp.test({
      id: -1, ip, snmpVersion: ver, snmpPort: Number(body.snmpPort) || 161,
      snmpTimeoutMs: Number(body.snmpTimeoutMs) || 5000, snmpRetries: Number(body.snmpRetries) ?? 1,
      name: ip,
      // creds go through the same decryption path as a real device
      _creds: {
        community: body.community || '',
        v3Username: body.v3Username || null,
        v3AuthProto: body.v3AuthProto || null,
        v3AuthKey: body.v3AuthKey || null,
        v3PrivProto: body.v3PrivProto || null,
        v3PrivKey: body.v3PrivKey || null,
      },
    });
    return result;
  }

  /** Discover — same session path, returns the interface table (not persisted). */
  async discover(body: NdmTestBody) {
    const ip = String(body.ip || '').trim();
    if (!ip) throw new BadRequestException('Device IP is required.');
    // Hard overall cap (well above the per-walk 15s cap in snmp.service): a
    // misbehaving/bricked agent must never leave the wizard in "Discovering…".
    let timer: NodeJS.Timeout | undefined;
    const res = await Promise.race([
      this.snmp.readInterfaceTable({
        id: -1, ip, snmpVersion: String(body.snmpVersion || 'V2C').toUpperCase(),
        snmpPort: Number(body.snmpPort) || 161,
        snmpTimeoutMs: Number(body.snmpTimeoutMs) || 5000, snmpRetries: Number(body.snmpRetries) ?? 1,
        _creds: {
          community: body.community || '',
          v3Username: body.v3Username || null,
          v3AuthProto: body.v3AuthProto || null,
          v3AuthKey: body.v3AuthKey || null,
          v3PrivProto: body.v3PrivProto || null,
          v3PrivKey: body.v3PrivKey || null,
        },
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({
          ok: false, interfaces: [], reachable: false,
          error: 'SNMP interface discovery timed out after 30 seconds.',
        }), 30_000);
      }),
    ]);
    clearTimeout(timer);
    return res;
  }

  async create(body: NdmCreateBody, actor?: Actor) {
    const ip = String(body.ip || '').trim();
    const name = String(body.name || ip).trim();
    if (!ip) throw new BadRequestException('Device IP is required.');
    if (body.pollIntervalSec && !POLL_INTERVALS.includes(Number(body.pollIntervalSec))) {
      throw new BadRequestException(`Poll interval must be one of ${POLL_INTERVALS.join('/')} seconds.`);
    }
    const ownerId = actor ? this.scope.actorId(actor) : null;
    const device = await this.prisma.networkDevice.create({
      data: {
        ownerId,
        name: name.slice(0, 120), ip,
        vendor: String(body.vendor || 'OTHER').toUpperCase().slice(0, 24),
        deviceType: body.deviceType ? String(body.deviceType).slice(0, 80) : null,
        groupName: body.groupName ? String(body.groupName).slice(0, 80) : null,
        location: body.location ? String(body.location).slice(0, 160) : null,
        description: body.description ? String(body.description).slice(0, 500) : null,
        snmpVersion: String(body.snmpVersion || 'V2C').toUpperCase(),
        snmpPort: Number(body.snmpPort) || 161,
        pollIntervalSec: Number(body.pollIntervalSec) || 30,
        snmpTimeoutMs: Number(body.snmpTimeoutMs) || 5000,
        snmpRetries: Number(body.snmpRetries) ?? 1,
        syslogEnabled: !!body.syslogEnabled,
        syslogProtocol: String(body.syslogProtocol || 'UDP').toUpperCase(),
        syslogPort: Number(body.syslogPort) || 514,
      },
    });

    const cred = this.stagedCreds(body);
    if (cred) {
      await this.prisma.snmpConfiguration.create({ data: { deviceId: device.id, ...cred } });
    }
    // First poll happens on the next sweep; callers can force one via /check.
    return this.getOne(device.id, actor);
  }

  async update(id: number, body: any, actor?: Actor) {
    const d = await this.assertDevice(id, actor);
    const data: any = {};
    for (const f of ['name', 'deviceType', 'groupName', 'location', 'description', 'vendor']) {
      if (body[f] !== undefined) data[f] = String(body[f]).slice(0, f === 'description' ? 500 : f === 'location' ? 160 : 120);
    }
    if (body.ip !== undefined) {
      const ip = String(body.ip).trim();
      if (!ip) throw new BadRequestException('Device IP is required.');
      data.ip = ip;
    }
    if (body.enabled !== undefined) data.enabled = !!body.enabled;
    if (body.snmpVersion !== undefined) data.snmpVersion = String(body.snmpVersion).toUpperCase();
    if (body.snmpPort !== undefined) data.snmpPort = Number(body.snmpPort) || 161;
    if (body.pollIntervalSec !== undefined) {
      const v = Number(body.pollIntervalSec);
      if (!POLL_INTERVALS.includes(v)) throw new BadRequestException(`Poll interval must be one of ${POLL_INTERVALS.join('/')} seconds.`);
      data.pollIntervalSec = v;
    }
    if (body.syslogEnabled !== undefined) data.syslogEnabled = !!body.syslogEnabled;
    if (body.syslogProtocol !== undefined) data.syslogProtocol = String(body.syslogProtocol).toUpperCase();
    if (body.syslogPort !== undefined) data.syslogPort = Number(body.syslogPort) || 514;

    const cred = this.stagedCreds(body);
    if (cred) {
      await this.prisma.snmpConfiguration.upsert({
        where: { deviceId: id }, update: cred, create: { deviceId: id, ...cred },
      });
    }
    await this.prisma.networkDevice.update({ where: { id }, data });
    // Force the next sweep to pick the change up immediately.
    await this.poller.checkNow(id);
    return this.getOne(id, actor);
  }

  /** Soft-disable (reversible): keeps all history, stops polling + alerts. */
  async remove(id: number, actor?: Actor) {
    const d = await this.assertDevice(id, actor);
    await this.prisma.networkDevice.update({ where: { id }, data: { enabled: false } });
    this.log.log(`Device disabled (soft-delete): ${d.name} (${id})`);
    return { ok: true, id, disabled: true };
  }

  async checkNow(id: number, actor?: Actor) {
    await this.assertDevice(id, actor);
    return this.poller.checkNow(id);
  }

  /** Live rescan of an existing device — persists the interface table (the
   *  normal poll does the same; this is the explicit "Scan now" button). */
  async discoverDevice(id: number, _body: any, actor?: Actor) {
    const d = await this.assertDevice(id, actor);
    const res = await this.snmp.readInterfaceTable(d);
    if (res.reachable && res.interfaces.length) {
      const now = new Date();
      for (const row of res.interfaces) {
        await this.prisma.networkInterface.upsert({
          where: { deviceId_ifIndex: { deviceId: id, ifIndex: row.ifIndex } },
          update: {
            name: row.name, description: row.description, adminStatus: row.adminStatus ?? 1,
            operStatus: row.operStatus ?? 2, speedMbps: row.speedMbps, duplex: row.duplex,
            mac: row.mac, ifLastChangeTicks: row.ifLastChangeTicks, lastPollAt: now, lastSeen: now, updatedAt: now,
          },
          create: {
            deviceId: id, ifIndex: row.ifIndex, name: row.name, description: row.description,
            adminStatus: row.adminStatus ?? 1, operStatus: row.operStatus ?? 2,
            speedMbps: row.speedMbps, duplex: row.duplex, mac: row.mac,
            ifLastChangeTicks: row.ifLastChangeTicks, lastPollAt: now, lastSeen: now,
          },
        });
      }
      await this.prisma.networkDevice.update({
        where: { id }, data: { interfaceCount: res.interfaces.length, lastSnmpPollAt: now, isReachable: true },
      });
    }
    return res;
  }

  // ── SNMP credential staging ───────────────────────────────────
  /**
   * Build the encrypted SnmpConfiguration shape from a form body. The MASK
   * sent back by the UI means "unchanged", so a round-trip save never clobbers
   * the real secret. `undefined` fields are left untouched entirely.
   */
  private stagedCreds(body: any) {
    const hasAny = body.community !== undefined || body.v3Username !== undefined ||
      body.v3AuthKey !== undefined || body.v3PrivKey !== undefined;
    if (!hasAny) return null;
    return {
      communityEnc: encField(this.secrets, isMask(body.community) ? undefined : body.community),
      hasCommunity: !!body.community && !isMask(body.community),
      v3Username: body.v3Username != null ? String(body.v3Username).slice(0, 64) : null,
      v3AuthProto: body.v3AuthProto != null ? String(body.v3AuthProto).slice(0, 16) : null,
      v3AuthKeyEnc: encField(this.secrets, isMask(body.v3AuthKey) ? undefined : body.v3AuthKey),
      hasAuthKey: !!body.v3AuthKey && !isMask(body.v3AuthKey),
      v3PrivProto: body.v3PrivProto != null ? String(body.v3PrivProto).slice(0, 16) : null,
      v3PrivKeyEnc: encField(this.secrets, isMask(body.v3PrivKey) ? undefined : body.v3PrivKey),
      hasPrivKey: !!body.v3PrivKey && !isMask(body.v3PrivKey),
    };
  }

  // ── Ports / history ───────────────────────────────────────────
  async ports(id: number, actor?: Actor) {
    await this.assertDevice(id, actor);
    const rows = await this.prisma.networkInterface.findMany({ where: { deviceId: id }, orderBy: { ifIndex: 'asc' } });
    return rows.map((p) => ({
      id: p.id, ifIndex: p.ifIndex, name: p.name, description: p.description,
      adminStatus: p.adminStatus, operStatus: p.operStatus, speedMbps: p.speedMbps, duplex: p.duplex,
      rxRateBps: Math.round(p.rxRateBps), txRateBps: Math.round(p.txRateBps),
      rxPps: p.rxPps, txPps: p.txPps, errorRatePerMin: p.errorRatePerMin,
      mac: p.mac, ifLastChangeTicks: p.ifLastChangeTicks,
      inOctets: p.inOctets, outOctets: p.outOctets, inErrors: p.inErrors, outErrors: p.outErrors,
      crcErrors: p.crcErrors, lastStateChangeAt: p.lastStateChangeAt,
      firstSeen: p.firstSeen, lastSeen: p.lastSeen,
    }));
  }

  /** Per-port traffic + status history for the mini-graphs (downsampled ≤180 pts). */
  async portHistory(deviceId: number, portId: number, range: string, actor?: Actor) {
    await this.assertDevice(deviceId, actor);
    const port = await this.prisma.networkInterface.findFirst({ where: { id: portId, deviceId } });
    if (!port) throw new NotFoundException('Port not found on this device');

    const ms = rangeMs(range);
    const from = new Date(Date.now() - ms);
    const [traffic, statuses] = await Promise.all([
      this.prisma.interfaceTrafficHistory.findMany({
        where: { interfaceId: portId, at: { gte: from } },
        orderBy: { at: 'asc' },
        select: { at: true, rxRateBps: true, txRateBps: true, rxPps: true, txPps: true, up: true, errorRatePerMin: true },
      }),
      this.prisma.interfaceStatusHistory.findMany({
        where: { interfaceId: portId, at: { gte: from } },
        orderBy: { at: 'asc' },
        select: { at: true, toStatus: true, durationSec: true },
      }),
    ]);

    // Downsample: collapse roughly-contiguous points to a fixed bucket count.
    const MAX = 180;
    let points = traffic;
    if (traffic.length > MAX) {
      const bucket = Math.ceil(traffic.length / MAX);
      const out: typeof traffic = [];
      for (let i = 0; i < traffic.length; i += bucket) {
        const slice = traffic.slice(i, i + bucket);
        out.push({
          at: slice[Math.floor(slice.length / 2)].at,
          rxRateBps: avg(slice.map((s) => s.rxRateBps)),
          txRateBps: avg(slice.map((s) => s.txRateBps)),
          rxPps: avg(slice.map((s) => s.rxPps)),
          txPps: avg(slice.map((s) => s.txPps)),
          up: slice.some((s) => s.up),
          errorRatePerMin: avg(slice.map((s) => s.errorRatePerMin)),
        });
      }
      points = out;
    }

    const stats = {
      avgRx: Math.round(avg(traffic.map((t) => t.rxRateBps))),
      maxRx: nums(traffic.map((t) => t.rxRateBps)).length ? Math.round(Math.max(...nums(traffic.map((t) => t.rxRateBps)))) : 0,
      avgTx: Math.round(avg(traffic.map((t) => t.txRateBps))),
      maxTx: nums(traffic.map((t) => t.txRateBps)).length ? Math.round(Math.max(...nums(traffic.map((t) => t.txRateBps)))) : 0,
      samples: traffic.length,
      upPct: traffic.length ? Math.round((traffic.filter((t) => t.up).length / traffic.length) * 10000) / 100 : 100,
    };
    return {
      range, from,
      port: { id: port.id, name: port.name, ifIndex: port.ifIndex, description: port.description },
      points, statuses, stats,
    };
  }

  /** Aggregate device stream: health metric rows + reachability-derived availability. */
  async deviceStream(deviceId: number, range: string, actor?: Actor) {
    await this.assertDevice(deviceId, actor);
    const ms = rangeMs(range);
    const from = new Date(Date.now() - ms);
    const [health, polls] = await Promise.all([
      this.prisma.deviceHealthMetric.findMany({
        where: { deviceId, ts: { gte: from } },
        orderBy: { ts: 'asc' },
        select: { ts: true, metric: true, value: true },
      }),
      this.prisma.interfaceTrafficHistory.findMany({
        where: { deviceId, at: { gte: from } },
        orderBy: 'at' as any,
        select: { at: true, up: true },
        distinct: ['at'],
      }),
    ]);
    const uptime = health.filter((h) => h.metric === 'uptime');
    const rxRows = health.filter((h) => h.metric === 'rx');
    const txRows = health.filter((h) => h.metric === 'tx');
    const byTs = new Map<number, { ts: Date; rx: number; tx: number }>();
    for (const h of rxRows) byTs.set(h.ts.getTime(), { ts: h.ts, rx: h.value, tx: 0 });
    for (const h of txRows) {
      const e = byTs.get(h.ts.getTime()) || { ts: h.ts, rx: 0, tx: 0 };
      e.tx = h.value; byTs.set(h.ts.getTime(), e);
    }
    const points = [...byTs.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime())
      .map((e) => ({ at: e.ts, rxRateBps: Math.round(e.rx), txRateBps: Math.round(e.tx) }));

    const availability = uptime.length
      ? { samples: uptime.length, upPct: Math.round((uptime.filter((u) => u.value > 0).length / uptime.length) * 10000) / 100 }
      : { samples: 0, upPct: null };
    return { range, from, points, availability, uptimeNow: uptime.length ? uptime[uptime.length - 1].value : null };
  }

  // ── Syslog feed ───────────────────────────────────────────────
  async syslog(opts: { deviceId?: number; severity?: string; limit?: number; page?: number }, actor?: Actor) {
    const where: any = {};
    if (opts.deviceId) where.deviceId = opts.deviceId;
    if (opts.severity) {
      const sevMap: Record<string, number> = { EMERGENCY: 0, ALERT: 1, CRITICAL: 2, ERROR: 3, WARNING: 4, NOTICE: 5, INFORMATIONAL: 6, DEBUG: 7 };
      where.severity = { lte: sevMap[String(opts.severity).toUpperCase()] ?? 7 };
    }
    const scopeWhere = await this.deviceScopeWhere(actor);
    if (scopeWhere.ownerId) {
      const ids = (await this.prisma.networkDevice.findMany({ where: scopeWhere, select: { id: true } })).map((i) => i.id);
      if (opts.deviceId && !ids.includes(opts.deviceId)) return { rows: [], total: 0 };
      where.deviceId = { in: ids };
    }
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
    const page = Math.max(Number(opts.page) || 1, 1);
    const [total, rows] = await Promise.all([
      this.prisma.syslogEvent.count({ where }),
      this.prisma.syslogEvent.findMany({ where, orderBy: { receivedAt: 'desc' }, take: limit, skip: (page - 1) * limit }),
    ]);
    return { total, page, limit, rows };
  }

  // ── Events ────────────────────────────────────────────────────
  async events(opts: { status?: string; type?: string; deviceId?: number; limit?: number; page?: number }, actor?: Actor) {
    const where: any = {};
    if (opts.status) where.status = opts.status;
    if (opts.type) where.eventType = opts.type;
    if (opts.deviceId) where.deviceId = opts.deviceId;
    const scopeWhere = await this.deviceScopeWhere(actor);
    if (scopeWhere.ownerId) {
      const ids = await this.prisma.networkDevice.findMany({ where: scopeWhere, select: { id: true } });
      where.deviceId = { in: ids.map((i) => i.id) };
      if (opts.deviceId && !ids.some((i) => i.id === opts.deviceId)) return { rows: [], total: 0 };
    }
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
    const page = Math.max(Number(opts.page) || 1, 1);
    const [total, rows] = await Promise.all([
      this.prisma.networkEvent.count({ where }),
      this.prisma.networkEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: (page - 1) * limit }),
    ]);
    return { total, page, limit, rows: rows.map((r) => ({ ...r, label: EVENT_LABELS[r.eventType] || r.eventType })) };
  }

  // ── Alerts ────────────────────────────────────────────────────
  async listAlerts(opts: { status?: string; deviceId?: number; limit?: number; page?: number }, actor?: Actor) {
    const where: any = {};
    if (opts.status) where.status = opts.status;
    if (opts.deviceId) where.deviceId = opts.deviceId;
    const scopeWhere = await this.deviceScopeWhere(actor);
    if (scopeWhere.ownerId) {
      const ids = await this.prisma.networkDevice.findMany({ where: scopeWhere, select: { id: true } });
      where.deviceId = { in: ids.map((i) => i.id) };
      if (opts.deviceId && !ids.some((i) => i.id === opts.deviceId)) return { rows: [], total: 0 };
    }
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
    const page = Math.max(Number(opts.page) || 1, 1);
    const [total, rows] = await Promise.all([
      this.prisma.alert.count({ where }),
      this.prisma.alert.findMany({
        where, orderBy: [{ status: 'asc' }, { openedAt: 'desc' }], take: limit, skip: (page - 1) * limit,
        include: { device: { select: { name: true, ip: true } }, rule: { select: { name: true, condition: true, channels: true } } },
      }),
    ]);
    return { total, page, limit, rows };
  }

  async listOpenAlerts(actor?: Actor) {
    return this.listAlerts({ status: 'OPEN', limit: 200 }, actor);
  }

  async ackAlert(id: number, actor?: Actor) {
    const a = await this.prisma.alert.findUnique({ where: { id }, include: { device: { select: { ownerId: true } } } });
    if (!a) throw new NotFoundException('Alert not found');
    if (actor && !this.scope.isAdmin(actor.role)) {
      const root = await this.scope.rootId(actor);
      const ids = await this.scope.descendantIds(root);
      if (a.device?.ownerId == null || !ids.includes(a.device.ownerId)) throw new NotFoundException('Alert not found');
    }
    return this.alerts.acknowledge(id, this.scope.actorId(actor) || 0);
  }

  /** Manual resolve (a human fixed it) — sends a RESOLVE notification too. */
  async resolveAlert(id: number, actor?: Actor) {
    await this.ackAlert(id, actor); // same scope check, then:
    const a = await this.prisma.alert.findUnique({
      where: { id },
      include: { rule: true, device: { select: { ownerId: true, name: true, ip: true } } },
    });
    if (!a) throw new NotFoundException('Alert not found');
    if (a.status === 'RESOLVED') return a;
    const updated = await this.prisma.alert.update({ where: { id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
    if (a.rule?.enabled) {
      await this.notify.notify({
        alertId: id, title: `✅ Resolved: ${a.title}`, message: `${a.title} recovered (confirmed by operator).`,
        severity: 'INFO', channels: (a.rule.channels as any) || {}, ownerId: a.device?.ownerId,
        deviceName: a.device?.name, deviceIp: a.device?.ip,
        event: 'RESOLVE',
      });
    }
    return updated;
  }

  // ── Rules ─────────────────────────────────────────────────────
  async listRules(actor?: Actor) {
    const where: any = actor && !this.scope.isAdmin(actor.role) ? { ownerId: this.scope.actorId(actor) } : {};
    return this.prisma.alertRule.findMany({ where, orderBy: { createdAt: 'desc' }, include: { _count: { select: { alerts: true } } } });
  }

  async createRule(body: any, actor?: Actor) {
    const name = String(body.name || '').trim();
    const eventType = String(body.eventType || '').trim();
    if (!name) throw new BadRequestException('Rule name is required.');
    if (!eventType || !EVENT_LABELS[eventType] && !['PORT_DOWN', 'LINK_DOWN', 'BGP_DOWN', 'OSPF_DOWN', 'DEVICE_DOWN', 'CPU_HIGH', 'MEMORY_HIGH', 'AUTH_FAILURE', 'CONFIG_CHANGE', 'SYSLOG', 'SYSLOG_STOPPED'].includes(eventType)) {
      throw new BadRequestException('A valid event type is required.');
    }
    const ownerId = actor ? this.scope.actorId(actor) : null;
    return this.prisma.alertRule.create({
      data: {
        ownerId, name: name.slice(0, 120), eventType: eventType.slice(0, 48),
        condition: body.condition ? String(body.condition).slice(0, 120) : null,
        severity: String(body.severity || 'WARNING').toUpperCase().slice(0, 16),
        enabled: body.enabled !== false,
        channels: body.channels || {},
        description: body.description ? String(body.description).slice(0, 500) : null,
      },
    });
  }

  async assertRule(id: number, actor?: Actor) {
    const r = await this.prisma.alertRule.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Rule not found');
    if (actor && !this.scope.isAdmin(actor.role) && r.ownerId !== this.scope.actorId(actor)) {
      throw new NotFoundException('Rule not found');
    }
    return r;
  }

  async updateRule(id: number, body: any, actor?: Actor) {
    await this.assertRule(id, actor);
    const data: any = {};
    if (body.name !== undefined) data.name = String(body.name).slice(0, 120);
    if (body.condition !== undefined) data.condition = body.condition ? String(body.condition).slice(0, 120) : null;
    if (body.severity !== undefined) data.severity = String(body.severity).toUpperCase();
    if (body.enabled !== undefined) data.enabled = !!body.enabled;
    if (body.channels !== undefined) data.channels = body.channels;
    if (body.description !== undefined) data.description = body.description ? String(body.description).slice(0, 500) : null;
    if (body.eventType !== undefined) data.eventType = String(body.eventType).slice(0, 48);
    return this.prisma.alertRule.update({ where: { id }, data });
  }

  async deleteRule(id: number, actor?: Actor) {
    await this.assertRule(id, actor);
    await this.prisma.alertRule.delete({ where: { id } });
    return { ok: true };
  }

  // ── Dashboard stats ───────────────────────────────────────────
  async stats(actor?: Actor) {
    const where = await this.deviceScopeWhere(actor);
    const deviceWhere = Object.keys(where).length ? where : {};
    const devices = await this.prisma.networkDevice.findMany({ where: deviceWhere, select: { id: true, enabled: true, isReachable: true, upPorts: true, downPorts: true, interfaceCount: true, name: true, ip: true, lastError: true } });
    const deviceIds = devices.map((d) => d.id);
    const scopedDeviceFilter = deviceIds.length ? { in: deviceIds } : { in: [-1] };

    const [openAlerts, criticalAlerts, openEvents, events24h, syslog24h] = await Promise.all([
      this.prisma.alert.count({ where: { status: 'OPEN', deviceId: scopedDeviceFilter } }),
      this.prisma.alert.count({ where: { status: 'OPEN', severity: 'CRITICAL', deviceId: scopedDeviceFilter } }),
      this.prisma.networkEvent.count({ where: { status: 'OPEN', deviceId: scopedDeviceFilter } }),
      this.prisma.networkEvent.count({ where: { deviceId: scopedDeviceFilter, createdAt: { gte: new Date(Date.now() - 86400_000) } } }),
      this.prisma.syslogEvent.count({ where: { deviceId: scopedDeviceFilter, receivedAt: { gte: new Date(Date.now() - 86400_000) } } }),
    ]);

    // 24h uptime per device (from health samples, reachable = poll recorded).
    const dayAgo = new Date(Date.now() - 86400_000);
    const health = await this.prisma.deviceHealthMetric.findMany({
      where: { deviceId: scopedDeviceFilter, ts: { gte: dayAgo } },
      select: { deviceId: true, metric: true },
    });
    const perDevice = new Map<number, { total: number; up: number }>();
    for (const h of health) {
      if (h.metric !== 'uptime') continue;
      const e = perDevice.get(h.deviceId) || { total: 0, up: 0 };
      e.total++; e.up++; perDevice.set(h.deviceId, e);
    }

    return {
      devices: {
        total: devices.length,
        enabled: devices.filter((d) => d.enabled).length,
        reachable: devices.filter((d) => d.enabled && d.isReachable).length,
        down: devices.filter((d) => d.enabled && d.isReachable === false).length,
        ports: devices.reduce((a, d) => a + d.interfaceCount, 0),
        upPorts: devices.reduce((a, d) => a + d.upPorts, 0),
        downPorts: devices.reduce((a, d) => a + d.downPorts, 0),
        perDevice: devices.map((d) => ({
          id: d.id, name: d.name, ip: d.ip, enabled: d.enabled, isReachable: d.isReachable,
          upPorts: d.upPorts, downPorts: d.downPorts, interfaceCount: d.interfaceCount, lastError: d.lastError,
          uptime24h: (() => { const e = perDevice.get(d.id); return e ? Math.round((e.up / e.total) * 10000) / 100 : null; })(),
        })),
      },
      alerts: { open: openAlerts, critical: criticalAlerts },
      events: { open: openEvents, last24h: events24h },
      syslog: { last24h: syslog24h },
    };
  }

  // ── Listener settings (SUPER_ADMIN only) ──────────────────────
  async getSettings(actor?: Actor) {
    this.canManageSettings(actor);
    const rows = await this.prisma.syslogServerSetting.findMany({ orderBy: { protocol: 'asc' } });
    return { listeners: rows.map((r) => ({ protocol: r.protocol, enabled: r.enabled, port: r.port, tlsCertPath: r.tlsCertPath, tlsKeyPath: r.tlsKeyPath })), running: this.receiver.activeProtocols };
  }

  async updateSettings(body: { listeners?: { protocol: string; enabled?: boolean; port?: number; tlsCertPath?: string; tlsKeyPath?: string }[] }, actor?: Actor) {
    this.canManageSettings(actor);
    for (const l of body?.listeners || []) {
      const proto = String(l.protocol || '').toUpperCase();
      if (!['UDP', 'TCP', 'TLS'].includes(proto)) continue;
      const data: any = {};
      if (l.enabled !== undefined) data.enabled = !!l.enabled;
      if (l.port !== undefined) data.port = Math.min(65535, Math.max(1, Number(l.port) || 514));
      if (l.tlsCertPath !== undefined) data.tlsCertPath = l.tlsCertPath || null;
      if (l.tlsKeyPath !== undefined) data.tlsKeyPath = l.tlsKeyPath || null;
      await this.prisma.syslogServerSetting.updateMany({ where: { protocol: proto }, data });
    }
    await this.receiver.reload();
    return this.getSettings(actor);
  }

  // ── Rule preview helper (for the UI) ─────────────────────────
  async ruleHelp() {
    return {
      eventTypes: Object.entries(EVENT_LABELS).map(([type, label]) => ({ type, label })),
      conditions: [
        { value: '', label: 'Every event of this type (default)' },
        { value: 'DURATION:120', label: 'Sustained more than 120 s → escalate' },
        { value: 'FLAP:5:600', label: 'Flapped 5× within 10 min → CRITICAL' },
        { value: 'THRESHOLD:90:CPU', label: 'Device CPU ≥ 90%' },
        { value: 'THRESHOLD:90:MEMORY', label: 'Device memory ≥ 90%' },
        { value: 'SYSLOG_SILENCE:300', label: 'No syslog for 5 min from a syslog-enabled device' },
      ],
      channels: ['discord', 'whatsapp', 'sms', 'email', 'sound', 'desktop'],
    };
  }
}

// ── Shared types + helpers ───────────────────────────────────────
export interface NdmTestBody {
  ip: string;
  name?: string;
  snmpVersion?: string;
  snmpPort?: number;
  community?: string;
  v3Username?: string;
  v3AuthProto?: string;
  v3AuthKey?: string;
  v3PrivProto?: string;
  v3PrivKey?: string;
  snmpTimeoutMs?: number;
  snmpRetries?: number;
  vendor?: string;
}

export interface NdmCreateBody extends NdmTestBody {
  vendor?: string;
  deviceType?: string;
  groupName?: string;
  location?: string;
  description?: string;
  pollIntervalSec?: number;
  syslogEnabled?: boolean;
  syslogProtocol?: string;
  syslogPort?: number;
}

function rangeMs(range: string): number {
  const spans: Record<string, number> = {
    '5m': 5 * 60_000, '1h': 3600_000, '6h': 6 * 3600_000, '24h': 24 * 3600_000,
    '7d': 7 * 86400_000, '30d': 30 * 86400_000,
  };
  return spans[range] ?? spans['1h'];
}

function avg(nums: number[]): number {
  const v = nums.filter((n) => Number.isFinite(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
function nums(arr: number[]): number[] { return arr.filter((n) => Number.isFinite(n)); }