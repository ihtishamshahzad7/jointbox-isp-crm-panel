import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { NetworkService } from './network.service';
import { CoaService } from './coa.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('network')
export class NetworkController {
  constructor(private readonly network: NetworkService, private readonly coa: CoaService) {}

  @Get('live')
  live(@Query('nasIp') nasIp?: string) {
    return this.network.liveSessions(nasIp);
  }

  @Get('live/stats')
  liveStats() {
    return this.network.liveStats();
  }

  @Post('disconnect/:username')
  disconnect(@Param('username') username: string) {
    return this.network.disconnect(username);
  }

  /** Live bandwidth change via RADIUS CoA (vendor-agnostic). */
  @Post('bandwidth/:subscriberId')
  changeBandwidth(
    @Param('subscriberId') subscriberId: string,
    @Body() body: { downloadSpeed: number; uploadSpeed: number },
  ) {
    return this.coa.changeBandwidth(+subscriberId, Number(body.downloadSpeed), Number(body.uploadSpeed));
  }

  /** Probe whether a NAS accepts RADIUS CoA (harmless, changes nothing). */
  @Get('nas/:id/test-coa')
  testCoa(@Param('id') id: string) {
    return this.coa.testCoa(+id);
  }

  // ── MAC binding ───────────────────────────────────────────────
  @Get('mac/:username')
  getMac(@Param('username') username: string) {
    return this.network.getMacBinding(username);
  }

  @Post('mac/:username')
  bindMac(@Param('username') username: string, @Body() body: { mac: string }) {
    return this.network.bindMac(username, body.mac);
  }

  @Post('mac/:username/autolearn')
  autolearn(@Param('username') username: string) {
    return this.network.autolearnMac(username);
  }

  @Delete('mac/:username')
  unbindMac(@Param('username') username: string, @Query('mac') mac?: string) {
    return this.network.unbindMac(username, mac);
  }
}
