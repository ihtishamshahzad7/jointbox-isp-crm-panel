/**
 * FIRST-BOOT ADMIN CREDENTIALS — NO HARDCODED DEFAULT (S3).
 *
 * The platform (SUPER_ADMIN) and the first company (ADMIN) need a password the
 * very first time the database comes up with no users. Shipping a known default
 * (`admin123`) meant every fresh install was briefly reachable by anyone who
 * read the README — and the privileged platform account had no env requirement
 * at all, so it stayed on the default indefinitely.
 *
 * Instead:
 *   • If the operator set a password in the environment, that is used.
 *   • Otherwise a cryptographically random password is GENERATED ONCE and
 *     written to a 0600 credentials file (dir 0700). The operator reads it from
 *     that file; it is never printed to the application log on every restart.
 *   • The same resolved value is reused on later boots (read back from the
 *     file), so the account is NOT reset — and no NEW secret is minted — each
 *     time the process restarts.
 *   • `mustChangePassword` forces a change at first sign-in, and once that
 *     happens the entry is cleared from the file (`clearBootstrapPassword`), so
 *     the bootstrap secret is strictly one-time.
 *
 * The password value lives only in the file and the (hashed) user row — never
 * in logs, never in an API response.
 */
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** A known legacy default we must never mint a new account on. */
export const INSECURE_DEFAULTS = new Set(['admin123', 'password', 'changeme', '']);

/** Where the generated bootstrap secrets are kept (0600). */
export function bootstrapCredFile(): string {
  if (process.env.BOOTSTRAP_CRED_FILE) return process.env.BOOTSTRAP_CRED_FILE;
  const dir = process.env.UPLINKO_STATE_DIR || '/var/lib/jointbox';
  return path.join(dir, 'bootstrap-credentials.json');
}

type Store = Record<string, string>;

function readStore(): Store {
  try {
    const raw = fs.readFileSync(bootstrapCredFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Write the store with locked-down permissions. Returns false if it could not. */
function writeStore(store: Store): boolean {
  const file = bootstrapCredFile();
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
    // Re-assert on overwrite — writeFileSync does not re-chmod an existing file.
    fs.chmodSync(file, 0o600);
    if (process.platform === 'win32') {
      const username = process.env.USERNAME;
      if (!username) return false;
      const principal = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username;
      const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
      execFileSync(icacls, [dir, '/inheritance:r', '/grant:r', `${principal}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
      execFileSync(icacls, [file, '/inheritance:r', '/grant:r', `${principal}:(F)`], { stdio: 'ignore', windowsHide: true });
    } else {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        /* file permissions still protect the bootstrap secret */
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** A URL-safe 24-character random password (~144 bits). */
export function generatePassword(): string {
  return crypto.randomBytes(18).toString('base64url');
}

export type BootstrapResolution = {
  password: string;
  /** 'env' = operator-provided; 'file' = reused generated; 'generated' = new this boot. */
  source: 'env' | 'file' | 'generated';
  /** When generated: whether it was persisted to the file (false = could not write). */
  persisted?: boolean;
  /** The file it was (or should have been) written to. */
  file?: string;
};

/**
 * Resolve the password to seed an account with. `scope` is a stable key
 * ('platform' / 'company') so each account keeps its own secret.
 *
 * An environment value equal to a known insecure default is treated as unset,
 * so a legacy `.env` carrying `admin123` still produces a secure account.
 */
export function resolveBootstrapPassword(scope: string, envVar: string): BootstrapResolution {
  const env = (process.env[envVar] || '').trim();
  if (env && !INSECURE_DEFAULTS.has(env)) return { password: env, source: 'env' };

  const store = readStore();
  if (store[scope]) return { password: store[scope], source: 'file', persisted: true, file: bootstrapCredFile() };

  const password = generatePassword();
  store[scope] = password;
  const persisted = writeStore(store);
  if (!persisted) {
    throw new Error(
      `Could not persist the generated ${scope} bootstrap credential to ${bootstrapCredFile()}. Set ${envVar} or fix the state-directory permissions.`,
    );
  }
  return { password, source: 'generated', persisted, file: bootstrapCredFile() };
}

/**
 * Remove a scope's secret once the owner has chosen their own password
 * (one-time use). Best-effort: never throws. Deletes the file when empty.
 */
export function clearBootstrapPassword(scope: string): void {
  try {
    const store = readStore();
    if (!(scope in store)) return;
    delete store[scope];
    if (Object.keys(store).length === 0) {
      try {
        fs.unlinkSync(bootstrapCredFile());
      } catch {
        /* already gone */
      }
      return;
    }
    writeStore(store);
  } catch {
    /* best-effort cleanup */
  }
}
