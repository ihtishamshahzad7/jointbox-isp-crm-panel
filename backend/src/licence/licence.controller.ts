import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LicenceService } from './licence.service';

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
  constructor(private readonly licence: LicenceService) {}

  @Get('status')
  status() {
    return this.licence.status();
  }

  /** Force an immediate re-read, for the "I've just paid" button. */
  @Get('refresh')
  async refresh() {
    await this.licence.refresh();
    return this.licence.status();
  }
}
