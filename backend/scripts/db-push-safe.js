#!/usr/bin/env node
/**
 * db-push-safe.js — DEV-ONLY schema sync.
 *
 * Safety rules (verification-phase Priority 1):
 *  - NEVER passes the Prisma data-loss acceptance flag: if the schema drift
 *    requires dropping anything, `prisma db push` fails instead of destroying
 *    data. A failed sync MUST fail loudly — it is never papered over.
 *  - Refuses to run when NODE_ENV=production. Production schema changes go
 *    through `npm run db:deploy` (scripts/db-deploy.sh → `migrate deploy`),
 *    which never uses the push tool.
 *  - Blocks when the FreeRADIUS `radius` schema is present, protecting it from
 *    accidental Prisma resets.
 */
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('prisma db push is a DEV-ONLY tool and refuses to run with NODE_ENV=production. Use npm run db:deploy (prisma migrate deploy) for production.');
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'radius') AS exists");
    if (rows[0].exists) throw new Error('RADIUS schema is present. Use npm run db:deploy; Prisma db push is blocked to protect the radius schema.');
  } finally { await client.end(); }
  execFileSync('npx', ['prisma', 'db', 'push'], { stdio: 'inherit', shell: process.platform === 'win32' });
  execFileSync('npx', ['prisma', 'generate'], { stdio: 'inherit', shell: process.platform === 'win32' });
}
main().catch((err) => { console.error(`\n✗ ${err.message}`); process.exit(1); });
