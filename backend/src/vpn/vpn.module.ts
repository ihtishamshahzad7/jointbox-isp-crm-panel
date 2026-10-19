import { Module } from '@nestjs/common';
import { VpnService } from './vpn.service';
import { VpnController } from './vpn.controller';
import { CommonModule } from '../common/common.module';

/**
 * Panel VPN servers (WireGuard / OpenVPN / L2TP-IPsec) for reaching remote
 * routers behind CGNAT. CommonModule provides ScopeService for the
 * platform-owner guard in the controller.
 */
@Module({
  imports: [CommonModule],
  controllers: [VpnController],
  providers: [VpnService],
  exports: [VpnService],
})
export class VpnModule {}
