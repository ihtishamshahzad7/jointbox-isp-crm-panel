#!/usr/bin/env node
/**
 * pg-url.js — print a libpq/psql-safe connection URL derived from a Prisma
 * DATABASE_URL.
 *
 * WHY THIS EXISTS
 *   Prisma connection strings carry pool/engine parameters that libpq does not
 *   understand, e.g. `?connection_limit=20&pool_timeout=30`. Passing such a URL
 *   straight to `psql` fails with:
 *       psql: error: invalid URI query parameter: "connection_limit"
 *
 *   We do NOT blindly delete the query string, because some parameters there
 *   ARE meaningful to libpq (sslmode, sslrootcert, connect_timeout, …). Instead
 *   we parse the URL, keep only query keys libpq accepts, and drop the rest.
 *
 * INPUT  (first match wins): argv[2], $PGURL_SOURCE var name, ADMIN_DATABASE_URL,
 *         RADIUS_DATABASE_URL, DATABASE_URL.
 * OUTPUT single sanitized URL on stdout. Exits non-zero with a message on
 *        stderr if no usable URL is present or it cannot be parsed.
 *
 * The URL (which contains a password) is printed to stdout only, for capture by
 * `psql "$(...)"`. It is never logged by this script.
 */
'use strict';

// Query keywords libpq/psql understands in a connection URI.
// Source: PostgreSQL "Parameter Key Words" (libpq). Anything not here is
// treated as an application/ORM-only parameter and dropped.
const LIBPQ_KEYS = new Set([
  'host', 'hostaddr', 'port', 'dbname', 'user', 'password', 'passfile',
  'channel_binding', 'connect_timeout', 'client_encoding', 'options',
  'application_name', 'fallback_application_name', 'keepalives',
  'keepalives_idle', 'keepalives_interval', 'keepalives_count',
  'tcp_user_timeout', 'replication', 'gssencmode', 'sslmode', 'requiressl',
  'sslnegotiation', 'sslcompression', 'sslcert', 'sslkey', 'sslpassword',
  'sslcertmode', 'sslrootcert', 'sslcrl', 'sslcrldir', 'sslsni', 'requirepeer',
  'ssl_min_protocol_version', 'ssl_max_protocol_version', 'krbsrvname',
  'gsslib', 'gssdelegation', 'service', 'target_session_attrs', 'load_balance_hosts',
]);

function pickUrl() {
  if (process.argv[2]) return process.argv[2];
  if (process.env.PGURL_SOURCE && process.env[process.env.PGURL_SOURCE]) {
    return process.env[process.env.PGURL_SOURCE];
  }
  return (
    process.env.ADMIN_DATABASE_URL ||
    process.env.RADIUS_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ''
  );
}

const raw = pickUrl();
if (!raw) {
  process.stderr.write('pg-url: no database URL available (set DATABASE_URL)\n');
  process.exit(2);
}

let u;
try {
  u = new URL(raw);
} catch {
  process.stderr.write('pg-url: DATABASE_URL is not a valid URL\n');
  process.exit(1);
}

if (!/^postgres(ql)?:$/.test(u.protocol)) {
  process.stderr.write(`pg-url: unsupported scheme "${u.protocol}"\n`);
  process.exit(1);
}

// Drop any query parameter libpq does not accept (lower-cased comparison).
for (const key of [...u.searchParams.keys()]) {
  if (!LIBPQ_KEYS.has(key.toLowerCase())) u.searchParams.delete(key);
}

process.stdout.write(u.toString());
