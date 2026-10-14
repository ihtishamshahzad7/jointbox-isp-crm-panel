import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { PgHarness, describePg, race, succeeded, TEST_DB_URL } from '../pg';

/**
 * RADIUS TENANCY — the database decision FreeRADIUS and the panel's CoA use.
 *
 * Runs the REAL migration (prisma/migrations/20261013130000_radius_tenancy_policy)
 * on minimal copies of the tables it reads, then pins every rule of
 * docs/RADIUS_TENANCY.md: same company allowed, other companies refused,
 * explicit shares honoured only as documented, everything missing or
 * ambiguous refused, a NAS-IP-Address naming another company's router
 * refused, a failing check never letting a request through in enforce, the
 * switch, the event log, Accounting-On/Off, and that a caller's temporary
 * table cannot stand in for a real one.
 */
const MIGRATION = readFileSync(
  join(
    __dirname,
    '../../prisma/migrations/20261013130000_radius_tenancy_policy/migration.sql',
  ),
  'utf8',
);

describePg('RADIUS tenancy policy (SQL)', () => {
  const pg = new PgHarness('radtenancy');
  let initialMode = '';

  // Companies: A = 10 (dealer 11, sub-dealer 12), B = 20 (dealer 21). Platform = 1.
  // Routers: 100 (A, 192.0.2.10), 200 (B, 192.0.2.20), 300 (dealer 11 of A, 192.0.2.30).
  beforeAll(async () => {
    await pg.setup([
      `CREATE TABLE "User" (id int PRIMARY KEY, "parentId" int, role text NOT NULL)`,
      `CREATE TABLE "Subscriber" (id serial PRIMARY KEY, username varchar(64) UNIQUE NOT NULL, "userId" int)`,
      `CREATE TABLE nas (id int PRIMARY KEY, "nasIp" inet UNIQUE, "isActive" boolean NOT NULL DEFAULT true, "ownerId" int)`,
      `CREATE TABLE "NasAssignment" (id serial PRIMARY KEY, "nasId" int NOT NULL, "userId" int NOT NULL,
         "assignedById" int, propagate boolean NOT NULL DEFAULT true, UNIQUE ("nasId", "userId"))`,
      `CREATE TABLE radacct (radacctid bigserial PRIMARY KEY, username varchar(64), nasipaddress inet NOT NULL,
         acctstarttime timestamptz DEFAULT now(), acctstoptime timestamptz)`,
    ]);
    await pg.query(MIGRATION);
    initialMode = await pg.scalar(`SELECT mode FROM radius_tenancy_setting`);
    await pg.query(`INSERT INTO "User" VALUES
      (1, NULL, 'SUPER_ADMIN'),
      (10, 1, 'ADMIN'), (11, 10, 'RESELLER'), (12, 11, 'DEALER'),
      (20, 1, 'ADMIN'), (21, 20, 'RESELLER')`);
    await pg.query(`INSERT INTO nas (id, "nasIp", "ownerId") VALUES
      (100, '192.0.2.10', 10), (200, '192.0.2.20', 20), (300, '192.0.2.30', 11)`);
    await pg.query(`INSERT INTO "Subscriber" (username, "userId") VALUES
      ('a_root', 10), ('a_dealer', 11), ('a_sub', 12), ('b_root', 20), ('b_dealer', 21)`);
  });
  afterAll(() => pg.teardown());

  beforeEach(async () => {
    await pg.query(`DELETE FROM "NasAssignment"`);
    await pg.query(`DELETE FROM radius_tenancy_event`);
    await pg.query(`UPDATE radius_tenancy_setting SET mode = 'enforce'`);
  });

  const authz = (u: string | null, ip: string | null) =>
    pg.scalar<string>('SELECT jointbox_radius_authz($1, $2)', [u, ip]);
  // the panel's call (CoA / router API): no claimed address
  const tenancy = (kind: string, u: string | null, ip: string | null) =>
    pg.scalar<string>('SELECT jointbox_radius_tenancy($1, $2, $3)', [
      kind,
      u,
      ip,
    ]);
  // FreeRADIUS's call: source address + the NAS-IP-Address the packet claims
  const tenancy4 = (
    kind: string,
    u: string | null,
    src: string | null,
    claimed: string | null,
  ) =>
    pg.scalar<string>('SELECT jointbox_radius_tenancy($1, $2, $3, $4)', [
      kind,
      u,
      src,
      claimed,
    ]);
  /** Run fn with one row temporarily changed, then put it back. */
  async function withChange(
    set: string,
    undo: string,
    fn: () => Promise<void>,
  ) {
    await pg.query(set);
    try {
      await fn();
    } finally {
      await pg.query(undo);
    }
  }

  it("every database starts in monitor; re-running never changes an operator's choice", async () => {
    expect(initialMode).toBe('monitor'); // the migration ran on empty tables in beforeAll
    await pg.query(`DELETE FROM radius_tenancy_setting`);
    await pg.query(MIGRATION); // now there are routers and subscribers
    expect(await pg.scalar(`SELECT mode FROM radius_tenancy_setting`)).toBe(
      'monitor',
    );
    await pg.query(
      `UPDATE radius_tenancy_setting SET mode = 'enforce', updated_by = 'operator'`,
    );
    await pg.query(MIGRATION); // replay (update script, crash recovery)
    expect(
      await pg.scalar(`SELECT count(*)::int FROM radius_tenancy_setting`),
    ).toBe(1);
    expect(
      await pg.scalar(
        `SELECT mode || '/' || updated_by FROM radius_tenancy_setting`,
      ),
    ).toBe('enforce/operator');
  });

  it("the panel's 3-argument call and FreeRADIUS's 4-argument call are one function", async () => {
    expect(
      await pg.scalar(`SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                             WHERE n.nspname = current_schema() AND p.proname = 'jointbox_radius_tenancy'`),
    ).toBe(1);
    expect(await tenancy('coa', 'a_root', '192.0.2.10')).toBe('allow');
    expect(await tenancy('coa', 'b_root', '192.0.2.10')).toBe(
      'reject:cross-company',
    );
  });

  describe('same company', () => {
    it.each([
      ['a_root', '192.0.2.10'],
      ['a_dealer', '192.0.2.10'],
      ['a_sub', '192.0.2.10'],
      ['a_sub', '192.0.2.30'], // a dealer's router serves the whole company
      ['a_root', '192.0.2.30'],
      ['b_root', '192.0.2.20'],
      ['b_dealer', '192.0.2.20'],
    ])('%s on %s → allow', async (u, ip) => {
      expect(await authz(u, ip)).toBe('allow');
    });
  });

  describe('other company', () => {
    it.each([
      ['b_root', '192.0.2.10'],
      ['b_dealer', '192.0.2.30'],
      ['a_root', '192.0.2.20'],
      ['a_sub', '192.0.2.20'],
    ])('%s on %s → cross-company', async (u, ip) => {
      expect(await authz(u, ip)).toBe('cross-company');
    });
  });

  describe('missing, ambiguous or invalid → refused', () => {
    it('unknown router address', async () => {
      expect(await authz('a_root', '198.51.100.1')).toBe('nas-unknown');
      expect(await authz('a_root', '')).toBe('nas-unknown');
      expect(await authz('a_root', null)).toBe('nas-unknown');
      expect(await authz('a_root', 'not-an-ip')).toBe('nas-unknown');
    });
    it('disabled router', () =>
      withChange(
        `UPDATE nas SET "isActive" = false WHERE id = 100`,
        `UPDATE nas SET "isActive" = true WHERE id = 100`,
        async () => {
          expect(await authz('a_root', '192.0.2.10')).toBe('nas-disabled');
        },
      ));
    it('two active routers on one address', () =>
      withChange(
        `INSERT INTO nas (id, "nasIp", "ownerId") VALUES (101, '192.0.2.10/24', 10)`,
        `DELETE FROM nas WHERE id = 101`,
        async () => {
          expect(await authz('a_root', '192.0.2.10')).toBe('nas-ambiguous');
        },
      ));
    it('an inactive duplicate does not make it ambiguous', () =>
      withChange(
        `INSERT INTO nas (id, "nasIp", "ownerId", "isActive") VALUES (101, '192.0.2.10/24', 20, false)`,
        `DELETE FROM nas WHERE id = 101`,
        async () => {
          expect(await authz('a_root', '192.0.2.10')).toBe('allow');
        },
      ));
    it('unknown subscriber', async () => {
      expect(await authz('nobody', '192.0.2.10')).toBe('subscriber-unknown');
      expect(await authz('', '192.0.2.10')).toBe('subscriber-unknown');
      expect(await authz('A_ROOT', '192.0.2.10')).toBe('subscriber-unknown'); // exact, like radcheck
    });
    it('subscriber without an owner, or with a deleted owner', async () => {
      await withChange(
        `UPDATE "Subscriber" SET "userId" = NULL WHERE username = 'a_root'`,
        `UPDATE "Subscriber" SET "userId" = 10 WHERE username = 'a_root'`,
        async () => {
          expect(await authz('a_root', '192.0.2.10')).toBe(
            'subscriber-no-owner',
          );
        },
      );
      await withChange(
        `UPDATE "Subscriber" SET "userId" = 999 WHERE username = 'a_root'`,
        `UPDATE "Subscriber" SET "userId" = 10 WHERE username = 'a_root'`,
        async () => {
          expect(await authz('a_root', '192.0.2.10')).toBe(
            'subscriber-no-owner',
          );
        },
      );
    });
    it('subscriber owned by the platform account belongs to no company (no platform bypass)', () =>
      withChange(
        `UPDATE "Subscriber" SET "userId" = 1 WHERE username = 'a_root'`,
        `UPDATE "Subscriber" SET "userId" = 10 WHERE username = 'a_root'`,
        async () => {
          expect(await authz('a_root', '192.0.2.10')).toBe(
            'subscriber-no-company',
          );
        },
      ));
    it('router without an owner / owned by the platform account', async () => {
      await withChange(
        `UPDATE nas SET "ownerId" = NULL WHERE id = 100`,
        `UPDATE nas SET "ownerId" = 10 WHERE id = 100`,
        async () => {
          expect(await authz('a_root', '192.0.2.10')).toBe('nas-no-owner');
        },
      );
      await withChange(
        `UPDATE nas SET "ownerId" = 1 WHERE id = 100`,
        `UPDATE nas SET "ownerId" = 10 WHERE id = 100`,
        async () => {
          expect(await authz('a_root', '192.0.2.10')).toBe('nas-no-company');
        },
      );
    });
    it('a parent cycle gives no company', () =>
      withChange(
        `UPDATE "User" SET "parentId" = 12 WHERE id = 10`,
        `UPDATE "User" SET "parentId" = 1 WHERE id = 10`,
        async () => {
          expect(
            await pg.scalar('SELECT jointbox_company_root(12)'),
          ).toBeNull();
          expect(await authz('a_sub', '192.0.2.10')).toBe(
            'subscriber-no-company',
          );
        },
      ));
  });

  describe('explicit shares (NasAssignment)', () => {
    const share = (
      nas: number,
      user: number,
      by: number | null,
      propagate = true,
    ) =>
      pg.query(
        `INSERT INTO "NasAssignment" ("nasId", "userId", "assignedById", propagate) VALUES ($1, $2, $3, $4)`,
        [nas, user, by, propagate],
      );

    it("shared directly to the owner by the router's company → allow (any propagate)", async () => {
      await share(100, 21, 10, false);
      expect(await authz('b_dealer', '192.0.2.10')).toBe('allow');
      expect(await authz('b_root', '192.0.2.10')).toBe('cross-company'); // not to the account above
    });
    it('shared to an account above the owner → allow only with propagate', async () => {
      await share(100, 20, 10, false);
      expect(await authz('b_root', '192.0.2.10')).toBe('allow'); // direct
      expect(await authz('b_dealer', '192.0.2.10')).toBe('cross-company'); // not inherited
      await pg.query(`UPDATE "NasAssignment" SET propagate = true`);
      expect(await authz('b_dealer', '192.0.2.10')).toBe('allow');
    });
    it('a share with no recorded author does not count', async () => {
      await share(100, 21, null);
      expect(await authz('b_dealer', '192.0.2.10')).toBe('cross-company');
    });
    it('a share made by the receiving company itself does not count', async () => {
      await share(100, 21, 20);
      expect(await authz('b_dealer', '192.0.2.10')).toBe('cross-company');
    });
    it("a share made by any account of the router's company counts", async () => {
      await share(300, 21, 11); // router 300 belongs to dealer 11 of company A
      expect(await authz('b_dealer', '192.0.2.30')).toBe('allow');
    });
    it('a share made by the platform account counts (explicit, recorded)', async () => {
      await share(100, 21, 1);
      expect(await authz('b_dealer', '192.0.2.10')).toBe('allow');
    });
    it('a share to the platform account reaches nobody', async () => {
      await share(100, 1, 1, true);
      expect(await authz('b_root', '192.0.2.10')).toBe('cross-company');
      expect(await authz('b_dealer', '192.0.2.10')).toBe('cross-company');
    });
    it('a share makes a router with no company usable only for whom it names', async () => {
      await withChange(
        `UPDATE nas SET "ownerId" = NULL WHERE id = 100`,
        `UPDATE nas SET "ownerId" = 10 WHERE id = 100`,
        async () => {
          await share(100, 21, 1);
          expect(await authz('b_dealer', '192.0.2.10')).toBe('allow');
          expect(await authz('a_root', '192.0.2.10')).toBe('nas-no-owner');
        },
      );
    });
  });

  describe("the router is the packet's source; NAS-IP-Address is only its claim", () => {
    it("a router of the subscriber's company claiming ANOTHER company's router address is refused", async () => {
      expect(await tenancy4('auth', 'a_root', '192.0.2.10', '192.0.2.20')).toBe(
        'reject:nas-ip-foreign',
      );
      expect(
        await tenancy4('acct', 'a_root', '192.0.2.10', '::ffff:192.0.2.20'),
      ).toBe('reject:nas-ip-foreign');
      const rows = (
        await pg.query(
          `SELECT kind, reason, username, nas_ip FROM radius_tenancy_event ORDER BY kind`,
        )
      ).rows;
      // recorded under the router it came FROM, never the router it named
      expect(rows).toEqual([
        {
          kind: 'acct',
          reason: 'nas-ip-foreign',
          username: 'a_root',
          nas_ip: '192.0.2.10',
        },
        {
          kind: 'auth',
          reason: 'nas-ip-foreign',
          username: 'a_root',
          nas_ip: '192.0.2.10',
        },
      ]);
    });
    it('a claim naming a DISABLED router of another company is still refused', async () => {
      await withChange(
        `UPDATE nas SET "isActive" = false WHERE id = 200`,
        `UPDATE nas SET "isActive" = true WHERE id = 200`,
        async () => {
          expect(
            await tenancy4('auth', 'a_root', '192.0.2.10', '192.0.2.20'),
          ).toBe('reject:nas-ip-foreign');
        },
      );
    });
    it.each([
      ['its own address', '192.0.2.10'],
      ['another router of the same company', '192.0.2.30'],
      ['an address no router has (private, behind NAT)', '10.20.30.40'],
      ['no claim', ''],
      ['no claim (NULL)', null],
      ['not an address', "1.2.3.4' OR '1'='1"],
    ])('harmless claim: %s', async (_d, claimed) => {
      expect(await tenancy4('auth', 'a_root', '192.0.2.10', claimed)).toBe(
        'allow',
      );
    });
    it("the claim never ALLOWS: another company's subscriber is refused whatever its router claims", async () => {
      expect(await tenancy4('auth', 'b_root', '192.0.2.10', '192.0.2.20')).toBe(
        'reject:cross-company',
      );
      expect(
        await tenancy4('auth', 'b_root', '198.51.100.7', '192.0.2.20'),
      ).toBe('reject:nas-unknown');
    });
    it('monitor: a foreign claim is allowed and recorded', async () => {
      await pg.query(`UPDATE radius_tenancy_setting SET mode = 'monitor'`);
      expect(await tenancy4('auth', 'a_root', '192.0.2.10', '192.0.2.20')).toBe(
        'monitor:nas-ip-foreign',
      );
      expect(await pg.scalar(`SELECT mode FROM radius_tenancy_event`)).toBe(
        'monitor',
      );
    });
    it('an IPv4 router seen through a dual-stack socket (::ffff:a.b.c.d) is the same router', async () => {
      expect(await authz('a_root', '::ffff:192.0.2.10')).toBe('allow');
      expect(await authz('b_root', '::ffff:192.0.2.10')).toBe('cross-company');
      expect(
        await tenancy4('auth', 'a_root', '::ffff:192.0.2.10', '192.0.2.10'),
      ).toBe('allow');
    });
  });

  describe('EAP Identity / NAK round (kind auth-eap-id): no credential is verified on it', () => {
    it('a name that is no subscriber ("anonymous" outside a TTLS / PEAP tunnel) is left to the credential round, unrecorded', async () => {
      expect(await tenancy4('auth-eap-id', 'anonymous', '192.0.2.10', '')).toBe(
        'allow',
      );
      expect(await tenancy4('auth-eap-id', '', '192.0.2.10', null)).toBe(
        'allow',
      );
      expect(
        await pg.scalar(`SELECT count(*)::int FROM radius_tenancy_event`),
      ).toBe(0);
      // the same name on a credential round is refused as usual
      expect(await tenancy4('auth', 'anonymous', '192.0.2.10', '')).toBe(
        'reject:subscriber-unknown',
      );
    });
    it('the router is still judged: unknown, disabled, foreign claim', async () => {
      expect(
        await tenancy4('auth-eap-id', 'anonymous', '198.51.100.7', ''),
      ).toBe('reject:nas-unknown');
      expect(
        await tenancy4('auth-eap-id', 'anonymous', '192.0.2.10', '192.0.2.20'),
      ).toBe('reject:nas-ip-foreign');
      await withChange(
        `UPDATE nas SET "isActive" = false WHERE id = 100`,
        `UPDATE nas SET "isActive" = true WHERE id = 100`,
        async () => {
          expect(
            await tenancy4('auth-eap-id', 'anonymous', '192.0.2.10', ''),
          ).toBe('reject:nas-disabled');
        },
      );
      // recorded as auth, and never with the unverified name
      expect(
        (
          await pg.query(
            `SELECT DISTINCT kind, username FROM radius_tenancy_event`,
          )
        ).rows,
      ).toEqual([{ kind: 'auth', username: '' }]);
    });
    it("a name that IS a subscriber is judged in full (another company's subscriber refused early)", async () => {
      expect(await tenancy4('auth-eap-id', 'a_root', '192.0.2.10', '')).toBe(
        'allow',
      );
      expect(await tenancy4('auth-eap-id', 'b_root', '192.0.2.10', '')).toBe(
        'reject:cross-company',
      );
      expect(
        (
          await pg.query(
            `SELECT kind, reason, username FROM radius_tenancy_event`,
          )
        ).rows,
      ).toEqual([
        { kind: 'auth', reason: 'cross-company', username: 'b_root' },
      ]);
    });
    it('monitor: the same decisions, prefixed monitor:', async () => {
      await pg.query(`UPDATE radius_tenancy_setting SET mode = 'monitor'`);
      expect(await tenancy4('auth-eap-id', 'anonymous', '192.0.2.10', '')).toBe(
        'allow',
      );
      expect(await tenancy4('auth-eap-id', 'b_root', '192.0.2.10', '')).toBe(
        'monitor:cross-company',
      );
    });
    it('no other kind is lenient about unknown names', async () => {
      for (const k of [
        'auth',
        'acct',
        'coa',
        'AUTH-EAP-ID',
        'auth-eap-id ',
        '',
      ]) {
        expect(await tenancy4(k, 'anonymous', '192.0.2.10', '')).toBe(
          'reject:subscriber-unknown',
        );
      }
    });
  });

  describe('a failing check never lets a request through when enforced', () => {
    const breakShares = (fn: () => Promise<void>) =>
      withChange(
        `ALTER TABLE "NasAssignment" RENAME TO "NasAssignment_away"`,
        `ALTER TABLE "NasAssignment_away" RENAME TO "NasAssignment"`,
        fn,
      );
    it('enforce: reject:check-error, recorded without the username', async () => {
      await breakShares(async () => {
        expect(await tenancy('auth', 'b_root', '192.0.2.10')).toBe(
          'reject:check-error',
        );
        // a decision that does not need the broken table is unaffected
        expect(await tenancy('auth', 'a_root', '192.0.2.10')).toBe('allow');
      });
      const rows = (
        await pg.query(
          `SELECT reason, username, mode FROM radius_tenancy_event`,
        )
      ).rows;
      expect(rows).toEqual([
        { reason: 'check-error', username: '', mode: 'enforce' },
      ]);
    });
    it('monitor: monitor:check-error (allowed, recorded) — an error never switches the mode', async () => {
      await pg.query(`UPDATE radius_tenancy_setting SET mode = 'monitor'`);
      await breakShares(async () => {
        expect(await tenancy('auth', 'b_root', '192.0.2.10')).toBe(
          'monitor:check-error',
        );
      });
      expect(await pg.scalar(`SELECT mode FROM radius_tenancy_setting`)).toBe(
        'monitor',
      );
    });
    it('Accounting-On/Off: reject:check-error when enforced', async () => {
      await pg.query(`DELETE FROM radacct`);
      await pg.query(
        `INSERT INTO radacct (username, nasipaddress) VALUES ('a_root', '192.0.2.10')`,
      );
      await withChange(
        `ALTER TABLE radacct RENAME TO radacct_away`,
        `ALTER TABLE radacct_away RENAME TO radacct`,
        async () => {
          expect(
            await pg.scalar('SELECT jointbox_radius_tenancy_onoff($1, $2)', [
              '192.0.2.10',
              '192.0.2.10',
            ]),
          ).toBe('reject:check-error');
        },
      );
    });
    it('an unreadable switch table means enforce, not off', async () => {
      await withChange(
        `ALTER TABLE radius_tenancy_setting RENAME TO radius_tenancy_setting_away`,
        `ALTER TABLE radius_tenancy_setting_away RENAME TO radius_tenancy_setting`,
        async () => {
          expect(await pg.scalar(`SELECT jointbox_radius_tenancy_mode()`)).toBe(
            'enforce',
          );
          expect(await tenancy('auth', 'b_root', '192.0.2.10')).toBe(
            'reject:cross-company',
          );
        },
      );
    });
    it('an unreadable event table does not change the decision', async () => {
      await withChange(
        `ALTER TABLE radius_tenancy_event RENAME TO radius_tenancy_event_away`,
        `ALTER TABLE radius_tenancy_event_away RENAME TO radius_tenancy_event`,
        async () => {
          expect(await tenancy('auth', 'b_root', '192.0.2.10')).toBe(
            'reject:cross-company',
          );
          expect(await tenancy('auth', 'a_root', '192.0.2.10')).toBe('allow');
        },
      );
    });
  });

  describe('the switch and the event log', () => {
    it('enforce: reject:<reason>, counted once per subscriber and router', async () => {
      expect(await tenancy('auth', 'b_root', '192.0.2.10')).toBe(
        'reject:cross-company',
      );
      expect(await tenancy('auth', 'b_root', '192.0.2.10')).toBe(
        'reject:cross-company',
      );
      const rows = (
        await pg.query(
          `SELECT kind, reason, username, nas_ip, mode, count FROM radius_tenancy_event`,
        )
      ).rows;
      expect(rows).toEqual([
        {
          kind: 'auth',
          reason: 'cross-company',
          username: 'b_root',
          nas_ip: '192.0.2.10',
          mode: 'enforce',
          count: '2',
        },
      ]);
    });
    it('monitor: allowed but recorded', async () => {
      await pg.query(`UPDATE radius_tenancy_setting SET mode = 'monitor'`);
      expect(await tenancy('acct', 'b_root', '192.0.2.10')).toBe(
        'monitor:cross-company',
      );
      expect(await pg.scalar(`SELECT mode FROM radius_tenancy_event`)).toBe(
        'monitor',
      );
    });
    it('off: allowed, nothing checked or recorded', async () => {
      await pg.query(`UPDATE radius_tenancy_setting SET mode = 'off'`);
      expect(await tenancy('auth', 'b_root', '192.0.2.10')).toBe('allow');
      expect(
        await pg.scalar(`SELECT count(*)::int FROM radius_tenancy_event`),
      ).toBe(0);
    });
    it('allowed requests are not recorded', async () => {
      expect(await tenancy('auth', 'a_root', '192.0.2.10')).toBe('allow');
      expect(
        await pg.scalar(`SELECT count(*)::int FROM radius_tenancy_event`),
      ).toBe(0);
    });
    it('a username that matches no subscriber is not stored, whatever the reason', async () => {
      expect(await tenancy('auth', "x' OR 1=1 --", '192.0.2.10')).toBe(
        'reject:subscriber-unknown',
      );
      expect(await tenancy('auth', 'MyPassw0rd!', '198.51.100.7')).toBe(
        'reject:nas-unknown',
      );
      expect(
        await tenancy4('auth', 'typo-user', '192.0.2.10', '192.0.2.20'),
      ).toBe('reject:subscriber-unknown');
      await withChange(
        `UPDATE nas SET "isActive" = false WHERE id = 100`,
        `UPDATE nas SET "isActive" = true WHERE id = 100`,
        async () => {
          expect(await tenancy('auth', 'not-a-subscriber', '192.0.2.10')).toBe(
            'reject:nas-disabled',
          );
          expect(await tenancy('auth', 'a_root', '192.0.2.10')).toBe(
            'reject:nas-disabled',
          );
        },
      );
      expect(
        (
          await pg.query(
            `SELECT reason, username FROM radius_tenancy_event ORDER BY reason, username`,
          )
        ).rows,
      ).toEqual([
        { reason: 'nas-disabled', username: '' },
        { reason: 'nas-disabled', username: 'a_root' }, // a subscriber: recorded
        { reason: 'nas-unknown', username: '' },
        { reason: 'subscriber-unknown', username: '' },
      ]);
    });
    it('a missing switch row means enforce (fail closed); a bad mode cannot be stored', async () => {
      await withChange(
        `DELETE FROM radius_tenancy_setting`,
        `INSERT INTO radius_tenancy_setting (id, mode) VALUES (1, 'enforce')`,
        async () => {
          expect(await tenancy('auth', 'b_root', '192.0.2.10')).toBe(
            'reject:cross-company',
          );
        },
      );
      await expect(
        pg.query(`UPDATE radius_tenancy_setting SET mode = 'allow-all'`),
      ).rejects.toThrow(/radius_tenancy_setting_mode/);
      await expect(
        pg.query(
          `INSERT INTO radius_tenancy_setting (id, mode) VALUES (2, 'off')`,
        ),
      ).rejects.toThrow();
    });
    it('the event table has no column that could hold a password or secret', async () => {
      const cols = (
        await pg.query(`SELECT column_name FROM information_schema.columns
                                     WHERE table_schema = current_schema() AND table_name = 'radius_tenancy_event'`)
      ).rows.map((r: { column_name: string }) => r.column_name);
      expect(cols.sort()).toEqual([
        'count',
        'first_at',
        'id',
        'kind',
        'last_at',
        'mode',
        'nas_ip',
        'reason',
        'username',
      ]);
    });
    it('200 concurrent refusals are all counted, none fails', async () => {
      const out = await race(200, () =>
        tenancy('auth', 'b_root', '192.0.2.10'),
      );
      expect(succeeded(out)).toHaveLength(200);
      expect(await pg.scalar(`SELECT count FROM radius_tenancy_event`)).toBe(
        '200',
      );
    });
  });

  describe('Accounting-On / Accounting-Off', () => {
    const onoff = (claimed: string, src: string) =>
      pg.scalar<string>('SELECT jointbox_radius_tenancy_onoff($1, $2)', [
        claimed,
        src,
      ]);
    beforeEach(async () => {
      await pg.query(`DELETE FROM radacct`);
      await pg.query(
        `INSERT INTO radacct (username, nasipaddress) VALUES ('a_root', '192.0.2.10'), ('a_sub', '192.0.2.10'), ('b_root', '192.0.2.20')`,
      );
    });
    it("a router may reset its own company's sessions", async () => {
      expect(await onoff('192.0.2.10', '192.0.2.10')).toBe('allow');
      expect(await onoff('192.0.2.10', '192.0.2.30')).toBe('allow'); // same company, other router
    });
    it("another company's router claiming that address is refused (even with no open sessions)", async () => {
      expect(await onoff('192.0.2.10', '192.0.2.20')).toBe(
        'reject:nas-ip-foreign',
      );
      await pg.query(`DELETE FROM radacct`);
      expect(await onoff('192.0.2.10', '192.0.2.20')).toBe(
        'reject:nas-ip-foreign',
      );
    });
    it("a router claiming an address that holds another company's sessions is refused", async () => {
      // 203.0.113.50 is no router's address, but company B's session sits under it
      await pg.query(
        `INSERT INTO radacct (username, nasipaddress) VALUES ('b_root', '203.0.113.50')`,
      );
      expect(await onoff('203.0.113.50', '192.0.2.10')).toBe(
        'reject:onoff-foreign-sessions',
      );
      expect(await onoff('203.0.113.50', '192.0.2.20')).toBe('allow');
    });
    it('monitor: allowed and recorded under the sending router, without a username', async () => {
      await pg.query(`UPDATE radius_tenancy_setting SET mode = 'monitor'`);
      expect(await onoff('192.0.2.10', '192.0.2.20')).toBe(
        'monitor:nas-ip-foreign',
      );
      expect(
        (
          await pg.query(
            `SELECT kind, username, nas_ip FROM radius_tenancy_event`,
          )
        ).rows,
      ).toEqual([{ kind: 'acct-onoff', username: '', nas_ip: '192.0.2.20' }]);
    });
    it('an unknown sending router is refused; an address with no sessions is harmless', async () => {
      expect(await onoff('192.0.2.10', '198.51.100.1')).toBe(
        'reject:nas-unknown',
      );
      expect(await onoff('203.0.113.9', '192.0.2.20')).toBe('allow');
      expect(await onoff('', '192.0.2.20')).toBe('allow');
    });
  });

  it('a caller\'s temporary table cannot stand in for "Subscriber" or "nas"', async () => {
    const c = new Client({
      connectionString: TEST_DB_URL,
      options: `-c search_path=${pg.schema}`,
    });
    await c.connect();
    try {
      await c.query(
        `CREATE TEMP TABLE "Subscriber" (id int, username text, "userId" int)`,
      );
      await c.query(
        `INSERT INTO pg_temp."Subscriber" VALUES (1, 'b_root', 10)`,
      ); // claims b_root is company A's
      await c.query(
        `CREATE TEMP TABLE nas (id int, "nasIp" inet, "isActive" boolean, "ownerId" int)`,
      );
      await c.query(
        `INSERT INTO pg_temp.nas VALUES (100, '192.0.2.10', true, 20)`,
      );
      await c.query(`SET search_path = pg_temp, ${pg.schema}`);
      const r = await c.query<{ d: string }>(
        `SELECT ${pg.schema}.jointbox_radius_tenancy('auth', 'b_root', '192.0.2.10') AS d`,
      );
      expect(r.rows[0].d).toBe('reject:cross-company');
    } finally {
      await c.end();
    }
  });
});
