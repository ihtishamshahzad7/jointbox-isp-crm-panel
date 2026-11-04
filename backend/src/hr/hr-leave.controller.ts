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
import {
  HrLeaveService,
  type LeaveListQuery,
  type LeaveRequestInput,
} from './hr-leave.service';

@UseGuards(JwtAuthGuard, PermissionsGuard, ProductEntitlementGuard)
@RequireProductFeature('crm-advanced')
@Controller('hr/leave')
export class HrLeaveController {
  constructor(private readonly leave: HrLeaveService) {}

  @Get('access')
  access(@Req() req: { user: Actor }) {
    return this.leave.access(req.user);
  }

  @Get('types')
  listTypes(@Req() req: { user: Actor }) {
    return this.leave.listTypes(req.user);
  }

  @Post('types')
  createType(
    @Req() req: { user: Actor },
    @Body()
    body: {
      name?: unknown;
      description?: unknown;
      isPaid?: unknown;
      annualAllocationDays?: unknown;
    },
  ) {
    return this.leave.createType(req.user, body);
  }

  @Patch('types/:leaveTypeId')
  updateType(
    @Req() req: { user: Actor },
    @Param('leaveTypeId', ParseIntPipe) leaveTypeId: number,
    @Body()
    body: {
      name?: unknown;
      description?: unknown;
      isPaid?: unknown;
      annualAllocationDays?: unknown;
      isActive?: unknown;
    },
  ) {
    return this.leave.updateType(req.user, leaveTypeId, body);
  }

  @Get('requests/mine')
  listMine(@Req() req: { user: Actor }, @Query() query: LeaveListQuery) {
    return this.leave.listMine(req.user, query);
  }

  @Get('requests')
  listRequests(@Req() req: { user: Actor }, @Query() query: LeaveListQuery) {
    return this.leave.listRequests(req.user, query);
  }

  @Post('requests')
  createRequest(@Req() req: { user: Actor }, @Body() body: LeaveRequestInput) {
    return this.leave.createRequest(req.user, body);
  }

  @Get('requests/:requestId/history')
  history(
    @Req() req: { user: Actor },
    @Param('requestId', ParseIntPipe) requestId: number,
  ) {
    return this.leave.requestHistory(req.user, requestId);
  }

  @Get('requests/:requestId')
  getRequest(
    @Req() req: { user: Actor },
    @Param('requestId', ParseIntPipe) requestId: number,
  ) {
    return this.leave.getRequest(req.user, requestId);
  }

  @Post('requests/:requestId/approve')
  approve(
    @Req() req: { user: Actor },
    @Param('requestId', ParseIntPipe) requestId: number,
    @Body() body: { comment?: unknown },
  ) {
    return this.leave.approve(req.user, requestId, body.comment);
  }

  @Post('requests/:requestId/reject')
  reject(
    @Req() req: { user: Actor },
    @Param('requestId', ParseIntPipe) requestId: number,
    @Body() body: { comment?: unknown },
  ) {
    return this.leave.reject(req.user, requestId, body.comment);
  }

  @Patch('requests/:requestId/cancel')
  cancel(
    @Req() req: { user: Actor },
    @Param('requestId', ParseIntPipe) requestId: number,
    @Body() body: { comment?: unknown },
  ) {
    return this.leave.cancel(req.user, requestId, body.comment);
  }

  @Get('balances')
  listBalances(@Req() req: { user: Actor }, @Query() query: LeaveListQuery) {
    return this.leave.listBalances(req.user, query);
  }

  @Post('balances/allocate')
  allocate(
    @Req() req: { user: Actor },
    @Body()
    body: {
      employeeId?: unknown;
      leaveTypeId?: unknown;
      year?: unknown;
      days?: unknown;
      reason?: unknown;
    },
  ) {
    return this.leave.allocateBalance(req.user, body);
  }

  @Patch('balances/:balanceId/adjust')
  adjust(
    @Req() req: { user: Actor },
    @Param('balanceId', ParseIntPipe) balanceId: number,
    @Body() body: { days?: unknown; reason?: unknown },
  ) {
    return this.leave.adjustBalance(req.user, balanceId, body);
  }
}
