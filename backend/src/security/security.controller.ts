import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Request, UseGuards } from '@nestjs/common';
import { SecurityService } from './security.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from './permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('security')
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  // ── Permissions matrix ────────────────────────────────────────
  // The catalog of resources/roles/actions and the current role matrix are
  // the same for every caller: they describe what CAN be granted, not anyone's
  // data. Readable by any operator; only changing them is restricted.
  @Get('meta')
  meta(@Request() req: any) {
    return this.security.meta();
  }

  @Get('permissions')
  matrix(@Request() req: any) {
    return this.security.getMatrix();
  }

  /**
   * RolePermission has no owner: one row set per ROLE serves every company on
   * the installation, so changing it is a platform-owner operation.
   */
  @Put('permissions/:role')
  setRole(@Param('role') role: string, @Body() body: { permissions: string[] }, @Request() req: any) {
    return this.security.setRolePermissions(req.user, role.toUpperCase(), body.permissions || []);
  }

  // ── Recommended presets (one-click per tier) ───────────────────
  @Get('presets')
  presets(@Request() req: any) {
    return this.security.presets();
  }

  /** Same installation-wide write as setRole(), so the same platform-owner gate. */
  @Put('presets/:role')
  applyPreset(@Param('role') role: string, @Request() req: any) {
    return this.security.applyPreset(req.user, role.toUpperCase());
  }

  // ── Delegated per-child permissions ───────────────────────────
  @Get('child-permissions/catalog')
  permCatalog(@Request() req: any) {
    return this.security.permissionCatalog();
  }
  @Get('child-permissions/:userId')
  getChildPerms(@Param('userId') userId: string, @Request() req: any) {
    return this.security.getChildPermissions(req.user, +userId);
  }
  @Put('child-permissions/:userId')
  setChildPerms(@Param('userId') userId: string, @Body() body: { denied: string[] }, @Request() req: any) {
    return this.security.setChildPermissions(req.user, +userId, body.denied || []);
  }

  // ── 2FA (always for the logged-in user) ───────────────────────
  @Get('2fa')
  status(@Request() req: any) {
    return this.security.twoFactorStatus(req.user.sub);
  }

  /**
   * 2FA belongs to the person, not to whoever is switched into the account:
   * an operator "acting as" a dealer must not reset the dealer's 2FA.
   */
  private assertOwnSession(req: any) {
    if (req?.user?.imp) throw new ForbiddenException('Two-factor settings can only be changed by the account itself, not while switched into it.');
  }

  @Post('2fa/enroll')
  enroll(@Request() req: any, @Body() body: { code?: string }) {
    this.assertOwnSession(req);
    return this.security.enrollTwoFactor(req.user.sub, body?.code || '');
  }

  @Post('2fa/confirm')
  confirm(@Request() req: any, @Body() body: { code: string }) {
    this.assertOwnSession(req);
    return this.security.confirmTwoFactor(req.user.sub, body.code || '');
  }

  @Post('2fa/disable')
  disable(@Request() req: any, @Body() body: { code: string }) {
    this.assertOwnSession(req);
    return this.security.disableTwoFactor(req.user.sub, body.code || '');
  }

  // ── Sessions ──────────────────────────────────────────────────
  /** Login sessions of the accounts the caller can see (all, for the platform owner). */
  @Get('sessions')
  sessions(@Request() req: any) {
    return this.security.activeSessions(req.user);
  }

  @Delete('sessions/:sessionId')
  kill(@Param('sessionId') sessionId: string, @Request() req: any) {
    return this.security.killSession(sessionId, req.user?.sub, req.user);
  }
}
