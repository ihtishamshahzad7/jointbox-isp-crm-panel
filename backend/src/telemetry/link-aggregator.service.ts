import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PORT_ERROR_PER_MIN } from './oids';

export type FeedLevel = 'info' | 'up' | 'down' | 'warning' | 'critical';

export interface FeedItem {
  id: number;
  ts: number;
  nasId: number;
  nasName: string;
  level: FeedLevel;
  kind: string; // UP | DOWN | FLAP | SIGNAL | ERROR | NAS | SYSLOG | PPPOE
  port?: string;
  username?: string;
  dbm?: number;
  message: string;
}

/**
 * Link event aggregator — the single place that decides what raw telemetry
 * MEANS. The SNMP poller and the syslog receiver both feed it; it dedups,
 * detects flaps, applies signal thresholds, and records durable NetworkLog rows
 * while also keeping a small in-memory ring buffer for the live sidebar feed.
 *
 * Keeping the logic here (not in the collectors) means MikroTik-API, SNMP and
 * syslog all raise events the same way and the same alert never fires twice.
 */
@Injectable()
export class LinkAggregatorService {
  private readonly log = new Logger('LinkAggregator');

  private nasReachable = new Map<number, boolean>();
  private ifUp = new Map<string, boolean>(); // `${nasId}:${ifIndex}` → up?
  private downTimes = new Map<string, number[]>(); // flap window (1h) of down events
  private signalAlertedAt = new Map<string, number>(); // debounce signal alerts (15m)
  private errorAlertedAt = new Map<string, number>();

  private feed: FeedItem[] = [];
  private feedSeq = 1;
  private readonly FEED_MAX = 250;

  constructor(private prisma: PrismaService) {}

  /** Most-recent events for the live sidebar (newest first). */
  getFeed(limit = 50): FeedItem[] {
    return this.feed.slice(-limit).reverse();
  }

  private push(item: Omit<FeedItem, 'id' | 'ts'>) {
    const full: FeedItem = { ...item, id: this.feedSeq++, ts: Date.now() };
    this.feed.push(full);
    if (this.feed.length > this.FEED_MAX) this.feed.splice(0, this.feed.length - this.FEED_MAX);
    return full;
  }

  private async record(
    nasId: number,
    eventType: any,
    severity: 'info' | 'warning' | 'critical',
    message: string,
    extra: { username?: string; port?: string } = {},
  ) {
    try {
      await this.prisma.networkLog.create({
        data: {
          nasId,
          eventType,
          severity,
          message,
          username: extra.username,
          eventReason: extra.port,
        },
      });
    } catch (e: any) {
      this.log.debug(`record failed: ${e?.message || e}`);
    }
  }

  // ---- NAS reachability -----------------------------------------------------
  async onNasReachable(nas: any) {
    if (this.nasReachable.get(nas.id) === true) return;
    const was = this.nasReachable.get(nas.id);
    this.nasReachable.set(nas.id, true);
    if (was === false) {
      this.push({ nasId: nas.id, nasName: nas.nasname, level: 'up', kind: 'NAS', message: `${nas.nasname} reachable again` });
      await this.record(nas.id, 'NAS_ONLINE', 'info', `SNMP reachable`);
    }
  }

  async onNasUnreachable(nas: any) {
    if (this.nasReachable.get(nas.id) === false) return;
    this.nasReachable.set(nas.id, false);
    this.push({ nasId: nas.id, nasName: nas.nasname, level: 'critical', kind: 'NAS', message: `${nas.nasname} not responding to SNMP` });
    await this.record(nas.id, 'NAS_OFFLINE', 'critical', `No SNMP response`);
  }

  // ---- Interface up/down + flap ---------------------------------------------
  async onInterfaceStatus(nas: any, ifIndex: number, port: string, up: boolean) {
    const key = `${nas.id}:${ifIndex}`;
    const prev = this.ifUp.get(key);
    if (prev === up) return; // no change
    this.ifUp.set(key, up);
    if (prev === undefined) return; // first observation, don't alert

    if (up) {
      this.push({ nasId: nas.id, nasName: nas.nasname, level: 'up', kind: 'UP', port, message: `${port} link UP` });
      await this.record(nas.id, 'LINK_UP', 'info', `${port} up`, { port });
    } else {
      this.push({ nasId: nas.id, nasName: nas.nasname, level: 'down', kind: 'DOWN', port, message: `${port} link DOWN` });
      await this.record(nas.id, 'LINK_DOWN', 'warning', `${port} down`, { port });

      // flap detection — 3+ downs within the last hour
      const now = Date.now();
      const arr = (this.downTimes.get(key) || []).filter((t) => now - t < 3600_000);
      arr.push(now);
      this.downTimes.set(key, arr);
      if (arr.length >= 3) {
        this.push({ nasId: nas.id, nasName: nas.nasname, level: 'warning', kind: 'FLAP', port, message: `${port} flapping — ${arr.length}× in 1h` });
        await this.record(nas.id, 'LINK_FLAP', 'warning', `${port} flapping ${arr.length}x/1h`, { port });
      }
    }
  }

  // ---- Port errors ----------------------------------------------------------
  async onPortErrors(nas: any, ifIndex: number, port: string, perMin: number) {
    if (perMin < PORT_ERROR_PER_MIN) return;
    const key = `${nas.id}:${ifIndex}`;
    const last = this.errorAlertedAt.get(key) || 0;
    if (Date.now() - last < 5 * 60_000) return; // at most one alert / 5 min
    this.errorAlertedAt.set(key, Date.now());
    this.push({ nasId: nas.id, nasName: nas.nasname, level: 'warning', kind: 'ERROR', port, message: `${port} errors ${Math.round(perMin)}/min` });
    await this.record(nas.id, 'PORT_ERROR', 'warning', `${port} ${Math.round(perMin)} errors/min`, { port });
  }

  // ---- Optical signal -------------------------------------------------------
  async onSignal(
    nas: any,
    s: { kind: string; ifIndex?: number; port?: string; dbm: number; status: 'GOOD' | 'WEAK' | 'CRITICAL'; username?: string; subscriberId?: number },
  ) {
    // Store the reading (time-series for the subscriber signal chart).
    try {
      await this.prisma.linkSignal.create({
        data: {
          nasId: nas.id,
          subscriberId: s.subscriberId,
          username: s.username,
          kind: s.kind,
          ifIndex: s.ifIndex,
          port: s.port,
          dbm: s.dbm,
          status: s.status,
        },
      });
    } catch (e: any) {
      this.log.debug(`signal store failed: ${e?.message || e}`);
    }

    if (s.status === 'GOOD') return;
    const key = `${nas.id}:${s.port || s.ifIndex}:${s.status}`;
    const last = this.signalAlertedAt.get(key) || 0;
    if (Date.now() - last < 15 * 60_000) return; // debounce 15 min
    this.signalAlertedAt.set(key, Date.now());

    const dbmTxt = `${s.dbm.toFixed(1)}dBm`;
    if (s.status === 'CRITICAL') {
      this.push({ nasId: nas.id, nasName: nas.nasname, level: 'critical', kind: 'SIGNAL', port: s.port, dbm: s.dbm, username: s.username, message: `${s.port || 'signal'} critical ${dbmTxt}` });
      await this.record(nas.id, 'SIGNAL_CRITICAL', 'critical', `${s.port || 'signal'} ${dbmTxt}`, { port: s.port, username: s.username });
    } else {
      this.push({ nasId: nas.id, nasName: nas.nasname, level: 'warning', kind: 'SIGNAL', port: s.port, dbm: s.dbm, username: s.username, message: `${s.port || 'signal'} weak ${dbmTxt}` });
      await this.record(nas.id, 'SIGNAL_WEAK', 'warning', `${s.port || 'signal'} ${dbmTxt}`, { port: s.port, username: s.username });
    }
  }

  // ---- Raw syslog line (already parsed) -------------------------------------
  async onSyslog(
    nas: any,
    p: { level: FeedLevel; kind: string; message: string; username?: string; port?: string; eventType?: any; severity?: 'info' | 'warning' | 'critical' },
  ) {
    this.push({ nasId: nas.id, nasName: nas.nasname, level: p.level, kind: p.kind, port: p.port, username: p.username, message: p.message });
    await this.record(nas.id, p.eventType || 'SYSLOG', p.severity || 'info', p.message, { username: p.username, port: p.port });
  }
}
