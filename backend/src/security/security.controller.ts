import { Body, Controller, Delete, Get, Param, Post, Put, Request, UseGuards } from '@nestjs/common';
import { SecurityService } from './security.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from './permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('security')
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  // ── Permissions matrix ────────────────────────────────────────
  @Get('meta')
  meta() {
    return this.security.meta();
  }

  @Get('permissions')
  matrix() {
    return this.security.getMatrix();
  }

  @Put('permissions/:role')
  setRole(@Param('role') role: string, @Body() body: { permissions: string[] }) {
    return this.security.setRolePermissions(role.toUpperCase(), body.permissions || []);
  }

  // ── Recommended presets (one-click per tier) ───────────────────
  @Get('presets')
  presets() {
    return this.security.presets();
  }

  @Put('presets/:role')
  applyPreset(@Param('role') role: string) {
    return this.security.applyPreset(role.toUpperCase());
  }

  // ── Delegated per-child permissions ───────────────────────────
  @Get('child-permissions/catalog')
  permCatalog() {
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

  @Post('2fa/enroll')
  enroll(@Request() req: any) {
    return this.security.enrollTwoFactor(req.user.sub);
  }

  @Post('2fa/confirm')
  confirm(@Request() req: any, @Body() body: { code: string }) {
    return this.security.confirmTwoFactor(req.user.sub, body.code || '');
  }

  @Post('2fa/disable')
  disable(@Request() req: any, @Body() body: { code: string }) {
    return this.security.disableTwoFactor(req.user.sub, body.code || '');
  }

  // ── Sessions ──────────────────────────────────────────────────
  @Get('sessions')
  sessions() {
    return this.security.activeSessions();
  }

  @Delete('sessions/:sessionId')
  kill(@Param('sessionId') sessionId: string, @Request() req: any) {
    return this.security.killSession(sessionId, req.user?.sub);
  }
}
