import { installLogCapture } from './console/log-buffer';
// Tap stdout/stderr before anything logs, so the Server Console can show the
// backend's own output on any OS (there is no pm2/journald on Windows).
installLogCapture();

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import * as bcrypt from 'bcrypt';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';

// First-boot bootstrap: create the default super-admin if the DB has no users.
// Runs on every startup but is idempotent — only fires on a brand-new database
// (e.g. right after `prisma migrate deploy` on a fresh Ubuntu install).
async function ensureDefaultAdmin(app: NestExpressApplication) {
  try {
    const prisma = app.get(PrismaService);
    const userCount = await prisma.user.count();
    if (userCount > 0) return;

    const email = process.env.ADMIN_EMAIL || 'admin@jointbox.com';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    await prisma.user.create({
      data: {
        name: 'Super Admin',
        email,
        password: await bcrypt.hash(password, 10),
        role: 'SUPER_ADMIN',
        isActive: true,
      },
    });
    console.log('👤 First-boot: default admin created');
    console.log(`   → login: ${email} / ${password}  (change the password after first login)`);
  } catch (e: any) {
    console.error('⚠️ Default-admin bootstrap failed:', e?.message || e);
  }
}

function validateEnv() {
  const required: [string, string][] = [
    ['JWT_SECRET', 'JWT_SECRET'],
    ['ADMIN_PASSWORD', 'ADMIN_PASSWORD'],
  ];
  for (const [key, desc] of required) {
    if (!process.env[key] || process.env[key] === 'your-super-secret-key-change-this-in-production') {
      console.error(`❌ CRITICAL: ${desc} environment variable is not set or is using the default value.`);
      console.error(`   Set ${key}=<your-value> in .env or environment.`);
      process.exit(1);
    }
  }
}

async function bootstrap() {
  validateEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Create the default admin on a fresh database (first Ubuntu install / new VM).
  await ensureDefaultAdmin(app);

  // Keep the published demo login working (created once, password kept in step
  // with DEMO_PASSWORD). Never fatal: a demo problem must not stop the panel.
  try {
    const { DemoService } = require('./demo/demo.service');
    await app.get(DemoService, { strict: false })?.ensureShared?.();
  } catch (e: any) {
    console.warn(`⚠ Shared demo account not ready: ${e?.message || e}`);
  }

  /**
   * Behind a TLS terminator, EVERY request arrives from 127.0.0.1 unless we
   * say otherwise. That silently breaks three things that matter here:
   *   • the login brute-force lockout, which keys on the client IP,
   *   • the rate limiter below, which would throttle all users as one,
   *   • the audit log, which would record the proxy for every action.
   * Trusting one hop restores the real client IP from X-Forwarded-For.
   */
  app.set('trust proxy', 1);

  /**
   * Global rate limit — a blunt instrument on purpose.
   *
   * Login already has a per-account lockout, but nothing stopped a script
   * hammering the rest of the API. On a public IP that is a matter of when,
   * not if. In-memory and dependency-free: it protects a single box, which is
   * exactly the deployment this is.
   */
  const RL_WINDOW = 60_000;
  const RL_MAX = Number(process.env.RATE_LIMIT_PER_MIN || 600);
  const RL_MAX_AUTH = Number(process.env.RATE_LIMIT_AUTH_PER_MIN || 20);
  const hits = new Map<string, { n: number; until: number }>();
  setInterval(() => {                       // keep the map from growing forever
    const now = Date.now();
    for (const [k, v] of hits) if (v.until < now) hits.delete(k);
  }, RL_WINDOW).unref();

  app.use((req: any, res: any, next: any) => {
    const path = String(req.originalUrl || req.url || '');
    // Health checks must never be throttled — that would make a monitor look
    // like an outage.
    if (path.startsWith('/health')) return next();
    const sensitive = /^\/(auth|demo)\b/.test(path);
    const key = `${sensitive ? 'a' : 'g'}:${req.ip}`;
    const limit = sensitive ? RL_MAX_AUTH : RL_MAX;
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || rec.until < now) {
      hits.set(key, { n: 1, until: now + RL_WINDOW });
      return next();
    }
    if (++rec.n > limit) {
      res.setHeader('Retry-After', Math.ceil((rec.until - now) / 1000));
      return res.status(429).json({ statusCode: 429, message: 'Too many requests. Please slow down.' });
    }
    next();
  });

  // Security headers (no extra dependency). Hardens the API against clickjacking,
  // MIME-sniffing, referrer leakage and forces HTTPS where a proxy sets it.
  app.use((_req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    // Send HSTS whenever the request actually arrived over TLS, not only when
    // an operator remembered to set FORCE_HTTPS. Sending it on a plain-HTTP
    // LAN install would be actively harmful — the browser would then refuse to
    // load that host over HTTP at all — so the proxy header decides.
    const secure = process.env.FORCE_HTTPS === '1' || _req.headers?.['x-forwarded-proto'] === 'https';
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // ⚡ Phase 0: gzip all JSON responses (only bodies > 1kB)
  app.use(compression({ threshold: 1024 }));

  // ⚡ Phase 0: strong ETags → browsers/axios revalidate instead of re-downloading
  app.getHttpAdapter().getInstance().set('etag', 'strong');

  /**
   * CORS — permissive on a LAN, closed on the public internet.
   *
   * The old default was `*`, which with `credentials: true` tells the browser
   * that ANY website may make authenticated calls to this API. That is an
   * acceptable shortcut on a private network and not something to publish on a
   * public IP. The allow-list below keeps every existing install working (the
   * panel is served from the same machine on a different port, which is
   * cross-origin as far as the browser is concerned) while refusing origins
   * that have nothing to do with this server.
   */
  const explicitOrigins = (process.env.CORS_ORIGIN || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const publicHosts = (process.env.PUBLIC_HOST || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const isPrivateHost = (h: string) =>
    h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
    /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);

  app.enableCors({
    origin: (origin, cb) => {
      // No Origin header at all: curl, server-to-server, or a same-origin
      // request. Never a cross-site attack, so always allowed.
      if (!origin) return cb(null, true);
      if (explicitOrigins.includes('*')) return cb(null, true);
      if (explicitOrigins.includes(origin)) return cb(null, true);
      try {
        const host = new URL(origin).hostname;
        if (isPrivateHost(host) || publicHosts.includes(host)) return cb(null, true);
      } catch { /* malformed Origin — fall through and refuse */ }
      // Refuse by omitting the CORS headers rather than throwing: a 500 here
      // would turn a blocked page into a confusing server error in the logs.
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  });

  // Serve uploaded images (profile pictures / CNIC) statically at /uploads/*
  const uploadDir = join(process.cwd(), 'uploads');
  if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });
  app.useStaticAssets(uploadDir, { prefix: '/uploads/' });

  // Graceful shutdown (queues, redis, prisma)
  app.enableShutdownHooks();

  // Microservice split: a worker-role process runs background services only
  // (crons, pollers, queue workers via isPrimaryInstance) and binds NO HTTP
  // port, so it never competes with the web nodes for the request path.
  const { isWorkerOnly } = require('./common/cluster-util');
  if (isWorkerOnly()) {
    await app.init();
    console.log('✅ Backend running as WORKER (background services only, no HTTP).');
    return;
  }

  const port = Number(process.env.PORT) || 3001;
  await app.listen(port, '0.0.0.0');
  console.log('✅ Backend running on:');
  console.log(`  - http://localhost:${port}`);
  // Build marker — bump this whenever the activation/money path changes, so a
  // quick `pm2 logs jointbox-backend | grep BUILD` after deploy PROVES the new
  // code is live (and not the old dist a failed migrate/build left running).
  console.log('🏷  BUILD MARKER: activation-money-fix-2026-08-16 (charge-in-tx, prepaid-enforced)');

  // Bull-Board queue dashboard (the Laravel Horizon equivalent). Only mounts
  // when Redis is on AND the optional packages are installed — otherwise skips
  // silently. Protected by HTTP basic auth (admin creds by default). Mounted
  // AFTER listen() so every processor is registered and shows up.
  try {
    const { QueueService } = require('./common/queue.service');
    const queueSvc = app.get(QueueService, { strict: false });
    if (queueSvc?.isBull?.()) {
      const { createBullBoard } = require('@bull-board/api');
      const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
      const { ExpressAdapter } = require('@bull-board/express');
      const queues = queueSvc.getBullQueues();
      const serverAdapter = new ExpressAdapter();
      serverAdapter.setBasePath('/admin/queues');
      createBullBoard({ queues: queues.map((q: any) => new BullMQAdapter(q)), serverAdapter });
      const U = process.env.QUEUE_DASHBOARD_USER || process.env.ADMIN_EMAIL || 'admin';
      const P = process.env.QUEUE_DASHBOARD_PASS || process.env.ADMIN_PASSWORD || '';
      // Basic-auth over the public internet with a guessable password is not a
      // door worth leaving open. No explicit password → no dashboard.
      if (!P || P === 'admin123') {
        console.log('  - Queue dashboard DISABLED (set QUEUE_DASHBOARD_PASS to enable it).');
        throw new Error('queue dashboard not configured');
      }
      app.use('/admin/queues', (req: any, res: any, next: any) => {
        const [, b64] = String(req.headers['authorization'] || '').split(' ');
        const [u, p] = Buffer.from(b64 || '', 'base64').toString().split(':');
        if (u === U && p === P) return next();
        res.set('WWW-Authenticate', 'Basic realm="Jointbox Queues"').status(401).send('Auth required');
      }, serverAdapter.getRouter());
      console.log(`  - Queue dashboard: http://localhost:${port}/admin/queues`);
    }
  } catch { /* @bull-board not installed — dashboard disabled */ }
}
bootstrap();

