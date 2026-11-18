import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FeatureGuard, RequireFeature } from '../common/feature.guard';
import { CrmLedgerService } from './crm-ledger.service';
import { CrmInventoryService } from './crm-inventory.service';
import { CrmIssueService } from './crm-issue.service';
import { CrmTerminationService } from './crm-termination.service';
import { CrmTatService } from './crm-tat.service';
import { CrmStaffService } from './crm-staff.service';
import { CrmCostsService } from './crm-costs.service';
import { CrmReportsService } from './crm-reports.service';

/**
 * Advanced CRM (sold separately). Every route: signed in, company holds
 * `crm-advanced`, then the service checks the caller may read the underlying
 * screens and that the record is inside their account.
 */
@UseGuards(JwtAuthGuard, FeatureGuard)
@RequireFeature('crm-advanced')
@Controller('crm')
export class CrmController {
  constructor(
    private readonly ledger: CrmLedgerService,
    private readonly inventory: CrmInventoryService,
    private readonly issues: CrmIssueService,
    private readonly terminations: CrmTerminationService,
    private readonly tat: CrmTatService,
    private readonly staff: CrmStaffService,
    private readonly costs: CrmCostsService,
    private readonly reports: CrmReportsService,
  ) {}

  /** Dated account statement: ?from=YYYY-MM-DD&to=YYYY-MM-DD (both optional). */
  @Get('customers/:id/statement')
  statement(@Param('id') id: string, @Query() q: { from?: string; to?: string }, @Req() req: any) {
    return this.ledger.statement(req.user, Number(id), q);
  }

  /** The receipt for a payment — issued on first print, identical on every reprint. */
  @Get('receipts/:paymentId')
  receipt(@Param('paymentId') paymentId: string, @Req() req: any) {
    return this.ledger.receipt(req.user, Number(paymentId));
  }

  // ── warehouses, QR labels, transfers, stock counts ──

  @Get('inventory/warehouses')
  warehouses(@Req() req: any) {
    return this.inventory.listWarehouses(req.user);
  }

  @Post('inventory/warehouses')
  createWarehouse(@Body() body: any, @Req() req: any) {
    return this.inventory.createWarehouse(req.user, body);
  }

  @Patch('inventory/warehouses/:id')
  updateWarehouse(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.inventory.updateWarehouse(req.user, Number(id), body);
  }

  /** { itemIds: number[] } → each unit's QR code (issued once, never changed). */
  @Post('inventory/qr')
  issueQr(@Body() body: any, @Req() req: any) {
    return this.inventory.issueQr(req.user, body);
  }

  @Get('inventory/scan/:code')
  scan(@Param('code') code: string, @Req() req: any) {
    return this.inventory.scan(req.user, code);
  }

  /** { itemIds: number[], toWarehouseId: number, notes?: string } — all or nothing. */
  @Post('inventory/transfers')
  transfer(@Body() body: any, @Req() req: any) {
    return this.inventory.transfer(req.user, body);
  }

  @Post('inventory/stocktakes')
  openStocktake(@Body() body: any, @Req() req: any) {
    return this.inventory.openStocktake(req.user, body);
  }

  @Post('inventory/stocktakes/:id/scan')
  scanStocktake(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.inventory.scanIntoStocktake(req.user, Number(id), body);
  }

  @Post('inventory/stocktakes/:id/close')
  closeStocktake(@Param('id') id: string, @Req() req: any) {
    return this.inventory.closeStocktake(req.user, Number(id));
  }

  @Get('inventory/stocktakes/:id')
  stocktake(@Param('id') id: string, @Req() req: any) {
    return this.inventory.report(req.user, Number(id));
  }

  // ── equipment issued to customers, and recovery ──

  /** { itemId, subscriberId, charge?, notes?, requestKey: uuid } — issue a unit, optionally invoiced. */
  @Post('inventory/issues')
  issue(@Body() body: any, @Req() req: any) {
    return this.issues.issue(req.user, body);
  }

  /** Retry raising the invoice for a charged issue (never raises a second one). */
  @Post('inventory/issues/:id/bill')
  bill(@Param('id') id: string, @Req() req: any) {
    return this.issues.bill(req.user, Number(id));
  }

  /** { condition: IN_STOCK | FAULTY | LOST, warehouseId?, notes? } */
  @Post('inventory/issues/:id/recover')
  recover(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.issues.recover(req.user, Number(id), body);
  }

  @Get('customers/:id/equipment')
  equipment(@Param('id') id: string, @Req() req: any) {
    return this.issues.forSubscriber(req.user, Number(id));
  }

  /** Units still at customers whose service has ended — the recovery queue. */
  @Get('inventory/recoveries')
  recoveries(@Req() req: any) {
    return this.issues.recoveries(req.user);
  }

  // ── termination ──

  /** { reason, assignTo? } — Uplinko's own disconnect, plus audit and a recovery ticket if equipment is out. */
  @Post('customers/:id/terminate')
  terminate(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.terminations.terminate(req.user, Number(id), body);
  }

  @Get('terminations')
  terminationList(@Query() q: { status?: string }, @Req() req: any) {
    return this.terminations.list(req.user, q);
  }

  // ── ticket turnaround (TAT) ──

  @Get('tat')
  tatGrid(@Req() req: any) {
    return this.tat.grid(req.user);
  }

  /** { category, priority, responseMinutes, resolutionMinutes } — company owner only. */
  @Put('tat')
  tatSet(@Body() body: any, @Req() req: any) {
    return this.tat.set(req.user, body);
  }

  /** { category, priority } — back to the installation default. */
  @Delete('tat')
  tatReset(@Body() body: any, @Req() req: any) {
    return this.tat.reset(req.user, body);
  }

  /** { hours: 1–720 } — one open ticket's turnaround. */
  @Post('tickets/:id/tat')
  ticketTat(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.tat.setTicketTat(req.user, Number(id), body);
  }

  // ── staff: codes, designations, reporting lines, availability ──

  @Get('staff')
  staffList(@Req() req: any) {
    return this.staff.list(req.user);
  }

  @Get('staff/tree')
  staffTree(@Req() req: any) {
    return this.staff.tree(req.user);
  }

  /** { designationId?, department?, reportsToUserId?, availability? } — company owner only. */
  @Put('staff/:userId')
  staffSave(@Param('userId') userId: string, @Body() body: any, @Req() req: any) {
    return this.staff.save(req.user, Number(userId), body);
  }

  @Get('designations')
  designations(@Req() req: any) {
    return this.staff.designations(req.user);
  }

  @Post('designations')
  createDesignation(@Body() body: any, @Req() req: any) {
    return this.staff.createDesignation(req.user, body);
  }

  @Patch('designations/:id')
  updateDesignation(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.staff.updateDesignation(req.user, Number(id), body);
  }

  // ── cost to serve ──

  /** { subscriberId | null } — link an expense to the customer it was spent on. */
  @Put('expenses/:id/customer')
  linkExpense(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.costs.link(req.user, Number(id), body);
  }

  @Get('customers/:id/costs')
  customerCosts(@Param('id') id: string, @Req() req: any) {
    return this.costs.costs(req.user, Number(id));
  }

  // ── reports ──

  /** The report names (the caller's own reports; each still checks its permission when run). */
  @Get('reports')
  reportList(@Req() req: any) {
    return req.user ? this.reports.list() : [];
  }

  /** ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: this month, company time zone). */
  @Get('reports/:name')
  report(@Param('name') name: string, @Query() q: { from?: string; to?: string }, @Req() req: any) {
    return this.reports.run(req.user, name, q);
  }
}
