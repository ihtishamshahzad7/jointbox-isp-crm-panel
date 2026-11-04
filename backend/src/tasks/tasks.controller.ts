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
import { PermissionsGuard } from '../security/permissions.guard';
import type { Actor } from '../common/scope.service';
import { TasksService } from './tasks.service';

@UseGuards(JwtAuthGuard, PermissionsGuard, ProductEntitlementGuard)
@RequireProductFeature('crm-advanced')
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get('options')
  options(@Req() req: { user: Actor }) {
    return this.tasks.options(req.user);
  }

  @Get('summary')
  summary(@Req() req: { user: Actor }) {
    return this.tasks.summary(req.user);
  }

  @Get()
  list(
    @Req() req: { user: Actor },
    @Query() query: Record<string, unknown>,
  ) {
    return this.tasks.list(req.user, query);
  }

  @Post()
  create(@Req() req: { user: Actor }, @Body() body: Record<string, unknown>) {
    return this.tasks.create(req.user, body);
  }

  @Get(':id')
  detail(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.tasks.detail(req.user, id);
  }

  @Patch(':id')
  update(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.tasks.update(req.user, id, body);
  }

  @Patch(':id/assignment')
  assign(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.tasks.assign(req.user, id, body);
  }

  @Patch(':id/status')
  changeStatus(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.tasks.changeStatus(req.user, id, body);
  }

  @Post(':id/comments')
  comment(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.tasks.comment(req.user, id, body);
  }
}
