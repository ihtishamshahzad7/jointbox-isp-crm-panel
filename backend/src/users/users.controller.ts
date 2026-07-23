import {
  Controller, Get, Post, Put, Delete, Patch,
  Body, Param, UseGuards, Req,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll(@Req() req: any) {
    return this.usersService.findAll(req.user);
  }

  @Get('stats')
  getStats(@Req() req: any) {
    return this.usersService.getStats(req.user);
  }

  @Get('me/profile')
  myProfile(@Req() req: any) {
    return this.usersService.myProfile(req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.usersService.findOne(+id, req.user);
  }

  @Post()
  create(@Body() body: any, @Req() req: any) {
    return this.usersService.create(body, req.user);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.usersService.update(+id, body, req.user);
  }

  @Patch(':id/toggle')
  toggleStatus(@Param('id') id: string, @Req() req: any) {
    return this.usersService.toggleStatus(+id, req.user);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @Req() req: any) {
    return this.usersService.delete(+id, req.user);
  }

  /**
   * ISP-only: wipe an account and its whole subtree.
   *
   * GET-shaped preview first (`POST` with no body returns the plan and changes
   * nothing). Pass `confirm` matching the account name to actually run it.
   */
  @Post(':id/purge')
  purge(
    @Param('id') id: string,
    @Body() body: { confirm?: string },
    @Req() req: any,
  ) {
    return this.usersService.purgeAccount(req.user, +id, {
      dryRun: !body?.confirm,
      confirm: body?.confirm,
    });
  }
}