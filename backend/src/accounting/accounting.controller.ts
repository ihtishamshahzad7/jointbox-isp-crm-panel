import { Body, Controller, Delete, Get, Param, Post, Put, Query, Request, UseGuards, ForbiddenException } from '@nestjs/common';
import { AccountingService } from './accounting.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('accounting')
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}

  // ── Ledger ────────────────────────────────────────────────────
  @Get('ledger')
  getLedger(@Query() query: any, @Request() req: any) {
    return this.accounting.getLedger(query, req.user);
  }

  @Get('ledger/summary')
  getLedgerSummary() {
    return this.accounting.getLedgerSummary();
  }

  /** Trial balance — total debits vs credits + malformed-entry count. */
  @Get('trial-balance')
  getTrialBalance() {
    return this.accounting.getTrialBalance();
  }

  /** Accounting-period lock — the date through which the books are closed. */
  @Get('period-lock')
  getPeriodLock() {
    return this.accounting.getPeriodLock();
  }

  /** Close/reopen the books through a date. ISP owner only. */
  @Put('period-lock')
  setPeriodLock(@Body() body: { lockedThrough: string | null }, @Request() req: any) {
    if (req?.user?.role !== 'SUPER_ADMIN' && req?.user?.role !== 'ADMIN') {
      throw new ForbiddenException('Only the ISP owner can close or reopen an accounting period.');
    }
    return this.accounting.setPeriodLock(body?.lockedThrough ?? null, req.user?.sub);
  }

  // ── Cashflow ──────────────────────────────────────────────────
  @Get('cashflow')
  getCashflow(@Query() query: any) {
    return this.accounting.getCashflow(query);
  }

  // ── Expenses ──────────────────────────────────────────────────
  @Get('expenses')
  getExpenses(@Query() query: any) {
    return this.accounting.getExpenses(query);
  }

  @Post('expenses')
  createExpense(@Body() body: any, @Request() req: any) {
    return this.accounting.createExpense(body, req.user);
  }

  @Get('expense-requests')
  listExpenseRequests(@Query('status') status: string, @Request() req: any) {
    this.assertOwner(req);
    return this.accounting.listExpenseRequests(status || 'PENDING');
  }

  @Post('expense-requests/:id/approve')
  approveExpense(@Param('id') id: string, @Request() req: any) {
    this.assertOwner(req);
    return this.accounting.approveExpense(+id, req.user?.sub);
  }

  @Post('expense-requests/:id/reject')
  rejectExpense(@Param('id') id: string, @Request() req: any) {
    this.assertOwner(req);
    return this.accounting.rejectExpense(+id, req.user?.sub);
  }

  @Delete('expenses/:id')
  deleteExpense(@Param('id') id: string, @Request() req: any) {
    return this.accounting.deleteExpense(+id, req.user?.sub);
  }

  // ── Balances (subscriber wallets) ─────────────────────────────
  @Get('balances')
  getBalances(@Query() query: any, @Request() req: any) {
    return this.accounting.getBalances(query, req.user);
  }

  @Get('balances/:subscriberId/history')
  getBalanceHistory(@Param('subscriberId') subscriberId: string, @Request() req: any) {
    return this.accounting.getBalanceHistory(+subscriberId, req.user);
  }

  @Post('balances/:subscriberId/topup')
  topUp(@Param('subscriberId') subscriberId: string, @Body() body: { amount: number; notes?: string }, @Request() req: any) {
    return this.accounting.topUpBalance(+subscriberId, Number(body.amount), body.notes, req.user?.sub);
  }

  // ── Reversal / Refund ─────────────────────────────────────────
  @Post('invoices/:id/reverse')
  reverseInvoice(@Param('id') id: string, @Body() body: { reason: string }, @Request() req: any) {
    return this.accounting.reverseInvoice(+id, body.reason, req.user?.sub);
  }

  @Post('payments/:id/refund')
  refundPayment(
    @Param('id') id: string,
    @Body() body: { reason: string; toBalance?: boolean; amount?: number },
    @Request() req: any,
  ) {
    return this.accounting.requestRefund(+id, body, req.user);
  }

  // ── Refund approval workflow ──────────────────────────────────
  private assertOwner(req: any) {
    if (req?.user?.role !== 'SUPER_ADMIN' && req?.user?.role !== 'ADMIN') {
      throw new ForbiddenException('Only the ISP owner can manage refund policy and approvals.');
    }
  }

  @Get('finance-settings')
  getFinanceSettings() {
    return this.accounting.getFinanceSettings();
  }

  @Put('finance-settings')
  setFinanceSettings(@Body() body: { refundApprovalThreshold?: number; expenseApprovalThreshold?: number }, @Request() req: any) {
    this.assertOwner(req);
    return this.accounting.setFinanceSettings(body || {}, req.user?.sub);
  }

  @Get('refund-requests')
  listRefundRequests(@Query('status') status: string, @Request() req: any) {
    this.assertOwner(req);
    return this.accounting.listRefundRequests(status || 'PENDING');
  }

  @Post('refund-requests/:id/approve')
  approveRefundRequest(@Param('id') id: string, @Body() body: { note?: string }, @Request() req: any) {
    this.assertOwner(req);
    return this.accounting.approveRefundRequest(+id, req.user?.sub, body?.note);
  }

  @Post('refund-requests/:id/reject')
  rejectRefundRequest(@Param('id') id: string, @Body() body: { note?: string }, @Request() req: any) {
    this.assertOwner(req);
    return this.accounting.rejectRefundRequest(+id, req.user?.sub, body?.note);
  }
}
