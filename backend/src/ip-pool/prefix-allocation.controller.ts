import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { PrefixAllocationService } from './prefix-allocation.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

/**
 * Routed prefix allocation — the corporate/P2P client register.
 *
 * Separate prefix from /ip-pools deliberately: that module owns PPPoE address
 * pools, this one owns delegated blocks, VLANs and transit links. Merging them
 * would put two different address-management models behind one noun.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('prefixes')
export class PrefixAllocationController {
  constructor(private readonly svc: PrefixAllocationService) {}

  /** Pools with live utilisation (blocks used / free), computed not cached. */
  @Get('pools')
  pools(@Req() req: any) { return this.svc.listPools(req.user); }

  @Post('pools')
  createPool(@Body() body: any, @Req() req: any) { return this.svc.createPool(body, req.user); }

  /**
   * "What is the next free /29?" — the question this module exists to answer.
   * Read-only: it reserves nothing, so it is safe to call while planning.
   */
  @Get('pools/:id/next-free')
  nextFree(@Param('id') id: string, @Query('size') size?: string) {
    return this.svc.nextFree(+id, size ? Number(size) : undefined);
  }

  /** The register. Defaults to hiding RELEASED rows. */
  @Get()
  list(@Query() query: any) { return this.svc.list(query); }

  /** One allocation, with its generated router config and handover sheet. */
  @Get(':id')
  getOne(@Param('id') id: string) { return this.svc.getOne(+id); }

  /**
   * Provision a client: allocate the block AND the transit /30, write the
   * record, and return the configuration to paste onto the router — in one
   * call, so a half-provisioned client cannot hold unaccounted address space.
   */
  @Post('provision')
  provision(@Body() body: any, @Req() req: any) { return this.svc.provision(body, req.user); }

  /** Return space to the pool. Keeps the history for abuse reports. */
  @Delete(':id')
  release(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: any) {
    return this.svc.release(+id, body?.reason || '', req.user);
  }
}
