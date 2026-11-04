import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  ProductEntitlementGuard,
  RequireProductFeature,
} from '../common/product-entitlement.guard';
import type { Actor } from '../common/scope.service';
import { PermissionsGuard } from '../security/permissions.guard';
import { CrmLeadsService } from './crm-leads.service';

@UseGuards(JwtAuthGuard, PermissionsGuard, ProductEntitlementGuard)
@RequireProductFeature('crm-advanced')
@Controller('crm/leads')
export class CrmLeadsController {
  constructor(private readonly leads: CrmLeadsService) {}

  @Get('options')
  options(@Req() req: { user: Actor }) {
    return this.leads.options(req.user);
  }

  @Get('pipeline')
  pipeline(
    @Req() req: { user: Actor },
    @Query() query: Record<string, unknown>,
  ) {
    return this.leads.pipeline(req.user, query);
  }

  @Get()
  list(
    @Req() req: { user: Actor },
    @Query() query: Record<string, unknown>,
  ) {
    return this.leads.list(req.user, query);
  }

  @Post()
  create(@Req() req: { user: Actor }, @Body() body: Record<string, unknown>) {
    return this.leads.create(req.user, body);
  }

  @Get(':id/conversion-candidates')
  conversionCandidates(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.leads.conversionCandidates(req.user, id);
  }

  @Post(':id/convert')
  convert(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.leads.convert(req.user, id, body);
  }

  @Post(':id/activities')
  addActivity(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.leads.addActivity(req.user, id, body);
  }

  @Patch(':id/assignment')
  assign(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.leads.assign(req.user, id, body);
  }

  @Patch(':id/stage')
  changeStage(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.leads.changeStage(req.user, id, body);
  }

  @Post(':id/archive')
  archive(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.leads.archive(req.user, id, true);
  }

  @Post(':id/restore')
  restore(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.leads.archive(req.user, id, false);
  }

  @Get(':id')
  detail(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.leads.detail(req.user, id);
  }

  @Patch(':id')
  update(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.leads.update(req.user, id, body);
  }
}
