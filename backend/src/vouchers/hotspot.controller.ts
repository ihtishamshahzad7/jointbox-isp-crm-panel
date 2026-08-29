import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import { RateLimitGuard } from '../common/rate-limit.guard';

/**
 * The captive-portal login API. NO AUTHENTICATION, by definition.
 *
 * A hotspot customer walked into a cafe, bought a card, and has no account —
 * the card IS the credential. So this cannot sit behind JwtAuthGuard, and it
 * lives in its own file rather than as an exemption on the guarded
 * VouchersController: a hole punched in a class-level guard is how an endpoint
 * quietly goes public later, whereas a file named hotspot.controller.ts states
 * its own exposure.
 *
 * RATE LIMIT — the reason this number is small.
 *
 * A card is bearer value. Someone who has seen a code (a photographed card, a
 * discarded receipt) still needs the 6-digit PIN, and six digits is a million
 * guesses — trivially brute-forceable at the global 600/min limit, which
 * exists to stop scripted abuse of the panel, not to protect a secret. Ten
 * attempts a minute per IP makes that attack take years while leaving a real
 * customer, who mistypes once or twice, entirely unaffected.
 *
 * The matching half of this defence is in redeemAtHotspot(): every failure
 * returns an identical message, so the endpoint cannot be used to confirm
 * which codes exist.
 */
@Controller('public/hotspot')
export class HotspotController {
  constructor(private readonly vouchers: VouchersService) {}

  @Post('redeem')
  @UseGuards(new RateLimitGuard(10, 60_000))
  async redeem(
    @Body() body: { code?: string; pin?: string; mac?: string },
    @Req() req: any,
  ) {
    // MikroTik passes the client MAC in the redirect; binding the card to it
    // stops one code being shared around a room after activation.
    const mac = (body?.mac || req?.query?.mac || '').trim() || null;
    return this.vouchers.redeemAtHotspot(body?.code ?? '', body?.pin ?? '', {
      macAddress: mac,
    });
  }
}
