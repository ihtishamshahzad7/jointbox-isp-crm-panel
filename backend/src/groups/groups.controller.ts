import {
  Controller, Get, Post, Put, Delete,
  Body, Param, UseGuards, Patch, Query, Req,
} from '@nestjs/common';
import { GroupsService } from './groups.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

/**
 * Access Groups let the ISP say "share this NAS / package with franchise A and
 * dealer B, but hide it from dealer C". A resource can be GLOBAL (no rows in
 * the link table = everyone sees it), PERSONAL (only the owner sees it), or in
 * one or more named groups (members of those groups see it, with optional
 * inheritance to their downline).
 *
 * Three sets of endpoints:
 *   /groups            — manage the groups themselves
 *   /groups/:id/members — who is in the group
 *   /nas/group-bindings /packages/group-bindings — what's IN the groups
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  // ─── GROUPS CRUD ───────────────────────────────────────────────────────

  @Get()
  list(@Query() query: any, @Req() req: any) {
    return this.groups.listGroups(query, req.user);
  }

  @Get('options')
  options() {
    return this.groups.listOptions();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.groups.getGroup(+id);
  }

  @Post()
  create(@Body() body: any, @Req() req: any) {
    return this.groups.createGroup(body, req.user);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.groups.updateGroup(+id, body, req.user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.groups.removeGroup(+id, req.user);
  }

  // ─── MEMBERSHIP ───────────────────────────────────────────────────────

  @Get(':id/members')
  members(@Param('id') id: string) {
    return this.groups.listMembers(+id);
  }

  @Post(':id/members')
  addMember(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.groups.addMember(+id, body, req.user);
  }

  @Put(':id/members/:userId')
  updateMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: any,
  ) {
    return this.groups.updateMember(+id, +userId, body);
  }

  @Delete(':id/members/:userId')
  removeMember(@Param('id') id: string, @Param('userId') userId: string) {
    return this.groups.removeMember(+id, +userId);
  }

  // ─── RESOURCE BINDINGS ────────────────────────────────────────────────

  @Get(':id/nas')
  listNas(@Param('id') id: string) {
    return this.groups.listNasInGroup(+id);
  }

  @Post(':id/nas')
  bindNas(@Param('id') id: string, @Body() body: any) {
    return this.groups.bindNas(+id, body);
  }

  @Delete(':id/nas/:nasId')
  unbindNas(@Param('id') id: string, @Param('nasId') nasId: string) {
    return this.groups.unbindNas(+id, +nasId);
  }

  @Get(':id/packages')
  listPackages(@Param('id') id: string) {
    return this.groups.listPackagesInGroup(+id);
  }

  @Post(':id/packages')
  bindPackage(@Param('id') id: string, @Body() body: any) {
    return this.groups.bindPackage(+id, body);
  }

  @Delete(':id/packages/:pkgId')
  unbindPackage(@Param('id') id: string, @Param('pkgId') pkgId: string) {
    return this.groups.unbindPackage(+id, +pkgId);
  }

  // ─── VISIBILITY HELPERS ───────────────────────────────────────────────

  /**
   * Returns the effective set of NAS ids the actor is allowed to see, taking
   * group membership into account. Useful for the front-end to render
   * "Available in your groups" badges without multiple round-trips.
   */
  @Get('visibility/nas')
  visibleNas(@Req() req: any) {
    return this.groups.visibleNasFor(req.user);
  }

  @Get('visibility/packages')
  visiblePackages(@Req() req: any) {
    return this.groups.visiblePackagesFor(req.user);
  }
}
