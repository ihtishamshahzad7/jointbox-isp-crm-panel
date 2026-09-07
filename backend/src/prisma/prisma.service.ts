import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { evaluateAgainstServer, evaluateConnectionPolicy } from './connection-policy';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      log: ['error', 'warn'],
    });
  }

  private stopped = false;

  /**
   * Refuse to start a clustered deployment that will exhaust `max_connections`.
   *
   * SCALING.md tells operators to put Postgres behind PgBouncer before raising
   * BACKEND_INSTANCES, because each PM2 worker opens its own Prisma pool.
   * Nothing enforced it, so the documented prerequisite was one an operator
   * could miss by not reading that paragraph — and the resulting "sorry, too
   * many clients already" reads as an application fault, appears only under
   * real load, and hits FreeRADIUS as well as the panel.
   *
   * Thrown from onModuleInit so bootstrap fails cleanly and PM2 surfaces it,
   * rather than N workers starting and degrading later.
   */
  private enforceConnectionPolicy() {
    const verdict = evaluateConnectionPolicy();
    if (verdict.error) throw new Error(`Unsafe database connection configuration. ${verdict.error}`);
    if (verdict.warning) console.warn(`⚠️ ${verdict.warning}`);
    if (verdict.instances > 1) {
      console.log(
        `  - DB pool: ${verdict.instances} process(es) × ${verdict.perWorker} = ~${verdict.projectedConnections} connections`,
      );
    }
  }

  /**
   * Ask the server what it will actually accept, and compare.
   *
   * The static check reasons only about this app's side of the arithmetic.
   * This catches the case where `max_connections` was lowered under a topology
   * that used to fit. Advisory only: refusing to boot over a number that can
   * change underneath us would be too blunt, and by this point the app is
   * already connected and working.
   */
  private async checkServerCapacity() {
    try {
      const rows = await this.$queryRaw<any[]>`
        SELECT current_setting('max_connections')::int AS max_connections,
               current_setting('superuser_reserved_connections')::int AS reserved`;
      const row = rows?.[0];
      if (!row?.max_connections) return;
      const { projectedConnections } = evaluateConnectionPolicy();
      const r = evaluateAgainstServer(projectedConnections, Number(row.max_connections), Number(row.reserved ?? 0));
      if (r.warning) console.warn(`⚠️ ${r.warning}`);
    } catch {
      // A diagnostic must never be the reason the app fails to start.
    }
  }

  async onModuleInit() {
    // Before connecting: a configuration error should be reported as one, not
    // as a mysterious connection failure later under load.
    this.enforceConnectionPolicy();

    // Try to connect, but DON'T crash the whole backend if the DB is down at
    // boot (e.g. the VM's Postgres is still starting or briefly unreachable).
    // We retry in the background; Prisma also connects lazily on first query.
    try {
      await this.$connect();
      console.log('✅ Database connected successfully');
      await this.checkServerCapacity();
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