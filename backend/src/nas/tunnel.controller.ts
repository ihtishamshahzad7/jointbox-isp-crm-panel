import { Controller, Get, Post, Delete, Param, Req, UseGuards } from '@nestjs/common';
import { TunnelService } from './tunnel.service';
import { NasService } from './nas.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

/**
 * Management-tunnel endpoints.
 *
 * OWNER-ONLY, ENFORCED HERE. A tunnel is standing remote access into somebody
 * else's network, so it is gated harder than reading a router: every mutating
 * route calls NasService.assertNasOwner() first. Merely being able to SEE a
 * router — which includes routers shared down to a dealer — must not be enough
 * to re-key it, because rotating a tunnel invalidates the config the owner
 * installed and takes their router off the panel until they paste a new one.
 *
 * Kept in its own controller rather than bolted onto NasController because the
 * provisioning response contains a private key. A route that returns key
 * material should be somewhere a reviewer will look at it.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('nas')
export class TunnelController {
  constructor(
    private readonly tunnels: TunnelService,
    private readonly nas: NasService,
  ) {}

  /** Every tunnel the caller can see, for the network overview. */
  @Get('tunnels')
  async list(@Req() req: any) {
    const visible = await this.nas.findAll({}, req.user);
    return this.tunnels.listAll(visible.map((n: any) => n.id));
  }

  /**
   * Re-apply every stored peer to the kernel. Needed after a panel reboot,
   * because WireGuard keeps its peer list in memory only.
   */
  @Post('tunnels/reconcile')
  reconcile() {
    return this.tunnels.reconcile();
  }

  /** Pull fresh handshake/byte counters off the interface. */
  @Post('tunnels/refresh')
  refresh() {
    return this.tunnels.refreshStatus();
  }

  @Get(':id/tunnel')
  async status(@Param('id') id: string, @Req() req: any) {
    // Read uses the ordinary visibility rules — a dealer using a shared router
    // has a legitimate need to know whether its tunnel is up.
    await this.nas.findOne(+id, req.user);
    return this.tunnels.status(+id);
  }

  /**
   * Issue a tunnel and return the router config.
   *
   * The private key in this response is shown ONCE and never stored, so the
   * client must present it to the operator immediately — there is no second
   * chance to fetch it, by design.
   */
  @Post(':id/tunnel')
  async provision(@Param('id') id: string, @Req() req: any) {
    await this.nas.assertOwnerPublic(+id, req.user);
    return this.tunnels.provision(+id, { createdBy: req.user?.sub ?? null });
  }

  /** New keys, same overlay address. The old config stops working at once. */
  @Post(':id/tunnel/rotate')
  async rotate(@Param('id') id: string, @Req() req: any) {
    await this.nas.assertOwnerPublic(+id, req.user);
    return this.tunnels.provision(+id, { createdBy: req.user?.sub ?? null, rotate: true });
  }

  @Delete(':id/tunnel')
  async revoke(@Param('id') id: string, @Req() req: any) {
    await this.nas.assertOwnerPublic(+id, req.user);
    return this.tunnels.revoke(+id);
  }
}
