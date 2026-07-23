import {
  Controller, Get, Post, Put, Delete,
  Body, Param, UseGuards, Patch, Query, Req,
} from '@nestjs/common';
import { PackagesService } from './packages.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('packages')
export class PackagesController {
  constructor(private readonly packagesService: PackagesService) {}

  @Get()
  findAll(@Query() query: any, @Req() req: any): any {
    // Pass the actor so resellers only see packages assigned to them,
    // priced at their own buy price.
    return this.packagesService.findAll(query, req.user);
  }

  @Get('stats')
  getStats(@Req() req: any): any {
    return this.packagesService.getStats(req.user);
  }

  @Get('options')
  getManagementOptions(): any {
    return this.packagesService.getManagementOptions();
  }

  @Get('taxes')
  getTaxes(): any {
    return this.packagesService.getTaxes();
  }

  @Post('taxes')
  createTax(@Body() body: any): any {
    return this.packagesService.createTax(body);
  }

  @Put('taxes/:id')
  updateTax(@Param('id') id: string, @Body() body: any): any {
    return this.packagesService.updateTax(+id, body);
  }

  @Delete('taxes/:id')
  deleteTax(@Param('id') id: string): any {
    return this.packagesService.deleteTax(+id);
  }

  @Get('policies')
  getPolicies(): any {
    return this.packagesService.getPolicies();
  }

  @Post('policies')
  createPolicy(@Body() body: any): any {
    return this.packagesService.createPolicy(body);
  }

  @Put('policies/:id')
  updatePolicy(@Param('id') id: string, @Body() body: any): any {
    return this.packagesService.updatePolicy(+id, body);
  }

  @Delete('policies/:id')
  deletePolicy(@Param('id') id: string): any {
    return this.packagesService.deletePolicy(+id);
  }

  @Get('allocations')
  getAllocations(): any {
    return this.packagesService.getAllocations();
  }

  @Post('allocations')
  createAllocation(@Body() body: any): any {
    return this.packagesService.createAllocation(body);
  }

  @Put('allocations/:id')
  updateAllocation(@Param('id') id: string, @Body() body: any): any {
    return this.packagesService.updateAllocation(+id, body);
  }

  @Delete('allocations/:id')
  deleteAllocation(@Param('id') id: string): any {
    return this.packagesService.deleteAllocation(+id);
  }

  @Get(':id/subscribers')
  subscribersByPackage(@Param('id') id: string): any {
    return this.packagesService.subscribersByPackage(+id);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id') id: string): any {
    return this.packagesService.duplicate(+id);
  }

  @Get(':id')
  findOne(@Param('id') id: string): any {
    return this.packagesService.findOne(+id);
  }

  @Post()
  create(@Body() body: any): any {
    return this.packagesService.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any): any {
    return this.packagesService.update(+id, body);
  }

  @Patch(':id/toggle')
  toggleStatus(@Param('id') id: string): any {
    return this.packagesService.toggleStatus(+id);
  }

  @Delete(':id')
  remove(@Param('id') id: string): any {
    return this.packagesService.remove(+id);
  }
}