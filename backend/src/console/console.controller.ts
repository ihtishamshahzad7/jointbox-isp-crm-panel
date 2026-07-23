import { Controller, Get, Post, Body, Query, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ConsoleService } from './console.service';

/**
 * Server console — ISP owner (SUPER_ADMIN) ONLY.
 *
 * Not behind PermissionsGuard's per-feature flags on purpose: this is not a
 * delegable feature, it is the platform owner's root access to their own box.
 * The role check below is absolute and repeated on every route.
 */
@UseGuards(JwtAuthGuard)
@Controller('console')
export class ConsoleController {
  constructor(private readonly svc: ConsoleService) {}

  private assertOwner(req: any) {
    if (req?.user?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('The server console is available to the ISP owner account only.');
    }
  }

  @Get('info')
  info(@Req() req: any) {
    this.assertOwner(req);
    return this.svc.info(req.user);
  }

  @Get('logs')
  logs(@Query('source') source: string, @Query('lines') lines: string, @Req() req: any) {
    this.assertOwner(req);
    return this.svc.tail(req.user, source || 'backend', lines ? parseInt(lines) : 200);
  }

  @Post('exec')
  execCmd(@Body() body: { command: string }, @Req() req: any) {
    this.assertOwner(req);
    return this.svc.exec(req.user, body?.command || '');
  }
}
