-- ─────────────────────────────────────────────────────────────────────────────
-- Jointbox ⇄ FreeRADIUS accounting verification
-- Run:  sudo -u postgres psql -d jointbox -f verify-radius.sql
-- Every check below must pass for full PPPoE traceability to work.
-- ─────────────────────────────────────────────────────────────────────────────

\echo '=== 1. radacct columns required by FreeRADIUS accounting queries ==='
-- All six must appear. Missing ones = accounting INSERT fails = no session logs.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'radacct'
  AND column_name IN ('acctupdatetime','acctinterval','framedipv6address',
                      'framedipv6prefix','framedinterfaceid','delegatedipv6prefix')
ORDER BY column_name;

\echo '=== 2. nasreload table exists (simul_count / simul_verify) ==='
SELECT to_regclass('public.nasreload') AS nasreload_table;

\echo '=== 3. ON CONFLICT target — unique index on acctuniqueid ==='
SELECT indexname FROM pg_indexes
WHERE tablename = 'radacct' AND indexdef ILIKE '%acctuniqueid%';

\echo '=== 4. NAS records — nasname (FreeRADIUS client) must equal the router IP ==='
SELECT id, nasname, "nasIp", shortname, secret FROM nas;

\echo '=== 5. Grants — FreeRADIUS connects as the jointbox user ==='
SELECT table_name,
       has_table_privilege('jointbox', 'public.'||table_name, 'INSERT') AS ins,
       has_table_privilege('jointbox', 'public.'||table_name, 'UPDATE') AS upd,
       has_table_privilege('jointbox', 'public.'||table_name, 'SELECT') AS sel
FROM (VALUES ('radacct'),('radpostauth'),('radcheck'),('radreply'),
             ('radusergroup'),('radgroupcheck'),('radgroupreply'),('nas')) AS t(table_name);

\echo '=== 6. Recent accounting rows (sessions) ==='
SELECT username, nasipaddress, acctstarttime, acctstoptime,
       acctterminatecause, acctsessiontime, framedipaddress, callingstationid
FROM radacct ORDER BY radacctid DESC LIMIT 10;

\echo '=== 7. Recent auth attempts ==='
SELECT username, reply, authdate FROM radpostauth ORDER BY id DESC LIMIT 10;

\echo '=== 8. Users available to authenticate (radcheck) ==='
SELECT username, attribute, op FROM radcheck ORDER BY id DESC LIMIT 10;
