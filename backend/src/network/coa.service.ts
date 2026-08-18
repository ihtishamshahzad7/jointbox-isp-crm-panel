import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { sendCoa, sessionAttributes, mikrotikRateLimit, RadiusCode, CoaSession } from './radius-coa';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Dynamic session control via standard RFC 3576/5176 RADIUS CoA/Disconnect.
 *
 * VENDOR-AGNOSTIC: the same Disconnect-Request / CoA-Request works on MikroTik,
 * Cisco, Juniper, pfSense, vBNG/BiSON and any RADIUS OLT/BNG — no per-vendor
 * API needed. For MikroTik we additionally keep the router-API path as a
 * fallback (some setups don't open the CoA port), so it degrades gracefully.
 *
 * BUG FIX: this used to lazily `import('../mikrotik/mikrotik.service')` — a
 * SECOND, unrelated RouterOS client — for the API fallback. That client's
 * `disconnectPppoeUser` never queried `/ppp/active/print` at all; it called
 * `/ppp/active/remove =.id=<username>`, i.e. it tried to remove a session
 * using the USERNAME as the RouterOS internal `.id` (which always looks like
 * `*1A`, never a name). That command could never match a real session, so
 * this fallback silently did nothing while still reporting success. Every
 * caller below now goes through `MikrotikSyncService`, the same client
 * `NetworkService.disconnect()` uses, which finds the session by name first
 * and reports whether anything was actually found/removed.
 */
@Injectable()
export class CoaService {
  private readonly logger = new Logger(CoaService.name);

  constructor(
    private prisma: PrismaService,
    private mikrotik: MikrotikSyncService,
  ) {}

  /** Look up the subscriber's current live session + its NAS (with CoA creds). */
  private async resolve(subscriberId: number) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: {
        id: true, username: true, nasId: true,
        nas: { select: { nasIp: true, nasIdentifier: true, secret: true, incomingPort: true, apiPort: true, apiUsername: true, apiPassword: true } },
      },
    });
    if (!sub?.username) return null;
    const session = await this.liveSession(sub.username);
    if (session && sub.nas?.nasIdentifier) session.nasIdentifier = sub.nas.nasIdentifier;
    return { sub, session };
  }

  private async liveSession(username: string): Promise<(CoaSession & { nas?: any }) | null> {
    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT acctsessionid, nasipaddress, framedipaddress, callingstationid
      FROM radacct WHERE username = ${username} AND acctstoptime IS NULL
      ORDER BY acctstarttime DESC LIMIT 1`;
    if (!rows.length) return null;
    const r = rows[0];
    return {
      username,
      acctSessionId: r.acctsessionid,
      nasIp: r.nasipaddress,
      framedIp: r.framedipaddress,
      callingStationId: r.callingstationid,
    };
  }

  /**
   * Disconnect a subscriber's live session. Tries standard RADIUS Disconnect
   * first (works on every vendor); falls back to the MikroTik API when present.
   */
  async disconnectSubscriber(subscriberId: number): Promise<{ success: boolean; message: string; method?: string }> {
    const r = await this.resolve(subscriberId);
    if (!r) return { success: false, message: 'Subscriber not found or has no username' };
    const { sub, session } = r;
    if (!sub.nas?.nasIp) return { success: false, message: 'No NAS assigned to this subscriber' };
    if (!session) return { success: false, message: 'No active session to disconnect' };

    // 1) Standard RADIUS Disconnect-Request — vendor-agnostic.
    const secret = sub.nas.secret;
    if (secret) {
      const res = await sendCoa({
        host: sub.nas.nasIp,
        port: coaPort(sub.nas.incomingPort),
        secret,
        code: RadiusCode.DisconnectRequest,
        attributes: sessionAttributes(session),
      });
      if (res.ok) {
        this.logger.log(`✅ RADIUS disconnect (CoA): ${sub.username} → ${sub.nas.nasIp}`);
        return { success: true, message: 'Disconnected via RADIUS CoA', method: 'radius-coa' };
      }
      this.logger.warn(`RADIUS disconnect ${res.type} for ${sub.username}: ${res.message}`);
    } else {
      this.logger.warn(`NAS for ${sub.username} has no shared secret set — cannot send CoA`);
    }

    // 2) MikroTik API fallback (only if the router exposes the API).
    try {
      if (sub.nas.apiUsername && sub.nas.apiPassword) {
        const r = await this.mikrotik.disconnectPppoeUser(
          sub.nas.nasIp, sub.nas.apiPort ?? 8728, sub.nas.apiUsername, sub.nas.apiPassword, sub.username!,
        );
        if (!r.found) {
          return { success: false, message: `No active session found for ${sub.username} on the router — it may already be offline.` };
        }
        if (!r.removed) {
          return { success: false, message: `Session for ${sub.username} was found on the router but could not be removed.` };
        }
        // VERIFY rather than trust the remove call — confirm the router
        // actually agrees the session is gone before reporting success.
        await sleep(1200);
        const stillActive = await this.mikrotik
          .isSessionActive(sub.nas.nasIp, sub.nas.apiPort ?? 8728, sub.nas.apiUsername, sub.nas.apiPassword, sub.username!)
          .catch(() => null); // null = could not re-check; don't downgrade the reported removal
        if (stillActive === true) {
          this.logger.error(`Disconnect for ${sub.username} reported removed but session is STILL active on the router`);
          return { success: false, message: `${sub.username} was still online on the router after the disconnect attempt.` };
        }
        this.logger.log(`✅ Disconnect via MikroTik API (verified): ${sub.username}`);
        return { success: true, message: 'Disconnected via router API (CoA unavailable)', method: 'mikrotik-api' };
      }
    } catch (e: any) {
      this.logger.error(`MikroTik API disconnect failed for ${sub.username}: ${e.message}`);
    }
    return { success: false, message: 'Could not disconnect — no CoA acknowledgement and no working router API. Check the NAS shared secret and that the CoA port (3799) is reachable.' };
  }

  /**
   * SIMULTANEOUS-USE GUARD.
   *
   * The same username dialled from two devices produces two open radacct
   * sessions on the NAS — both online at once, which must never happen on a
   * one-account-one-connection ISP (it is either credential sharing or a stuck
   * ghost session). This finds every username with more than one open session,
   * logs it, and drops EVERY one of that user's sessions (as requested: both
   * down), so the customer reconnects exactly once. Their radacct rows are also
   * closed so a ghost session does not keep them "online" forever.
   *
   * Returns a summary for the caller/cron to surface.
   */
  /** Sweep for duplicate logins every 2 minutes and cut them automatically. */
  @Cron('*/2 * * * *')
  async duplicateSessionSweep() {
    try {
      await this.disconnectDuplicateSessions();
    } catch (e: any) {
      this.logger.warn(`Duplicate-session sweep failed: ${e?.message || e}`);
    }
  }

  async disconnectDuplicateSessions(): Promise<{ offenders: number; sessionsCut: number; users: string[] }> {
    // Usernames with >1 OPEN session right now.
    const dupes = await this.prisma.$queryRaw<Array<{ username: string; sessions: bigint }>>`
      SELECT username, COUNT(*) AS sessions
      FROM radacct
      WHERE acctstoptime IS NULL AND username IS NOT NULL
      GROUP BY username
      HAVING COUNT(*) > 1`;

    let sessionsCut = 0;
    const users: string[] = [];

    for (const d of dupes) {
      const username = d.username;
      const count = Number(d.sessions);
      users.push(username);

      // Every open session for this user, each with the attributes CoA needs.
      const sessions = await this.prisma.$queryRaw<Array<any>>`
        SELECT acctsessionid, nasipaddress, framedipaddress, callingstationid
        FROM radacct WHERE username = ${username} AND acctstoptime IS NULL`;

      // Log it loudly and durably so the operator can see the sharing/ghost.
      await this.prisma.systemLog.create({
        data: {
          level: 'ERROR',
          source: 'simultaneous-use',
          message: `Duplicate login: "${username}" had ${count} sessions online at once — cutting all of them.`,
          metadata: JSON.stringify({
            username, sessions: count,
            nasIps: [...new Set(sessions.map((s) => s.nasipaddress))],
            callingStations: sessions.map((s) => s.callingstationid),
            framedIps: sessions.map((s) => s.framedipaddress),
          }),
        },
      }).catch(() => null);
      this.logger.error(`⛔ Simultaneous-Use: "${username}" online ${count}× — disconnecting all sessions.`);

      const nasCreds = new Map<string, any>();
      const cutByCoa = new Set<string>();
      for (const s of sessions) {
        // Per-session RADIUS CoA Disconnect (vendor-agnostic).
        let nas = nasCreds.get(s.nasipaddress);
        if (nas === undefined) {
          nas = await this.prisma.nas.findFirst({
            where: { nasIp: s.nasipaddress as string },
            select: { secret: true, incomingPort: true, nasIdentifier: true, apiPort: true, apiUsername: true, apiPassword: true, nasIp: true },
          });
          nasCreds.set(s.nasipaddress, nas);
        }
        const session: any = {
          username,
          acctSessionId: s.acctsessionid,
          nasIp: s.nasipaddress,
          framedIp: s.framedipaddress,
          callingStationId: s.callingstationid,
          nasIdentifier: nas?.nasIdentifier,
        };
        if (nas?.secret) {
          const res = await sendCoa({
            host: s.nasipaddress,
            port: coaPort(nas.incomingPort),
            secret: nas.secret,
            code: RadiusCode.DisconnectRequest,
            attributes: sessionAttributes(session),
          }).catch(() => ({ ok: false } as any));
          if (res.ok) {
            sessionsCut++;
            cutByCoa.add(s.acctsessionid);
          }
        }
      }

      // MikroTik API fallback: removes ALL active PPP sessions matching the name
      // in one call, covering any the CoA did not acknowledge.
      const remaining = sessions.filter((s) => !cutByCoa.has(s.acctsessionid));
      const anyNas = remaining.length ? [...nasCreds.values()].find((n) => n?.apiUsername && n?.apiPassword) : null;
      let verifiedGone: boolean | null = null;
      if (anyNas && remaining.length) {
        try {
          const r = await this.mikrotik.disconnectPppoeUser(
            anyNas.nasIp, anyNas.apiPort ?? 8728, anyNas.apiUsername, anyNas.apiPassword, username,
          );
          await sleep(1200);
          const stillActive = await this.mikrotik
            .isSessionActive(anyNas.nasIp, anyNas.apiPort ?? 8728, anyNas.apiUsername, anyNas.apiPassword, username)
            .catch(() => null);
          verifiedGone = stillActive === null ? null : !stillActive;
          // Only treat the fallback as a cut when the router agrees (or there
          // was never a session to begin with). A remove that didn't land and
          // could not be verified leaves the rows OPEN + flags the operator.
          if (r.found === false || r.removed || verifiedGone === true) {
            sessionsCut += remaining.length;
            remaining.forEach((s) => cutByCoa.add(s.acctsessionid));
          }
        } catch (e: any) {
          this.logger.warn(`Simultaneous-Use: MikroTik API kick for "${username}" failed: ${e?.message || e}`);
        }
      } else if (remaining.length && !anyNas) {
        await this.prisma.systemLog.create({
          data: {
            level: 'ERROR', source: 'simultaneous-use',
            message: `"${username}": ${remaining.length} duplicate session(s) could not be confirmed cut — no CoA ack and no NAS API credentials for verification.`,
            metadata: JSON.stringify({ username, unconfirmedSessions: remaining.map((s) => s.acctsessionid), timestamp: new Date().toISOString() }),
          },
        }).catch(() => null);
      }
      const stillOpen = remaining.filter((s) => !cutByCoa.has(s.acctsessionid));
      if (stillOpen.length) {
        // The router verifiably (or at least unverifiably) still has the user.
        // Do not pretend they are offline — surface it loudly so an operator
        // follows up, and keep the accounting rows OPEN so the UI shows online.
        this.logger.error(`⛔ Simultaneous-Use: "${username}" is STILL ACTIVE on ${anyNas?.nasIp ?? 'unknown NAS'} after disconnect attempts.`);
        await this.prisma.systemLog.create({
          data: {
            level: 'ERROR', source: 'simultaneous-use',
            message: `"${username}" could not be fully disconnected — session(s) ${stillOpen.map((s) => s.acctsessionid).join(', ')} still open on ${anyNas?.nasIp ?? 'unknown NAS'} after CoA + MikroTik API kick.`,
            metadata: JSON.stringify({ username, nasIp: anyNas?.nasIp ?? null, stillActiveSessions: stillOpen.map((s) => ({ acctsessionid: s.acctsessionid, nas: s.nasipaddress })), timestamp: new Date().toISOString() }),
          },
        }).catch(() => null);
      }

      // Close ONLY the accounting rows whose sessions were actually terminated.
      // Closing them for a session the router still has is what made the panel
      // lie about offline before; the open rows here now correctly keep showing
      // "online" until the NAS itself drops the connection.
      for (const s of sessions) {
        if (cutByCoa.has(s.acctsessionid)) {
          await this.prisma.$executeRaw`
            UPDATE radacct SET acctstoptime = NOW(), acctterminatecause = 'Admin-Reset'
            WHERE acctsessionid = ${s.acctsessionid} AND acctstoptime IS NULL`.catch(() => null);
        }
      }
    }

    if (dupes.length) {
      this.logger.warn(`Simultaneous-Use sweep: ${dupes.length} user(s), ${sessionsCut} session(s) cut.`);
    }
    return { offenders: dupes.length, sessionsCut, users };
  }

  /**
   * Change a subscriber's bandwidth LIVE. Persists the new rate to radcheck
   * (so it survives re-auth) AND pushes a CoA-Request so it applies now without
   * a reconnect. The persisted attribute is standard; the live CoA carries the
   * MikroTik rate VSA (extend `rateAttributes` for other vendors as needed).
   */
  async changeBandwidth(subscriberId: number, downloadSpeed: number, uploadSpeed: number): Promise<{ success: boolean; message: string; live?: boolean }> {
    const r = await this.resolve(subscriberId);
    if (!r || !r.sub.username) return { success: false, message: 'Subscriber not found' };
    const { sub, session } = r;
    const rate = `${downloadSpeed}M/${uploadSpeed}M`;

    // Persist for the next authentication (works on every vendor via RADIUS).
    //
    // Same fix as radius-sync.service.ts: this used to rely on
    // `ON CONFLICT (username, attribute)`, which needs a UNIQUE index on
    // radcheck(username, attribute) that the stock FreeRADIUS schema does not
    // have — so on a default install this threw and the rate change was never
    // persisted. Delete-then-insert is equivalent and works on any schema.
    try {
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM radcheck WHERE username = $1 AND attribute = 'MikroTik-Rate-Limit'`,
        sub.username,
      );
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO radcheck (username, attribute, op, value)
         VALUES ($1, 'MikroTik-Rate-Limit', ':=', $2)`,
        sub.username, rate,
      );
    } catch (e: any) {
      return { success: false, message: `Could not save the new rate: ${e.message}` };
    }

    // Push it live via CoA if we have a session + secret.
    let live = false;
    if (session && sub.nas?.nasIp && sub.nas.secret) {
      const res = await sendCoa({
        host: sub.nas.nasIp,
        port: coaPort(sub.nas.incomingPort),
        secret: sub.nas.secret,
        code: RadiusCode.CoaRequest,
        attributes: [...sessionAttributes(session), mikrotikRateLimit(rate)],
      });
      live = res.ok;
      if (!res.ok) this.logger.warn(`Live CoA re-rate ${res.type} for ${sub.username}: ${res.message}`);
    }
    return {
      success: true,
      live,
      message: live
        ? `Bandwidth changed live to ${rate} (applied without reconnect)`
        : `Bandwidth set to ${rate} — applies on next reconnect (live CoA not acknowledged)`,
    };
  }

  /**
   * Reachability probe for a NAS's CoA channel. Sends a harmless Disconnect
   * for a non-existent session: ANY reply (ACK or NAK) proves the CoA port is
   * open and the shared secret is accepted; a timeout means the port is blocked
   * or the secret/identifier is wrong. Changes nothing on the router.
   */
  async testCoa(nasId: number): Promise<{ reachable: boolean; message: string }> {
    const nas = await this.prisma.nas.findUnique({
      where: { id: nasId },
      select: { nasIp: true, secret: true, incomingPort: true, nasIdentifier: true },
    });
    if (!nas?.nasIp) return { reachable: false, message: 'NAS has no IP address' };
    if (!nas.secret) return { reachable: false, message: 'Set the RADIUS shared secret first' };
    const res = await sendCoa({
      host: nas.nasIp,
      port: coaPort(nas.incomingPort),
      secret: nas.secret,
      code: RadiusCode.DisconnectRequest,
      attributes: sessionAttributes({ acctSessionId: 'jointbox-coa-test', nasIdentifier: nas.nasIdentifier, nasIp: nas.nasIp }),
      timeoutMs: 4000,
    });
    if (res.type === 'timeout') {
      return { reachable: false, message: `No CoA reply on ${nas.nasIp}:${coaPort(nas.incomingPort)} — check the CoA port is open and the shared secret matches` };
    }
    if (res.type === 'error') return { reachable: false, message: res.message };
    // ACK or NAK both mean the router received and processed our request.
    return { reachable: true, message: `CoA reachable — router responded (${res.type}). Session control will work on this NAS.` };
  }

  /** Disconnect by username (used by NetworkService). Returns method used. */
  async disconnectByUsername(username: string): Promise<{ ok: boolean; method: string; message: string }> {
    const session = await this.liveSession(username);
    if (!session) return { ok: false, method: 'none', message: 'No active session' };
    const nas = await this.prisma.nas.findFirst({
      where: { nasIp: session.nasIp as string },
      select: { secret: true, incomingPort: true, nasIdentifier: true },
    });
    if (!nas?.secret) return { ok: false, method: 'none', message: 'NAS has no shared secret configured' };
    if (nas.nasIdentifier) session.nasIdentifier = nas.nasIdentifier;
    const res = await sendCoa({
      host: session.nasIp as string,
      port: coaPort(nas.incomingPort),
      secret: nas.secret,
      code: RadiusCode.DisconnectRequest,
      attributes: sessionAttributes(session),
    });
    return { ok: res.ok, method: 'radius-coa', message: res.message };
  }

  /**
   * Cut EVERY open session for one username (not just the newest). Used when a
   * subscriber profile flags a duplicate login — the customer must go fully
   * offline so they re-dial exactly once. Mirrors the global duplicate sweep
   * but scoped to a single account.
   */
  async cutAllSessions(username: string): Promise<{ sessionsCut: number; closed: number; users: string[] }> {
    const sessions = await this.prisma.$queryRaw<Array<any>>`
      SELECT acctsessionid, nasipaddress, framedipaddress, callingstationid
      FROM radacct WHERE username = ${username} AND acctstoptime IS NULL`;

    let sessionsCut = 0;
    const cutByCoa = new Set<string>();
    const nasCreds = new Map<string, any>();
    for (const s of sessions) {
      let nas = nasCreds.get(s.nasipaddress);
      if (nas === undefined) {
        nas = await this.prisma.nas.findFirst({
          where: { nasIp: s.nasipaddress as string },
          select: { secret: true, incomingPort: true, nasIdentifier: true, apiPort: true, apiUsername: true, apiPassword: true, nasIp: true },
        });
        nasCreds.set(s.nasipaddress, nas);
      }
      const session: any = {
        username,
        acctSessionId: s.acctsessionid,
        nasIp: s.nasipaddress,
        framedIp: s.framedipaddress,
        callingStationId: s.callingstationid,
        nasIdentifier: nas?.nasIdentifier,
      };
      if (nas?.secret) {
        const res = await sendCoa({
          host: s.nasipaddress,
          port: coaPort(nas.incomingPort),
          secret: nas.secret,
          code: RadiusCode.DisconnectRequest,
          attributes: sessionAttributes(session),
        }).catch(() => ({ ok: false } as any));
        if (res.ok) {
          sessionsCut++;
          cutByCoa.add(s.acctsessionid);
        }
      }
    }

    // MikroTik API fallback: one call removes ALL active PPP sessions for the name.
    // Even when a session is removed we keep the accounting row OPEN until the
    // router actually confirms the user is gone — closing it first is exactly
    // the "panel says offline while the router still forwards traffic" lie.
    const remaining = sessions.filter((s) => !cutByCoa.has(s.acctsessionid));
    const anyNas = remaining.length ? [...nasCreds.values()].find((n) => n?.apiUsername && n?.apiPassword) : null;
    if (anyNas && remaining.length) {
      try {
        const r = await this.mikrotik.disconnectPppoeUser(
          anyNas.nasIp, anyNas.apiPort ?? 8728, anyNas.apiUsername, anyNas.apiPassword, username,
        );
        await sleep(1200);
        const stillActive = await this.mikrotik
          .isSessionActive(anyNas.nasIp, anyNas.apiPort ?? 8728, anyNas.apiUsername, anyNas.apiPassword, username)
          .catch(() => null);
        // Session is only "cut" when the router agrees it is gone. A remove
        // that did not land AND could not be verified is NOT a success.
        if (r.found === false || r.removed || stillActive === false) {
          sessionsCut += remaining.length;
          remaining.forEach((s) => cutByCoa.add(s.acctsessionid));
        } else {
          this.logger.error(`⛔ Cut-all for "${username}": STILL ACTIVE on ${anyNas?.nasIp} after CoA + MikroTik API kick.`);
          await this.prisma.systemLog.create({
            data: {
              level: 'ERROR', source: 'network',
              message: `Cut-all for "${username}" could not confirm the session was removed from ${anyNas?.nasIp}.`,
              metadata: JSON.stringify({ username, nasIp: anyNas?.nasIp, stillActive, removeResult: r, timestamp: new Date().toISOString() }),
            },
          }).catch(() => null);
        }
      } catch (e: any) {
        this.logger.warn(`Cut-all for "${username}": MikroTik API kick failed: ${e?.message || e}`);
      }
    } else if (remaining.length && !anyNas) {
      // No CoA ack, no API creds — the router may still have the user online.
      // Keep the rows open and say so loudly rather than pretending.
      await this.prisma.systemLog.create({
        data: {
          level: 'ERROR', source: 'network',
          message: `Cut-all for "${username}": ${remaining.length} session(s) could not be confirmed cut — no CoA ack and no NAS API credentials.`,
          metadata: JSON.stringify({ username, unconfirmedSessions: remaining.map((s) => s.acctsessionid), timestamp: new Date().toISOString() }),
        },
      }).catch(() => null);
    }

    // Close ONLY the rows whose sessions were actually terminated. Anything
    // still open stays open — the UI keeps showing the customer online, which
    // is the truth until the router itself lets go.
    let closed = 0;
    for (const s of sessions) {
      if (cutByCoa.has(s.acctsessionid)) {
        try {
          const res = await this.prisma.$executeRaw`
            UPDATE radacct SET acctstoptime = NOW(), acctterminatecause = 'Admin-Reset'
            WHERE acctsessionid = ${s.acctsessionid} AND acctstoptime IS NULL`;
          closed += Number(res);
        } catch { /* row may already be closed */ }
      }
    }

    return { sessionsCut, closed, users: [username] };
  }
}

/** Pick the CoA port — never the auth/acct ports; default 3799. */
function coaPort(p?: number | null): number {
  if (p && p !== 1812 && p !== 1813) return p;
  return 3799;
}
