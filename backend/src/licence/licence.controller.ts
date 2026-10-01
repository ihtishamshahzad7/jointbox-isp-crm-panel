import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LicenceService } from './licence.service';
import { LicenceActivationService } from './licence-activation.service';

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
  ) {}

  @Get('status')
  status() {
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
  async refresh() {
    await this.licence.refresh();
    return this.licence.status();
  }
}
