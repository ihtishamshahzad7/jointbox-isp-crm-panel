/**
 * S3 — secure first-boot admin credentials.
 *
 * First-boot password: the operator's value as-is, otherwise admin123. The
 * accounts are created with mustChangePassword (see main.ts), so the default
 * only ever opens the change-password screen.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveBootstrapPassword,
  clearBootstrapPassword,
  generatePassword,
  DEFAULT_FIRST_BOOT_PASSWORD,
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

  it('accepts admin123 from the environment (it must still be changed at first sign-in)', () => {
    process.env.PLATFORM_ADMIN_PASSWORD = 'admin123';
    expect(resolveBootstrapPassword('platform', 'PLATFORM_ADMIN_PASSWORD')).toMatchObject({ password: 'admin123', source: 'env' });
  });

  it('defaults to admin123 when nothing is set, and writes no file', () => {
    expect(DEFAULT_FIRST_BOOT_PASSWORD).toBe('admin123');
    expect(resolveBootstrapPassword('company', 'ADMIN_PASSWORD')).toMatchObject({ password: 'admin123', source: 'default' });
    expect(fs.existsSync(bootstrapCredFile())).toBe(false);
  });



  it('still clears a legacy generated secret after the first password change', () => {
    fs.writeFileSync(bootstrapCredFile(), JSON.stringify({ platform: 'x'.repeat(24), company: 'y'.repeat(24) }), { mode: 0o600 });
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
