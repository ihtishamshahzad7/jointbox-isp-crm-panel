import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BackupService } from './backup.service';

/**
 * BackupService.resolveBackupFile — the path-traversal guard behind the new
 * download/restore-command endpoints (backup.controller.ts).
 *
 * A pg_dump is the entire business in one file. The download endpoint takes
 * a filename straight from the URL, so this function is the only thing
 * standing between that request and arbitrary file disclosure. Same shape as
 * NDM's resolveArchiveFile: reject on a resolved-path prefix check (not just
 * a regex on the raw input), so `../`, an absolute path, or a same-directory
 * file that merely LOOKS like a backup can never be served.
 *
 * Real filesystem, not mocked — this is exactly the kind of logic where a
 * mocked `existsSync`/`resolve` could hide a real traversal bug.
 */
describe('BackupService.resolveBackupFile', () => {
  let dir: string;
  let svc: BackupService;
  const originalEnv = { ...process.env };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jointbox-backup-test-'));
    process.env.BACKUP_DIR = dir;
    fs.writeFileSync(path.join(dir, 'jointbox-2026-08-24T10-00-00.dump'), 'dummy');
    // Sits in the SAME directory but is not a backup — must never be servable
    // just because it happens to live where dumps live.
    fs.writeFileSync(path.join(dir, 'not-a-backup.txt'), 'secret');
    svc = new BackupService({} as any); // prisma is unused by this method
  });

  afterAll(() => {
    process.env = { ...originalEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a real, correctly-named backup file', () => {
    const full = svc.resolveBackupFile('jointbox-2026-08-24T10-00-00.dump');
    expect(full).toBe(path.join(dir, 'jointbox-2026-08-24T10-00-00.dump'));
  });

  it('refuses a path-traversal attempt', () => {
    expect(svc.resolveBackupFile('../not-a-backup.txt')).toBeNull();
    expect(svc.resolveBackupFile('../../../../etc/passwd')).toBeNull();
  });

  it('refuses a file in the same directory that does not match the backup naming scheme', () => {
    // Proves the check is the naming scheme AND the directory, not just the directory.
    expect(svc.resolveBackupFile('not-a-backup.txt')).toBeNull();
  });

  it('refuses a well-formed name that does not actually exist', () => {
    expect(svc.resolveBackupFile('jointbox-1999-01-01T00-00-00.dump')).toBeNull();
  });

  it('refuses an absolute path into a different directory entirely', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'jointbox-elsewhere-'));
    const decoy = path.join(elsewhere, 'jointbox-2026-08-24T10-00-00.dump');
    fs.writeFileSync(decoy, 'dummy');
    try {
      expect(svc.resolveBackupFile(decoy)).toBeNull();
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses an empty or missing name', () => {
    expect(svc.resolveBackupFile('')).toBeNull();
    expect(svc.resolveBackupFile(undefined as any)).toBeNull();
  });
});
