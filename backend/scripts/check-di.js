/**
 * Startup wiring check: resolves the full NestJS dependency graph of the built
 * backend WITHOUT starting it or touching the database (Nest "preview" mode).
 * A module that forgets an import (e.g. PrismaModule) fails here, during the
 * update, instead of crash-looping every backend process after the reload.
 * Usage: node scripts/check-di.js   (from backend/, after `npm run build`)
 */
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch {}
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require(path.join(__dirname, '..', 'dist', 'app.module'));

NestFactory.createApplicationContext(AppModule, { preview: true, abortOnError: false, logger: ['error'] })
  .then(async (ctx) => { await ctx.close().catch(() => {}); console.log('✓ backend wiring check passed'); process.exit(0); })
  .catch((e) => { console.error('✗ backend wiring check FAILED — not reloading the running panel.'); console.error(e && e.message ? e.message : e); process.exit(1); });
