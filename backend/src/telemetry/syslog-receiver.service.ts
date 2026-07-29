import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as dgram from 'dgram';
import { PrismaService } from '../prisma/prisma.service';
import { isPrimaryInstance } from '../common/cluster-util';
import { LinkAggregatorService, FeedLevel } from './link-aggregator.service';

/**
 * Syslog receiver — the real-time, zero-polling collector.
 *
 * Devices are pointed at this panel (UDP, default 514) and push a line the
 * instant something happens: a link drops, a PPPoE user connects, an OLT reports
 * a weak ONT. We map the source IP to a syslog-ENABLED NAS, parse the useful
 * shapes, and hand structured events to the aggregator.
 *
 * Binds only on the primary cluster worker (one listener per host) and only if
 * at least one NAS has syslog enabled. Port 514 is privileged, so the process
 * must run as root (it does under the pm2/systemd install) or be granted
 * cap_net_bind_service; if the bind fails we log and carry on — nothing else
 * breaks.
 */
@Injectable()
export class SyslogReceiverService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SyslogReceiver');
  private socket?: dgram.Socket;
  private byIp = new Map<string, any>(); // source ip → nas
  private refreshTimer?: NodeJS.Timeout;
  private port = Number(process.env.SYSLOG_PORT) || 514;

  constructor(
    private prisma: PrismaService,
    private aggregator: LinkAggregatorService,
  ) {}

  async onModuleInit() {
    if (!isPrimaryInstance()) return;
    await this.refreshNasMap();
    this.refreshTimer = setInterval(() => this.refreshNasMap().catch(() => {}), 30_000);
    if (this.byIp.size === 0) {
      this.log.log('No NAS has syslog enabled yet — receiver idle (will start when one does).');
    }
    this.bind();
  }

  onModuleDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    try { this.socket?.close(); } catch { /* ignore */ }
  }

  private async refreshNasMap() {
    const list = await this.prisma.nas.findMany({
      where: { syslogEnabled: true, isActive: true },
      select: { id: true, nasname: true, nasIp: true, syslogPort: true },
    });
    const map = new Map<string, any>();
    for (const n of list) {
      const ip = n.nasIp || (n.nasname && /^\d+\.\d+\.\d+\.\d+$/.test(n.nasname) ? n.nasname : null);
      if (ip) map.set(ip, n);
    }
    this.byIp = map;
    if (list.length && !this.socket) this.bind();
  }

  private bind() {
    if (this.socket) return;
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => this.onMessage(msg.toString('utf8'), rinfo.address));
    sock.on('error', (err) => {
      this.log.warn(`Syslog bind/listen error on :${this.port} — ${err.message}. Run as root or grant cap_net_bind_service for privileged ports.`);
      try { sock.close(); } catch { /* ignore */ }
      this.socket = undefined;
    });
    sock.bind(this.port, () => this.log.log(`Syslog receiver listening on UDP :${this.port}`));
    this.socket = sock;
  }

  private onMessage(raw: string, srcIp: string) {
    const nas = this.byIp.get(srcIp);
    if (!nas) return; // unknown or syslog-disabled source — ignore
    const parsed = this.parse(raw);
    if (!parsed) {
      // Keep the raw line as a low-priority feed entry so nothing is lost.
      void this.aggregator.onSyslog(nas, { level: 'info', kind: 'SYSLOG', message: raw.slice(0, 300).trim() });
      return;
    }
    void this.aggregator.onSyslog(nas, parsed);
  }

  /** Extract the meaningful shapes from common (MikroTik / OLT) syslog lines. */
  private parse(line: string): { level: FeedLevel; kind: string; message: string; username?: string; port?: string; eventType?: any; severity?: 'info' | 'warning' | 'critical' } | null {
    const l = line.trim();

    // interface up/down:  "sfp1: link up"  /  "ether3 link down"
    let m = l.match(/([a-z0-9\/\-_]+)[:\s].*link\s+(up|down)/i);
    if (m) {
      const up = /up/i.test(m[2]);
      return {
        level: up ? 'up' : 'down',
        kind: up ? 'UP' : 'DOWN',
        port: m[1],
        message: `${m[1]} link ${up ? 'UP' : 'DOWN'}`,
        eventType: up ? 'LINK_UP' : 'LINK_DOWN',
        severity: up ? 'info' : 'warning',
      };
    }

    // pppoe login/logout:  "pppoe: user Ali logged in from 10.x"
    m = l.match(/ppp(?:oe)?[,:\s].*?\b([A-Za-z0-9._@-]+)\b.*(logged in|connected|logged out|disconnected|terminating)/i);
    if (m) {
      const inn = /(logged in|connected)/i.test(m[2]);
      return {
        level: inn ? 'up' : 'down',
        kind: 'PPPOE',
        username: m[1],
        message: `${m[1]} ${inn ? 'connected' : 'disconnected'}`,
        eventType: inn ? 'CONNECTION' : 'DISCONNECTION',
        severity: 'info',
      };
    }

    // optical signal:  "pon3 ONT signal low -30dBm"
    m = l.match(/(-?\d{1,2}(?:\.\d+)?)\s?dbm/i);
    if (m) {
      const dbm = Number(m[1]);
      const port = (l.match(/\b(pon\d+|gpon\d+|sfp\d+|ge[\d\/]+)\b/i) || [])[1];
      const sev = dbm <= -30 ? 'critical' : dbm <= -25 ? 'warning' : 'info';
      return {
        level: sev === 'critical' ? 'critical' : sev === 'warning' ? 'warning' : 'info',
        kind: 'SIGNAL',
        port,
        message: `${port || 'signal'} ${dbm.toFixed(1)}dBm`,
        eventType: dbm <= -30 ? 'SIGNAL_CRITICAL' : dbm <= -25 ? 'SIGNAL_WEAK' : 'SYSLOG',
        severity: sev,
      };
    }

    // hardware / excessive errors
    if (/excessive|error|fault|fail/i.test(l)) {
      const port = (l.match(/\b(pon\d+|sfp\d+|ether\d+|ge[\d\/]+)\b/i) || [])[1];
      return { level: 'warning', kind: 'ERROR', port, message: l.slice(0, 200), eventType: 'PORT_ERROR', severity: 'warning' };
    }

    return null;
  }
}
