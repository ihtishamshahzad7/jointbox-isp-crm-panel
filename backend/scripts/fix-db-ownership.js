#!/usr/bin/env node
/**
 * Normalise database object ownership so Prisma can manage the schema.
 *
 * WHY THIS EXISTS
 * Anything created while connected as the `postgres` superuser is owned by
 * `postgres`. Prisma connects as the application user, and PostgreSQL only
 * allows the OWNER (or a superuser) to ALTER a table — so `prisma db push`
 * fails with "permission denied for table ...".
 *
 * This reassigns every public table, sequence, view and function to the app
 * user. Safe to run repeatedly; it only touches objects owned by someone else.
 *
 * CREDENTIALS
 *   Uses ADMIN_DATABASE_URL if set (a superuser connection), otherwise falls
 *   back to DATABASE_URL. With the app user it can only fix objects the app
 *   already owns — which is a no-op, and it will say so clearly rather than
 *   failing silently.
 *
 * USAGE
 *   node scripts/fix-db-ownership.js
 *   npm run db:push        (runs this first, then prisma db push)
 */
const { Client } = require('pg');
require('dotenv').config();

const APP_URL = process.env.DATABASE_URL;
const ADMIN_URL = process.env.ADMIN_DATABASE_URL || APP_URL;

if (!APP_URL) {
  console.error('✖ DATABASE_URL is not set. Check your .env file.');
  process.exit(1);
}

/** Pull the role name out of a connection string. */
function userOf(url) {
  const m = /postgresql:\/\/([^:]+):/.exec(url || '');
  return m ? m[1] : null;
}

const appUser = userOf(APP_URL);
if (!appUser || !/^[A-Za-z0-9_]+$/.test(appUser)) {
  console.error('✖ Could not read a valid username from DATABASE_URL.');
  process.exit(1);
}

const SQL = `
DO $$
DECLARE r record; n int := 0;
BEGIN
  -- Tables
  FOR r IN SELECT tablename FROM pg_tables
           WHERE schemaname = 'public' AND tableowner <> '${appUser}'
  LOOP EXECUTE format('ALTER TABLE public.%I OWNER TO %I', r.tablename, '${appUser}'); n := n + 1; END LOOP;

  -- Sequences (created alongside SERIAL columns)
  FOR r IN SELECT sequencename FROM pg_sequences
           WHERE schemaname = 'public' AND sequenceowner <> '${appUser}'
  LOOP EXECUTE format('ALTER SEQUENCE public.%I OWNER TO %I', r.sequencename, '${appUser}'); n := n + 1; END LOOP;

  -- Views
  FOR r IN SELECT viewname FROM pg_views
           WHERE schemaname = 'public' AND viewowner <> '${appUser}'
  LOOP EXECUTE format('ALTER VIEW public.%I OWNER TO %I', r.viewname, '${appUser}'); n := n + 1; END LOOP;

  -- Functions (e.g. archive_radacct)
  FOR r IN SELECT p.oid::regprocedure AS sig
           FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
           WHERE ns.nspname = 'public' AND pg_get_userbyid(p.proowner) <> '${appUser}'
  LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO %I', r.sig, '${appUser}'); n := n + 1; END LOOP;

  RAISE NOTICE 'reassigned % object(s)', n;
END $$;
`;

const CHECK = `
  SELECT tablename AS name, 'table' AS kind FROM pg_tables
   WHERE schemaname='public' AND tableowner <> $1
  UNION ALL
  SELECT p.proname, 'function' FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname='public' AND pg_get_userbyid(p.proowner) <> $1
`;

(async () => {
  const usingAdmin = ADMIN_URL !== APP_URL;
  const client = new Client({ connectionString: ADMIN_URL });

  try {
    await client.connect();
  } catch (e) {
    console.error(`✖ Could not connect: ${e.message}`);
    process.exit(1);
  }

  try {
    // What is currently mis-owned?
    const before = await client.query(CHECK, [appUser]);
    if (before.rows.length === 0) {
      console.log(`✔ All public objects already owned by "${appUser}" — nothing to do.`);
      await client.end();
      return;
    }

    console.log(
      `Found ${before.rows.length} object(s) not owned by "${appUser}":`,
      before.rows.slice(0, 10).map((r) => `${r.kind} ${r.name}`).join(', ') +
        (before.rows.length > 10 ? ` …and ${before.rows.length - 10} more` : ''),
    );

    client.on('notice', (m) => m?.message && console.log(`  ${m.message}`));
    await client.query(SQL);

    const after = await client.query(CHECK, [appUser]);
    if (after.rows.length === 0) {
      console.log(`✔ Ownership normalised to "${appUser}". Prisma can now manage the schema.`);
    } else {
      console.warn(`▲ ${after.rows.length} object(s) still mis-owned.`);
      throw new Error('insufficient privileges');
    }
    await client.end();
  } catch (e) {
    await client.end().catch(() => {});
    const msg = String(e.message || e);

    if (/permission denied|must be owner|insufficient privileges/i.test(msg)) {
      console.error(`
✖ Cannot reassign ownership with the current credentials.

PostgreSQL only allows the object's OWNER or a SUPERUSER to change ownership,
so the application user cannot fix objects owned by "postgres".

Fix it once, either way:

  A) Give this script superuser credentials — add to backend/.env:
       ADMIN_DATABASE_URL="postgresql://postgres:<password>@<host>:5432/jointbox"
     then re-run:  npm run db:fix-ownership

  B) Or run this once on the database server:
       sudo -u postgres psql -d jointbox -c 'REASSIGN OWNED BY postgres TO ${appUser};'

After that it will not recur: the app creates its own objects as "${appUser}",
and DatabaseSetupService re-checks ownership on every startup.
`);
      process.exit(1);
    }

    console.error(`✖ ${msg}`);
    process.exit(1);
  }
})();
