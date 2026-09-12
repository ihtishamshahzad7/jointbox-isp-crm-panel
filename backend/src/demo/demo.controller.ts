import { Controller, ForbiddenException, Get, Ip, Post } from '@nestjs/common';
import { DemoService } from './demo.service';

/**
 * Public demo access.
 *
 * ── Why this no longer mints accounts by default ─────────────────────────
 * `POST /demo/create` used to create a fresh sandbox franchise per visitor.
 * That was proportionate when a demo account was an empty shell. It stopped
 * being proportionate the moment seeding was added: each account now writes
 * 10,000 subscribers, 500 NAS, 50 pools, 20 areas, a package catalogue and a
 * 20-node reseller tree. The cap of 50 live demos therefore bounded ACCOUNTS
 * while leaving ROWS unbounded — 50 × 10,000 is half a million synthetic
 * subscribers in the same tables that hold the operator's real customers, all
 * reachable from an unauthenticated POST.
 *
 * The per-IP cooldown did not close it either. It lived in a static Map in
 * process memory, and the panel runs twelve PM2 cluster workers, so each worker
 * enforced its own private cooldown — roughly twelve creations per hour per IP,
 * reset to zero by any restart. The `liveCount()` check had the same problem:
 * read-then-write across twelve processes lets concurrent requests sail past 50
 * together.
 *
 * A shared sandbox gives a visitor everything a private one did — the same
 * seeded environment, the same franchise powers — while keeping the cost fixed
 * at one dataset no matter how many people click "Try the demo". So that is now
 * the default, and the endpoint hands back the shared credentials instead of
 * writing anything.
 *
 * Self-serve can be re-enabled with DEMO_SELF_SERVE=1 for an operator who
 * genuinely wants per-visitor accounts and has the database headroom for them.
 * The limits below then apply, with their cluster caveat unchanged — which is
 * why it is not the default.
 */
@Controller('demo')
export class DemoController {
  private static readonly PER_IP_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
  private static readonly MAX_LIVE_DEMOS = 50;
  private static readonly lastByIp = new Map<string, number>();

  static selfServeEnabled(): boolean {
    return process.env.DEMO_SELF_SERVE === '1';
  }

  constructor(private readonly demo: DemoService) {}

  /**
   * The shared demo credentials, for the login screen to display.
   *
   * Deliberately public: these are meant to be printed on a website. The
   * account they unlock is a sandbox that can only ever see its own data, so
   * publishing them gives away nothing a visitor could not get by clicking
   * "Try the demo" anyway.
   */
  @Get('public')
  publicDemo() {
    return this.demo.publicCredentials();
  }

  @Post('create')
  async create(@Ip() ip: string) {
    if (!DemoController.selfServeEnabled()) {
      // Answer with the shared sandbox rather than an error: the login screen's
      // "Try a NEW demo account" button must still do something useful, and
      // from the visitor's side this IS a working demo — same data, same
      // franchise powers. Nothing is written to the database.
      return {
        ...this.demo.publicCredentials(),
        shared: true,
        note:
          'Shared sandbox. You are signed in to a demo franchise with synthetic ' +
          'Pakistan ISP data — real customer data is never exposed. It resets weekly.',
      };
    }

    const key = ip || 'unknown';
    const now = Date.now();

    // Prune old entries so the map can't grow without bound.
    for (const [k, t] of DemoController.lastByIp) {
      if (now - t > DemoController.PER_IP_COOLDOWN_MS) DemoController.lastByIp.delete(k);
    }

    const last = DemoController.lastByIp.get(key);
    if (last && now - last < DemoController.PER_IP_COOLDOWN_MS) {
      const mins = Math.ceil((DemoController.PER_IP_COOLDOWN_MS - (now - last)) / 60000);
      throw new ForbiddenException(`A demo account was already created from this address. Try again in ${mins} minute(s).`);
    }

    if ((await this.demo.liveCount()) >= DemoController.MAX_LIVE_DEMOS) {
      throw new ForbiddenException('Demo capacity is full right now. Please try again later.');
    }

    DemoController.lastByIp.set(key, now);
    return this.demo.create();
  }
}
