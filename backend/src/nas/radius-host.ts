/**
 * The FreeRADIUS server on THIS machine — shared by the router vault
 * (radius-client-vault.service) and the platform's FreeRADIUS admin screen
 * (radius-admin), so both check, restart and lock it the same way.
 *
 * Every helper honours the FREERADIUS_* environment overrides so the
 * behaviour can be exercised in tests and on non-systemd hosts:
 *   FREERADIUS_DIR          config directory (default: auto-detected)
 *   FREERADIUS_CHECK_CMD    config check command
 *   FREERADIUS_STATUS_CMD   "is it running" command (exit 0 = running)
 *   FREERADIUS_RESTART_CMD  restart command
 *   JOINTBOX_RADIUS_LOCK    path of the host-wide lock file
 */
import { execFile } from 'child_process';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'fs';
import { open, readFile, stat, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

export type RunResult = { ok: boolean; out: string };

export function run(
  cmd: string,
  args: string[],
  timeoutMs = 25_000,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}` });
      },
    );
  });
}

export function runShell(cmd: string, timeoutMs = 30_000): Promise<RunResult> {
  return run('/bin/sh', ['-c', cmd], timeoutMs);
}

function readText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** FreeRADIUS config directory on this server, or null when it is not here. */
export function radDir(): string | null {
  const env = (process.env.FREERADIUS_DIR || '').trim();
  if (env) return existsSync(env) ? env : null;
  for (const d of ['/etc/freeradius/3.0', '/etc/freeradius', '/etc/raddb']) {
    if (existsSync(join(d, 'radiusd.conf'))) return d;
  }
  return null;
}

export function binary(): string {
  for (const b of [
    '/usr/sbin/freeradius',
    '/usr/sbin/radiusd',
    '/usr/local/sbin/radiusd',
  ]) {
    if (existsSync(b)) return b;
  }
  return 'freeradius';
}

/** The account FreeRADIUS runs as (radiusd.conf `user =`), freerad by default. */
export function serviceUser(dir = radDir()): string {
  const conf = dir ? readText(join(dir, 'radiusd.conf')) : null;
  const m = conf?.match(/^\s*user\s*=\s*([A-Za-z0-9_.-]+)/m);
  return m?.[1] || 'freerad';
}

/** Keep the lines that say what is wrong — file:line first — with secrets hidden. */
export function checkErrors(out: string): string {
  const lines = out
    .split('\n')
    .filter((l) =>
      /\.conf\[\d+\]|error|unable|failed|invalid|permission|duplicate|expect|unknown|missing|reached/i.test(
        l,
      ),
    )
    .map((l) => hideSecrets(l).trim())
    .filter(Boolean);
  const located = lines.filter((l) => /\[\d+\]:/.test(l));
  return [...new Set([...located, ...lines])].slice(0, 4).join(' · ');
}

/** Hide the value of any secret-looking `key = value` in a line of config/log text. */
export function hideSecrets(line: string): string {
  return line.replace(
    /\b(secret|password|private_key_password|certificate_password|key_password)(\s*=\s*).*$/i,
    '$1$2<hidden>',
  );
}

/**
 * FreeRADIUS's own config check, run the way systemd's ExecStartPre runs it:
 * AS THE SERVICE USER. A root-only check passes files the service then
 * cannot read, and FreeRADIUS fails to start.
 */
/**
 * The vault routers FreeRADIUS's debug check shows it would load: router id →
 * the address it would match the router on. (FreeRADIUS prints secrets in
 * this output as <<< secret >>>; nothing here keeps or logs the output.)
 */
export function routersLoaded(checkOutput: string): Map<number, string | null> {
  const out = new Map<number, string | null>();
  let current: number | null = null;
  for (const line of checkOutput.split('\n')) {
    const open = /^\s*client jointbox-nas-(\d+) \{/.exec(line);
    if (open) {
      current = Number(open[1]);
      out.set(current, null);
      continue;
    }
    if (current == null) continue;
    const ip = /^\s*ip(?:v4|v6)?addr\s*=\s*(\S+)/.exec(line);
    if (ip) {
      out.set(current, ip[1].replace(/^"|"$/g, ''));
      current = null;
    } else if (/^\s*\}/.test(line)) current = null;
  }
  return out;
}

/** Compare what FreeRADIUS would load with the routers the file is meant to hold. */
export function loadedMismatch(
  loaded: Map<number, string | null>,
  expected: Array<{ id: number; ip: string }>,
): string | null {
  const missing = expected
    .filter((e) => !loaded.has(e.id))
    .map((e) => `#${e.id}`);
  const wrongIp = expected
    .filter((e) => loaded.has(e.id) && loaded.get(e.id) !== e.ip)
    .map((e) => `#${e.id}`);
  const extra = [...loaded.keys()]
    .filter((id) => !expected.some((e) => e.id === id))
    .map((id) => `#${id}`);
  if (!missing.length && !wrongIp.length && !extra.length) return null;
  const parts: string[] = [];
  if (missing.length)
    parts.push(
      `would not load router(s) ${missing.slice(0, 8).join(', ')} — is "$INCLUDE clients.d/jointbox-nas.conf" in clients.conf?`,
    );
  if (wrongIp.length)
    parts.push(
      `would load router(s) ${wrongIp.slice(0, 8).join(', ')} with a different address`,
    );
  if (extra.length)
    parts.push(
      `would also load unexpected router(s) ${extra.slice(0, 8).join(', ')}`,
    );
  return `FreeRADIUS ${parts.join('; ')}.`;
}

/**
 * FreeRADIUS's own config check, run the way systemd's ExecStartPre runs it:
 * AS THE SERVICE USER. A root-only check passes files the service then
 * cannot read, and FreeRADIUS fails to start.
 *
 * With `expected`, the check also confirms FreeRADIUS would load exactly
 * those routers, each on its address: a file that is valid but not in effect
 * (include line missing, a different file included) fails here instead of
 * passing. The raw check output is never returned — it is configuration.
 */
export async function validateConfig(
  expected?: Array<{ id: number; ip: string }>,
): Promise<{ ok: boolean; error?: string; loaded?: number }> {
  const custom = (process.env.FREERADIUS_CHECK_CMD || '').trim();
  let res: RunResult;
  if (custom) {
    res = await runShell(custom);
  } else {
    const bin = binary();
    const dir = radDir();
    const dArgs = dir ? ['-d', dir] : [];
    const asUser =
      typeof process.getuid === 'function' &&
      process.getuid() === 0 &&
      existsSync('/usr/sbin/runuser');
    res = asUser
      ? await run(
          '/usr/sbin/runuser',
          ['-u', serviceUser(dir), '--', bin, ...dArgs, '-XC'],
          60_000,
        )
      : await run(bin, [...dArgs, '-XC'], 60_000);
  }
  if (!res.ok) {
    return {
      ok: false,
      error: checkErrors(res.out) || 'FreeRADIUS rejected its configuration.',
    };
  }
  // A custom check command (tests, non-standard hosts) may not print the
  // client list; only the real debug check is held to it.
  if (expected && (!custom || /client jointbox-nas-\d+ \{/.test(res.out))) {
    const loaded = routersLoaded(res.out);
    const wrong = loadedMismatch(loaded, expected);
    if (wrong) return { ok: false, error: wrong, loaded: loaded.size };
    return { ok: true, loaded: loaded.size };
  }
  return { ok: true };
}

export async function isRunning(tries = 8): Promise<boolean> {
  const custom = (process.env.FREERADIUS_STATUS_CMD || '').trim();
  for (let i = 0; i < tries; i++) {
    const r = custom
      ? await runShell(custom)
      : await run('systemctl', ['is-active', '--quiet', 'freeradius']);
    if (r.ok) return true;
    if (i < tries - 1) await new Promise((ok) => setTimeout(ok, 750));
  }
  return false;
}

/** Restart FreeRADIUS and confirm it is running again. */
export async function restart(): Promise<{ ok: boolean; error?: string }> {
  const custom = (process.env.FREERADIUS_RESTART_CMD || '').trim();
  const attempts = custom
    ? [() => runShell(custom, 45_000)]
    : [
        () => run('systemctl', ['restart', 'freeradius'], 45_000),
        () => run('sudo', ['-n', 'systemctl', 'restart', 'freeradius'], 45_000),
        () => run('service', ['freeradius', 'restart'], 45_000),
      ];
  let detail = '';
  for (const [i, attempt] of attempts.entries()) {
    const r = await attempt();
    if (r.ok) {
      if (await isRunning()) return { ok: true };
      return {
        ok: false,
        error:
          'FreeRADIUS was restarted but did not come back up (see: journalctl -u freeradius -n 50).',
      };
    }
    // The first failure is the informative one (systemctl's "Job … failed");
    // sudo / service only matter when systemctl itself is not usable.
    if (i === 0) {
      detail =
        r.out
          .split('\n')
          .map((l) => hideSecrets(l.trim()))
          .filter(Boolean)[0]
          ?.slice(0, 200) || '';
    }
  }
  return {
    ok: false,
    error: `FreeRADIUS did not restart${detail ? ` (${detail})` : ''} — check: journalctl -u freeradius -n 50, or run: systemctl restart freeradius`,
  };
}

// ── one writer at a time, across every process on this machine ─────────────
//
// pm2 cluster mode runs several backend processes, and the update script runs
// radius-vault-cutover.sh beside them. Each of them may rewrite the router
// file and restart FreeRADIUS; two at once would race each other's file,
// check and restart. The lock is a file created with O_EXCL holding
// "<pid> <epoch-ms>"; the cutover script takes the same lock.

const STALE_MS = 10 * 60_000;

export function lockPath(): string {
  const env = (process.env.JOINTBOX_RADIUS_LOCK || '').trim();
  if (env) return env;
  for (const d of ['/run/lock', '/var/lock']) {
    try {
      accessSync(d, constants.W_OK);
      return join(d, 'jointbox-radius.lock');
    } catch {
      /* try the next one */
    }
  }
  return join(tmpdir(), 'jointbox-radius.lock');
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

async function staleLock(path: string): Promise<string | null> {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text == null) return null;
  if (!text.trim()) {
    // Just created; the holder has not written its id yet.
    const st = await stat(path).catch(() => null);
    if (st && Date.now() - st.mtimeMs < 5_000) return null;
  }
  const [pidS, atS] = text.trim().split(/\s+/);
  const pid = Number(pidS);
  const at = Number(atS);
  const dead = !pidAlive(pid);
  const old = !Number.isFinite(at) || Date.now() - at > STALE_MS;
  return dead || old ? text : null;
}

/**
 * Run `fn` while holding the host-wide FreeRADIUS lock. Waits up to `waitMs`
 * for another holder; a holder that died (or held it over 10 minutes) is
 * cleared. If the lock directory cannot be written at all, `fn` still runs —
 * the in-process queue keeps this process's own changes in order.
 */
export async function withHostLock<T>(
  fn: () => Promise<T>,
  waitMs = 150_000,
): Promise<T> {
  const path = lockPath();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fh = await open(path, 'wx', 0o600);
      try {
        await fh.writeFile(`${process.pid} ${Date.now()}\n`);
      } finally {
        await fh.close();
      }
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') return fn();
      const stale = await staleLock(path);
      if (stale != null) {
        // Only remove it if it is still the same stale holder.
        const now = await readFile(path, 'utf8').catch(() => null);
        if (now === stale) await unlink(path).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          'Another FreeRADIUS update is still running on this server — try again in a minute.',
        );
      }
      await new Promise((ok) => setTimeout(ok, 400));
    }
  }
  try {
    return await fn();
  } finally {
    const mine = await readFile(path, 'utf8').catch(() => null);
    if (mine?.startsWith(`${process.pid} `))
      await unlink(path).catch(() => undefined);
  }
}

// ── secrets in config files shown on screen ────────────────────────────────

const SECRET_LINE =
  /^(\s*)(secret|password|private_key_password|certificate_password|key_password)(\s*=\s*)(.*)$/i;
export const HIDDEN = '<hidden>';

/** Config text for the screen: every secret value replaced by <hidden>. */
export function redactConfig(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      const m = SECRET_LINE.exec(l);
      return m ? `${m[1]}${m[2]}${m[3]}${HIDDEN}` : l;
    })
    .join('\n');
}

/**
 * Each secret line with its place in the file: the enclosing sections
 * (`client office {` → "client office") plus the key and its count within
 * that section. Adding, removing or reordering OTHER blocks does not move it.
 */
function secretSlots(
  text: string,
): Array<{ index: number; slot: string; value: string; m: RegExpExecArray }> {
  const stack: string[] = [];
  const seen = new Map<string, number>();
  const out: Array<{
    index: number;
    slot: string;
    value: string;
    m: RegExpExecArray;
  }> = [];
  text.split('\n').forEach((raw, index) => {
    const l = raw.replace(/#.*$/, '');
    const m = SECRET_LINE.exec(raw);
    if (m && !/^\s*#/.test(raw)) {
      const base = `${stack.join('/')}|${m[2].toLowerCase()}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      out.push({ index, slot: `${base}#${n}`, value: m[4], m });
    }
    const open = /^\s*([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.:/-]+)?)\s*\{\s*$/.exec(
      l,
    );
    if (open) stack.push(open[1].replace(/\s+/g, ' '));
    else if (/^\s*\}\s*$/.test(l)) stack.pop();
  });
  return out;
}

/**
 * Put the real values back into text edited from redactConfig(): each
 * `<hidden>` takes the value that sat in the same place (same section, same
 * key) in the current file. A <hidden> with nothing to take is refused — the
 * placeholder itself is never written as a secret.
 */
export function unredactConfig(
  edited: string,
  current: string,
): { ok: true; text: string } | { ok: false; error: string } {
  const originals = new Map(secretSlots(current).map((x) => [x.slot, x.value]));
  const lines = edited.split('\n');
  for (const x of secretSlots(edited)) {
    if (x.value.trim() !== HIDDEN) continue;
    const orig = originals.get(x.slot);
    if (orig == null) {
      return {
        ok: false,
        error: `Line ${x.index + 1}: "${x.m[2]} = ${HIDDEN}" has no saved value to keep — type the real value instead.`,
      };
    }
    lines[x.index] = `${x.m[1]}${x.m[2]}${x.m[3]}${orig}`;
  }
  return { ok: true, text: lines.join('\n') };
}

// ── persisted sync state (shared by every worker and the cutover script) ───
//
// Secret-free: times, counts, router ids, messages. Root-only (0600).

export interface VaultState {
  /** When FreeRADIUS first ran on the router file (the cutover). */
  cutoverAt?: string;
  /** Last sync that left FreeRADIUS in line with the panel. */
  lastOkAt?: string;
  /** The last sync result, whatever its outcome. */
  last?: {
    ok: boolean;
    mode: string;
    changed: boolean;
    restarted: boolean;
    clients: number;
    message: string;
    at: string;
    skipped?: Array<{ id: number; ip: string | null; reason: string }>;
  };
  /** Last retirement of legacy plaintext copies. */
  retired?: { at: string; count: number; kept: number };
  /** When FreeRADIUS was last switched back to reading routers from SQL. */
  rolledBackAt?: string;
}

export function statePath(): string {
  const env = (process.env.JOINTBOX_RADIUS_STATE || '').trim();
  if (env) return env;
  const dir = '/var/lib/jointbox';
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    accessSync(dir, constants.W_OK);
    return join(dir, 'radius-vault.json');
  } catch {
    return join(tmpdir(), 'jointbox-radius-vault.json');
  }
}

export function readState(): VaultState {
  try {
    const v = JSON.parse(readFileSync(statePath(), 'utf8')) as unknown;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the state file, atomically. Never throws. */
export function writeState(patch: Partial<VaultState>): VaultState {
  const path = statePath();
  const next = { ...readState(), ...patch };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch {
    /* state is a convenience for the status screen; never fail a sync on it */
  }
  return next;
}

/**
 * When the running FreeRADIUS process started (epoch ms), or null when it is
 * not running or cannot be told. Used to tell "the router file is current"
 * apart from "FreeRADIUS has actually loaded it": clients are only read at
 * start-up, so a file newer than the process is NOT yet in effect.
 */
export async function freeradiusStartedAt(): Promise<number | null> {
  const custom = (process.env.FREERADIUS_PID_CMD || '').trim();
  let pid = 0;
  const viaCustom = custom ? await runShell(custom) : null;
  if (viaCustom?.ok) pid = Number(viaCustom.out.trim().split(/\s+/)[0]) || 0;
  if (!pid && !custom) {
    const sd = await run('systemctl', [
      'show',
      '-p',
      'MainPID',
      '--value',
      'freeradius',
    ]);
    if (sd.ok) pid = Number(sd.out.trim()) || 0;
  }
  if (!pid && !custom) {
    // the oldest process running as the FreeRADIUS user — not a
    // `freeradius -X` someone started by hand as root
    const pg = await run('pgrep', [
      '-o',
      '-u',
      serviceUser(),
      '-x',
      'freeradius',
    ]);
    if (pg.ok) pid = Number(pg.out.trim().split(/\s+/)[0]) || 0;
  }
  if (!pid) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // field 22 (starttime, clock ticks since boot) — after the ")" that ends the name
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]);
    const btime = Number(
      /^btime\s+(\d+)/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1],
    );
    const hz = Number((await run('getconf', ['CLK_TCK'])).out.trim()) || 100;
    if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
    return btime * 1000 + Math.floor((ticks * 1000) / hz);
  } catch {
    return null;
  }
}
