#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'radius') AS exists");
    if (rows[0].exists) throw new Error('RADIUS schema is present. Use npm run db:deploy; Prisma db push is blocked to protect the radius schema.');
  } finally { await client.end(); }
  execFileSync('npx', ['prisma', 'db', 'push', '--accept-data-loss'], { stdio: 'inherit', shell: process.platform === 'win32' });
  execFileSync('npx', ['prisma', 'generate'], { stdio: 'inherit', shell: process.platform === 'win32' });
}
main().catch((err) => { console.error(`\n✗ ${err.message}`); process.exit(1); });
