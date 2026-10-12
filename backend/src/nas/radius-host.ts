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
import { accessSync, constants, existsSync, readFileSync } from 'fs';
import { open, readFile, stat, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

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
export async function validateConfig(): Promise<{
  ok: boolean;
  error?: string;
  out: string;
}> {
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
      ? await run('/usr/sbin/runuser', [
          '-u',
          serviceUser(dir),
          '--',
          bin,
          ...dArgs,
          '-Cx',
          '-lstdout',
        ])
      : await run(bin, [...dArgs, '-XC']);
  }
  if (res.ok) return { ok: true, out: res.out };
  return {
    ok: false,
    error: checkErrors(res.out) || 'FreeRADIUS rejected its configuration.',
    out: res.out,
  };
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
