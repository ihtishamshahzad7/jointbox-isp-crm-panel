import { Controller, ForbiddenException, Ip, Post } from '@nestjs/common';
import { DemoService } from './demo.service';

/**
 * Public demo-account creation. No auth required — anyone can spin up a
 * sandbox franchise account to try the panel; it self-destructs in 7 days.
 *
 * SECURITY: because it is unauthenticated it MUST be rate-limited, or a script
 * could create unlimited users/wallets and fill the database. Two limits apply:
 * a per-IP cooldown, and a global cap on live demo accounts.
 */
@Controller('demo')
export class DemoController {
  private static readonly PER_IP_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
  private static readonly MAX_LIVE_DEMOS = 50;
  private static readonly lastByIp = new Map<string, number>();

  constructor(private readonly demo: DemoService) {}

  @Post('create')
  async create(@Ip() ip: string) {
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
