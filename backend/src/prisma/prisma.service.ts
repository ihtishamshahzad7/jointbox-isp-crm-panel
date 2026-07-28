import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      log: ['error', 'warn'],
    });
  }

  private stopped = false;

  async onModuleInit() {
    // Try to connect, but DON'T crash the whole backend if the DB is down at
    // boot (e.g. the VM's Postgres is still starting or briefly unreachable).
    // We retry in the background; Prisma also connects lazily on first query.
    try {
      await this.$connect();
      console.log('✅ Database connected successfully');
    } catch (err: any) {
      console.error(
        `⚠️ Database not reachable at startup: ${err?.message || err}. ` +
          `Backend will keep running and retry in the background.`,
      );
      this.retryConnect();
    }
  }

  private retryConnect(attempt = 1) {
    if (this.stopped) return;
    setTimeout(async () => {
      if (this.stopped) return;
      try {
        await this.$connect();
        console.log(`✅ Database connected successfully (retry #${attempt})`);
      } catch (err: any) {
        console.error(
          `⚠️ DB reconnect attempt #${attempt} failed: ${err?.message || err}`,
        );
        this.retryConnect(attempt + 1);
      }
    }, 10_000).unref?.();
  }

  async onModuleDestroy() {
    this.stopped = true;
    await this.$disconnect();
    console.log('🔴 Database disconnected');
  }
}