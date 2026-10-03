import {
  Controller,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Req,
  Get,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './auth.guard';
import { TokenBlacklistService } from './token-blacklist.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenBlacklistService: TokenBlacklistService,
  ) {}

  @Post('impersonate/:userId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async impersonate(@Param('userId') userId: string, @Req() req: any) {
    return this.authService.impersonate(req.user, +userId);
  }

  @Post('impersonate-stop')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async stopImpersonation(@Req() req: any) {
    return this.authService.stopImpersonation(req.user);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: { email: string; password: string; code?: string },
    @Req() req: any,
  ) {
    // Keep authentication deterministic with the demo-account creator and
    // with production accounts whose email may have been entered with spaces
    // or different casing. Passwords are intentionally NOT trimmed/changed.
    const email = String(loginDto?.email || '').trim().toLowerCase();
    const password = String(loginDto?.password || '');
    const code = loginDto?.code ? String(loginDto.code).trim() : undefined;

    console.log('📝 Login attempt for email:', email);

    const forwarded = req.headers['x-forwarded-for'];
    const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim()) ||
      req.socket?.remoteAddress ||
      req.connection?.remoteAddress ||
      'Unknown';
    const userAgent = req.headers['user-agent'] || 'Unknown';

    return this.authService.login(email, password, ip, userAgent, code);
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  async getProfile(@Req() req: any) {
    const user = await this.authService.getProfile(req.user.sub);
    return { user };
  }

  /**
   * refresh / verify act on the token in the BODY — the caller's own token,
   * with no authenticated request around it — so the checks the operator
   * strategy makes on every request (jwt.strategy.ts) never ran here:
   *
   *   • A subscriber PORTAL token is signed with this same secret as
   *     `{ sub: <subscriberId>, scope: 'subscriber' }`. refreshToken() reads
   *     `sub` as a USER id, so a customer could trade their portal token for a
   *     7-day operator token of whichever account shares their number — id 1
   *     being the platform owner — and verify returned that account's profile.
   *   • A logged-out (revoked) token could still mint a fresh 7-day one, which
   *     made logout meaningless.
   *
   * The payload is only DECODED here, to refuse; the service still verifies
   * the signature, so a forged claim gains nothing.
   */
  private refusedToken(token: unknown): string | null {
    const t = typeof token === 'string' ? token : '';
    if (!t) return 'Invalid token';
    if (this.tokenBlacklistService.isBlacklisted(t)) return 'Token revoked';
    let claims: any = null;
    try {
      claims = JSON.parse(Buffer.from(t.split('.')[1] || '', 'base64url').toString('utf8'));
    } catch {
      claims = null;
    }
    if (claims?.scope && claims.scope !== 'admin') return 'Invalid token';
    return null;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: { token: string }) {
    if (this.refusedToken(body?.token)) throw new UnauthorizedException('Invalid refresh token');
    return this.authService.refreshToken(body.token);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verifyToken(@Body() body: { token: string }) {
    const refused = this.refusedToken(body?.token);
    if (refused) return { valid: false, message: refused };
    return this.authService.verifyToken(body.token);
  }

  /** Change my own password. Reachable while a forced change is pending. */
  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Req() req: any,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    const old = req.headers.authorization?.replace('Bearer ', '');
    const result = await this.authService.changeOwnPassword(
      Number(req.user.sub),
      String(body?.currentPassword ?? ''),
      String(body?.newPassword ?? ''),
    );
    if (old) this.tokenBlacklistService.add(old);
    return { message: result.message, token: result.token };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: any) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) this.tokenBlacklistService.add(token);
    return { message: 'Logged out successfully' };
  }
}
