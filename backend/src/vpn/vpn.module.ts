import { Module } from '@nestjs/common';
import { VpnService } from './vpn.service';
import { VpnController } from './vpn.controller';
import { CommonModule } from '../common/common.module';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * Panel VPN servers (WireGuard / OpenVPN / L2TP-IPsec) for reaching remote
 * routers behind CGNAT. CommonModule provides ScopeService for the
 * platform-owner guard; PrismaModule provides PrismaService, which the
 * route-level PermissionsGuard depends on — without it Nest cannot resolve the
 * guard and the whole backend fails to boot.
 */
@Module({
  imports: [CommonModule, PrismaModule],
  controllers: [VpnController],
  providers: [VpnService],
  exports: [VpnService],
})
export class VpnModule {}
