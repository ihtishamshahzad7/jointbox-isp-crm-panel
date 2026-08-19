import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as dgram from 'dgram';
import * as net from 'net';
import * as tls from 'tls';
import * as fs from 'fs';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { isPrimaryInstance } from '../common/cluster-util';
import { NdmSyslogParserService } from './syslog-parser.service';
import { NdmEventEngine } from './event-engine.service';
import { NdmAlertEngine } from './alert-engine.service';
import { parseCondition, type NdmEventType } from './ndm.constants';

/**
 * Syslog receiver — real-time collection for switch/router logs.
 *
 * Listeners are driven by the syslog_server_setting table (UDP / TCP / TLS,
 * each independently enabled with its own port — RFC 5424 + 3164 accepted,
 * smart event detection lifts the actionable facts out of the noise).
 *
 * Flow per line:  source-IP → device lookup → SyslogEvent row (always) →
 * detected event → EventEngine (dedup, recovery) → AlertEngine (rules) →
 * alerts (SSE + notifications, handled by the engine).
 *
 * Binds only on the primary cluster worker. Ports 514 are privileged, so the
 * process must run as root or with cap_net_bind_service; a failed bind is
 * logged and everything else keeps working.
 */
@Injectable()
export class NdmSyslogReceiverService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('NdmSyslog');
  private sockets: (dgram.Socket | net.Server)[] = [];
  private active = new Set<string>(); // protocol keys currently listening
  private byIp = new Map<string, any>();
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private parser: NdmSyslogParserService,
    private events: NdmEventEngine,
    private alerts: NdmAlertEngine,
  ) {}

  async onModuleInit() {
    if (!isPrimaryInstance()) return;
    await this.refreshDeviceMap();
    this.refreshTimer = setInterval(() => this.refreshDeviceMap().catch(() => {}), 30_000);
    await this.syncListeners();
    this.log.log('Network-device syslog receiver initialised');
  }

  onModuleDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const s of this.sockets) { try { (s as any).close(); } catch { /* ignore */ } }
    this.sockets = [];
  }

  /** Keep the ip → device map fresh when devices are added/edited. */
  /** Called by the controller whenever listener settings change. */
  async reload() {
    if (!isPrimaryInstance()) return;
    await this.refreshDeviceMap();
    await this.syncListeners();
  }

  /** Remove a socket from the tracking list (used by close paths). */
  get activeProtocols(): string[] {
    return [...this.active];
  }

  private async refreshDeviceMap() {
    const list = await this.prisma.networkDevice.findMany({
      where: { syslogEnabled: true, enabled: true },
      select: { id: true, name: true, ip: true, ownerId: true },
    });
    const map = new Map<string, any>();
    for (const d of list) if (d.ip) map.set(d.ip, d);
    this.byIp = map;
  }

  /** (Re)create listeners to match syslog_server_setting rows. */
  private async syncListeners() {
    const settings = await this.prisma.syslogServerSetting.findMany().catch(() => []);
    const desired = new Set<string>();
    for (const s of settings) {
      if (!s.enabled) continue;
      desired.add(s.protocol);
      if (!this.active.has(s.protocol)) this.listen(s.protocol as 'UDP' | 'TCP' | 'TLS', s.port, s.tlsCertPath, s.tlsKeyPath);
    }
    // Stop listeners whose setting was disabled since boot.
    for (const proto of [...this.active]) {
      if (!desired.has(proto)) {
        const idx = this.sockets.findIndex((s: any) => (s as any).__room === proto);
        if (idx >= 0) { try { (this.sockets[idx] as any).close(); } catch { /* ignore */ } this.sockets.splice(idx, 1); }
        this.active.delete(proto);
      }
    }
  }

  private listen(protocol: 'UDP' | 'TCP' | 'TLS', port: number, certPath?: string | null, keyPath?: string | null) {
    try {
      if (protocol === 'UDP') {
        const sock = dgram.createSocket('udp4');
        (sock as any).__room = 'UDP';
        sock.on('message', (msg, rinfo) => this.onMessage(msg.toString('utf8'), rinfo.address, 'UDP'));
        sock.on('error', (e) => this.onListenError(sock, protocol, port, e));
        sock.bind(port, () => { this.active.add('UDP'); this.log.log(`[NDM] Syslog UDP :${port} listening`); });
        this.sockets.push(sock);
        return;
      }
      const server = net.createServer((conn) => {
        conn.on('data', (buf) => this.onMessage(buf.toString('utf8'), (conn.remoteAddress || '').replace(/^::ffff:/, ''), protocol));
        conn.on('error', () => { /* per-connection error is fine */ });
      });
      (server as any).__room = protocol;
      server.on('error', (e) => this.onListenError(server, protocol, port, e));
      if (protocol === 'TLS') {
        if (!certPath || !keyPath || !fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
          this.log.warn(`[NDM] TLS syslog enabled but cert/key not found — skipping TLS listener. (cert=${certPath}, key=${keyPath})`);
          return;
        }
        const tlsServer = tls.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, (socket) => {
          socket.on('data', (buf) => this.onMessage(buf.toString('utf8'), (socket.remoteAddress || '').replace(/^::ffff:/, ''), 'TLS'));
          socket.on('error', () => { /* per-connection error is fine */ });
        });
        tlsServer.listen(port, () => { this.active.add('TLS'); this.log.log(`[NDM] Syslog TLS :${port} listening`); });
        this.sockets.push(tlsServer);
      } else {
        server.listen(port, () => { this.active.add(protocol); this.log.log(`[NDM] Syslog TCP :${port} listening`); });
        this.sockets.push(server);
      }
    } catch (e: any) {
      this.log.warn(`[NDM] Could not start ${protocol} syslog listener: ${e?.message}`);
    }
  }

  private onListenError(sock: any, protocol: string, port: number, e: Error) {
    this.active.delete(protocol);
    this.log.warn(`[NDM] Syslog ${protocol} :${port} error — ${e.message}. Run as root or grant cap_net_bind_service for privileged ports.`);
    try { sock.close(); } catch { /* ignore */ }
    this.sockets = this.sockets.filter((s) => s !== sock);
  }

  // ── Per-line handling ──────────────────────────────────────────
  private async onMessage(raw: string, srcIp: string, via: 'UDP' | 'TCP' | 'TLS') {
    if (!raw || raw.length > 4096) return; // lines are short by definition
    try {
      const parsed = this.parser.parse(raw);
      if (!parsed) return;
      const device = this.byIp.get(srcIp) || null;

      // 1) Persist every line (the raw feed) — even unknown sources, so the
      //    admin can spot devices that should be added.
      const row = await this.prisma.syslogEvent.create({
        data: {
          deviceId: device?.id ?? null,
          sourceIp: srcIp,
          hostname: parsed.host || device?.name || null,
          facility: parsed.facility,
          facilityName: parsed.facilityName,
          severity: parsed.severityCode,
          severityName: parsed.severity,
          tag: parsed.process,
          message: (parsed.message || '').slice(0, 800),
          eventType: parsed.event,
          status: 'OPEN',
          raw: parsed.raw.slice(0, 2048),
        },
      });

      if (!device) return; // unknown source — feed only (avoids alert storms)

      // 2) Any line proves the device still talks → clear SYSLOG_STOPPED.
      await this.prisma.networkDevice.update({ where: { id: device.id }, data: { lastSyslogAt: new Date() } });
      await this.events.resolve({ deviceId: device.id, types: ['SYSLOG_STOPPED'] });
      await this.alerts.resolveFamily({ deviceId: device.id, family: 'DEVICE', deviceName: device.name });

      // 3) Smart detection → event engine (dedup + recovery) → alert engine.
      if (parsed.event !== 'SYSLOG' || parsed.eventSeverity !== 'info') {
        const ev = await this.events.record({
          eventType: parsed.event,
          source: 'SYSLOG',
          device: { id: device.id, name: device.name },
          sourceIp: srcIp,
          message: (parsed.message || raw).slice(0, 800),
          severity: parsed.eventSeverity,
        });
        if (ev) {
          await this.alerts.evaluate({
            eventId: ev.id,
            eventType: ev.eventType as NdmEventType,
            message: ev.message,
            severity: ev.severity,
            device: { id: device.id, name: device.name, ownerId: device.ownerId },
            count: ev.count,
          });
          // Recovery events close their family alerts.
          if (parsed.event === 'LINK_UP' || parsed.event === 'BGP_UP' || parsed.event === 'OSPF_UP') {
            await this.alerts.onRecovery({ eventType: parsed.event, deviceId: device.id, deviceName: device.name });
          }
        }
      }
      void row;
    } catch (e: any) {
      this.log.warn(`syslog line error: ${e?.message || e}`);
    }
  }

  /** Quiet check every minute: syslog-enabled devices that stopped talking. */
  @Cron(CronExpression.EVERY_MINUTE)
  async checkSilence() {
    if (!isPrimaryInstance()) return;
    try {
      const rules = await this.prisma.alertRule.findMany({ where: { enabled: true, condition: { startsWith: 'SYSLOG_SILENCE' } } });
      const defaultSec = 300;
      const silenceSec = rules.length
        ? Math.min(...rules.map((r) => { const c = parseCondition(r.condition); return c.kind === 'SYSLOG_SILENCE' ? c.seconds : defaultSec; }))
        : defaultSec;
      const cutoff = new Date(Date.now() - silenceSec * 1000);
      const quiet = await this.prisma.networkDevice.findMany({
        where: { enabled: true, syslogEnabled: true, isReachable: true, OR: [{ lastSyslogAt: { lt: cutoff } }, { lastSyslogAt: null }] },
        select: { id: true, name: true, ownerId: true, ip: true, lastSyslogAt: true },
      });
      for (const d of quiet) {
        const ev = await this.events.record({
          eventType: 'SYSLOG_STOPPED', source: 'SYSTEM', device: { id: d.id, name: d.name },
          message: `No syslog received for ${Math.round(silenceSec / 60)} min from ${d.name} (${d.ip})`,
        });
        if (ev) {
          await this.alerts.evaluate({
            eventId: ev.id, eventType: 'SYSLOG_STOPPED', message: ev.message, severity: ev.severity,
            device: { id: d.id, name: d.name, ownerId: d.ownerId },
          });
        }
      }
      if (quiet.length) this.log.warn(`Syslog silence: ${quiet.length} device(s) quiet for >${Math.round(silenceSec / 60)} min`);
    } catch (e: any) {
      this.log.warn(`checkSilence failed: ${e?.message || e}`);
    }
  }
}