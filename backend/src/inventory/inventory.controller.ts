import {
  Controller, Get, Post, Put, Patch, Delete,
  Body, Param, Query, UseGuards, Req,
} from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  findAll(@Query() query: any, @Req() req: any) {
    return this.inventory.findAll(req.user, query);
  }

  /** Stock counts by status/type + warranty expiring in 30 days. */
  @Get('stats')
  stats(@Req() req: any) {
    return this.inventory.stats(req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.inventory.findOne(+id, req.user);
  }

  /** Chain of custody — who held this unit and when. */
  @Get(':id/history')
  history(@Param('id') id: string, @Req() req: any) {
    return this.inventory.history(+id, req.user);
  }

  @Post()
  create(@Body() body: any, @Req() req: any) {
    return this.inventory.create(body, req.user);
  }

  /** Bulk intake for a delivery — one call, many serials. */
  @Post('bulk')
  bulkCreate(@Body() body: { items: any[] }, @Req() req: any) {
    return this.inventory.bulkCreate(body?.items || [], req.user);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.inventory.update(+id, body, req.user);
  }

  /** Issue stock to a reseller. */
  @Patch(':id/assign/:userId')
  assign(@Param('id') id: string, @Param('userId') userId: string, @Req() req: any) {
    return this.inventory.assignToUser(+id, +userId, req.user);
  }

  /** Install at a customer premises. */
  @Patch(':id/install/:subscriberId')
  install(@Param('id') id: string, @Param('subscriberId') subscriberId: string, @Req() req: any) {
    return this.inventory.installAtSubscriber(+id, +subscriberId, req.user);
  }

  /** Take it back: IN_STOCK | FAULTY | RETURNED | LOST */
  @Patch(':id/return')
  returnItem(
    @Param('id') id: string,
    @Body() body: { status?: 'IN_STOCK' | 'FAULTY' | 'RETURNED' | 'LOST'; notes?: string },
    @Req() req: any,
  ) {
    return this.inventory.returnItem(+id, body?.status || 'IN_STOCK', req.user, body?.notes);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.inventory.remove(+id, req.user);
  }
}
