import { DatabaseSetupService } from './database-setup.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * After scripts/radius-schema-apply.sh the FreeRADIUS tables live in schema
 * `radius` and public.radacct & co. are views. Setup must aim at the real
 * tables (a view takes no index, column or storage parameter), and must build
 * the RADIUS indexes CONCURRENTLY so FreeRADIUS's writes are never blocked.
 */
describe('DatabaseSetupService — RADIUS tables', () => {
  function make(moved: boolean, invalid: string[] = []) {
    const executed: string[] = [];
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ moved }]),
      $queryRawUnsafe: jest.fn((sql: string) => {
        const m = /i\.relname = '([a-z_]+)'/.exec(sql);
        return Promise.resolve(
          m && invalid.includes(m[1]) ? [{ '?column?': 1 }] : [],
        );
      }),
      $executeRawUnsafe: jest.fn((sql: string) => {
        executed.push(sql.replace(/\s+/g, ' ').trim());
        return Promise.resolve(0);
      }),
    };
    return {
      svc: new DatabaseSetupService(prisma as unknown as PrismaService),
      executed,
    };
  }

  it('targets radius.* when the tables were moved, CONCURRENTLY', async () => {
    const { svc, executed } = make(true);
    await svc.applyAll();
    const radius = executed.filter(
      (s) =>
        /\b(radacct|radpostauth|radcheck|radreply)\b/.test(s) &&
        !/archive\./.test(s),
    );
    expect(executed).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS radacct_open_sessions_idx ON radius.radacct (username, nasipaddress) WHERE acctstoptime IS NULL',
    );
    expect(
      executed.some((s) =>
        s.startsWith(
          'ALTER TABLE radius.radacct ADD COLUMN IF NOT EXISTS acctupdatetime',
        ),
      ),
    ).toBe(true);
    expect(
      executed.some((s) => s.startsWith('ALTER TABLE radius.radacct SET (')),
    ).toBe(true);
    // no index or ALTER aimed at the public views
    expect(
      radius.filter(
        (s) =>
          /^(CREATE INDEX|ALTER TABLE)/.test(s) &&
          / (ON|TABLE) (public\.)?rad(acct|postauth|check|reply)\b/.test(s),
      ),
    ).toEqual([]);
    // every index on a table FreeRADIUS writes is concurrent (the archive
    // schema is the panel's own, written only by the archival job)
    expect(
      executed.filter(
        (s) =>
          /^CREATE INDEX (IF NOT EXISTS )?rad/.test(s) &&
          !/ ON archive\./.test(s),
      ),
    ).toEqual([]);
  });

  it('keeps the public tables when nothing was moved', async () => {
    const { svc, executed } = make(false);
    await svc.applyAll();
    expect(executed).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS radcheck_username_idx ON radcheck (username)',
    );
    expect(
      executed.some((s) => s.startsWith('ALTER TABLE radacct SET (')),
    ).toBe(true);
  });

  it('drops an index an interrupted concurrent build left INVALID, then rebuilds it', async () => {
    const { svc, executed } = make(true, ['radacct_nas_idx']);
    await svc.applyAll();
    const drop = executed.indexOf(
      'DROP INDEX CONCURRENTLY IF EXISTS radius.radacct_nas_idx',
    );
    const create = executed.findIndex((s) =>
      s.startsWith(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS radacct_nas_idx ON radius.radacct',
      ),
    );
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(drop);
  });
});
