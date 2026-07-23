import { Body, Controller, Delete, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
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
    return this.accounting.createExpense(body, req.user?.sub);
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
    @Body() body: { reason: string; toBalance?: boolean },
    @Request() req: any,
  ) {
    return this.accounting.refundPayment(+id, body.reason, body.toBalance === true, req.user?.sub);
  }
}
