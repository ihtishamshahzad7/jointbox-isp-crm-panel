import {
  Body,
  Controller,
  Delete,
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
import { HrEmployeesService, type EmployeeInput } from './hr-employees.service';

@UseGuards(JwtAuthGuard, PermissionsGuard, ProductEntitlementGuard)
@RequireProductFeature('crm-advanced')
@Controller('hr/employees')
export class HrEmployeesController {
  constructor(private readonly employees: HrEmployeesService) {}

  @Get()
  findAll(
    @Req() req: { user: Actor },
    @Query() query: { search?: string; status?: string },
  ) {
    return this.employees.findAll(req.user, query);
  }

  @Post()
  create(@Req() req: { user: Actor }, @Body() body: EmployeeInput) {
    return this.employees.create(req.user, body);
  }

  @Patch(':id')
  update(
    @Req() req: { user: Actor },
    @Param('id', ParseIntPipe) id: number,
    @Body() body: EmployeeInput,
  ) {
    return this.employees.update(req.user, id, body);
  }

  @Delete(':id')
  remove(@Req() req: { user: Actor }, @Param('id', ParseIntPipe) id: number) {
    return this.employees.remove(req.user, id);
  }
}
