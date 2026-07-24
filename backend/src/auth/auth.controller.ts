import {
  Controller,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Req,
  Get,
  UseGuards
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './auth.guard'; // Use JwtAuthGuard instead
import { TokenBlacklistService } from './token-blacklist.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenBlacklistService: TokenBlacklistService,
  ) {}

  // Switch into a downstream user's profile ("act as").
  @Post('impersonate/:userId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async impersonate(@Param('userId') userId: string, @Req() req: any) {
    return this.authService.impersonate(req.user, +userId);
  }

  // Return to the original operator's account.
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
    console.log('📝 Login attempt for email:', loginDto.email);
    
    const ip = req.headers['x-forwarded-for'] || 
               req.socket?.remoteAddress || 
               req.connection?.remoteAddress || 
               'Unknown';
    
    const userAgent = req.headers['user-agent'] || 'Unknown';
    
    return this.authService.login(
      loginDto.email,
      loginDto.password,
      ip,
      userAgent,
      loginDto.code,
    );
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  async getProfile(@Req() req: any) {
    const user = await this.authService.getProfile(req.user.sub);
    return { user };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: { token: string }) {
    return this.authService.refreshToken(body.token);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verifyToken(@Body() body: { token: string }) {
    return this.authService.verifyToken(body.token);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: any) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      this.tokenBlacklistService.add(token);
    }
    return { message: 'Logged out successfully' };
  }
}
