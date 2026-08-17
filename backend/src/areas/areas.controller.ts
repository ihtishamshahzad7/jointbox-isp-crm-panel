import {
  Controller, Get, Post, Put, Delete,
  Body, Param, UseGuards, Patch, Req
} from '@nestjs/common';
import { AreasService } from './areas.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('areas')
export class AreasController {
  constructor(private readonly areasService: AreasService) {}

  @Get()
  findAll(@Req() req: any) { return this.areasService.findAll(req.user); }

  @Get('stats')
  getStats(@Req() req: any) { return this.areasService.getStats(req.user); }

  @Get(':id')
  findOne(@Param('id') id: string) { return this.areasService.findOne(+id); }

  @Post()
  create(@Body() body: any, @Req() req: any) { return this.areasService.create(body, req.user); }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.areasService.update(+id, body, req.user);
  }

  @Patch(':id/toggle')
  toggleStatus(@Param('id') id: string, @Req() req: any) {
    return this.areasService.toggleArea(+id, req.user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) { return this.areasService.remove(+id, req.user); }
}