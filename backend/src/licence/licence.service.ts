import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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
  /**
   * The licence server suspended, revoked or blocked this licence. Read-only
   * at once rather than when the licence's own expiry runs out. RADIUS is
   * untouched, as in every other state. Sent by agent 1.1+ only on a verdict
   * the licence server signed for this installation.
   */
  | 'SUSPENDED'
  | 'TAMPERED'
  | 'UNAVAILABLE'
  // Agent 1.2 policy state machine.
  | 'UNVERIFIED'
  | 'UNLICENSED_WINDOW'
  | 'OFFLINE_GRACE'
  | 'LOCKED';

/** Reason codes the agent reports with a LOCKED state (display only). */
export type LockReason =
  | 'UNLICENSED_EXPIRED'
  | 'NEVER_VERIFIED'
  | 'TAMPER_DETECTED'
  | 'CLOCK_ROLLBACK'
  | 'HARDWARE_MISMATCH'
  | 'LICENCE_REVOKED'
  | 'OFFLINE_TOO_LONG'
  | 'LICENCE_EXPIRED';

export interface Entitlement {
  state: LicenceState;
  plan: string;
  max_subs: number;
  /**
   * Cap POLICY, decided and signed by the licence server. Optional because an
   * older licence server (before migrations 002/004) does not send them, and a
   * panel talking to one must keep working with no enforcement rather than
   * refusing creates on an undefined number.
   */
  cap_action?: 'block' | 'overage' | 'warn';
  cap_hard?: number;
  max_nas?: number;
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

export interface LicenceUsage {
  subscribers: number;
  nas: number;
  dealers?: number;
  companies?: number;
  at: string;
}

const SOCKET_PATH =
  process.env.JBX_LICENCE_SOCKET || '/run/jointbox/licensed.sock';
const RUN_DIR = process.env.JBX_RUN_DIR || '/run/jointbox';
const REFRESH_MS = Number(process.env.JBX_LICENCE_REFRESH_MS || 15 * 60 * 1000);
/**
 * How long a panel may run with no working licence — agent missing, stopped,
 * or installed but never activated — before writes stop. Counted from the
 * last time the agent reported a valid licence, or from installation when it
 * never has. 48 hours: long enough to install and activate, short enough
 * that removing the agent is not a way to run unlicensed.
 */
const NO_LICENCE_ALLOWANCE_MS = Number(
  process.env.JBX_NO_LICENCE_ALLOWANCE_MS || 48 * 3600 * 1000,
);
const LAST_GOOD_FILE =
  process.env.JBX_LICENCE_LAST_GOOD_FILE ||
  path.join(process.cwd(), '.licence-last-good');
const QUERY_TIMEOUT_MS = Number(process.env.JBX_LICENCE_TIMEOUT_MS || 3000);

/**
 * Licensing off entirely. For development, and for anyone who forks this for
 * their own use — it is deliberately easy to find rather than hidden, because
 * hiding it in open source fools nobody and annoys contributors.
 */
export function licensingDisabled(): boolean {
  // Development only. On a production server (NODE_ENV=production, which
  // the installer and PM2 config set) this switch is ignored, so editing
  // .env is not a way to run the panel without a licence.
  return (
    process.env.JBX_LICENCE_ENFORCE === 'false' &&
    process.env.NODE_ENV !== 'production'
  );
}

@Injectable()
export class LicenceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LicenceService.name);
  private current: Entitlement | null = null;
  private timer?: NodeJS.Timeout;
  private lastLoggedState: LicenceState | null = null;
  /** ms epoch the agent last reported ACTIVE/GRACE (persisted to disk). */
  private lastGood: number | null = null;
  /** ms epoch this installation was set up (first database migration). */
  private installedAt: number | null = null;
  private bootedAt = Date.now();

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async onModuleInit(): Promise<void> {
    if (licensingDisabled()) {
      this.log.warn(
        'Licence enforcement is DISABLED (JBX_LICENCE_ENFORCE=false)',
      );
      return;
    }
    this.loadLastGood();
    await this.loadInstalledAt();
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    // Never hold the process open on shutdown.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── no working licence: allowance, then read-only ─────────────────────

  private loadLastGood(): void {
    try {
      const n = Number(fs.readFileSync(LAST_GOOD_FILE, 'utf8').trim());
      if (Number.isFinite(n) && n > 0 && n <= Date.now()) this.lastGood = n;
    } catch {
      /* never had a licence, or the file was removed: count from install */
    }
  }

  private markGood(): void {
    const now = Date.now();
    const stale = !this.lastGood || now - this.lastGood > 3600 * 1000;
    this.lastGood = now;
    if (!stale) return;
    try {
      fs.writeFileSync(LAST_GOOD_FILE, String(now));
    } catch (e) {
      this.log.warn(
        `Could not record licence check time: ${(e as Error).message}`,
      );
    }
  }

  /** When the first migration ran: deleting a file cannot move this. */
  private async loadInstalledAt(): Promise<void> {
    if (!this.prisma) return;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ t: Date | null }>>`
        SELECT MIN(started_at) AS t FROM _prisma_migrations`;
      const t = rows?.[0]?.t ? new Date(rows[0].t).getTime() : NaN;
      if (Number.isFinite(t)) this.installedAt = t;
    } catch {
      /* no migrations table (tests): fall back to process start */
    }
  }

  /** When the clock for "no working licence" started. */
  private get noLicenceSince(): number {
    return this.lastGood ?? this.installedAt ?? this.bootedAt;
  }

  /** Writes stop at this moment if no licence turns up. null = not counting. */
  get noLicenceDeadline(): number | null {
    if (licensingDisabled()) return null;
    const st = this.current?.state ?? 'UNAVAILABLE';
    if (st !== 'UNAVAILABLE' && st !== 'UNLICENSED') return null;
    return this.noLicenceSince + NO_LICENCE_ALLOWANCE_MS;
  }

  /** Agent missing or never activated for longer than the allowance. */
  get noLicenceExpired(): boolean {
    const d = this.noLicenceDeadline;
    return d !== null && Date.now() >= d;
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
    if (this.noLicenceExpired) return false;
    if (this.current === null) return true;
    return this.current.licensed;
  }

  /** Whether new records may be created. The first rung that actually bites. */
  get writable(): boolean {
    if (licensingDisabled()) return true;
    if (this.noLicenceExpired) return false;
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

  /**
   * Whether a VERIFIED entitlement is in hand.
   *
   * Distinct from `licensed`, which answers true when the agent is unreachable
   * because that state must not behave like a lapse. Capacity enforcement
   * needs the stricter question: do we actually hold numbers the licence
   * server signed? No entitlement means no enforcement.
   */
  get hasEntitlement(): boolean {
    return !licensingDisabled() && this.current !== null;
  }

  /**
   * The count at which creating a subscriber is refused. 0 = never refuse.
   *
   * Computed on the licence server (plan cap, per-customer override and any
   * overage percentage all resolved there) and signed, so this is a number to
   * obey rather than a calculation to repeat. See jbx_cap_policy() in the
   * licence server's lib/licence.php.
   */
  get capHard(): number {
    if (licensingDisabled()) return 0;
    return this.current?.cap_hard ?? 0;
  }

  /** block | overage | warn. 'warn' never refuses anything. */
  get capAction(): string {
    if (licensingDisabled()) return 'warn';
    return this.current?.cap_action ?? 'warn';
  }

  /** NAS device cap. 0 = unlimited. */
  get maxNas(): number {
    if (licensingDisabled()) return 0;
    return this.current?.max_nas ?? 0;
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
      maxNas: e?.max_nas ?? 0,
      capAction: e?.cap_action ?? 'warn',
      capHard: e?.cap_hard ?? 0,
      features: e?.feat ?? [],
      expiresAt: e?.exp ? new Date(e.exp * 1000).toISOString() : null,
      graceEndsAt: e?.grace_ends
        ? new Date(e.grace_ends * 1000).toISOString()
        : null,
      message: e?.message ?? '',
      noLicenceDeadline: this.noLicenceDeadline
        ? new Date(this.noLicenceDeadline).toISOString()
        : null,
      usage: this.counts,
      banner: this.banner,
      policy: this.policyDisplay,
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
    if (this.noLicenceExpired) {
      return {
        level: 'error',
        message: e
          ? 'This panel has not been activated. It is read-only until a licence is activated; subscribers stay online.'
          : 'The licence agent is not running, so this panel is read-only. Subscribers stay online. Start the agent and activate a licence to continue.',
      };
    }
    if (!e) {
      return {
        level: 'warn',
        message:
          'The licence agent is not running on this server. Start it and activate a ' +
          'licence before ' +
          new Date(this.noLicenceDeadline ?? Date.now()).toUTCString() +
          ', or adding and changing records will stop.',
      };
    }

    if (e.state === 'ACTIVE') return { level: 'none', message: '' };

    if (e.state === 'GRACE') {
      return {
        level: 'info',
        message: e.message || 'Your licence is being renewed.',
      };
    }
    if (e.state === 'SUSPENDED') {
      return {
        level: 'error',
        message:
          e.message ||
          'This licence has been suspended. The panel is read-only; subscribers stay online.',
      };
    }
    if (e.state === 'TAMPERED') {
      return {
        level: 'error',
        message:
          'Licence verification failed on this server. Please contact support.',
      };
    }
    if (e.state === 'UNAVAILABLE') {
      return {
        level: 'warn',
        message: 'The licence agent is not running on this server.',
      };
    }
    return {
      level: 'error',
      message: e.message || 'This panel is not licensed.',
    };
  }

  // ── talking to the agent ───────────────────────────────────────────────

  async refresh(): Promise<void> {
    if (licensingDisabled()) return;

    try {
      const nonce = crypto.randomBytes(16).toString('hex');
      const resp = await this.query(nonce);

      if (!this.verifySignature(resp, nonce)) {
        this.log.error(
          'Entitlement signature did not verify — reporting TAMPERED',
        );
        this.current = {
          ...resp,
          state: 'TAMPERED',
          licensed: false,
          writable: false,
        };
        this.reportTamper('SOCKET_FORGED');
        return;
      }

      if (this.lastLoggedState !== resp.state) {
        this.log.log(
          `Licence state: ${resp.state}${resp.message ? ' — ' + resp.message : ''}`,
        );
        this.lastLoggedState = resp.state;
      }
      this.current = resp;
      if (resp.state === 'ACTIVE' || resp.state === 'GRACE') this.markGood();
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
      sock.on('close', () =>
        finish(() => reject(new Error('closed before reply'))),
      );
      // v:2 asks for the cap policy as well. An agent before 1.1 ignores
      // the field and answers in the v1 layout, which verifySignature also
      // accepts — so the panel and the agent can be upgraded in either order.
      sock.on('connect', () =>
        sock.write(JSON.stringify({ nonce, v: 2 }) + '\n'),
      );
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
   *
   * max_nas, cap_action and cap_hard sit right after max_subs, in that order,
   * and only when the agent sent them (agent 1.1+, asked for v2, non-zero).
   * JSON.stringify drops a key whose value is undefined, so ONE layout covers
   * both: from an older agent the three are absent and this is byte for byte
   * the v1 payload. They were missing from this list before, which is why the
   * agent could never be taught to send them — any panel would have reported
   * every licence carrying a cap as TAMPERED.
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
        max_nas: r.max_nas,
        cap_action: r.cap_action,
        cap_hard: r.cap_hard,
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
      const der = Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        raw,
      ]);
      const key = crypto.createPublicKey({
        key: der,
        format: 'der',
        type: 'spki',
      });

      return crypto.verify(
        null,
        Buffer.from(payload),
        key,
        Buffer.from(r.sig, 'hex'),
      );
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
  /**
   * The last counts published for the heartbeat, kept in memory as well as on
   * disk.
   *
   * The file is what the AGENT reads — it has no database credentials, so two
   * integers in a file is the whole of what ever leaves the ISP's server. The
   * in-memory copy is for the PANEL, so `status()` can tell an operator "412 of
   * 800" without a second round trip. Same numbers, two readers.
   *
   * Null until the first publish, which happens at boot. A null usage is
   * rendered as "not measured yet" rather than as zero — reporting zero
   * subscribers to someone who has four hundred is worse than saying nothing.
   */
  private counts: LicenceUsage | null = null;

  get usage(): LicenceUsage | null {
    return this.counts;
  }

  /**
   * The agent's current decision, for the banner and the locked screen.
   *
   * DISPLAY ONLY. Enforcement runs off the signed socket answer (`state` /
   * `writable`), never off this file, so a hand-edit of it can change wording
   * but not whether the panel is locked. Written by agent 1.2; absent on 1.1
   * and earlier, where the getter simply returns null.
   */
  get policyDisplay(): {
    state: string;
    reason?: string;
    deadline?: string;
    support?: { name?: string; email?: string; phone?: string };
  } | null {
    try {
      const raw = fs.readFileSync(
        path.join(RUN_DIR, 'policy-state.json'),
        'utf8',
      );
      const j = JSON.parse(raw) as {
        state?: string;
        reason?: string;
        deadline?: number;
        support?: { name?: string; email?: string; phone?: string };
      };
      if (!j || typeof j.state !== 'string') return null;
      return {
        state: j.state,
        reason: j.reason || undefined,
        deadline: j.deadline
          ? new Date(j.deadline * 1000).toISOString()
          : undefined,
        support: j.support,
      };
    } catch {
      return null;
    }
  }

  /**
   * `dealers` is franchises, dealers and sub-dealers; `companies` is ISP
   * companies (ADMIN accounts) under the platform owner. Both are counts of
   * accounts, never their names, and both are optional so a caller that only
   * knows the original two numbers still works.
   */
  publishCounts(
    subscribers: number,
    nas: number,
    dealers?: number,
    companies?: number,
  ): void {
    this.counts = {
      subscribers,
      nas,
      dealers,
      companies,
      at: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(RUN_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(RUN_DIR, 'counts.json'),
        // undefined keys vanish here, which the agent reads as "not reported"
        // rather than as zero.
        JSON.stringify({ subscribers, nas, dealers, companies }),
        { mode: 0o644 },
      );
    } catch {
      /* best effort */
    }
  }
}
