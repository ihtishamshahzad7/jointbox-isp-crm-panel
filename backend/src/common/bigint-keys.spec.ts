import * as fs from 'fs';
import * as path from 'path';
import { installBigIntJson } from './bigint-json';

/**
 * 64-BIT KEYS ON THE APPEND-ONLY TABLES.
 *
 * THE CEILING BEING REMOVED
 * `Int` in Prisma is `integer` in PostgreSQL: max 2,147,483,647. The tables
 * covered here are append-only and grow with subscriber count and elapsed
 * time, so that number is a date, not a limit. `radacct` takes one row per
 * accounting session; at 10M subscribers reconnecting a few times a day it is
 * weeks away, and when it arrives FreeRADIUS simply stops recording
 * accounting.
 *
 * WHAT THESE TESTS ACTUALLY GUARD
 * The SQL migration was verified against a real PostgreSQL 16 — both schema
 * layouts, idempotency, data preservation, and inserts past 2^31 — because
 * none of that can be checked with a mock. What a mock CAN check, and what
 * breaks silently if someone gets it wrong later, is the JavaScript half:
 *
 *   · a BigInt reaching JSON.stringify throws rather than serialising;
 *   · `a - b` is not a valid comparator for BigInt;
 *   · Number() on a large id returns a different id.
 *
 * Each of those was a real defect in this codebase, found by looking, and
 * each fails in a way that does not resemble its cause.
 */
describe('BigInt primary keys', () => {
  // ───────────────────────────────────────────────────────────────
  // Serialisation
  // ───────────────────────────────────────────────────────────────
  describe('JSON serialisation', () => {
    beforeAll(() => installBigIntJson());

    it('THE FIX: a BigInt no longer breaks JSON.stringify', () => {
      /**
       * Without the shim this throws `TypeError: Do not know how to serialize
       * a BigInt`, so EVERY endpoint returning one of these rows answers 500 —
       * the logs page, syslog viewer, network events, ONU telemetry. The
       * database migration and this shim are one change; either alone breaks
       * the product.
       */
      expect(() => JSON.stringify({ id: 10n })).not.toThrow();
    });

    it('serialises as a string, exactly, at any magnitude', () => {
      // A number would be byte-identical today and lose precision above 2^53
      // later — the same class of bug being fixed, moved somewhere harder to
      // see. 2^53 + 1 is the smallest integer a double cannot represent.
      expect(JSON.stringify({ id: 9007199254740993n })).toBe('{"id":"9007199254740993"}');
    });

    it('round-trips a value a number would have corrupted', () => {
      const id = 9007199254740993n;
      expect(JSON.parse(JSON.stringify({ id })).id).toBe('9007199254740993');
      // What the tempting alternative would have produced instead:
      expect(Number(id)).toBe(9007199254740992);
    });

    it('works nested, in arrays, and through Prisma-shaped rows', () => {
      const rows = [{ id: 1n, nested: { radacctid: 2n } }, { id: 3n, nested: { radacctid: 4n } }];
      expect(JSON.stringify(rows)).toBe(
        '[{"id":"1","nested":{"radacctid":"2"}},{"id":"3","nested":{"radacctid":"4"}}]',
      );
    });

    it('is non-enumerable, so it cannot leak into for...in', () => {
      // A plain assignment to a built-in prototype is enumerable and shows up
      // in `for...in` over any object — the classic way a prototype patch
      // breaks unrelated library code.
      const d = Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON');
      expect(d?.enumerable).toBe(false);
    });

    it('is idempotent', () => {
      const first = Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON')?.value;
      installBigIntJson();
      installBigIntJson();
      expect(Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON')?.value).toBe(first);
    });

    it('bootstrap installs it before anything can serialise', () => {
      // The logger taps stdout on the very first line of main.ts and
      // stringifies as it goes, so the import has to precede it.
      const main = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
      expect(main).toMatch(/import '\.\/common\/bigint-json'/);
      expect(main.indexOf("bigint-json")).toBeLessThan(main.indexOf('NestFactory'));
    });
  });

  // ───────────────────────────────────────────────────────────────
  // The arithmetic that stops working
  // ───────────────────────────────────────────────────────────────
  describe('BigInt arithmetic hazards these keys introduce', () => {
    it('subtraction is NOT a valid sort comparator for BigInt', () => {
      // `(a, b) => a.id - b.id` is the reflex, and it returns a BigInt rather
      // than the number Array.sort's contract calls for. This is what
      // network-logs.service.ts used on radacctid.
      expect(typeof (5n - 3n)).toBe('bigint');
      expect(typeof (5 - 3)).toBe('number');
    });

    it('the comparator actually used sorts correctly past 2^53', () => {
      const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
      const ids = [9007199254740993n, 2n, 9007199254740992n, 1n];
      expect([...ids].sort(cmp)).toEqual([1n, 2n, 9007199254740992n, 9007199254740993n]);
    });

    it('Number() on a large id silently selects a DIFFERENT row', () => {
      /**
       * The reason `String()` replaced `Number()` in the bulk session-close.
       * That statement is an UPDATE keyed on radacctid: a rounded id closes
       * some other subscriber's session, with no error anywhere.
       */
      const a = 9007199254740993n;
      const b = 9007199254740992n;
      expect(a).not.toEqual(b);
      expect(Number(a)).toBe(Number(b)); // collapsed onto each other
      expect(String(a)).not.toBe(String(b)); // exact
    });
  });

  // ───────────────────────────────────────────────────────────────
  // The schema itself
  // ───────────────────────────────────────────────────────────────
  describe('schema.prisma', () => {
    const schema = fs.readFileSync(
      path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
      'utf8',
    );
    const modelBody = (name: string) =>
      new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1] ?? '';

    const CONVERTED = [
      ['RadAcct', 'radacctid'],
      ['NasTrafficSample', 'id'],
      ['LoginLog', 'id'],
      ['ActivityLog', 'id'],
      ['SessionLog', 'id'],
      ['NetworkLog', 'id'],
      ['OnuTelemetry', 'id'],
      ['OnuSignalSample', 'id'],
      ['InterfaceStatusHistory', 'id'],
      ['InterfaceTrafficHistory', 'id'],
      ['SyslogEvent', 'id'],
      ['NetworkEvent', 'id'],
    ] as const;

    it.each(CONVERTED)('%s.%s is BigInt', (model, col) => {
      const line = modelBody(model)
        .split('\n')
        .find((l) => l.trim().startsWith(col + ' ') && l.includes('@id'));
      expect(line).toBeDefined();
      expect(line).toMatch(/\bBigInt\b/);
    });

    it('leaves the money tables alone, deliberately', () => {
      /**
       * Invoice, Payment and Alert have INBOUND foreign keys — InvoiceItem,
       * PaymentTransaction, InvoiceReversal, Notification — so converting them
       * means converting every referencing column in the same transaction, a
       * far larger blast radius across the financial tables. They also do not
       * need it: one invoice per subscriber per month is ~120M rows/year at
       * 10M subscribers, roughly seventeen years of headroom. The twelve
       * tables above have no inbound foreign keys at all, which is exactly
       * what made this migration safe to do in one step.
       */
      for (const m of ['Invoice', 'Payment', 'Alert']) {
        const line = modelBody(m)
          .split('\n')
          .find((l) => l.includes('@id'));
        expect(line).toMatch(/\bInt\b/);
        expect(line).not.toMatch(/\bBigInt\b/);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────
  // The migration
  // ───────────────────────────────────────────────────────────────
  describe('migration SQL', () => {
    const sql = fs.readFileSync(
      path.join(
        __dirname, '..', '..', 'prisma', 'migrations',
        '20260906120000_bigint_growth_table_keys', 'migration.sql',
      ),
      'utf8',
    );

    it('alters the SEQUENCE, not only the column', () => {
      /**
       * The single most important line. `serial` creates a sequence typed
       * `integer`; altering the column leaves it at MAXVALUE 2147483647, so
       * the table still dies at exactly the same row. Verified against
       * PostgreSQL 16: without this, `nextval: reached maximum value of
       * sequence`. A migration missing this looks completely successful and
       * fixes nothing.
       */
      expect(sql).toMatch(/ALTER SEQUENCE %s AS bigint/);
    });

    it('drops and recreates dependent views', () => {
      // radius-schema-apply.sh leaves public.radacct as a view over
      // radius.radacct, and PostgreSQL refuses to alter a column a view
      // depends on. Every install that ran the RADIUS separation is in that
      // state, so without this the migration fails everywhere except a fresh
      // database.
      expect(sql).toMatch(/pg_get_viewdef/);
      expect(sql).toMatch(/DROP VIEW/);
      expect(sql).toMatch(/CREATE VIEW %s AS %s/);
    });

    it('resolves the schema at run time rather than assuming one', () => {
      // radacct is in `radius` after separation and `public` before it.
      expect(sql).toMatch(/nspname IN \('public', 'radius'\)/);
    });

    it('is idempotent', () => {
      expect(sql).toMatch(/data_type = 'bigint'/);
      expect(sql).toMatch(/IF FOUND THEN\s*\n\s*CONTINUE;/);
    });

    it('re-grants on the recreated view', () => {
      // Recreating a view drops its grants, and the RADIUS role reads
      // public.radacct through exactly such a view — so omitting this causes
      // a FreeRADIUS outage as a side effect of the fix.
      expect(sql).toMatch(/GRANT SELECT ON public\.radacct/);
    });
  });
});
