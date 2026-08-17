import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RadiusSyncService } from '../nas/radius-sync.service';
import { CoaService } from './coa.service';
import { ScopeService } from '../common/scope.service';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    // Needed so a disconnect can fall back to the router's own API when CoA
    // is not acknowledged — see disconnect() below.
    private mikrotik: MikrotikSyncService,
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
  /**
   * Disconnect a live session, for real.
   *
   * THE BUG THIS FIXES: the old version trusted two things that are routinely
   * untrue in the field.
   *
   *   1. It required an open `radacct` row and threw "No active session" when
   *      there wasn't one. But radacct only reflects reality when the NAS sends
   *      Interim-Updates — without them a row can be missing, stale or already
   *      closed while the customer is very much online. The operator then had
   *      to log into the router and remove the session by hand.
   *   2. When CoA was not acknowledged it closed the radacct row anyway and
   *      returned `disconnected: true`. The panel showed the customer offline
   *      while the router kept forwarding their traffic — the worst kind of
   *      failure, because nobody goes looking for it.
   *
   * Now the router itself is the source of truth: if CoA does not land we go
   * straight at the MikroTik API and remove /ppp/active, and we only report
   * success when something actually cut the session.
   */
  async disconnect(username: string) {
    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT acctsessionid, nasipaddress, framedipaddress
      FROM radacct WHERE username = ${username} AND acctstoptime IS NULL
      ORDER BY acctstarttime DESC LIMIT 1`;
    const session = rows[0] ?? null;

    const sub = await this.prisma.subscriber.findUnique({
      where: { username },
      select: { id: true, nas: true },
    });
    const nas = sub?.nas as any;
    const hasApi = !!(nas?.nasIp && nas.apiUsername && nas.apiPassword);

    // No accounting row AND no way to ask the router — nothing we can do.
    if (!session && !hasApi) {
      throw new BadRequestException(
        'No active session for this user, and this NAS has no API credentials ' +
          'configured, so the router cannot be checked directly.',
      );
    }

    const trail: string[] = []; // session action log — every attempt, not just the winning one
    let method = 'none';
    let cut = false;

    // 1. Standard RFC 3576 Disconnect-Request — vendor-agnostic (MikroTik,
    //    Cisco, Juniper, pfSense, vBNG, OLTs). No external tool required.
    try {
      const res = await this.coa.disconnectByUsername(username);
      trail.push(`radius-coa: ${res.ok ? 'ACK' : `not acknowledged (${res.message})`}`);
      if (res.ok) {
        method = 'radius-coa';
        cut = true;
        this.logger.log(`CoA disconnect ACK for ${username} → ${session?.nasipaddress ?? nas?.nasIp}`);
      } else {
        this.logger.warn(`CoA disconnect not acknowledged for ${username}: ${res.message}`);
      }
    } catch (e: any) {
      trail.push(`radius-coa: error (${e.message})`);
      this.logger.warn(`CoA disconnect error for ${username}: ${e.message}`);
    }

    // 2. CoA did not land — go directly at the router. This is the step that
    //    was missing: without it the panel reported a disconnect that never
    //    happened and the customer stayed online.
    //
    //    disconnectPppoeUser now reports found/removed separately (it used to
    //    return `true` whenever the API call didn't throw, even when the
    //    print filter matched ZERO sessions — a name mismatch or an already-
    //    dead session looked exactly like a successful kill). "found:false"
    //    means the router already agrees the user is offline — that's a
    //    legitimate success too, just not one where anything was removed.
    if (!cut && hasApi) {
      try {
        const r = await this.mikrotik.disconnectPppoeUser(
          nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, username,
        );
        trail.push(`mikrotik-api: ${!r.found ? 'no active session found (already offline)' : r.removed ? `${r.sessionIds.length} session(s) removed` : 'session found but remove did not confirm'}`);
        if (r.removed || !r.found) {
          cut = true;
          method = r.found ? 'mikrotik-api' : 'already-offline';
          this.logger.log(`CoA did not land for ${username}; ${trail[trail.length - 1]} (via MikroTik API)`);
        }
      } catch (e: any) {
        trail.push(`mikrotik-api: error (${e?.message || e})`);
        this.logger.warn(`MikroTik API disconnect failed for ${username}: ${e?.message || e}`);
      }
    }

    // 3. VERIFY, don't assume. A CoA ACK or a reported MikroTik removal is
    //    what the OLD code trusted blindly — but a router can ACK a
    //    Disconnect-Request and still keep the session (bugs, queued
    //    teardown, a stale entry the remove didn't actually match). If the
    //    NAS exposes its API, ask it directly whether the user is still
    //    there, and only accept "disconnected" once the router itself agrees.
    let verified: boolean | null = null; // null = no way to verify (no API creds)
    if (hasApi && cut) {
      await sleep(1500);
      try {
        const stillActive = await this.mikrotik.isSessionActive(
          nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, username,
        );
        if (!stillActive) {
          verified = true;
        } else {
          // Whatever succeeded above did not actually take. One hard-kill
          // retry via the API before giving up, then re-check.
          trail.push(`verify: still active after ${method} — retrying mikrotik-api removal`);
          const retry = await this.mikrotik
            .disconnectPppoeUser(nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, username)
            .catch((e: any) => { trail.push(`mikrotik-api retry: error (${e?.message || e})`); return null; });
          if (retry) trail.push(`mikrotik-api retry: ${retry.removed ? `${retry.sessionIds.length} session(s) removed` : 'remove did not confirm'}`);
          await sleep(1200);
          const stillActive2 = await this.mikrotik
            .isSessionActive(nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, username)
            .catch((e: any) => { trail.push(`verify retry: error (${e?.message || e})`); return true; });
          verified = !stillActive2;
          if (verified && retry?.removed) method = 'mikrotik-api';
        }
        trail.push(`verify: ${verified ? 'session NOT FOUND on router — confirmed offline' : 'session STILL ACTIVE on router'}`);
      } catch (e: any) {
        // Could not reach the router to verify (it may have gone down between
        // the disconnect call and now). Don't silently claim success — but
        // don't downgrade a real CoA ACK either; report as unverified.
        trail.push(`verify: could not reach router (${e?.message || e})`);
      }
    }

    // A verified-active session means the disconnect genuinely failed, no
    // matter what the CoA/API layer reported.
    if (verified === false) cut = false;

    // 4. Close the accounting row ONLY when the session was really cut (and,
    //    when verifiable, actually confirmed gone). Closing it after a failed
    //    disconnect is what made the panel lie.
    if (cut && session) {
      await this.prisma.$executeRaw`
        UPDATE radacct SET acctstoptime = NOW(), acctterminatecause = 'Admin-Reset'
        WHERE acctsessionid = ${session.acctsessionid} AND acctstoptime IS NULL`;
    }

    await this.prisma.activityLog.create({
      data: {
        action: cut ? 'DISCONNECT' : 'DISCONNECT_FAILED',
        entity: 'Session',
        entityId: sub?.id ?? null,
        details:
          `${username} @ ${nas?.nasname ?? nas?.nasIp ?? 'unknown NAS'}` +
          (session?.acctsessionid ? ` (session ${session.acctsessionid})` : '') +
          ` — ${trail.join(' → ')} — ` +
          (cut ? `SUCCESS via ${method}` : 'FAILED — still online'),
      },
    }).catch(() => null);

    if (!cut) {
      throw new BadRequestException(
        `${username} could not be disconnected — the session is still active on the router. ` +
          trail.join(' → ') +
          `. Check CoA port 3799, the RADIUS shared secret, and the NAS API credentials.`,
      );
    }

    return {
      disconnected: true,
      method,
      verified: verified === null ? 'unverified (NAS has no API credentials configured)' : 'confirmed offline on the router',
    };
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
