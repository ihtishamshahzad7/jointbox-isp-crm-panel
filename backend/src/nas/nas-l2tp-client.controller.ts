import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { NasL2tpClientService } from './nas-l2tp-client.service';

/**
 * NAS management VPN (Uplinko server = L2TP/IPsec client → NAS public IP).
 * Same guards as the other NAS routes: JWT + the `nas.read` / `nas.write`
 * permission (GET = read, everything else = write); the service then enforces
 * tenant scope and NAS ownership.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('nas')
export class NasL2tpClientController {
  constructor(private readonly service: NasL2tpClientService) {}

  @Get(':id/l2tp-client')
  view(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.getView(id, req.user);
  }

  @Put(':id/l2tp-client')
  save(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
    @Req() req: any,
  ) {
    return this.service.save(id, req.user, body ?? {});
  }

  @Get(':id/l2tp-client/status')
  status(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.status(id, req.user);
  }

  @Post(':id/l2tp-client/nas/preview')
  previewNas(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.previewNas(id, req.user);
  }

  @Post(':id/l2tp-client/nas/apply')
  applyNas(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
    @Req() req: any,
  ) {
    return this.service.applyNas(id, req.user, {
      confirmServerChange: body?.confirmServerChange === true,
    });
  }

  @Post(':id/l2tp-client/nas/rollback')
  rollbackNas(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.rollbackNas(id, req.user);
  }

  @Post(':id/l2tp-client/nas/recover')
  recoverNas(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.recoverNas(id, req.user);
  }

  @Post(':id/l2tp-client/connect')
  connect(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.connect(id, req.user);
  }

  @Post(':id/l2tp-client/cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.cancel(id, req.user);
  }

  @Post(':id/l2tp-client/disconnect')
  disconnect(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.disconnect(id, req.user);
  }

  @Post(':id/l2tp-client/reconnect')
  reconnect(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.reconnect(id, req.user);
  }

  @Delete(':id/l2tp-client/host')
  purgeHost(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.purgeHost(id, req.user);
  }
}
