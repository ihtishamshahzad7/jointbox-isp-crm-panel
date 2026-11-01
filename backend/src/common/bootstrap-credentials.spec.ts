/**
 * S3 — secure first-boot admin credentials.
 *
 * Proves there is no hardcoded default: an operator value is used as-is, a
 * legacy "admin123" is refused, an unset value yields a cryptographically
 * random one-time secret written 0600, the secret is REUSED on later boots
 * (not regenerated → no reset-on-restart), and clearing it after the first
 * password change makes it one-time.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  resolveBootstrapPassword,
  clearBootstrapPassword,
  generatePassword,
  INSECURE_DEFAULTS,
  bootstrapCredFile,
} from './bootstrap-credentials';

let tmpDir: string;
const OLD_ENV = process.env;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uplinko-boot-'));
  process.env = { ...OLD_ENV };
  process.env.BOOTSTRAP_CRED_FILE = path.join(tmpDir, 'bootstrap-credentials.json');
  delete process.env.PLATFORM_ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
});
afterEach(() => {
  process.env = OLD_ENV;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('bootstrap credentials (S3)', () => {
  it('uses an operator-set env password as-is and writes no file', () => {
    process.env.PLATFORM_ADMIN_PASSWORD = 'My$trongOne';
    const r = resolveBootstrapPassword('platform', 'PLATFORM_ADMIN_PASSWORD');
    expect(r).toMatchObject({ password: 'My$trongOne', source: 'env' });
    expect(fs.existsSync(bootstrapCredFile())).toBe(false);
  });

  it('treats a legacy insecure default as unset and generates instead', () => {
    expect(INSECURE_DEFAULTS.has('admin123')).toBe(true);
    process.env.PLATFORM_ADMIN_PASSWORD = 'admin123';
    const r = resolveBootstrapPassword('platform', 'PLATFORM_ADMIN_PASSWORD');
    expect(r.source).toBe('generated');
    expect(r.password).not.toBe('admin123');
    expect(r.password.length).toBeGreaterThanOrEqual(20);
  });

  it('generates a random secret, persists it 0600, and reuses it next boot', () => {
    const first = resolveBootstrapPassword('platform', 'PLATFORM_ADMIN_PASSWORD');
    expect(first.source).toBe('generated');
    expect(first.persisted).toBe(true);
    if (process.platform === 'win32') {
      const acl = execFileSync(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'),
        [bootstrapCredFile()],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(acl).toContain(process.env.USERNAME);
      expect(acl).not.toMatch(/BUILTIN\\Users|Everyone/);
    } else {
      const mode = fs.statSync(bootstrapCredFile()).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    // A second resolve (next boot) REUSES the same value — no new secret, no reset.
    const second = resolveBootstrapPassword('platform', 'PLATFORM_ADMIN_PASSWORD');
    expect(second.source).toBe('file');
    expect(second.password).toBe(first.password);
  });

  it('fails before account creation can proceed if the generated secret cannot be persisted', () => {
    process.env.BOOTSTRAP_CRED_FILE = tmpDir;
    expect(() => resolveBootstrapPassword('platform', 'PLATFORM_ADMIN_PASSWORD'))
      .toThrow(/Could not persist the generated platform bootstrap credential/);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('keeps separate secrets per scope', () => {
    const p = resolveBootstrapPassword('platform', 'PLATFORM_ADMIN_PASSWORD');
    const c = resolveBootstrapPassword('company', 'ADMIN_PASSWORD');
    expect(p.password).not.toBe(c.password);
    // Both persisted in the one file.
    const store = JSON.parse(fs.readFileSync(bootstrapCredFile(), 'utf8'));
    expect(Object.keys(store).sort()).toEqual(['company', 'platform']);
  });

  it('clears a secret after first password change (one-time use)', () => {
    resolveBootstrapPassword('platform', 'PLATFORM_ADMIN_PASSWORD');
    resolveBootstrapPassword('company', 'ADMIN_PASSWORD');
    clearBootstrapPassword('platform');
    const store = JSON.parse(fs.readFileSync(bootstrapCredFile(), 'utf8'));
    expect('platform' in store).toBe(false);
    expect('company' in store).toBe(true);
    // After the other is cleared too, the file is removed entirely.
    clearBootstrapPassword('company');
    expect(fs.existsSync(bootstrapCredFile())).toBe(false);
  });

  it('generatePassword returns URL-safe high-entropy strings', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });
});
