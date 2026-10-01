import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { execFile } from 'child_process';
import { PrismaService } from '../prisma/prisma.service';
import { LicenceService } from './licence.service';

/**
 * ACTIVATING A LICENCE FROM THE BROWSER.
 *
 * ── Why this shells out ──────────────────────────────────────────────────
 * The agent's unix socket answers exactly one question: "sign this nonce and
 * tell me the entitlement". There is no activation operation on it. Adding one
 * is the cleaner design, but it means a new agent build and every existing
 * customer updating before web activation works for them — so the panel drives
 * the CLI that is already installed on every server instead.
 *
 * ── Why that is not a command injection ──────────────────────────────────
 * `execFile`, never `exec`. There is no shell, so arguments are passed as an
 * array straight to execve() and shell metacharacters have no meaning —
 * `; rm -rf /` is just an argument that the Go flag parser rejects. On top of
 * that the key is validated against a strict pattern BEFORE we get here, and
 * every flag uses the unambiguous `-flag=value` form so a value can never be
 * mistaken for the next flag.
 *
 * Two layers rather than one because this is the single place in the panel
 * that runs a binary as root, and a future edit that loosens the regex should
 * still not be able to reach a shell.
 *
 * ── Why it needs root ────────────────────────────────────────────────────
 * The agent writes to /etc/jointbox and restarts its own service.
 *
 * PM2 often runs the API as root already, in which case sudo is not only
 * unnecessary but a liability — a minimal container may not have it installed
 * at all, and activation would fail with ENOENT for a reason nobody would
 * guess. So the privilege escalation is used ONLY when we are not already
 * root. Where it is used, the sudoers rule installed alongside the agent
 * permits exactly these two commands and nothing else, never a general grant.
 *
 * ── What is never recorded ───────────────────────────────────────────────
 * The licence key is a credential. It is masked everywhere it is written: the
 * audit row, the log line and any error returned to the browser. The agent's
 * own stderr is passed back because it carries the actionable message
 * ("already bound to another machine"), but it is truncated and scanned for
 * the key before it leaves this file.
 */

/** JBX-XXXXX-XXXXX-XXXXX-XXXXX, or the literal 'trial'. */
const KEY_PATTERN = /^JBX-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/;

const AGENT_BIN = process.env.JBX_AGENT_BIN || '/usr/local/bin/jointbox-licensed';
const SUDO_BIN = process.env.JBX_SUDO_BIN || '/usr/bin/sudo';
const SERVICE = 'jointbox-licensed';

/** Activation contacts the licence server, so allow for a slow link. */
const ACTIVATE_TIMEOUT_MS = Number(process.env.JBX_ACTIVATE_TIMEOUT_MS || 60_000);
const RESTART_TIMEOUT_MS = 15_000;

/** Free-text detail fields. Bounded, and stripped of anything not printable. */
const MAX_DETAIL = 120;

export interface ActivationInput {
  key: string;
  company?: string;
  website?: string;
  contact?: string;
  email?: string;
  phone?: string;
}

export interface ActivationActor {
  id?: number;
  role?: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class LicenceActivationService {
  private readonly log = new Logger(LicenceActivationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly licence: LicenceService,
  ) {}

  /**
   * Show enough of a key to match it against an invoice, never enough to use it.
   * JBX-E2PHH-6S8Q4-YB4E4-ADT1V becomes JBX-E2PHH-…-ADT1V.
   */
  static mask(key: string): string {
    if (!key) return '';
    if (key === 'trial') return 'trial';
    const g = key.split('-');
    if (g.length !== 5) return '•••';
    return `${g[0]}-${g[1]}-…-${g[4]}`;
  }

  static isValidKey(key: string): boolean {
    return key === 'trial' || KEY_PATTERN.test(key);
  }

  private clean(v: string | undefined): string {
    if (!v) return '';
    // Printable ASCII and common latin only; no control characters, no newlines.
    return v.replace(/[^\x20-\x7E -ɏ]/g, '').trim().slice(0, MAX_DETAIL);
  }

  async activate(input: ActivationInput, actor: ActivationActor): Promise<{ state: string; message: string }> {
    // Only an operator who can change the installation's licence may do this.
    // Checked here as well as on the route, because this method restarts a
    // system service and must not become reachable by a less guarded caller.
    if (actor.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only a super administrator can activate a licence.');
    }

    const key = (input.key || '').trim();
    if (!LicenceActivationService.isValidKey(key)) {
      // The message deliberately does not echo what was submitted — that is how
      // a reflected value ends up rendered somewhere later.
      throw new BadRequestException(
        'That does not look like a licence key. The format is JBX-XXXXX-XXXXX-XXXXX-XXXXX.',
      );
    }

    const masked = LicenceActivationService.mask(key);
    this.log.log(`Activation requested by user ${actor.id ?? '?'} with key ${masked}`);

    // Already root (the common PM2 deployment) — call the agent directly
    // rather than requiring sudo to exist.
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const bin = asRoot ? AGENT_BIN : SUDO_BIN;
    const prefix = asRoot ? [] : [AGENT_BIN];

    const args = [
      ...prefix,
      `-activate=${key}`,
      `-company=${this.clean(input.company)}`,
      `-website=${this.clean(input.website)}`,
      `-contact=${this.clean(input.contact)}`,
      `-email=${this.clean(input.email)}`,
      `-phone=${this.clean(input.phone)}`,
    ];

    let ok = false;
    let detail = '';
    try {
      const out = await this.run(bin, args, ACTIVATE_TIMEOUT_MS);
      ok = out.code === 0;
      detail = this.scrub(out.stderr || out.stdout, key);
    } catch (err) {
      detail = this.scrub((err as Error).message, key);
    }

    await this.audit(ok ? 'licence.activate' : 'licence.activate.failed', masked, detail, actor);

    if (!ok) {
      // The agent's own message is the useful one — "already bound to another
      // machine", "unknown key", "payment overdue" — so it is passed through
      // rather than replaced with something generic.
      throw new ServiceUnavailableException(
        detail || 'Activation failed and the agent gave no reason. Check that jointbox-licensed is installed.',
      );
    }

    // -activate writes the licence and exits; the running daemon does not
    // notice until it restarts or heartbeats. Restart so the panel reflects
    // the new state immediately rather than minutes later.
    const restartArgs = asRoot
      ? ['restart', SERVICE]
      : ['/usr/bin/systemctl', 'restart', SERVICE];
    await this.run(asRoot ? '/usr/bin/systemctl' : SUDO_BIN, restartArgs, RESTART_TIMEOUT_MS)
      .catch((e) => this.log.warn(`Activated, but restarting ${SERVICE} failed: ${e.message}`));

    // Give the daemon a moment to bind its socket before we ask it anything.
    await new Promise((r) => setTimeout(r, 1500));
    await this.licence.refresh();

    return { state: this.licence.state, message: 'Licence activated.' };
  }

  /** execFile, never exec: no shell is involved at any point. */
  private run(bin: string, args: string[], timeout: number): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        if (err && (err as any).killed) {
          return reject(new Error(`The agent did not respond within ${Math.round(timeout / 1000)}s.`));
        }
        if (err && (err as any).code === 'ENOENT') {
          return reject(new Error('The licence agent is not installed on this server.'));
        }
        resolve({ code: (err as any)?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
  }

  /**
   * Remove the key from anything on its way to a log, an audit row or the
   * browser. The agent does not print keys today — this is here so that it
   * cannot start doing so without the panel catching it.
   */
  private scrub(text: string, key: string): string {
    let s = String(text || '').slice(0, 600);
    if (key && key !== 'trial') s = s.split(key).join(LicenceActivationService.mask(key));
    return s.replace(/JBX-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}/g, (m) =>
      LicenceActivationService.mask(m),
    ).trim();
  }

  private async audit(action: string, masked: string, detail: string, actor: ActivationActor) {
    try {
      await this.prisma.activityLog.create({
        data: {
          userId: actor.id ?? null,
          action,
          entity: 'Licence',
          entityId: null,
          details: JSON.stringify({ key: masked, result: detail.slice(0, 400) }),
          ipAddress: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
        },
      });
    } catch (e) {
      // An audit failure must not swallow the activation result, but it is a
      // real problem and says so in the log rather than disappearing.
      this.log.error(`Could not write activation audit row: ${(e as Error).message}`);
    }
  }
}
