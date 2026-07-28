import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { sendCoa, sessionAttributes, mikrotikRateLimit, RadiusCode, CoaSession } from './radius-coa';

/**
 * Dynamic session control via standard RFC 3576/5176 RADIUS CoA/Disconnect.
 *
 * VENDOR-AGNOSTIC: the same Disconnect-Request / CoA-Request works on MikroTik,
 * Cisco, Juniper, pfSense, vBNG/BiSON and any RADIUS OLT/BNG — no per-vendor
 * API needed. For MikroTik we additionally keep the router-API path as a
 * fallback (some setups don't open the CoA port), so it degrades gracefully.
 */
@Injectable()
export class CoaService {
  private readonly logger = new Logger(CoaService.name);

  constructor(private prisma: PrismaService) {}

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
        const { MikrotikService } = await import('../mikrotik/mikrotik.service');
        const mikrotik = new MikrotikService();
        await mikrotik.disconnectPppoeUser(
          sub.nas.nasIp, sub.nas.apiPort ?? 8728, sub.nas.apiUsername, sub.nas.apiPassword, sub.username!,
        );
        this.logger.log(`✅ Disconnect via MikroTik API: ${sub.username}`);
        return { success: true, message: 'Disconnected via router API (CoA unavailable)', method: 'mikrotik-api' };
      }
    } catch (e: any) {
      this.logger.error(`MikroTik API disconnect failed for ${sub.username}: ${e.message}`);
    }
    return { success: false, message: 'Could not disconnect — no CoA acknowledgement and no working router API. Check the NAS shared secret and that the CoA port (3799) is reachable.' };
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
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO radcheck (username, attribute, op, value)
         VALUES ($1, 'MikroTik-Rate-Limit', ':=', $2)
         ON CONFLICT (username, attribute) DO UPDATE SET value = $2`,
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
}

/** Pick the CoA port — never the auth/acct ports; default 3799. */
function coaPort(p?: number | null): number {
  if (p && p !== 1812 && p !== 1813) return p;
  return 3799;
}
