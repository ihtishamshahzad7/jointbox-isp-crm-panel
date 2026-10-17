import { Client } from 'pg';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describePg, TEST_DB_URL } from '../pg';
import { BackupService } from '../../src/common/backup.service';

/**
 * A BACKUP IS ONLY A BACKUP ONCE IT HAS BEEN RESTORED.
 *
 * Runs the real BackupService.run() against a throwaway database, restores
 * the dump into a second throwaway database with the exact command the panel
 * shows operators, and compares the data. Both databases are created and
 * dropped here; nothing else is touched.
 */
const hasTools = (() => {
  try { execFileSync('pg_dump', ['--version']); execFileSync('pg_restore', ['--version']); return true; } catch { return false; }
})();
if (!hasTools) console.warn('backup-restore: pg_dump/pg_restore not on PATH — install postgresql-client to run this suite.');
const suite = hasTools ? describePg : describe.skip;

suite('backup → verify → restore', () => {
  const tag = `${process.pid}_${Date.now()}`;
  const SRC = `jbx_bk_src_${tag}`;
  const DST = `jbx_bk_dst_${tag}`;
  const dir = mkdtempSync(join(tmpdir(), 'jbx-backup-'));
  const urlFor = (db: string) => { const u = new URL(TEST_DB_URL); u.pathname = `/${db}`; u.search = ''; return u.toString(); };
  const admin = () => { const c = new Client({ connectionString: TEST_DB_URL }); return c.connect().then(() => c); };
  const prevEnv = { url: process.env.DATABASE_URL, dir: process.env.BACKUP_DIR };

  beforeAll(async () => {
    const a = await admin();
    await a.query(`CREATE DATABASE ${SRC}`);
    await a.query(`CREATE DATABASE ${DST}`);
    await a.end();
    const s = new Client({ connectionString: urlFor(SRC) });
    await s.connect();
    await s.query(`CREATE TABLE "Invoice" (id serial PRIMARY KEY, "invoiceNo" text UNIQUE, total numeric(18,4))`);
    await s.query(`INSERT INTO "Invoice" ("invoiceNo", total) SELECT 'INV-' || g, g * 1.25 FROM generate_series(1, 500) g`);
    await s.end();
    process.env.DATABASE_URL = urlFor(SRC);
    process.env.BACKUP_DIR = dir;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = prevEnv.url;
    process.env.BACKUP_DIR = prevEnv.dir;
    const a = await admin();
    await a.query(`DROP DATABASE IF EXISTS ${SRC}`);
    await a.query(`DROP DATABASE IF EXISTS ${DST}`);
    await a.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes a verified, checksummed dump that restores to identical data', async () => {
    const svc = new BackupService({} as any);
    const r: any = await svc.run();
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);

    const side = readFileSync(`${r.file}.sha256`, 'utf8').split(/\s+/)[0];
    expect(side).toBe(await BackupService.sha256(r.file));

    const u = new URL(urlFor(DST));
    execFileSync('pg_restore', ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username),
      '-d', DST, '--clean', '--if-exists', '--no-owner', r.file], { env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) } });

    const d = new Client({ connectionString: urlFor(DST) });
    await d.connect();
    const got = await d.query(`SELECT count(*)::int n, sum(total)::text s, max("invoiceNo") m FROM "Invoice"`);
    await d.end();
    expect(got.rows[0]).toEqual({ n: 500, s: '156562.5000', m: 'INV-99' });
  });

  it('a truncated dump fails the same verification run() applies', async () => {
    const svc = new BackupService({} as any);
    const r: any = await svc.run();
    const bad = join(dir, 'truncated.dump');
    const buf = readFileSync(r.file);
    writeFileSync(bad, buf.subarray(0, Math.floor(buf.length / 3)));
    expect(() => execFileSync('pg_restore', ['--list', bad], { stdio: 'pipe' })).toThrow();
  });
});
