import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { execFile } from 'child_process';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { EventsService } from '../common/events.service';
import { isPrimaryInstance } from '../common/cluster-util';
import { DiagnosticsService } from './diagnostics.service';

/**
 * Network monitoring — continuously pings the hosts each account adds, keeps a
 * short latency history for the mini graphs, and fires an alert the moment a
 * host goes down. Everything is owner-scoped: a parent's targets are private
 * unless they belong to the viewer's own subtree.
 */
@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);
  private polling = false;

  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
    private events: EventsService,
    // Reused rather than reimplemented: diagnostics already owns a hardened
    // TCP connect and an HTTP(S) fetch, including host validation.
    private diag: DiagnosticsService,
  ) {}

  // ── Scope helpers ────────────────────────────────────────────
  private async ownedIds(actor?: Actor): Promise<number[] | null> {
    if (!actor || this.scope.isAdmin(actor.role)) return null; // admin = all
    return this.scope.descendantIds(await this.scope.rootId(actor));
  }
  private async assertOwns(id: number, actor?: Actor) {
    const t = await this.prisma.monitorTarget.findUnique({ where: { id }, select: { ownerId: true } });
    if (!t) throw new NotFoundException(`Monitor target ${id} not found`);
    if (!actor || this.scope.isAdmin(actor.role)) return t;
    const ids = await this.ownedIds(actor);
    if (t.ownerId == null || !ids!.includes(t.ownerId)) throw new NotFoundException(`Monitor target ${id} not found`);
    return t;
  }

  // ── CRUD ─────────────────────────────────────────────────────
  async list(actor?: Actor) {
    const ids = await this.ownedIds(actor);
    const rows = await this.prisma.monitorTarget.findMany({
      where: ids ? { ownerId: { in: ids.length ? ids : [-1] } } : {},
      orderBy: [{ groupName: 'asc' }, { name: 'asc' }],
    });
    return rows.map((r) => ({ ...r, history: this.parseHistory(r.history) }));
  }

  /**
   * UNIFIED DEVICE LIST — one physical box, one row.
   *
   * THE PROBLEM THIS SOLVES. The platform grew two independent monitoring
   * records for the same hardware:
   *
   *   MonitorTarget  — ICMP/ping, added from the monitoring dashboard
   *   NetworkDevice  — SNMP/ports/syslog/alerts, added from the devices page
   *
   * A switch that was both pinged and SNMP-polled therefore appeared TWICE,
   * in two different screens, with no indication they were the same device.
   * An operator had to know which page answered which question.
   *
   * CORRELATION IS BY ADDRESS, AT QUERY TIME — deliberately not a migration.
   * `MonitorTarget.host` and `NetworkDevice.ip` are the same string for the
   * same box (10.254.1.30), so they can be matched without altering either
   * table, without a backfill, and without risking the existing ping data.
   * Both subsystems keep polling exactly as they do today; only the
   * PRESENTATION is unified. If the two records ever need to differ (a device
   * pinged on a management IP but SNMP-polled on a loopback), the upgrade path
   * is an explicit nullable `MonitorTarget.deviceId` link — a purely additive
   * column that this same merge function would prefer over the IP match.
   *
   * Scoping is applied INDEPENDENTLY to each side using that subsystem's own
   * rules, so this cannot widen visibility: a caller who may see the ping
   * monitor but not the SNMP device gets the ping half only.
   */
  async unifiedList(actor?: Actor) {
    const ids = await this.ownedIds(actor);

    const [pings, devices] = await Promise.all([
      this.prisma.monitorTarget.findMany({
        where: ids ? { ownerId: { in: ids.length ? ids : [-1] } } : {},
        orderBy: [{ groupName: 'asc' }, { name: 'asc' }],
      }),
      // Same scope rule the NDM module applies to its own list.
      this.prisma.networkDevice.findMany({
        where: ids ? { ownerId: { in: ids.length ? ids : [-1] } } : {},
        select: {
          id: true, name: true, ip: true, groupName: true, location: true,
          enabled: true, isReachable: true, cpu: true, memory: true, temperature: true,
          uptimeSec: true, lastSnmpPollAt: true, lastSyslogAt: true, lastError: true,
          interfaceCount: true, upPorts: true, downPorts: true,
          syslogEnabled: true, snmpVersion: true, vendor: true, deviceType: true,
        },
      }),
    ]);

    // Counts for the badges, fetched in bulk rather than per device.
    const deviceIds = devices.map((d) => d.id);
    const scoped = deviceIds.length ? { in: deviceIds } : { in: [-1] };
    const dayAgo = new Date(Date.now() - 86400_000);
    const [openAlerts, syslog24h] = await Promise.all([
      this.prisma.alert.groupBy({
        by: ['deviceId'], where: { status: 'OPEN', deviceId: scoped }, _count: { _all: true },
      }).catch(() => [] as any[]),
      this.prisma.syslogEvent.groupBy({
        by: ['deviceId'], where: { deviceId: scoped, receivedAt: { gte: dayAgo } }, _count: { _all: true },
      }).catch(() => [] as any[]),
    ]);
    const alertBy = new Map<number, number>(openAlerts.map((a: any): [number, number] => [a.deviceId, a._count._all]));
    const syslogBy = new Map<number, number>(syslog24h.map((s: any): [number, number] => [s.deviceId, s._count._all]));

    const byAddr = new Map<string, any>();
    const key = (s: string) => s.trim().toLowerCase();

    // 1. Ping monitors first — they are the existing, familiar records and
    //    their name/group should win in the merged view.
    for (const p of pings) {
      byAddr.set(key(p.host), {
        key: `p${p.id}`,
        monitorId: p.id,
        deviceId: null as number | null,
        name: p.name || p.host,
        host: p.host,
        groupName: p.groupName,
        enabled: p.enabled,
        // ICMP
        ping: {
          enabled: true, isUp: p.isUp, latencyMs: p.lastLatencyMs, lossPct: p.lossPct,
          lastCheckedAt: p.lastCheckedAt, downSince: p.downSince, intervalSec: p.intervalSec,
          history: this.parseHistory(p.history),
        },
        snmp: null, ports: null, syslog: null, alerts: 0,
        capabilities: ['PING'] as string[],
      });
    }

    // 2. Fold SNMP devices onto the matching address, or add as their own row.
    for (const d of devices) {
      const k = key(d.ip);
      const row = byAddr.get(k);
      const snmp = {
        enabled: true, reachable: d.isReachable, version: d.snmpVersion,
        vendor: d.vendor, deviceType: d.deviceType,
        cpu: d.cpu, memory: d.memory, temperature: d.temperature,
        uptimeSec: d.uptimeSec != null ? Number(d.uptimeSec) : null,
        lastPollAt: d.lastSnmpPollAt, lastError: d.lastError,
      };
      const ports = { total: d.interfaceCount, up: d.upPorts, down: d.downPorts };
      const syslog = d.syslogEnabled
        ? { enabled: true, last24h: syslogBy.get(d.id) ?? 0, lastAt: d.lastSyslogAt }
        : null;

      if (row) {
        // SAME BOX — enrich the existing card instead of adding a second one.
        row.deviceId = d.id;
        row.location = d.location ?? null;
        row.snmp = snmp;
        row.ports = ports;
        row.syslog = syslog;
        row.alerts = alertBy.get(d.id) ?? 0;
        row.capabilities.push('SNMP');
        if (d.interfaceCount > 0) row.capabilities.push('PORTS');
        if (syslog) row.capabilities.push('SYSLOG');
        if (!row.groupName && d.groupName) row.groupName = d.groupName;
      } else {
        // SNMP-only device — still belongs on the same dashboard.
        byAddr.set(k, {
          key: `d${d.id}`,
          monitorId: null, deviceId: d.id,
          name: d.name || d.ip, host: d.ip, groupName: d.groupName,
          location: d.location ?? null, enabled: d.enabled,
          ping: null, snmp, ports, syslog,
          alerts: alertBy.get(d.id) ?? 0,
          capabilities: ['SNMP', ...(d.interfaceCount > 0 ? ['PORTS'] : []), ...(syslog ? ['SYSLOG'] : [])],
        });
      }
    }

    const rows = [...byAddr.values()].sort((a, b) =>
      (a.groupName || 'zzz').localeCompare(b.groupName || 'zzz') || a.name.localeCompare(b.name));

    // Dashboard totals — ports and alerts included, so the header can show the
    // whole picture rather than ping-only counts.
    const summary = {
      total: rows.length,
      up: rows.filter((r) => r.enabled && (r.ping ? r.ping.isUp === true : r.snmp?.reachable === true)).length,
      down: rows.filter((r) => r.enabled && (r.ping ? r.ping.isUp === false : r.snmp?.reachable === false)).length,
      paused: rows.filter((r) => !r.enabled).length,
      portsUp: devices.reduce((s, d) => s + d.upPorts, 0),
      portsDown: devices.reduce((s, d) => s + d.downPorts, 0),
      openAlerts: [...alertBy.values()].reduce((s, n) => s + n, 0),
      syslog24h: [...syslogBy.values()].reduce((s, n) => s + n, 0),
      snmpDevices: devices.length,
      pingMonitors: pings.length,
      /** Boxes that had BOTH records and are now shown once. */
      merged: rows.filter((r) => r.monitorId && r.deviceId).length,
    };

    return { summary, devices: rows };
  }

  async getOne(id: number, actor?: Actor) {
    await this.assertOwns(id, actor);
    const t = await this.prisma.monitorTarget.findUnique({ where: { id } });
    return t ? { ...t, history: this.parseHistory(t.history) } : null;
  }

  /**
   * Normalise the check a caller asked for.
   *
   * Rejects an unknown type rather than silently falling back to ICMP: an
   * operator who typo'd "HTTPs" and got a ping monitor would believe a service
   * was being watched when it was not, and would find out during an outage.
   */
  private static parseCheck(data: { checkType?: any; port?: any; path?: any }) {
    const type = String(data.checkType ?? 'ICMP').toUpperCase();
    if (!['ICMP', 'TCP', 'HTTP', 'HTTPS'].includes(type)) {
      throw new BadRequestException(`Unknown check type "${data.checkType}". Use ICMP, TCP, HTTP or HTTPS.`);
    }
    if (type === 'ICMP') return { checkType: type, port: null, path: null };

    const raw = data.port ?? MonitoringService.DEFAULT_PORT[type];
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BadRequestException('Port must be a whole number between 1 and 65535.');
    }
    const path = type === 'HTTP' || type === 'HTTPS'
      ? (data.path ? String(data.path).trim().slice(0, 255) : '/')
      : null;
    return { checkType: type, port, path };
  }

  async create(data: { name?: string; host?: string; groupName?: string; intervalSec?: number; checkType?: string; port?: number; path?: string }, actor?: Actor) {
    const host = String(data.host || '').trim();
    if (!host) throw new BadRequestException('A host (IP or hostname) is required.');
    if (!/^[a-zA-Z0-9._:-]{1,255}$/.test(host)) throw new BadRequestException('That host looks invalid — use an IP or hostname.');
    return this.prisma.monitorTarget.create({
      data: {
        name: String(data.name || host).trim().slice(0, 120),
        host,
        groupName: data.groupName ? String(data.groupName).trim().slice(0, 80) : null,
        intervalSec: Math.min(Math.max(Number(data.intervalSec) || 30, 10), 3600),
        ...MonitoringService.parseCheck(data),
        ownerId: actor ? this.scope.actorId(actor) : null,
      },
    });
  }

  /**
   * BULK IMPORT — add many monitors from a spreadsheet in one call.
   *
   * Accepts rows of { host, name, group }. Only `host` is mandatory; a missing
   * label falls back to the host itself, which is what an operator means when
   * they paste a bare list of IPs.
   *
   * Design decisions worth knowing:
   *
   *  • PER-ROW RESULTS, NOT ALL-OR-NOTHING. A 200-row sheet with three bad
   *    addresses should import 197 monitors and tell you about the three, not
   *    reject the lot. Every row comes back with its own outcome so the UI can
   *    show exactly which line failed and why.
   *
   *  • DUPLICATES ARE SKIPPED, NOT DUPLICATED. Re-importing the same sheet is a
   *    normal operator action (someone adds ten rows and re-uploads). Matching
   *    is on host within the caller's own scope, so two dealers may each
   *    monitor 192.168.88.1 without colliding.
   *
   *  • The row's own index is echoed back so the UI can point at the exact
   *    spreadsheet line rather than saying "some rows failed".
   */
  async importTargets(
    rows: Array<{ host?: string; name?: string; label?: string; group?: string; groupName?: string; intervalSec?: number }>,
    actor?: Actor,
  ) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('No rows to import. The file appears to be empty.');
    }
    if (rows.length > 2000) {
      throw new BadRequestException(`Too many rows (${rows.length}). Import at most 2000 monitors at a time.`);
    }

    const ownerId = actor ? this.scope.actorId(actor) : null;

    // Existing hosts in THIS caller's scope, so a re-import is a no-op rather
    // than a second copy of every monitor.
    const ids = await this.ownedIds(actor);
    const existing = await this.prisma.monitorTarget.findMany({
      where: ids ? { ownerId: { in: ids.length ? ids : [-1] } } : {},
      select: { host: true },
    });
    const seen = new Set(existing.map((e) => e.host.toLowerCase()));

    const results: Array<{ row: number; host: string; status: 'added' | 'skipped' | 'failed'; reason?: string }> = [];
    let added = 0, skipped = 0, failed = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      // Accept either naming convention — spreadsheets in the wild use both.
      const host = String(r.host ?? '').trim();
      const label = String(r.name ?? r.label ?? '').trim();
      const group = String(r.group ?? r.groupName ?? '').trim();
      const rowNo = i + 1;

      if (!host) {
        results.push({ row: rowNo, host: '', status: 'failed', reason: 'No host or IP in this row.' });
        failed++; continue;
      }
      if (!/^[a-zA-Z0-9._:-]{1,255}$/.test(host)) {
        results.push({ row: rowNo, host, status: 'failed', reason: 'Not a valid IP address or hostname.' });
        failed++; continue;
      }
      if (seen.has(host.toLowerCase())) {
        results.push({ row: rowNo, host, status: 'skipped', reason: 'Already monitored.' });
        skipped++; continue;
      }

      try {
        await this.prisma.monitorTarget.create({
          data: {
            name: (label || host).slice(0, 120),
            host,
            groupName: group ? group.slice(0, 80) : null,
            intervalSec: Math.min(Math.max(Number(r.intervalSec) || 30, 10), 3600),
            ownerId,
          },
        });
        seen.add(host.toLowerCase()); // guards duplicates WITHIN the same file
        results.push({ row: rowNo, host, status: 'added' });
        added++;
      } catch (e: any) {
        results.push({ row: rowNo, host, status: 'failed', reason: e?.message || 'Database error.' });
        failed++;
      }
    }

    this.logger.log(`Monitor import: ${added} added, ${skipped} skipped, ${failed} failed (${rows.length} rows)`);
    return { total: rows.length, added, skipped, failed, results };
  }

  async update(id: number, data: any, actor?: Actor) {
    await this.assertOwns(id, actor);
    const patch: any = {};
    if (data.name !== undefined) patch.name = String(data.name).trim().slice(0, 120);
    if (data.host !== undefined) patch.host = String(data.host).trim().slice(0, 255);
    if (data.groupName !== undefined) patch.groupName = data.groupName ? String(data.groupName).trim().slice(0, 80) : null;
    if (data.enabled !== undefined) patch.enabled = !!data.enabled;
    if (data.intervalSec !== undefined) patch.intervalSec = Math.min(Math.max(Number(data.intervalSec) || 30, 10), 3600);
    if (data.checkType !== undefined || data.port !== undefined || data.path !== undefined) {
      const current = await this.prisma.monitorTarget.findUnique({
        where: { id }, select: { checkType: true, port: true, path: true },
      });
      // Merged with what is stored, so changing only the port on an HTTPS
      // monitor does not silently reset it to a ping.
      Object.assign(patch, MonitoringService.parseCheck({
        checkType: data.checkType ?? current?.checkType,
        port: data.port ?? current?.port,
        path: data.path ?? current?.path,
      }));
      // A type change invalidates the last status code.
      if (patch.checkType !== current?.checkType) patch.lastStatus = null;
    }
    return this.prisma.monitorTarget.update({ where: { id }, data: patch });
  }

  async remove(id: number, actor?: Actor) {
    await this.assertOwns(id, actor);
    return this.prisma.monitorTarget.delete({ where: { id } });
  }

  /** Rename/regroup a whole group at once. */
  async renameGroup(from: string, to: string, actor?: Actor) {
    const ids = await this.ownedIds(actor);
    await this.prisma.monitorTarget.updateMany({
      where: { groupName: from || null, ...(ids ? { ownerId: { in: ids.length ? ids : [-1] } } : {}) },
      data: { groupName: to ? to.trim().slice(0, 80) : null },
    });
    return { ok: true };
  }

  // ── Ping ─────────────────────────────────────────────────────
  private ping(host: string): Promise<{ up: boolean; ms: number | null; loss: number }> {
    return new Promise((resolve) => {
      // 2 packets, 2s deadline — fast enough to poll many at once.
      execFile('ping', ['-n', '-c', '2', '-w', '2', host], { timeout: 5000 }, (_err, stdout) => {
        const out = String(stdout || '');
        const lossM = out.match(/([\d.]+)% packet loss/);
        const rttM = out.match(/=\s*[\d.]+\/([\d.]+)\//); // avg
        const loss = lossM ? parseFloat(lossM[1]) : 100;
        resolve({ up: loss < 100, ms: rttM ? Math.round(parseFloat(rttM[1]) * 10) / 10 : null, loss });
      });
    });
  }

  private parseHistory(s: string | null): Array<{ t: number; ms: number | null; up: boolean }> {
    try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  }

  /** Ping one target now (the manual "check now" button). Scope-checked. */
  async checkTarget(id: number, actor?: Actor) {
    await this.assertOwns(id, actor);
    const t = await this.prisma.monitorTarget.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Target not found');
    return this.runCheck(t);
  }

  /** Default port when the operator did not name one. */
  private static readonly DEFAULT_PORT: Record<string, number> = { HTTP: 80, HTTPS: 443, TCP: 22 };

  /**
   * Run the check this target actually asks for.
   *
   * THE POINT OF THIS METHOD: "the device is up" and "the service is up" are
   * different questions, and only the second one matches what a customer
   * experiences. A box that answers ICMP while its web application returns 500
   * is down as far as anyone using it is concerned, and a monitor that only
   * pings reports it green.
   *
   * ICMP loses its meaning for the other types, so `loss` is reported as the
   * binary it really is (0 or 100) rather than invented — every consumer of
   * this value already treats 100 as "no answer".
   */
  private async probe(t: { host: string; checkType?: string | null; port?: number | null; path?: string | null }):
    Promise<{ up: boolean; ms: number | null; loss: number; status?: number | null; detail?: string | null }> {
    const type = (t.checkType || 'ICMP').toUpperCase();
    if (type === 'ICMP') return this.ping(t.host);

    const port = t.port ?? MonitoringService.DEFAULT_PORT[type] ?? 0;

    if (type === 'HTTP' || type === 'HTTPS') {
      const scheme = type.toLowerCase();
      const isDefaultPort = (type === 'HTTP' && port === 80) || (type === 'HTTPS' && port === 443);
      const authority = isDefaultPort ? t.host : `${t.host}:${port}`;
      const path = t.path && t.path.startsWith('/') ? t.path : `/${t.path || ''}`;
      const r: any = await this.diag.httpCheck(`${scheme}://${authority}${path}`).catch((e: any) => ({
        success: false, error: e?.message || 'request failed',
      }));
      const status: number | null = r?.status ?? null;
      // 2xx and 3xx are a working service. Anything else — including a refused
      // connection or a TLS failure — is an outage the operator should see.
      const up = !!status && status >= 200 && status < 400;
      return {
        up,
        ms: r?.responseMs ?? r?.latencyMs ?? null,
        loss: up ? 0 : 100,
        status,
        detail: up ? null : (r?.error || (status ? `HTTP ${status}` : 'no response')),
      };
    }

    const r: any = await this.diag.tcpPort(t.host, port, 4000).catch((e: any) => ({
      open: false, error: e?.message || 'connect failed',
    }));
    return {
      up: !!r?.open,
      ms: r?.latencyMs ?? null,
      loss: r?.open ? 0 : 100,
      status: null,
      detail: r?.open ? null : (r?.error || 'connection failed'),
    };
  }

  /** Human label for a target, used in alerts so "DOWN" says what is down. */
  private static describe(t: { host: string; checkType?: string | null; port?: number | null }): string {
    const type = (t.checkType || 'ICMP').toUpperCase();
    if (type === 'ICMP') return t.host;
    const port = t.port ?? MonitoringService.DEFAULT_PORT[type];
    return `${t.host}:${port} (${type})`;
  }

  private async runCheck(t: { id: number; host: string; name: string; ownerId: number | null; isUp: boolean | null; history: string | null; checkType?: string | null; port?: number | null; path?: string | null }) {
    const res = await this.probe(t);
    const wasUp = t.isUp;
    const now = new Date();
    const hist = this.parseHistory(t.history);
    hist.push({ t: now.getTime(), ms: res.ms, up: res.up });
    while (hist.length > 60) hist.shift(); // keep the last 60 for the mini graph

    await this.prisma.monitorTarget.update({
      where: { id: t.id },
      data: {
        isUp: res.up,
        lastLatencyMs: res.ms,
        lossPct: res.loss,
        lastStatus: res.status ?? null,
        lastCheckedAt: now,
        downSince: res.up ? null : (wasUp === false ? undefined : now),
        history: JSON.stringify(hist),
      },
    });

    // Persist the sample for the long-range history charts (retained ~30 days).
    await this.prisma.monitorSample.create({
      data: { targetId: t.id, up: res.up, latencyMs: res.ms, lossPct: res.loss },
    }).catch(() => null);

    // Transition → alert (up↔down). Broadcast so the browser can beep/announce,
    // and log a durable record.
    if (wasUp !== null && wasUp !== res.up) {
      this.events.broadcast('monitor', {
        id: t.id, name: t.name, host: t.host, ownerId: t.ownerId,
        isUp: res.up, at: now.toISOString(),
      });
      await this.prisma.systemLog.create({
        data: {
          level: res.up ? 'INFO' : 'ERROR',
          source: 'monitoring',
          message: res.up
            ? `Monitor UP: "${t.name}" (${MonitoringService.describe(t)}) recovered.`
            // The reason matters: "HTTP 502" and "connection refused" send an
            // engineer to completely different places.
            : `Monitor DOWN: "${t.name}" (${MonitoringService.describe(t)}) — ${res.detail || 'not responding'}.`,
          metadata: JSON.stringify({ targetId: t.id, ownerId: t.ownerId }),
        },
      }).catch(() => null);
      this.logger[res.up ? 'log' : 'warn'](`Monitor ${res.up ? 'UP' : 'DOWN'}: ${t.name} (${t.host})`);
    }
    return res;
  }

  // ── Poller ───────────────────────────────────────────────────
  @Cron(CronExpression.EVERY_30_SECONDS)
  async poll() {
    // CLUSTER GUARD — background work must run on ONE process only.
    // Without this the cron fired on every pm2 instance (11 web + 1 worker
    // = 12 concurrent runs of the same job), which duplicated side effects
    // and flooded the logs with identical rows.
    if (!isPrimaryInstance()) return;
    if (this.polling) return; // don't overlap slow runs
    this.polling = true;
    try {
      const targets = await this.prisma.monitorTarget.findMany({
        where: { enabled: true },
        select: { id: true, host: true, name: true, ownerId: true, isUp: true, history: true,
                  checkType: true, port: true, path: true },
      });
      // Bounded concurrency so a big list doesn't spawn hundreds of pings at once.
      const BATCH = 12;
      for (let i = 0; i < targets.length; i += BATCH) {
        await Promise.all(targets.slice(i, i + BATCH).map((t) => this.runCheck(t).catch(() => null)));
      }
    } catch (e: any) {
      this.logger.warn(`Monitor poll failed: ${e?.message || e}`);
    } finally {
      this.polling = false;
    }
  }

  /** Nightly: drop samples older than the retention window (default 30 days). */
  @Cron('20 3 * * *')
  async pruneSamples() {
    // CLUSTER GUARD — background work must run on ONE process only.
    // Without this the cron fired on every pm2 instance (11 web + 1 worker
    // = 12 concurrent runs of the same job), which duplicated side effects
    // and flooded the logs with identical rows.
    if (!isPrimaryInstance()) return;
    const days = Number(process.env.MONITOR_RETENTION_DAYS || 30);
    const cutoff = new Date(Date.now() - days * 86400_000);
    const { count } = await this.prisma.monitorSample.deleteMany({ where: { at: { lt: cutoff } } });
    if (count) this.logger.log(`Monitoring retention: pruned ${count} sample(s) older than ${days}d`);
  }

  // ── History for the detail-page charts ───────────────────────
  async history(id: number, range: string, actor?: Actor) {
    await this.assertOwns(id, actor);
    const spans: Record<string, number> = {
      '5m': 5 * 60_000, '1h': 3600_000, '6h': 6 * 3600_000,
      '24h': 24 * 3600_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000,
    };
    const ms = spans[range] ?? spans['1h'];
    const from = new Date(Date.now() - ms);
    const rows = await this.prisma.monitorSample.findMany({
      where: { targetId: id, at: { gte: from } },
      orderBy: { at: 'asc' },
      select: { at: true, up: true, latencyMs: true, lossPct: true },
    });

    // Downsample long ranges to ~180 points so the chart stays light.
    const MAX = 180;
    let points = rows;
    if (rows.length > MAX) {
      const bucket = Math.ceil(rows.length / MAX);
      const out: typeof rows = [];
      for (let i = 0; i < rows.length; i += bucket) {
        const slice = rows.slice(i, i + bucket);
        const lat = slice.filter((s) => s.up && s.latencyMs != null).map((s) => s.latencyMs!);
        out.push({
          at: slice[Math.floor(slice.length / 2)].at,
          up: slice.some((s) => s.up),
          latencyMs: lat.length ? Math.round((lat.reduce((a, b) => a + b, 0) / lat.length) * 10) / 10 : null,
          lossPct: Math.round((slice.reduce((a, s) => a + (s.lossPct ?? 0), 0) / slice.length)),
        });
      }
      points = out;
    }

    // Stats over the raw rows (not the downsampled set).
    const lats = rows.filter((s) => s.up && s.latencyMs != null).map((s) => s.latencyMs!);
    const upCount = rows.filter((s) => s.up).length;
    const stats = {
      samples: rows.length,
      min: lats.length ? Math.min(...lats) : null,
      avg: lats.length ? Math.round((lats.reduce((a, b) => a + b, 0) / lats.length) * 10) / 10 : null,
      max: lats.length ? Math.max(...lats) : null,
      uptimePct: rows.length ? Math.round((upCount / rows.length) * 10000) / 100 : null,
      lossPct: rows.length ? Math.round((rows.reduce((a, s) => a + (s.lossPct ?? 0), 0) / rows.length) * 100) / 100 : null,
    };
    return { range, from, points, stats };
  }
}
