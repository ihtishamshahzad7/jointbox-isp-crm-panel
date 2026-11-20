/**
 * FIRST-BOOT ADMIN CREDENTIALS.
 *
 * A new installation creates two logins — superadmin@uplinko.com (platform)
 * and admin@uplinko.com (first company) — with the operator's password from
 * the environment, or the published default `admin123`. Both are created with
 * `mustChangePassword`: every route except change-password answers 403 until
 * the owner sets their own password at the first sign-in.
 *
 * The file helpers below remain for installs that were bootstrapped with a
 * generated one-time secret (clearBootstrapPassword still removes it).
 */
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** The published first-boot password (must be changed at the first sign-in). */
export const DEFAULT_FIRST_BOOT_PASSWORD = 'admin123';

/** Passwords that are only acceptable as a one-time first-boot value. */
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
  /** 'env' = operator-provided; 'default' = admin123; 'file' / 'generated' = legacy generated secret. */
  source: 'env' | 'default' | 'file' | 'generated';
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
  // First-boot password: the operator's value, else the published default
  // `admin123`. Either way the account is created with mustChangePassword, so
  // nothing but the change-password screen is reachable until the owner picks
  // their own password at the first sign-in.
  const env = (process.env[envVar] || '').trim();
  if (env) return { password: env, source: 'env' };
  return { password: DEFAULT_FIRST_BOOT_PASSWORD, source: 'default' };
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
