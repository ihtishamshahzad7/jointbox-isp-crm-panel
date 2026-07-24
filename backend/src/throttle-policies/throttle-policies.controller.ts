import {
  Controller, Get, Post, Put, Delete,
  Body, Param, UseGuards, Query, Req,
} from '@nestjs/common';
import { ThrottlePoliciesService } from './throttle-policies.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

/**
 * Throttle policies — let the ISP say "during peak hours, give this package
 * 50% of its normal speed". Implementation on the NAS is via RADIUS reply
 * attributes written at session start; the policy is the user-friendly
 * version of that.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('throttle-policies')
export class ThrottlePoliciesController {
  constructor(private readonly svc: ThrottlePoliciesService) {}

  @Get()
  list(@Query() query: any) {
    return this.svc.list(query);
  }

  @Get('options')
  options() {
    return this.svc.options();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.get(+id);
  }

  @Post()
  create(@Body() body: any, @Req() req: any) {
    return this.svc.create(body, req.user);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.svc.update(+id, body, req.user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.svc.remove(+id, req.user);
  }

  // ─── Package bindings ────────────────────────────────────────────────

  @Post(':id/packages')
  attachToPackage(@Param('id') id: string, @Body() body: any) {
    return this.svc.attachToPackage(+id, body);
  }

  @Delete(':id/packages/:pkgId')
  detachFromPackage(@Param('id') id: string, @Param('pkgId') pkgId: string) {
    return this.svc.detachFromPackage(+id, +pkgId);
  }

  // ─── Subscriber overrides ───────────────────────────────────────────

  @Post(':id/subscribers')
  attachToSubscriber(@Param('id') id: string, @Body() body: any) {
    return this.svc.attachToSubscriber(+id, body);
  }

  @Delete(':id/subscribers/:subId')
  detachFromSubscriber(@Param('id') id: string, @Param('subId') subId: string) {
    return this.svc.detachFromSubscriber(+id, +subId);
  }
}
