import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { PlatformPlansService } from './platform-plans.service';
import type { Actor } from '../common/scope.service';

type AuthedReq = { user: Actor };

/** Plans & Pricing and company details. Platform account only (checked in the service). */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('platform')
export class PlatformPlansController {
  constructor(private readonly plans: PlatformPlansService) {}

  @Get('plans')
  list(@Req() req: AuthedReq) {
    return this.plans.list(req.user);
  }

  @Post('plans')
  create(@Body() body: Record<string, unknown>, @Req() req: AuthedReq) {
    return this.plans.create(req.user, body);
  }

  @Put('plans/:id')
  update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: AuthedReq,
  ) {
    return this.plans.update(req.user, +id, body);
  }

  @Delete('plans/:id')
  remove(@Param('id') id: string, @Req() req: AuthedReq) {
    return this.plans.remove(req.user, +id);
  }

  @Post('plans/:id/apply')
  apply(@Param('id') id: string, @Req() req: AuthedReq) {
    return this.plans.applyToCompanies(req.user, +id);
  }

  @Get('companies/:id/profile')
  getProfile(@Param('id') id: string, @Req() req: AuthedReq) {
    return this.plans.getProfile(req.user, +id);
  }

  @Put('companies/:id/profile')
  saveProfile(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: AuthedReq,
  ) {
    return this.plans.saveProfile(req.user, +id, body);
  }
}
