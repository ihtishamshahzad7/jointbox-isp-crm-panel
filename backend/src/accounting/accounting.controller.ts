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

  /**
   * Per-account totals. Scoped to the caller's own business: the ledger is
   * one table for the whole installation, so an unscoped sum is every
   * company's books added together.
   */
  @Get('ledger/summary')
  getLedgerSummary(@Request() req: any) {
    return this.accounting.getLedgerSummary(req.user);
  }

  /** Trial balance — total debits vs credits + malformed-entry count. Scoped as above. */
  @Get('trial-balance')
  getTrialBalance(@Request() req: any) {
    return this.accounting.getTrialBalance(req.user);
  }

  /**
   * Accounting-period lock — the date through which the books are closed.
   * An installation singleton (see PUT below); reading the date is harmless.
   */
  @Get('period-lock')
  getPeriodLock(@Request() req: any) {
    return this.accounting.getPeriodLock();
  }

  /**
   * Close/reopen the books through a date — PLATFORM OWNER ONLY.
   *
   * This used to admit ADMIN, which was right when one company owned the
   * installation. AccountingLock is a singleton — `upsert({ where: { id: 1 } })`
   * — so with several ISP companies on one panel, one of them closing its
   * books froze posting for ALL of them, silently, with no indication to the
   * others of who did it or why their entries had started failing.
   *
   * Per-company period locks are the right feature and a different one: the
   * table needs an owner column and every posting path needs to resolve the
   * lock for the entry's own company. Until that exists this stays with the
   * operator who can see the whole installation, because a shared lock quietly
   * operated by one tenant is worse than one nobody can reach.
   */
  @Put('period-lock')
  setPeriodLock(@Body() body: { lockedThrough: string | null }, @Request() req: any) {
    if (req?.user?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Accounting periods are managed by the platform owner.');
    }
    return this.accounting.setPeriodLock(body?.lockedThrough ?? null, req.user?.sub);
  }

  // ── Cashflow ──────────────────────────────────────────────────
  @Get('cashflow')
  getCashflow(@Query() query: any, @Request() req: any) {
    return this.accounting.getCashflow(query, req.user);
  }

  // ── Expenses ──────────────────────────────────────────────────
  @Get('expenses')
  getExpenses(@Query() query: any, @Request() req: any) {
    return this.accounting.getExpenses(query, req.user);
  }

  @Post('expenses')
  createExpense(@Body() body: any, @Request() req: any) {
    return this.accounting.createExpense(body, req.user);
  }

  @Get('expense-requests')
  listExpenseRequests(@Query('status') status: string, @Request() req: any) {
    this.assertOwner(req);
    return this.accounting.listExpenseRequests(status || 'PENDING', req.user);
  }

  @Post('expense-requests/:id/approve')
  async approveExpense(@Param('id') id: string, @Request() req: any) {
    this.assertOwner(req);
    await this.accounting.assertExpenseInScope(req.user, +id);
    return this.accounting.approveExpense(+id, req.user?.sub);
  }

  @Post('expense-requests/:id/reject')
  async rejectExpense(@Param('id') id: string, @Request() req: any) {
    this.assertOwner(req);
    await this.accounting.assertExpenseInScope(req.user, +id);
    return this.accounting.rejectExpense(+id, req.user?.sub);
  }

  @Delete('expenses/:id')
  async deleteExpense(@Param('id') id: string, @Request() req: any) {
    await this.accounting.assertExpenseInScope(req.user, +id);
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
  async topUp(@Param('subscriberId') subscriberId: string, @Body() body: { amount: number; notes?: string }, @Request() req: any) {
    await this.accounting.assertSubscriberInScope(req.user, +subscriberId);
    return this.accounting.topUpBalance(+subscriberId, Number(body.amount), body.notes, req.user?.sub);
  }

  // ── Reversal / Refund ─────────────────────────────────────────
  @Post('invoices/:id/reverse')
  async reverseInvoice(@Param('id') id: string, @Body() body: { reason: string }, @Request() req: any) {
    await this.accounting.assertInvoiceInScope(req.user, +id);
    return this.accounting.reverseInvoice(+id, body.reason, req.user?.sub);
  }

  @Post('payments/:id/refund')
  async refundPayment(
    @Param('id') id: string,
    @Body() body: { reason: string; toBalance?: boolean; amount?: number },
    @Request() req: any,
  ) {
    await this.accounting.assertPaymentInScope(req.user, +id);
    return this.accounting.requestRefund(+id, body, req.user);
  }

  // ── Refund approval workflow ──────────────────────────────────
  private assertOwner(req: any) {
    if (req?.user?.role !== 'SUPER_ADMIN' && req?.user?.role !== 'ADMIN') {
      throw new ForbiddenException('Only the ISP owner can manage refund policy and approvals.');
    }
  }

  /** Installation singleton (approval thresholds) — reading it is harmless. */
  @Get('finance-settings')
  getFinanceSettings(@Request() req: any) {
    return this.accounting.getFinanceSettings();
  }

  @Put('finance-settings')
  setFinanceSettings(@Body() body: { refundApprovalThreshold?: number; expenseApprovalThreshold?: number }, @Request() req: any) {
    this.assertOwner(req);
    return this.accounting.setFinanceSettings(body || {}, req.user?.sub);
  }

  @Get('pending-approvals')
  getPendingApprovals(@Request() req: any) {
    if (req?.user?.role !== 'SUPER_ADMIN' && req?.user?.role !== 'ADMIN') return { refunds: 0, expenses: 0, total: 0 };
    return this.accounting.getPendingApprovals(req.user);
  }

  @Get('refund-requests')
  listRefundRequests(@Query('status') status: string, @Request() req: any) {
    this.assertOwner(req);
    return this.accounting.listRefundRequests(status || 'PENDING', req.user);
  }

  @Post('refund-requests/:id/approve')
  async approveRefundRequest(@Param('id') id: string, @Body() body: { note?: string }, @Request() req: any) {
    this.assertOwner(req);
    await this.accounting.assertRefundRequestInScope(req.user, +id);
    return this.accounting.approveRefundRequest(+id, req.user?.sub, body?.note);
  }

  @Post('refund-requests/:id/reject')
  async rejectRefundRequest(@Param('id') id: string, @Body() body: { note?: string }, @Request() req: any) {
    this.assertOwner(req);
    await this.accounting.assertRefundRequestInScope(req.user, +id);
    return this.accounting.rejectRefundRequest(+id, req.user?.sub, body?.note);
  }
}
