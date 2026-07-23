import {
  Controller, Get, Post, Put, Patch, Delete,
  Body, Param, Query, UseGuards, Req,
} from '@nestjs/common';
import { StaticIpService } from './static-ip.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('static-ips')
export class StaticIpController {
  constructor(private readonly staticIps: StaticIpService) {}

  @Get()
  findAll(@Query() query: any, @Req() req: any) {
    return this.staticIps.findAll(req.user, query);
  }

  /** Pool utilisation, monthly revenue, expiring and overdue counts. */
  @Get('stats')
  stats(@Req() req: any) {
    return this.staticIps.stats(req.user);
  }

  /** Feeds the renewal banner. Declared before ':id' or that route swallows it. */
  @Get('alerts')
  alerts(@Req() req: any) {
    return this.staticIps.renewalAlerts(req.user);
  }

  /** The address a given subscriber currently holds, with its history. */
  @Get('subscriber/:subscriberId')
  forSubscriber(@Param('subscriberId') id: string, @Req() req: any) {
    return this.staticIps.forSubscriber(+id, req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.staticIps.findOne(+id, req.user);
  }

  /**
   * Set a live static IP straight onto a subscriber by typing the address.
   * Creates the register entry if the address isn't already known.
   */
  @Post('subscriber/:subscriberId')
  setForSubscriber(@Param('subscriberId') id: string, @Body() body: any, @Req() req: any) {
    return this.staticIps.setForSubscriber(+id, body, req.user);
  }

  @Post()
  create(@Body() body: any) {
    return this.staticIps.create(body);
  }

  /** Add a whole block at once — address space is bought in ranges. */
  @Post('range')
  createRange(@Body() body: any) {
    return this.staticIps.createRange(body);
  }

  /** Allocate to a customer, with price and optional end date. */
  @Patch(':id/assign')
  assign(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.staticIps.assign(+id, body, req.user);
  }

  /** Return the address to the pool. */
  @Patch(':id/release')
  release(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: any) {
    return this.staticIps.release(+id, body?.reason, req.user);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.staticIps.update(+id, body, req.user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.staticIps.remove(+id, req.user);
  }
}
