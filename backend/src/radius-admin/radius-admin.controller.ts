import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RadiusAdminService } from './radius-admin.service';

/**
 * FreeRADIUS & database administration — ISP owner (SUPER_ADMIN) ONLY.
 * Like the server console, this is the platform owner's control over their own
 * box, not a delegable per-role feature, so the role check is absolute and
 * repeated on every route.
 */
@UseGuards(JwtAuthGuard)
@Controller('radius-admin')
export class RadiusAdminController {
  constructor(private readonly svc: RadiusAdminService) {}

  private owner(req: any) {
    if (req?.user?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('FreeRADIUS & database settings are available to the ISP owner account only.');
    }
  }

  @Get('status')      status(@Req() r: any) { this.owner(r); return this.svc.status(); }
  @Get('modules')     modules(@Req() r: any) { this.owner(r); return this.svc.modules(); }
  @Get('files')       files(@Req() r: any) { this.owner(r); return this.svc.files(); }
  @Get('database')    database(@Req() r: any) { this.owner(r); return this.svc.database(); }

  @Get('file')
  readFile(@Query('path') p: string, @Req() r: any) { this.owner(r); return this.svc.readFile(p || ''); }

  @Post('file')
  writeFile(@Body() b: { path: string; content: string }, @Req() r: any) {
    this.owner(r); return this.svc.writeFile(b?.path || '', b?.content ?? '');
  }

  @Post('module/toggle')
  toggle(@Body() b: { name: string; enable: boolean }, @Req() r: any) {
    this.owner(r); return this.svc.toggleModule(b?.name, !!b?.enable);
  }

  @Post('control')
  control(@Body() b: { action: 'restart' | 'stop' | 'start' | 'test' }, @Req() r: any) {
    this.owner(r); return this.svc.control(b?.action);
  }
}
