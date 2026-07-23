import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PermissionsGuard } from './security/permissions.guard';

@Controller()
export class AppController {

  @Get('health')
  health() {
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Get('profile')
  profile(@Req() req: any) {
    return {
      message: "Protected Profile 🔐",
      user: req.user,
    };
  }
}