import { Body, Controller, ForbiddenException, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LicenceService } from './licence.service';
import { LicenceActivationService } from './licence-activation.service';
import { LicenceCountsService } from './licence-counts.service';

/**
 * Licence status for the UI.
 *
 * On the guard's exempt list on purpose: an operator whose licence has lapsed
 * must still be able to open this page and see what is wrong and what to do
 * about it. Locking someone out of the screen that explains why they are
 * locked out is the sort of thing that turns a renewal into a support ticket.
 */
@Controller('licence')
@UseGuards(JwtAuthGuard)
export class LicenceController {
  constructor(
    private readonly licence: LicenceService,
    private readonly activation: LicenceActivationService,
    private readonly counts: LicenceCountsService,
  ) {}

  /**
   * PLATFORM OWNER ONLY.
   *
   * The licence is a contract between us and the operator of this
   * INSTALLATION, not between us and each ISP company running on it. An ADMIN
   * is a tenant: the plan name, the expiry, the hardware fingerprint and the
   * installation-wide subscriber count are none of their business, and the
   * count in particular is a direct leak — it is the total across every
   * company on the panel, so publishing it tells one ISP roughly how large its
   * competitors are.
   *
   * 403 rather than a quiet empty object, so the panel's own LicenceProvider
   * treats it as unreachable and renders nothing at all for a tenant. That is
   * the same fail-quiet path it already takes on an older server, which is why
   * no banner, no dialog and no menu row appear — without a second rule
   * anywhere in the UI deciding who may see licensing.
   */
  private assertPlatformOwner(req: any) {
    if (req?.user?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Licensing is managed by the platform owner.');
    }
  }

  @Get('status')
  status(@Req() req: any) {
    this.assertPlatformOwner(req);
    return this.licence.status();
  }

  /**
   * Activate this installation from the browser.
   *
   * NOT on the guard's exempt list by accident — it is reachable while
   * UNLICENSED on purpose, because an unactivated panel is exactly the state
   * in which someone needs to activate it. Authorisation is enforced inside
   * the service, which refuses anyone who is not SUPER_ADMIN.
   */
  @Post('activate')
  activate(@Body() body: any, @Req() req: any) {
    this.assertPlatformOwner(req);
    return this.activation.activate(
      {
        key: String(body?.key ?? ''),
        company: body?.company,
        website: body?.website,
        contact: body?.contact,
        email: body?.email,
        phone: body?.phone,
      },
      {
        id: req?.user?.sub ?? req?.user?.id,
        role: req?.user?.role,
        ip: req?.ip ?? req?.headers?.['x-forwarded-for'],
        userAgent: req?.headers?.['user-agent'],
      },
    );
  }

  /** Force an immediate re-read, for the "I've just paid" button. */
  @Get('refresh')
  async refresh(@Req() req: any) {
    this.assertPlatformOwner(req);
    // Recount before re-reading, so the usage figures on the licence screen are
    // current too. The cron only runs hourly; someone who has just pressed this
    // button is asking "where am I NOW", and an hour-old subscriber count is
    // the kind of small wrongness that costs trust in the one number that
    // matters — the one sitting next to their plan cap.
    await this.counts.publishNow().catch(() => undefined);
    await this.licence.refresh();
    return this.licence.status();
  }
}
