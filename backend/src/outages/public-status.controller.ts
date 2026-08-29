import { Controller, Get, Query } from '@nestjs/common';
import { OutagesService } from './outages.service';

/**
 * The public status page's API. NO AUTHENTICATION, deliberately.
 *
 * This is a separate controller because OutagesController carries a
 * class-level @UseGuards(JwtAuthGuard, PermissionsGuard) — and it should keep
 * carrying it. Punching a hole in that guard for one route is how an endpoint
 * quietly becomes public years later without anyone noticing; a file whose
 * name says "public" cannot be misread.
 *
 * WHAT THIS MAY RETURN, AND WHY IT IS NARROW
 * Only area name, city, up/down, the customer-facing cause and the minute it
 * started. Never subscriber counts, offline percentages, internal notes or the
 * operational verdicts the staff board shows — published openly, counts hand
 * competitors a live map of the business, and the verdicts are instructions to
 * staff rather than information for customers. The narrowing happens in
 * publicStatus()/publicHistory(), not here, so no future controller change can
 * accidentally widen it.
 *
 * Being open, these routes are covered by the global rate limiter in main.ts.
 */
@Controller('public/status')
export class PublicStatusController {
  constructor(private readonly outages: OutagesService) {}

  /** Current status per service area — the page's main content. */
  @Get()
  status() {
    return this.outages.publicStatus();
  }

  /** Recently resolved incidents, so the page shows a track record. */
  @Get('history')
  history(@Query('days') days?: string) {
    return this.outages.publicHistory(days ? +days : 7);
  }
}
