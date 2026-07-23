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

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Create the default admin on a fresh database (first Ubuntu install / new VM).
  await ensureDefaultAdmin(app);

  // ⚡ Phase 0: gzip all JSON responses (only bodies > 1kB)
  app.use(compression({ threshold: 1024 }));

  // ⚡ Phase 0: strong ETags → browsers/axios revalidate instead of re-downloading
  app.getHttpAdapter().getInstance().set('etag', 'strong');

  // Enable CORS for frontend access
  app.enableCors({
    origin: true, // Allow all origins for development
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

  const port = Number(process.env.PORT) || 3001;
  await app.listen(port, '0.0.0.0');
  console.log('✅ Backend running on:');
  console.log(`  - http://localhost:${port}`);
}
bootstrap();
