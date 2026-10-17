import {
  Controller, Get, Post, Put, Delete,
  Body, Param, UseGuards, Patch, Query, Req,
} from '@nestjs/common';
import { PackagesService } from './packages.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('packages')
export class PackagesController {
  constructor(
    private readonly packagesService: PackagesService,
    private readonly scope: ScopeService,
  ) {}

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

  // ── Taxes / policies / allocations ─────────────────────────────
  // Each company owns its own taxes, RADIUS policies and time allocations,
  // exactly like its packages. The service scopes every read and write to the
  // caller's company and refuses the platform account (it manages companies,
  // not their network setup).

  /** Taxes, policies and allocations the caller's company can use on a package. */
  @Get('options')
  getManagementOptions(@Req() req: any): any {
    return this.packagesService.getManagementOptions(req.user);
  }

  /** Platform default taxes plus the caller's company's own. */
  @Get('taxes')
  getTaxes(@Req() req: any): any {
    return this.packagesService.getTaxes(req.user);
  }

  // A company's administrator manages the company's own taxes; platform
  // defaults stay the platform owner's (ScopeService.assertConfigWritable).
  @Post('taxes')
  createTax(@Body() body: any, @Req() req: any): any {
    return this.packagesService.createTax(body, req.user);
  }

  @Put('taxes/:id')
  updateTax(@Param('id') id: string, @Body() body: any, @Req() req: any): any {
    return this.packagesService.updateTax(+id, body, req.user);
  }

  @Delete('taxes/:id')
  deleteTax(@Param('id') id: string, @Req() req: any): any {
    return this.packagesService.deleteTax(+id, req.user);
  }

  /** The caller's company's RADIUS policies (plus legacy shared ones, read-only). */
  @Get('policies')
  getPolicies(@Req() req: any): any {
    return this.packagesService.getPolicies(req.user);
  }

  @Post('policies')
  createPolicy(@Body() body: any, @Req() req: any): any {
    return this.packagesService.createPolicy(body, req.user);
  }

  @Put('policies/:id')
  updatePolicy(@Param('id') id: string, @Body() body: any, @Req() req: any): any {
    return this.packagesService.updatePolicy(+id, body, req.user);
  }

  @Delete('policies/:id')
  deletePolicy(@Param('id') id: string, @Req() req: any): any {
    return this.packagesService.deletePolicy(+id, req.user);
  }

  /** The caller's company's time allocations (plus legacy shared ones, read-only). */
  @Get('allocations')
  getAllocations(@Req() req: any): any {
    return this.packagesService.getAllocations(req.user);
  }

  @Post('allocations')
  createAllocation(@Body() body: any, @Req() req: any): any {
    return this.packagesService.createAllocation(body, req.user);
  }

  @Put('allocations/:id')
  updateAllocation(@Param('id') id: string, @Body() body: any, @Req() req: any): any {
    return this.packagesService.updateAllocation(+id, body, req.user);
  }

  @Delete('allocations/:id')
  deleteAllocation(@Param('id') id: string, @Req() req: any): any {
    return this.packagesService.deleteAllocation(+id, req.user);
  }

  @Get(':id/subscribers')
  subscribersByPackage(@Param('id') id: string, @Req() req: any): any {
    return this.packagesService.subscribersByPackage(+id, req.user);
  }

  @Get(':id/overview')
  overview(@Param('id') id: string, @Req() req: any): any {
    return this.packagesService.overview(+id, req.user);
  }

  /** Archive (deactivate) — keeps existing subscribers running, blocks new sign-ups. */
  @Post(':id/archive')
  archive(@Param('id') id: string, @Req() req: any): any {
    return this.packagesService.archive(+id, req.user);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id') id: string, @Req() req: any): any {
    return this.packagesService.duplicate(+id, req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any): any {
    return this.packagesService.findOne(+id, req.user);
  }

  /**
   * Rate-limit audit — shows, per package, the Mikrotik-Rate-Limit string
   * written before vs after the rx/tx order fix, and how many subscribers each
   * package affects. Read-only; re-sync nothing until this has been reviewed.
   */
  @Get('rate-limit/audit')
  rateLimitAudit(@Req() req: any): any {
    return this.packagesService.rateLimitAudit(req.user);
  }

  /**
   * Test Package — run the real validation against live data and report what
   * would actually happen, including the exact RADIUS attributes that would be
   * written. Read-only: changes nothing, touches no subscriber.
   */
  @Get(':id/test')
  testPackage(@Param('id') id: string, @Req() req: any): any {
    return this.packagesService.testPackage(+id, req.user);
  }

  /**
   * Apply the package's current config to subscribers (scopes: new / renewals
   * / existing). 'existing' rewrites live RADIUS profiles and is admin-gated;
   * sessions are only kicked when kick=true is explicitly sent.
   */
  @Post(':id/apply')
  applyToSubscribers(@Param('id') id: string, @Body() body: any, @Req() req: any): any {
    return this.packagesService.applyToSubscribers(+id, body, req.user);
  }

  @Post()
  create(@Body() body: any, @Req() req: any): any {
    return this.packagesService.create(body, req.user);
  }

  /**
   * Bulk import packages from a file (used by the Import dialog). Each row is
   * stamped with the caller's own account as owner — see importMany().
   */
  @Post('import')
  importMany(@Body() body: { rows: any[] }, @Req() req: any): any {
    return this.packagesService.importMany(body?.rows || [], req.user);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any): any {
    return this.packagesService.update(+id, body, req.user);
  }

  @Patch(':id/toggle')
  toggleStatus(@Param('id') id: string, @Req() req: any): any {
    return this.packagesService.toggleStatus(+id, req.user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any): any {
    return this.packagesService.remove(+id, req.user);
  }
}