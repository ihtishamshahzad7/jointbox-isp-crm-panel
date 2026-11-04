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
  HrAttendanceService,
  type AttendanceCorrectionInput,
  type AttendanceListQuery,
} from './hr-attendance.service';

@UseGuards(JwtAuthGuard, PermissionsGuard, ProductEntitlementGuard)
@RequireProductFeature('crm-advanced')
@Controller('hr/attendance')
export class HrAttendanceController {
  constructor(private readonly attendance: HrAttendanceService) {}

  @Get()
  findAll(@Req() req: { user: Actor }, @Query() query: AttendanceListQuery) {
    return this.attendance.findAll(req.user, query);
  }

  @Get('employees/:employeeId')
  employeeHistory(
    @Req() req: { user: Actor },
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Query() query: AttendanceListQuery,
  ) {
    return this.attendance.employeeHistory(req.user, employeeId, query);
  }

  @Get(':attendanceId/history')
  correctionHistory(
    @Req() req: { user: Actor },
    @Param('attendanceId', ParseIntPipe) attendanceId: number,
    @Query() query: Pick<AttendanceListQuery, 'page' | 'pageSize'>,
  ) {
    return this.attendance.correctionHistory(req.user, attendanceId, query);
  }

  @Post('employees/:employeeId/check-in')
  checkIn(
    @Req() req: { user: Actor },
    @Param('employeeId', ParseIntPipe) employeeId: number,
  ) {
    return this.attendance.checkIn(req.user, employeeId);
  }

  @Post('employees/:employeeId/check-out')
  checkOut(
    @Req() req: { user: Actor },
    @Param('employeeId', ParseIntPipe) employeeId: number,
  ) {
    return this.attendance.checkOut(req.user, employeeId);
  }

  @Patch(':attendanceId/correction')
  correct(
    @Req() req: { user: Actor },
    @Param('attendanceId', ParseIntPipe) attendanceId: number,
    @Body() body: AttendanceCorrectionInput,
  ) {
    return this.attendance.correct(req.user, attendanceId, body);
  }
}
