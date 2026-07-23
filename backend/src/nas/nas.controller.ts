import {
  Controller, Get, Post, Put, Delete,
  Body, Param, UseGuards, Patch, Req,
} from '@nestjs/common';
import { NasService } from './nas.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('nas')
export class NasController {
  constructor(private readonly nasService: NasService) {}

  // ── CRUD ────────────────────────────────────────────────────
  @Get()
  findAll(@Req() req: any) { return this.nasService.findAll(req.user); }

  // ── Assign / unassign a router to a downline account ────────
  /** Bulk: give several routers to several accounts at once. */
  @Post('assign-bulk')
  assignBulk(@Body() body: { nasIds: number[]; userIds: number[]; propagate?: boolean }, @Req() req: any) {
    return this.nasService.assignBulk(body?.nasIds || [], body?.userIds || [], req.user, body?.propagate !== false);
  }

  @Post(':id/assign/:userId')
  assign(@Param('id') id: string, @Param('userId') userId: string, @Body() body: { propagate?: boolean }, @Req() req: any) {
    // propagate defaults to true (cascades to the whole downline) unless the
    // caller explicitly passes false to restrict the share to this one account.
    return this.nasService.assignToUser(+id, +userId, req.user, body?.propagate !== false);
  }

  @Delete(':id/assign/:userId')
  unassign(@Param('id') id: string, @Param('userId') userId: string, @Req() req: any) {
    return this.nasService.unassignFromUser(+id, +userId, req.user);
  }

  @Get('stats')
  getStats(@Req() req: any) { return this.nasService.getStats(req.user); }

  @Get('overview')
  getOverview(@Req() req: any) { return this.nasService.getOverview(req.user); }

  @Get('debug/radius-sync')
  debugRadiusSync() { return this.nasService.debugRadiusSync(); }

  // IMPORTANT: named routes like 'stats' and 'radius/stats' must come
  // BEFORE ':id' — otherwise NestJS treats them as id params
  @Get('radius/stats')
  getRadiusStats() { return this.nasService.getRadiusStats(); }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) { return this.nasService.findOne(+id, req.user); }

  @Post()
  create(@Body() body: any, @Req() req: any) { return this.nasService.create(body, req.user); }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.nasService.update(+id, body);
  }

  @Patch(':id/toggle')
  toggleStatus(@Param('id') id: string) {
    return this.nasService.toggleStatus(+id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) { return this.nasService.remove(+id); }

  // ── MikroTik + RADIUS endpoints ─────────────────────────────
  @Get(':id/reachability')
  checkReachability(@Param('id') id: string) {
    return this.nasService.checkReachability(+id);
  }

  @Get(':id/sync')
  syncDetails(@Param('id') id: string) {
    return this.nasService.syncDetails(+id);
  }

  @Get(':id/quick-check')
  quickCheck(@Param('id') id: string) {
    return this.nasService.quickCheck(+id);
  }

  @Get(':id/sessions')
  getActiveSessions(@Param('id') id: string) {
    return this.nasService.getActiveSessions(+id);
  }
}