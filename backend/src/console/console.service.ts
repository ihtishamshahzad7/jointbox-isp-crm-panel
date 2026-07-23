import { Injectable, Logger, ForbiddenException, BadRequestException } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import { PrismaService } from '../prisma/prisma.service';
import { readLog, logBufferSize } from './log-buffer';

const pexec = promisify(exec);
const IS_WIN = process.platform === 'win32';
const GB = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

/**
 * ConsoleService — server administration from the panel. ISP owner only.
 *
 * SECURITY MODEL (read before touching):
 *   1. Every method here is reachable only by SUPER_ADMIN — enforced again in
 *      the controller. This is the platform owner, not any reseller.
 *   2. Arbitrary shell execution is DORMANT unless the server operator sets
 *      CONSOLE_SHELL_ENABLED=true in the backend environment. A stolen login
 *      token therefore cannot reach a root shell on its own — the capability
 *      has to be deliberately armed on the box. This is the single most
 *      important guard: it turns "leaked token = full server compromise" into
 *      "leaked token = full compromise ONLY IF the shell was also armed".
 *   3. Every executed command is written to SystemLog with the actor's id, so
 *      there is an audit trail of who ran what and when.
 *   4. Log tailing and system info use a FIXED, hard-coded command set and are
 *      NOT gated by the env flag — reading logs is low-risk and always useful.
 */
@Injectable()
export class ConsoleService {
  private readonly logger = new Logger(ConsoleService.name);
  private get shellArmed() { return String(process.env.CONSOLE_SHELL_ENABLED).toLowerCase() === 'true'; }

  constructor(private prisma: PrismaService) {}

  /**
   * Host snapshot for the UI. Uses Node's os module rather than shell commands
   * so it works identically on Windows and Linux — no pg_dump-style path or
   * missing-binary surprises.
   */
  async info(actor: any) {
    const upSecs = os.uptime();
    const up = `${Math.floor(upSecs / 86400)}d ${Math.floor((upSecs % 86400) / 3600)}h ${Math.floor((upSecs % 3600) / 60)}m`;
    let whoami = '';
    try { whoami = os.userInfo().username; } catch { /* ignore */ }
    return {
      shellArmed: this.shellArmed,
      platform: process.platform,
      hostname: os.hostname(),
      os: `${os.type()} ${os.release()}`,
      uptime: up,
      mem: `${GB(os.totalmem() - os.freemem())} / ${GB(os.totalmem())}`,
      disk: '', // per-drive disk needs a shell; skipped to stay cross-platform
      node: process.version,
      whoami,
      logBuffered: logBufferSize(),
    };
  }

  /** Arbitrary shell — the dangerous one. Armed by env, ISP-only, audited. */
  async exec(actor: any, command: string) {
    const cmd = (command || '').trim();
    if (!cmd) throw new BadRequestException('Empty command.');
    if (!this.shellArmed) {
      throw new ForbiddenException(
        'Shell execution is disabled. Set CONSOLE_SHELL_ENABLED=true in the backend environment and restart to arm it.',
      );
    }
    await this.audit(actor, cmd);
    this.logger.warn(`[CONSOLE] user#${actor?.id ?? actor?.sub} ran: ${cmd}`);
    try {
      // Let each OS use its own shell — cmd.exe on Windows, bash on Linux.
      const opts: any = { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
      if (!IS_WIN) opts.shell = '/bin/bash';
      const { stdout, stderr } = await pexec(cmd, opts);
      return { ok: true, code: 0, stdout, stderr };
    } catch (e: any) {
      // A non-zero exit still carries useful stdout/stderr — return, don't throw.
      return { ok: false, code: e?.code ?? 1, stdout: e?.stdout ?? '', stderr: e?.stderr ?? String(e?.message ?? e) };
    }
  }

  /**
   * Tail a log source. FIXED commands only — the `source` picks one; there is
   * no user string in the command, so this is safe even with the shell dormant.
   *   backend  — BACKEND_LOG_PATH file, else pm2 backend, else journal
   *   frontend — FRONTEND_LOG_PATH file, else pm2 frontend
   *   system   — journalctl (system journal)
   */
  async tail(actor: any, source: string, lines = 200) {
    const n = Math.min(Math.max(Number(lines) || 200, 20), 2000);
    if (source === 'backend') return this.tailBackend(n);
    if (source === 'frontend') return this.tailFrontend(n);
    if (source === 'system') return this.tailSystem(n);
    throw new BadRequestException('Unknown log source.');
  }

  /**
   * Backend logs come from the in-process capture buffer first — this is what
   * actually works on Windows, where the backend just prints to a terminal and
   * there is no file to tail. A configured BACKEND_LOG_PATH overrides it.
   */
  private async tailBackend(n: number) {
    const p = process.env.BACKEND_LOG_PATH;
    if (p) return this.tailFile(p, n);
    const txt = readLog(n);
    if (txt.trim()) return { ok: true, code: 0, stdout: txt, stderr: '' };
    return { ok: true, code: 0, stdout: '(no backend output captured yet — logs appear here as the server prints them)', stderr: '' };
  }

  /**
   * The frontend (Next.js) is a SEPARATE process, so the backend can't capture
   * its stdout. Read a file if you point FRONTEND_LOG_PATH at one; otherwise
   * explain how to produce it, per OS.
   */
  private async tailFrontend(n: number) {
    const p = process.env.FRONTEND_LOG_PATH;
    if (p) return this.tailFile(p, n);
    const hint = IS_WIN
      ? 'The Next.js frontend prints to its own window. To show it here, start it as:  npm run start > logs\\frontend.log 2>&1  and set FRONTEND_LOG_PATH to that file.'
      : 'The Next.js frontend runs as its own process. To show it here, run it under pm2/systemd or redirect its output to a file and set FRONTEND_LOG_PATH.';
    return { ok: true, code: 0, stdout: hint, stderr: '' };
  }

  private async tailSystem(n: number) {
    if (IS_WIN) {
      // Windows event log — most recent System-channel entries as text.
      return this.runFixed(`powershell -NoProfile -Command "Get-WinEvent -LogName System -MaxEvents ${Math.min(n, 300)} | Sort-Object TimeCreated | Format-Table -AutoSize TimeCreated, LevelDisplayName, ProviderName, Message | Out-String -Width 400"`);
    }
    return this.runFixed(`journalctl -n ${n} --no-pager 2>&1 || dmesg | tail -n ${n}`);
  }
  private async tailFile(path: string, n: number) {
    try {
      const txt = await fs.readFile(path, 'utf8');
      return { ok: true, code: 0, stdout: txt.split('\n').slice(-n).join('\n'), stderr: '' };
    } catch (e: any) {
      return { ok: false, code: 1, stdout: '', stderr: `Cannot read ${path}: ${e?.message ?? e}` };
    }
  }

  /** Runs a hard-coded command. Role-gated (in the controller) but NOT env-gated. */
  private async runFixed(cmd: string) {
    try {
      const opts: any = { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
      if (!IS_WIN) opts.shell = '/bin/bash';
      const { stdout, stderr } = await pexec(cmd, opts);
      return { ok: true, code: 0, stdout, stderr };
    } catch (e: any) {
      return { ok: false, code: e?.code ?? 1, stdout: e?.stdout ?? '', stderr: e?.stderr ?? String(e?.message ?? e) };
    }
  }

  private async audit(actor: any, command: string) {
    try {
      await this.prisma.systemLog.create({
        data: {
          level: 'WARN',
          source: 'console',
          message: `Console command by user#${actor?.id ?? actor?.sub}: ${command}`.slice(0, 2000),
        },
      });
    } catch { /* auditing must never block the command path */ }
  }
}
