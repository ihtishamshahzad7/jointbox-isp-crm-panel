import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RadiusSyncService } from '../nas/radius-sync.service';
import { CoaService } from './coa.service';
import { ScopeService } from '../common/scope.service';

/**
 * Phase 5 network operations. RADIUS tables live in the same Postgres DB,
 * so MAC binding is pure Prisma. Live sessions come from radacct.
 *
 * CoA disconnect uses the `radclient` CLI (freeradius-utils) when present:
 *   RADIUS_SERVER_IP:incomingPort with the NAS secret. If radclient isn't
 *   installed, we still close the session in radacct and report degraded mode.
 */
@Injectable()
export class NetworkService {
  private readonly logger = new Logger(NetworkService.name);

  constructor(
    private prisma: PrismaService,
    private radiusSync: RadiusSyncService,
    private coa: CoaService,
    private scope: ScopeService,
  ) {}

  // ── Live sessions ─────────────────────────────────────────────
  async liveSessions(nasIp?: string, actor?: any) {
    const rows = await this.radiusSync.getActiveSessions(nasIp).catch(() => []);
    if (!rows.length) return [];
    const usernames = [...new Set(rows.map((r: any) => r.username).filter(Boolean))];
    // SECURITY: a non-admin may only see sessions for subscribers in its own
    // subtree — never the whole ISP's live users.
    const scopeWhere = await this.scope.subscriberWhere(actor);
    const subs = await this.prisma.subscriber.findMany({
      where: { AND: [{ username: { in: usernames } }, scopeWhere] },
      select: { id: true, username: true, fullName: true, phone: true, package: { select: { name: true } } },
    });
    const byUsername = new Map(subs.map((s) => [s.username, s]));
    const isAdmin = this.scope.isAdmin(actor?.role);
    return rows
      // drop any session whose subscriber is outside the caller's subtree
      .filter((r: any) => isAdmin || byUsername.has(r.username))
      .map((r: any) => {
      const sub = byUsername.get(r.username);
      const up = Number(r.upload_bytes || 0);
      const down = Number(r.download_bytes || 0);
      const secs = Number(r.duration_seconds || 0);
      return {
        username: r.username,
        subscriberId: sub?.id ?? null,
        fullName: sub?.fullName ?? null,
        phone: sub?.phone ?? null,
        package: sub?.package?.name ?? null,
        nasIp: r.nasipaddress,
        framedIp: r.framedipaddress,
        mac: r.callingstationid,
        startTime: r.acctstarttime,
        durationSeconds: secs,
        uploadBytes: up,
        downloadBytes: down,
        // rough live throughput = total bytes / session seconds
        rateBps: secs > 0 ? Math.round(((up + down) * 8) / secs) : 0,
      };
    });
  }

  async liveStats(actor?: any) {
    const sessions = await this.liveSessions(undefined, actor);
    const totalUp = sessions.reduce((a, s) => a + s.uploadBytes, 0);
    const totalDown = sessions.reduce((a, s) => a + s.downloadBytes, 0);
    return {
      online: sessions.length,
      knownSubscribers: sessions.filter((s) => s.subscriberId).length,
      totalUploadBytes: totalUp,
      totalDownloadBytes: totalDown,
      topTalkers: [...sessions].sort((a, b) => b.rateBps - a.rateBps).slice(0, 5),
    };
  }

  // ── CoA disconnect ────────────────────────────────────────────
  async disconnect(username: string) {
    // find the live session to get NAS IP + acct session id
    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT acctsessionid, nasipaddress, framedipaddress
      FROM radacct WHERE username = ${username} AND acctstoptime IS NULL
      ORDER BY acctstarttime DESC LIMIT 1`;
    if (!rows.length) throw new BadRequestException('No active session for this user');
    const session = rows[0];

    let method = 'radacct-only';
    try {
      // Standard RFC 3576 RADIUS Disconnect — vendor-agnostic (MikroTik, Cisco,
      // Juniper, pfSense, vBNG, OLTs). No external tool required.
      const res = await this.coa.disconnectByUsername(username);
      if (res.ok) {
        method = 'radius-coa';
        this.logger.log(`CoA disconnect ACK for ${username} → ${session.nasipaddress}`);
      } else {
        this.logger.warn(`CoA disconnect not acknowledged for ${username}: ${res.message}; closing session in DB only`);
      }
    } catch (e: any) {
      this.logger.warn(`CoA disconnect error for ${username} (${e.message}); closing session in DB only`);
    }

    // always close the session record so dashboards reflect reality
    await this.prisma.$executeRaw`
      UPDATE radacct SET acctstoptime = NOW(), acctterminatecause = 'Admin-Reset'
      WHERE acctsessionid = ${session.acctsessionid} AND acctstoptime IS NULL`;

    await this.prisma.activityLog.create({
      data: { action: 'DISCONNECT', entity: 'Session', details: `${username} via ${method}` },
    });
    return { disconnected: true, method };
  }

  /** Cut EVERY open session for a username (duplicate-login takedown). */
  async cutAllSessions(username: string) {
    const result = await this.coa.cutAllSessions(username);
    await this.prisma.activityLog.create({
      data: { action: 'DISCONNECT_ALL', entity: 'Session', details: `${username}: ${result.sessionsCut} session(s) cut, ${result.closed} row(s) closed` },
    });
    return { disconnected: true, ...result };
  }

  // ── MAC binding (radcheck Calling-Station-Id) ─────────────────
  async getMacBinding(username: string) {
    const rows = await this.prisma.radCheck.findMany({
      where: { username, attribute: 'Calling-Station-Id' },
      select: { value: true },
    });
    return { username, boundMacs: rows.map((r) => r.value) };
  }

  async bindMac(username: string, mac: string) {
    const clean = (mac || '').trim().toUpperCase();
    if (!/^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/.test(clean)) {
      throw new BadRequestException('Invalid MAC address (expected AA:BB:CC:DD:EE:FF)');
    }
    const sub = await this.prisma.subscriber.findUnique({ where: { username } });
    if (!sub) throw new BadRequestException('Subscriber not found');

    const exists = await this.prisma.radCheck.findFirst({
      where: { username, attribute: 'Calling-Station-Id', value: clean },
    });
    if (exists) return { bound: true, already: true };

    await this.prisma.radCheck.create({
      data: { username, attribute: 'Calling-Station-Id', op: '==', value: clean },
    });
    await this.prisma.serviceSettings.updateMany({ where: { subscriberId: sub.id }, data: { macAddress: clean } });
    await this.prisma.activityLog.create({
      data: { action: 'MAC_BIND', entity: 'Subscriber', entityId: sub.id, details: `${username} → ${clean}` },
    });
    return { bound: true };
  }

  async unbindMac(username: string, mac?: string) {
    await this.prisma.radCheck.deleteMany({
      where: { username, attribute: 'Calling-Station-Id', ...(mac ? { value: mac.toUpperCase() } : {}) },
    });
    await this.prisma.activityLog.create({
      data: { action: 'MAC_UNBIND', entity: 'Subscriber', details: `${username}${mac ? ` → ${mac}` : ' (all)'}` },
    });
    return { unbound: true };
  }

  /** Auto-learn: bind the MAC currently seen in the live session. */
  async autolearnMac(username: string) {
    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT callingstationid FROM radacct
      WHERE username = ${username} AND acctstoptime IS NULL AND callingstationid IS NOT NULL
      ORDER BY acctstarttime DESC LIMIT 1`;
    if (!rows.length || !rows[0].callingstationid) {
      throw new BadRequestException('No active session with a MAC to learn from');
    }
    return this.bindMac(username, rows[0].callingstationid);
  }
}
