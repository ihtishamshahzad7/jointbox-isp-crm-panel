import {
  Controller, Get, Post, Put, Delete, Patch,
  Body, Param, Query, UseGuards, Req,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ResellerPricingService } from '../organization/reseller-pricing.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly pricing: ResellerPricingService,
  ) {}

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

  /** Reseller/franchise operations snapshot: wallet, customers, revenue, dues. */
  @Get('me/business')
  myBusiness(@Req() req: any) {
    return this.usersService.myBusiness(req.user);
  }

  /** Collections/earnings report: totals, daily trend, per-package & method. */
  @Get('me/earnings')
  myEarnings(@Req() req: any, @Query('from') from?: string, @Query('to') to?: string) {
    return this.usersService.myEarnings(req.user, from, to);
  }

  /** Group accounts by role | parent | kyc, with counts. */
  @Get('grouped')
  grouped(@Query('by') by: string, @Req() req: any) {
    return this.usersService.groupedBy(by || 'role', req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.usersService.findOne(+id, req.user);
  }

  @Get(':id/packages')
  findPackages(@Param('id') id: string, @Req() req: any) {
    return this.usersService.findUserPackages(+id, req.user);
  }

  @Put(':id/packages/:packageId')
  setPackagePrice(
    @Param('id') id: string,
    @Param('packageId') packageId: string,
    @Body() body: { price?: number; retailPrice?: number; subresellerProfit?: number; subscriberProfit?: number },
    @Req() req: any,
  ) {
    return this.pricing.setPrice(req.user, {
      userId: +id,
      packageId: +packageId,
      price: body.price,
      retailPrice: body.retailPrice,
      subresellerProfit: body.subresellerProfit,
      subscriberProfit: body.subscriberProfit,
    });
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