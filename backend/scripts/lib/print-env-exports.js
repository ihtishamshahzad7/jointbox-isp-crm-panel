#!/usr/bin/env node
/**
 * print-env-exports.js — emit shell-safe `export KEY='VALUE'` lines for a .env
 * file, using dotenv's own parser so quoting, multiline values and comments are
 * interpreted exactly as the Node application sees them.
 *
 * WHY THIS EXISTS
 *   db-deploy.sh runs child processes that are NOT Node (psql) and Node
 *   heredocs that do not call `require('dotenv')`. Sourcing .env directly from
 *   bash (`. ./.env`) mis-parses quoted URLs, `#` inside values, and spaces.
 *   This script lets bash load the same values reliably via:
 *       eval "$(node scripts/lib/print-env-exports.js .env)"
 *
 * SAFETY
 *   - Only well-formed shell identifiers are exported.
 *   - Values are single-quoted with embedded single quotes escaped, so no value
 *     can inject shell commands when eval'd.
 *   - Output goes to stdout only (consumed by eval). It is NEVER written to a
 *     log by this script; callers must not tee it to disk.
 *   - Missing file or missing dotenv dependency exits 0 silently (callers may
 *     already have the variables in the environment).
 */
'use strict';

const fs = require('fs');

const envPath = process.argv[2] || '.env';

let dotenv;
try {
  dotenv = require('dotenv');
} catch {
  // dotenv not installed yet (e.g. before `npm ci`): nothing to emit.
  process.exit(0);
}

if (!fs.existsSync(envPath)) process.exit(0);

let parsed;
try {
  parsed = dotenv.parse(fs.readFileSync(envPath));
} catch {
  process.exit(0);
}

const shQuote = (s) => `'` + String(s).replace(/'/g, `'\\''`) + `'`;

for (const [key, value] of Object.entries(parsed)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // skip non-identifiers
  process.stdout.write(`export ${key}=${shQuote(value)}\n`);
}
