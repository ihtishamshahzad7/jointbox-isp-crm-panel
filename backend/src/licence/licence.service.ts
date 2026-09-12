import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * LICENCE ENTITLEMENT
 *
 * Talks to the local `jointbox-licensed` agent over a unix socket and verifies
 * the signature on its answer.
 *
 * WHY VERIFY A LOCAL SOCKET RESPONSE
 * Because this file is TypeScript on the customer's own disk and they have
 * root. Someone can edit it. What they cannot do is forge the agent's Ed25519
 * signature — so a patched build that hardcodes `licensed: true` produces a
 * response that fails verification, and we record TAMPERED, which reaches the
 * licence server on the agent's next heartbeat along with the licence key.
 *
 * This does not make the panel uncrackable; nothing running on someone else's
 * hardware can be. It makes the cheap attack detectable and attributable.
 *
 * ── THE RULE THAT MUST NOT BE BROKEN ─────────────────────────────────────
 * Licensing must never take an ISP's subscribers offline. FreeRADIUS reads
 * Postgres directly and never calls this API, so auth and accounting cannot
 * break here — but the RADIUS *sync* and CoA endpoints can, and blocking those
 * silently desyncs the RADIUS tables, which is just as bad. LicenceGuard
 * exempts them explicitly; see licence.guard.ts.
 *
 * Uses Node built-ins only. No new dependency.
 */

export type LicenceState =
  | 'ACTIVE'
  | 'GRACE'
  | 'EXPIRED'
  | 'HARDWARE_MISMATCH'
  | 'INVALID'
  | 'UNLICENSED'
  | 'TAMPERED'
  | 'UNAVAILABLE';

export interface Entitlement {
  state: LicenceState;
  plan: string;
  max_subs: number;
  feat: string[];
  company: string;
  trial: boolean;
  exp: number;
  grace_ends: number;
  licensed: boolean;
  writable: boolean;
  message: string;
  nonce: string;
  session_pub: string;
  sig: string;
}

const SOCKET_PATH = process.env.JBX_LICENCE_SOCKET || '/run/jointbox/licensed.sock';
const RUN_DIR = process.env.JBX_RUN_DIR || '/run/jointbox';
const REFRESH_MS = Number(process.env.JBX_LICENCE_REFRESH_MS || 15 * 60 * 1000);
const QUERY_TIMEOUT_MS = Number(process.env.JBX_LICENCE_TIMEOUT_MS || 3000);

/**
 * Licensing off entirely. For development, and for anyone who forks this for
 * their own use — it is deliberately easy to find rather than hidden, because
 * hiding it in open source fools nobody and annoys contributors.
 */
export function licensingDisabled(): boolean {
  return process.env.JBX_LICENCE_ENFORCE === 'false';
}

@Injectable()
export class LicenceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LicenceService.name);
  private current: Entitlement | null = null;
  private timer?: NodeJS.Timeout;
  private lastLoggedState: LicenceState | null = null;

  async onModuleInit(): Promise<void> {
    if (licensingDisabled()) {
      this.log.warn('Licence enforcement is DISABLED (JBX_LICENCE_ENFORCE=false)');
      return;
    }
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    // Never hold the process open on shutdown.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── what the rest of the app asks ──────────────────────────────────────

  get state(): LicenceState {
    if (licensingDisabled()) return 'ACTIVE';
    return this.current?.state ?? 'UNAVAILABLE';
  }

  /**
   * Whether the panel should behave as licensed.
   *
   * UNAVAILABLE — the agent is not installed or not running — counts as
   * LICENSED on purpose. A stopped service, a failed upgrade or a missing
   * socket is an operational problem on our side and must not present to the
   * customer as a licensing failure. Real lapsing is decided by the agent from
   * the signed licence's own expiry, which no local condition can fake.
   *
   * This is the same fail-open posture PermissionsGuard already takes.
   */
  get licensed(): boolean {
    if (licensingDisabled()) return true;
    if (this.current === null) return true;
    return this.current.licensed;
  }

  /** Whether new records may be created. The first rung that actually bites. */
  get writable(): boolean {
    if (licensingDisabled()) return true;
    if (this.current === null) return true;
    return this.current.writable;
  }

  hasFeature(name: string): boolean {
    if (licensingDisabled()) return true;
    if (this.current === null) return true;
    return this.current.feat?.includes(name) ?? false;
  }

  /** 0 means unlimited. */
  get maxSubscribers(): number {
    if (licensingDisabled()) return 0;
    return this.current?.max_subs ?? 0;
  }

  get company(): string {
    return this.current?.company ?? '';
  }

  /** Everything the UI needs for its banner and licence page. */
  status(): Record<string, unknown> {
    const e = this.current;
    return {
      state: this.state,
      licensed: this.licensed,
      writable: this.writable,
      enforced: !licensingDisabled(),
      plan: e?.plan ?? null,
      company: e?.company ?? null,
      trial: e?.trial ?? false,
      maxSubscribers: e?.max_subs ?? 0,
      features: e?.feat ?? [],
      expiresAt: e?.exp ? new Date(e.exp * 1000).toISOString() : null,
      graceEndsAt: e?.grace_ends ? new Date(e.grace_ends * 1000).toISOString() : null,
      message: e?.message ?? '',
      banner: this.banner,
    };
  }

  get banner(): { level: 'none' | 'info' | 'warn' | 'error'; message: string } {
    if (licensingDisabled()) return { level: 'none', message: '' };

    const e = this.current;

    // Never reached the agent. Nothing is blocked — but say so, because the
    // alternative is an operator whose agent died quietly finding out when
    // their licence lapses instead of while there is still time to fix it.
    // Anyone running deliberately without the agent sets JBX_LICENCE_ENFORCE
    // =false and this goes away.
    if (!e) {
      return {
        level: 'warn',
        message:
          'The licence agent is not running on this server. The panel is unaffected, ' +
          'but your licence cannot renew until it is restarted.',
      };
    }

    if (e.state === 'ACTIVE') return { level: 'none', message: '' };

    if (e.state === 'GRACE') {
      return { level: 'info', message: e.message || 'Your licence is being renewed.' };
    }
    if (e.state === 'TAMPERED') {
      return {
        level: 'error',
        message: 'Licence verification failed on this server. Please contact support.',
      };
    }
    if (e.state === 'UNAVAILABLE') {
      return { level: 'warn', message: 'The licence agent is not running on this server.' };
    }
    return { level: 'error', message: e.message || 'This panel is not licensed.' };
  }

  // ── talking to the agent ───────────────────────────────────────────────

  async refresh(): Promise<void> {
    if (licensingDisabled()) return;

    try {
      const nonce = crypto.randomBytes(16).toString('hex');
      const resp = await this.query(nonce);

      if (!this.verifySignature(resp, nonce)) {
        this.log.error('Entitlement signature did not verify — reporting TAMPERED');
        this.current = { ...resp, state: 'TAMPERED', licensed: false, writable: false };
        this.reportTamper('SOCKET_FORGED');
        return;
      }

      if (this.lastLoggedState !== resp.state) {
        this.log.log(`Licence state: ${resp.state}${resp.message ? ' — ' + resp.message : ''}`);
        this.lastLoggedState = resp.state;
      }
      this.current = resp;
    } catch (err) {
      // Agent not installed, not running, or socket missing. DO NOT downgrade:
      // keep whatever we last verified, and if we have nothing, stay permissive.
      if (this.lastLoggedState !== 'UNAVAILABLE' && this.current === null) {
        this.log.warn(
          `Licence agent unavailable (${(err as Error).message}); continuing unrestricted`,
        );
        this.lastLoggedState = 'UNAVAILABLE';
      }
    }
  }

  private query(nonce: string): Promise<Entitlement> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const sock = net.createConnection(SOCKET_PATH);
      let buf = '';

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        fn();
      };

      sock.setTimeout(QUERY_TIMEOUT_MS);
      sock.on('timeout', () => finish(() => reject(new Error('timed out'))));
      sock.on('error', (e) => finish(() => reject(e)));
      sock.on('close', () => finish(() => reject(new Error('closed before reply'))));
      sock.on('connect', () => sock.write(JSON.stringify({ nonce }) + '\n'));
      sock.on('data', (d) => {
        buf += d.toString();
        if (!buf.includes('\n')) return;
        try {
          const parsed = JSON.parse(buf.trim()) as Entitlement;
          finish(() => resolve(parsed));
        } catch (e) {
          finish(() => reject(e as Error));
        }
      });
    });
  }

  /**
   * Verify the agent's Ed25519 signature.
   *
   * The signed bytes are this object's JSON with `sig` blank, keys in the order
   * the agent's Go struct declares them. JSON.stringify follows insertion
   * order, so the object below must be built in exactly this sequence.
   *
   * The agent serialises with Go's HTML escaping turned OFF so its output
   * matches JSON.stringify byte for byte. With Go's default, any company name
   * containing `&` — "Ahmed & Sons" — would fail here and be reported as
   * tampering. There is a regression test on the Go side.
   */
  private verifySignature(r: Entitlement, expectNonce: string): boolean {
    try {
      if (!r || typeof r !== 'object') return false;
      if (!r.nonce || r.nonce !== expectNonce) return false;
      if (!r.sig || !r.session_pub) return false;

      const payload = JSON.stringify({
        state: r.state,
        plan: r.plan,
        max_subs: r.max_subs,
        feat: r.feat,
        company: r.company,
        trial: r.trial,
        exp: r.exp,
        grace_ends: r.grace_ends,
        licensed: r.licensed,
        writable: r.writable,
        message: r.message,
        nonce: r.nonce,
        session_pub: r.session_pub,
        sig: '',
      });

      // Wrap the raw 32-byte key in the SPKI DER prefix Node's crypto expects.
      const raw = Buffer.from(r.session_pub, 'hex');
      if (raw.length !== 32) return false;
      const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
      const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });

      return crypto.verify(null, Buffer.from(payload), key, Buffer.from(r.sig, 'hex'));
    } catch {
      return false;
    }
  }

  /** Leave a note for the agent to carry to the licence server. */
  private reportTamper(flag: string): void {
    try {
      fs.mkdirSync(RUN_DIR, { recursive: true });
      fs.writeFileSync(path.join(RUN_DIR, 'tamper'), flag, { mode: 0o600 });
    } catch {
      /* best effort — never throw from a licence path */
    }
  }

  /**
   * Publish counts for the agent's heartbeat.
   *
   * COUNTS ONLY. Never a subscriber's name, CNIC, MAC or IP. Nothing
   * identifying an end user may leave this box — these are Pakistani ISP
   * subscriber records and the blast radius must stay at zero.
   */
  publishCounts(subscribers: number, nas: number): void {
    try {
      fs.mkdirSync(RUN_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(RUN_DIR, 'counts.json'),
        JSON.stringify({ subscribers, nas }),
        { mode: 0o644 },
      );
    } catch {
      /* best effort */
    }
  }
}
