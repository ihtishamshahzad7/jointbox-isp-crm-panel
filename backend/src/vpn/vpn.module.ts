import { Module } from '@nestjs/common';
import { VpnService } from './vpn.service';

/**
 * VPN configuration validation used by the per-NAS subscriber VPN workflow.
 * VPN management routes live under each NAS, not as a panel-global server.
 */
@Module({
  providers: [VpnService],
  exports: [VpnService],
})
export class VpnModule {}
