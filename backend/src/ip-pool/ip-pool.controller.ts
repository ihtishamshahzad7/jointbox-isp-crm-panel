import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { IpPoolService } from './ip-pool.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('ip-pools')
export class IpPoolController {
  constructor(private readonly ipPoolService: IpPoolService) {}

  // Compare the panel's pools against what the router actually has.
  // GET  = report only (safe).  POST = make the panel match the router.
  @Get('sync/check')
  checkPoolSync() {
    return this.ipPoolService.syncFromNas(false);
  }

  @Post('sync/apply')
  applyPoolSync() {
    return this.ipPoolService.syncFromNas(true);
  }

  // ── GET /ip-pools
  // Returns all pools with assigned packages and subscriber counts
  @Get()
  findAll(@Query() query: any, @Req() req: any) {
    return this.ipPoolService.findAll(query, req.user);
  }

  // ── GET /ip-pools/stats
  // Must be declared BEFORE :id route or Express will treat "stats" as an ID
  @Get('stats')
  getStats(@Query() query: any) {
    return this.ipPoolService.getStats();
  }

  /**
   * Does every pool actually exist on the router?
   *
   * Declared before ':id' so that route doesn't swallow it. A pool name that
   * doesn't match the MikroTik authenticates fine and then drops every
   * session, which is invisible until customers start calling.
   */
  @Get('verify')
  verify() {
    return this.ipPoolService.verifyAgainstRouters();
  }

  /**
   * Share this pool with a downstream account, or withdraw it.
   * Owner-only; the share is inherited by that account's whole subtree.
   */
  @Post(':id/share/:userId')
  share(@Param('id') id: string, @Param('userId') userId: string, @Body() body: { propagate?: boolean }, @Req() req: any) {
    return this.ipPoolService.setShare(+id, +userId, true, req.user, body?.propagate !== false);
  }

  @Delete(':id/share/:userId')
  unshare(@Param('id') id: string, @Param('userId') userId: string, @Req() req: any) {
    return this.ipPoolService.setShare(+id, +userId, false, req.user);
  }

  // ── GET /ip-pools/:id
  @Get(':id')
  findOne(@Param('id') id: string) {
    const numId = parseInt(id, 10);
    if (isNaN(numId)) throw new BadRequestException('Pool ID must be a number');
    return this.ipPoolService.findOne(numId);
  }

  // ── POST /ip-pools
  // Body: { name, network, subnet }
  // nasId is intentionally NOT accepted — NAS is not required for IP pools
  @Post('import')
  importMany(@Body() body: any, @Req() req: any) {
    return this.ipPoolService.importMany(body?.rows || [], req.user);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: any, @Req() req: any) {
    // Guard against missing fields early so the error message is clear
    if (!body.name?.trim()) {
      throw new BadRequestException('name is required');
    }
    if (!body.network?.trim()) {
      throw new BadRequestException('network is required (e.g. 192.168.10.0)');
    }
    if (!body.subnet) {
      throw new BadRequestException('subnet is required (e.g. 24)');
    }

    return this.ipPoolService.create({
      name:    body.name,
      network: body.network,
      subnet:  String(body.subnet),
    }, req.user);
  }

  // ── PUT /ip-pools/:id
  // All fields are optional — only send what you want to change
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    const numId = parseInt(id, 10);
    if (isNaN(numId)) throw new BadRequestException('Pool ID must be a number');

    // Build update payload with only the fields that were sent
    const updateData: { name?: string; network?: string; subnet?: string } = {};
    if (body.name    !== undefined) updateData.name    = body.name;
    if (body.network !== undefined) updateData.network = body.network;
    if (body.subnet  !== undefined) updateData.subnet  = String(body.subnet);
    // nasId is intentionally never updated

    return this.ipPoolService.update(numId, updateData);
  }

  // ── DELETE /ip-pools/:id
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    const numId = parseInt(id, 10);
    if (isNaN(numId)) throw new BadRequestException('Pool ID must be a number');
    return this.ipPoolService.remove(numId);
  }
}