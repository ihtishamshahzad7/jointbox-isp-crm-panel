import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { HrAttendanceController } from './hr-attendance.controller';
import { HrAttendanceService } from './hr-attendance.service';
import { HrEmployeesController } from './hr-employees.controller';
import { HrEmployeesService } from './hr-employees.service';
import { HrLeaveController } from './hr-leave.controller';
import { HrLeaveService } from './hr-leave.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [
    HrEmployeesController,
    HrAttendanceController,
    HrLeaveController,
  ],
  providers: [HrEmployeesService, HrAttendanceService, HrLeaveService],
  exports: [HrEmployeesService, HrAttendanceService, HrLeaveService],
})
export class HrModule {}
