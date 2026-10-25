#!/usr/bin/env node
/**
 * Unit tests for pg-url.js — the libpq URL sanitizer.
 *
 * These are PURE (no database needed) and are the regression guard that proves
 * the original `psql: invalid URI query parameter: "connection_limit"` failure
 * cannot recur: a Prisma URL with connection_limit/pool_timeout must come out
 * as a URL psql accepts, while real libpq params (sslmode, …) survive.
 *
 * Run: node scripts/lib/__tests__/pg-url.test.js
 */
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert');

const SCRIPT = path.join(__dirname, '..', 'pg-url.js');

function run(url, env = {}) {
  try {
    const out = execFileSync('node', [SCRIPT, url].filter(Boolean), {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    return { code: 0, out: out.trim() };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '').toString().trim() };
  }
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('pg-url.js:');

test('drops Prisma-only params (connection_limit, pool_timeout)', () => {
  const { code, out } = run(
    'postgresql://u:p@localhost:5432/db?connection_limit=20&pool_timeout=30',
  );
  assert.strictEqual(code, 0);
  assert.ok(!out.includes('connection_limit'), 'connection_limit must be gone');
  assert.ok(!out.includes('pool_timeout'), 'pool_timeout must be gone');
});

test('keeps libpq params (sslmode, connect_timeout) and drops schema', () => {
  const { out } = run(
    'postgresql://u:p@localhost:5432/db?sslmode=require&connection_limit=20&schema=public&connect_timeout=10',
  );
  assert.ok(out.includes('sslmode=require'), 'sslmode must survive');
  assert.ok(out.includes('connect_timeout=10'), 'connect_timeout must survive');
  assert.ok(!out.includes('connection_limit'), 'connection_limit must be gone');
  assert.ok(!out.includes('schema='), 'schema must be gone');
});

test('leaves a plain URL (no query) untouched', () => {
  const url = 'postgresql://u:p@localhost:5432/db';
  const { out } = run(url);
  assert.strictEqual(out, url);
});

test('preserves password/user/host/port/dbname', () => {
  const { out } = run('postgresql://alice:s3cr3t@db.example:6543/mydb?connection_limit=5');
  const u = new URL(out);
  assert.strictEqual(u.username, 'alice');
  assert.strictEqual(u.password, 's3cr3t');
  assert.strictEqual(u.hostname, 'db.example');
  assert.strictEqual(u.port, '6543');
  assert.strictEqual(u.pathname, '/mydb');
});

test('accepts postgres:// scheme too', () => {
  const { code, out } = run('postgres://u:p@localhost/db?pgbouncer=true');
  assert.strictEqual(code, 0);
  assert.ok(!out.includes('pgbouncer'));
});

test('nonzero exit on invalid URL', () => {
  const { code } = run('not a url');
  assert.notStrictEqual(code, 0);
});

test('nonzero exit when no URL available', () => {
  const r = run('', {
    DATABASE_URL: '',
    ADMIN_DATABASE_URL: '',
    RADIUS_DATABASE_URL: '',
  });
  assert.notStrictEqual(r.code, 0);
});

test('reads from DATABASE_URL env when no arg', () => {
  const { code, out } = run('', {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db?connection_limit=9',
    ADMIN_DATABASE_URL: '',
    RADIUS_DATABASE_URL: '',
  });
  assert.strictEqual(code, 0);
  assert.ok(!out.includes('connection_limit'));
});

test('ADMIN_DATABASE_URL takes precedence over DATABASE_URL', () => {
  const { out } = run('', {
    ADMIN_DATABASE_URL: 'postgresql://admin:x@adminhost:5432/db',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  });
  assert.ok(out.includes('adminhost'));
});

console.log(`\npg-url.js: ${passed} passed`);
