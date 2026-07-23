import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { SetupService } from './setup.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * Deliberately NOT behind PermissionsGuard.
 *
 * This endpoint tells an account what it still needs to configure. Gating it
 * behind the permission matrix would mean the one screen that explains why you
 * are blocked could itself be blocked — which is the failure mode this whole
 * feature exists to remove. It reads nothing sensitive: only counts and flags
 * for the caller's own subtree.
 */
@UseGuards(JwtAuthGuard)
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get('status')
  status(@Req() req: any) {
    return this.setup.status(req.user);
  }
}
