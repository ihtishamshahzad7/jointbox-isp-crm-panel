import {
  Controller, Get, Post, Patch, Body, Param, Query, UseGuards, Req,
} from '@nestjs/common';
import { KycService } from './kyc.service';
import { FupService } from './fup.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('compliance')
export class ComplianceController {
  constructor(
    private readonly kyc: KycService,
    private readonly fup: FupService,
  ) {}

  // ── KYC ─────────────────────────────────────────────────────
  /** Verification coverage + what still needs attention. */
  @Get('kyc/stats')
  kycStats(@Req() req: any) {
    return this.kyc.stats(req.user);
  }

  /** Work queue: PENDING | EXPIRED | REJECTED | MISSING | ALL */
  @Get('kyc/queue')
  kycQueue(@Query('filter') filter: string, @Req() req: any) {
    return this.kyc.queue(req.user, filter || 'ALL');
  }

  /** Connections sharing a CNIC — the usual signature of resale. */
  @Get('kyc/duplicates')
  duplicates(@Req() req: any) {
    return this.kyc.duplicates(req.user);
  }

  /** PTA-style subscriber register export. */
  @Get('kyc/register')
  register(@Req() req: any) {
    return this.kyc.register(req.user);
  }

  /** Check a CNIC's format without saving it. */
  @Get('kyc/validate/:cnic')
  validateCnic(@Param('cnic') cnic: string) {
    return this.kyc.validate(cnic);
  }

  @Post('kyc/:subscriberId/cnic')
  setCnic(
    @Param('subscriberId') id: string,
    @Body() body: { cnicNumber: string; cnicExpiry?: string },
    @Req() req: any,
  ) {
    return this.kyc.setCnic(+id, body, req.user);
  }

  @Patch('kyc/:subscriberId/verify')
  verify(
    @Param('subscriberId') id: string,
    @Body() body: { approved: boolean; notes?: string },
    @Req() req: any,
  ) {
    return this.kyc.verify(+id, body?.approved !== false, body?.notes, req.user);
  }

  // ── User (account-holder) KYC ───────────────────────────────
  /** Verification coverage for reseller/staff accounts. */
  @Get('kyc/users/stats')
  userKycStats(@Req() req: any) {
    return this.kyc.userStats(req.user);
  }

  /** User-KYC work queue: PENDING | EXPIRED | REJECTED | VERIFIED | MISSING | ALL */
  @Get('kyc/users/queue')
  userKycQueue(@Query('filter') filter: string, @Req() req: any) {
    return this.kyc.userQueue(req.user, filter || 'ALL');
  }

  @Post('kyc/users/:userId/cnic')
  setUserCnic(
    @Param('userId') id: string,
    @Body() body: { cnicNumber: string; cnicExpiry?: string },
    @Req() req: any,
  ) {
    return this.kyc.setUserCnic(+id, body, req.user);
  }

  @Patch('kyc/users/:userId/verify')
  verifyUser(
    @Param('userId') id: string,
    @Body() body: { approved: boolean; notes?: string },
    @Req() req: any,
  ) {
    return this.kyc.verifyUser(+id, body?.approved !== false, body?.notes, req.user);
  }

  // ── FUP ─────────────────────────────────────────────────────
  /** Heavy users: near quota or already throttled. */
  @Get('fup/report')
  fupReport(@Req() req: any) {
    return this.fup.report(req.user);
  }

  /** Live usage and quota position for one subscriber. */
  @Get('fup/:subscriberId')
  fupUsage(@Param('subscriberId') id: string, @Req() req: any) {
    return this.fup.usageFor(+id, req.user);
  }

  /** Restore full speed / net — on renewal, or as a goodwill gesture. */
  @Patch('fup/:subscriberId/release')
  releaseFup(@Param('subscriberId') id: string, @Req() req: any) {
    return this.fup.release(+id, req.user);
  }

  /** Grant extra GB for this cycle (quota top-up); lifts the cut/throttle if now under cap. */
  @Post('fup/:subscriberId/extend')
  extendQuota(@Param('subscriberId') id: string, @Body() body: { gb: number }, @Req() req: any) {
    return this.fup.extendQuota(+id, Number(body?.gb), req.user);
  }
}
