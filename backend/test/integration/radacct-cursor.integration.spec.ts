import { PgHarness, describePg, race, succeeded, PG, codeOf } from '../pg';

/**
 * R1 · A2 — THE POLLER MUST SEE STOPS, AND MUST SURVIVE A RESTART.
 *
 * The bug had two halves and this file pins both, plus the safeguard that
 * keeps the fix from turning lost events into duplicate events.
 *
 * These model the queries and the cursor protocol in SQL rather than driving
 * the Nest service. What that proves is that the ALGORITHM is right — which is
 * where both bugs lived. It does not prove the service is wired to it; that
 * needs Prisma against this database and is a later step.
 */
describePg('R1: radacct polling cursor', () => {
  const pg = new PgHarness('radcursor');

  beforeAll(() =>
    pg.setup([
      `CREATE TABLE radacct (
         radacctid bigserial PRIMARY KEY,
         acctsessionid varchar(64),
         username varchar(64),
         acctstarttime timestamptz,
         acctstoptime timestamptz,
         acctupdatetime timestamptz)`,
      `CREATE TABLE "NetworkLog" (
         id bigserial PRIMARY KEY, "sessionId" text, "eventType" text,
         username text, "loggedAt" timestamptz DEFAULT now())`,
      `CREATE UNIQUE INDEX network_log_session_event_uq
         ON "NetworkLog" ("sessionId", "eventType")
         WHERE "sessionId" IS NOT NULL AND "eventType" IN ('CONNECTION','DISCONNECTION')`,
      `CREATE TABLE poller_cursor (
         name text PRIMARY KEY, ts timestamptz NOT NULL, id bigint DEFAULT 0)`,
    ]),
  );
  afterAll(() => pg.teardown());

  beforeEach(async () => {
    await pg.query('TRUNCATE radacct, "NetworkLog", poller_cursor RESTART IDENTITY');
    await pg.query(`INSERT INTO poller_cursor VALUES
      ('radacct_activity', '1970-01-01', 0), ('radacct_stop', '1970-01-01', 0)`);
  });

  const cursor = async (name: string) =>
    (await pg.query('SELECT ts, id FROM poller_cursor WHERE name = $1', [name])).rows[0];

  /** One poll cycle: select, write events, advance cursors, persist. */
  const poll = async () => {
    const a = await cursor('radacct_activity');
    const s = await cursor('radacct_stop');

    const stopped = await pg.query(
      `SELECT * FROM radacct WHERE acctstoptime IS NOT NULL
         AND (acctstoptime, radacctid) > ($1::timestamptz, $2::bigint)
       ORDER BY acctstoptime ASC, radacctid ASC LIMIT 200`,
      [s.ts, s.id],
    );
    const active = await pg.query(
      `SELECT * FROM radacct WHERE acctstoptime IS NULL AND acctstarttime IS NOT NULL
         AND (COALESCE(acctupdatetime, acctstarttime), radacctid) > ($1::timestamptz, $2::bigint)
       ORDER BY COALESCE(acctupdatetime, acctstarttime) ASC, radacctid ASC LIMIT 200`,
      [a.ts, a.id],
    );

    let newA = { ts: a.ts, id: a.id };
    let newS = { ts: s.ts, id: s.id };
    for (const r of [...active.rows, ...stopped.rows]) {
      const evt = r.acctstoptime ? 'DISCONNECTION' : 'CONNECTION';
      await pg
        .query(
          `INSERT INTO "NetworkLog" ("sessionId","eventType",username) VALUES ($1,$2,$3)`,
          [r.acctsessionid, evt, r.username],
        )
        .catch((e: any) => {
          if (codeOf(e) !== PG.UNIQUE_VIOLATION) throw e; // already recorded — fine
        });
      // Advance only AFTER the write.
      if (r.acctstoptime) newS = { ts: r.acctstoptime, id: r.radacctid };
      else newA = { ts: r.acctupdatetime ?? r.acctstarttime, id: r.radacctid };
    }

    await pg.query('UPDATE poller_cursor SET ts=$2, id=$3 WHERE name=$1', [
      'radacct_activity', newA.ts, newA.id,
    ]);
    await pg.query('UPDATE poller_cursor SET ts=$2, id=$3 WHERE name=$1', [
      'radacct_stop', newS.ts, newS.id,
    ]);
    return active.rows.length + stopped.rows.length;
  };

  const events = async (type?: string) =>
    Number(
      await pg.scalar(
        `SELECT count(*) FROM "NetworkLog"` + (type ? ` WHERE "eventType" = '${type}'` : ''),
      ),
    );

  // ── bug one: the stop that could never be seen ──────────────────────────
  it('THE POINT: a session seen while OPEN still produces a DISCONNECTION when it closes', async () => {
    // This is the exact sequence the old cursor could not survive: the row is
    // observed live, its radacctid is passed, and then the SAME row is updated
    // in place with a stop time.
    await pg.query(
      `INSERT INTO radacct (acctsessionid, username, acctstarttime, acctupdatetime)
       VALUES ('S1','ihtisham01', now() - interval '1 hour', now() - interval '5 minutes')`,
    );
    await poll();
    expect(await events('CONNECTION')).toBe(1);
    expect(await events('DISCONNECTION')).toBe(0);

    // FreeRADIUS closes it — same row, same radacctid.
    await pg.query(`UPDATE radacct SET acctstoptime = now() WHERE acctsessionid = 'S1'`);
    await poll();

    expect(await events('DISCONNECTION')).toBe(1);
  });

  it('and the OLD radacctid-only cursor still misses it, which is why A2 exists', async () => {
    await pg.query(
      `INSERT INTO radacct (acctsessionid, username, acctstarttime, acctupdatetime)
       VALUES ('S2','ali02', now(), now())`,
    );
    const lastId = Number(await pg.scalar('SELECT max(radacctid) FROM radacct'));
    await pg.query(`UPDATE radacct SET acctstoptime = now() WHERE acctsessionid = 'S2'`);

    // The old query: id strictly greater than what was already seen.
    const missed = await pg.query('SELECT * FROM radacct WHERE radacctid > $1', [lastId]);
    expect(missed.rowCount).toBe(0); // the stop is invisible — permanently
  });

  // ── bug two: the restart that skipped everything ────────────────────────
  it('a restart resumes from the stored cursor instead of jumping to now', async () => {
    await pg.query(
      `INSERT INTO radacct (acctsessionid, username, acctstarttime, acctupdatetime)
       SELECT 'R'||g, 'user'||g, now() - interval '2 hours', now() - (g || ' minutes')::interval
         FROM generate_series(1,5) g`,
    );
    await poll();
    expect(await events('CONNECTION')).toBe(5);

    // Sessions arrive while the process is down.
    await pg.query(
      `INSERT INTO radacct (acctsessionid, username, acctstarttime, acctupdatetime)
       VALUES ('DOWNTIME','during-deploy', now(), now())`,
    );

    // "Restart": the cursor is read back from the table, not reseeded to MAX.
    await poll();
    expect(await events('CONNECTION')).toBe(6);
    expect(
      Number(await pg.scalar(`SELECT count(*) FROM "NetworkLog" WHERE username = 'during-deploy'`)),
    ).toBe(1);
  });

  // ── safeguard 1: processed, not seen ────────────────────────────────────
  /**
   * A crash between writing the event and advancing the cursor must be
   * harmless. Polling the same batch again must produce no second event —
   * otherwise the fix has traded lost events for duplicate ones, which is the
   * failure mode the safeguard exists to prevent.
   */
  it('SAFEGUARD 1: replaying the same batch creates no duplicate events', async () => {
    await pg.query(
      `INSERT INTO radacct (acctsessionid, username, acctstarttime, acctupdatetime)
       SELECT 'C'||g, 'user'||g, now(), now() FROM generate_series(1,10) g`,
    );
    await poll();
    expect(await events()).toBe(10);

    // Simulate the crash: rewind the cursor as if the advance never persisted.
    await pg.query(`UPDATE poller_cursor SET ts='1970-01-01', id=0`);
    await poll();

    expect(await events()).toBe(10); // still ten, not twenty
  });

  it('and concurrent pollers cannot double-write the same event either', async () => {
    await pg.query(
      `INSERT INTO radacct (acctsessionid, username, acctstarttime, acctupdatetime)
       VALUES ('RACE','user1', now(), now())`,
    );
    const results = await race(10, () =>
      pg.query(`INSERT INTO "NetworkLog" ("sessionId","eventType",username)
                VALUES ('RACE','CONNECTION','user1')`),
    );
    expect(succeeded(results).length).toBe(1);
    expect(await events('CONNECTION')).toBe(1);
  });

  // ── safeguard 2: a timestamp alone is not a cursor ──────────────────────
  /**
   * FreeRADIUS writes accounting rows in bursts, so many share a timestamp to
   * the microsecond. With `ts > cursor` those rows are skipped; with `ts >=`
   * the poller loops on them forever. The row-value comparison on
   * (ts, radacctid) is what makes the order total.
   */
  it('SAFEGUARD 2: rows sharing one timestamp are each processed exactly once', async () => {
    await pg.query(
      `INSERT INTO radacct (acctsessionid, username, acctstarttime, acctupdatetime)
       SELECT 'T'||g, 'user'||g, '2026-09-13 10:00:00+00', '2026-09-13 10:00:00+00'
         FROM generate_series(1,50) g`,
    );
    // Identical timestamps, by construction.
    expect(Number(await pg.scalar('SELECT count(DISTINCT acctupdatetime) FROM radacct'))).toBe(1);

    await poll();
    await poll(); // a second cycle must find nothing left and must not loop

    expect(await events('CONNECTION')).toBe(50);
    expect(Number(await pg.scalar(`SELECT id FROM poller_cursor WHERE name='radacct_activity'`))).toBe(50);
  });

  it('a stop and an update on the same row use SEPARATE cursors', async () => {
    // The activity cursor is well past this row by the time it closes. Only a
    // separate stop cursor can still select it.
    await pg.query(
      `INSERT INTO radacct (acctsessionid, username, acctstarttime, acctupdatetime)
       SELECT 'X'||g, 'u'||g, now(), now() + (g || ' seconds')::interval FROM generate_series(1,5) g`,
    );
    await poll();
    const act = await cursor('radacct_activity');
    await pg.query(`UPDATE radacct SET acctstoptime = now() WHERE acctsessionid = 'X1'`);
    await poll();

    expect(await events('DISCONNECTION')).toBe(1);
    // The activity cursor did not rewind to accommodate the stop.
    expect(Number((await cursor('radacct_activity')).id)).toBe(Number(act.id));
  });
});
