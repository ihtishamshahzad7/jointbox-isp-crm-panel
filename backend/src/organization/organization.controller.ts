import { Body, Controller, Delete, Get, Param, Post, Put, Query, Request, UseGuards } from '@nestjs/common';
import { OrganizationService } from './organization.service';
import { ResellerPricingService } from './reseller-pricing.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { ScopeService } from '../common/scope.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('organization')
export class OrganizationController {
  constructor(
    private readonly org: OrganizationService,
    private readonly pricing: ResellerPricingService,
    private readonly scope: ScopeService,
  ) {}

  // ── Per-tier package pricing (wholesale ladder) ───────────────
  @Get('pricing')
  listPricing(@Query('packageId') packageId: string | undefined, @Request() req: any) {
    return this.pricing.listPrices(req.user, packageId ? +packageId : undefined);
  }
  @Put('pricing')
  setPricing(@Body() body: { userId?: number; packageId: number; price: number }, @Request() req: any) {
    return this.pricing.setPrice(req.user, body);
  }
  @Delete('pricing/:userId/:packageId')
  removePricing(@Param('userId') userId: string, @Param('packageId') packageId: string, @Request() req: any) {
    return this.pricing.removePrice(req.user, +userId, +packageId);
  }
  @Get('pricing/quote/:subscriberId')
  quotePricing(@Param('subscriberId') subscriberId: string, @Request() req: any) {
    // Scoped: upstream tiers and the ISP's base cost are hidden from resellers.
    return this.pricing.quoteFor(req.user, +subscriberId);
  }
  // Simple accounting: earnings per layer (scoped) + per-subscriber breakdown
  @Get('profit/summary')
  profitSummary(@Request() req: any) {
    return this.pricing.profitSummary(req.user);
  }
  /** This account's own books — sales, costs and what is actually left. */
  @Get('profit/mine')
  myBooks(@Request() req: any) {
    return this.pricing.myBooks(req.user);
  }

  @Get('profit/subscriber/:subscriberId')
  profitBySubscriber(@Param('subscriberId') subscriberId: string, @Request() req: any) {
    return this.pricing.profitBySubscriber(req.user, +subscriberId);
  }
  /**
   * Manually re-run the wallet cascade for one subscriber.
   *
   * Was wide open: no scope check and no ownership check, so ANY logged-in
   * account could settle ANY subscriber by guessing an id. Since the cascade
   * debits the activator and credits every tier above them, a franchise could
   * repeatedly settle one of its dealers' subscribers to drain that dealer's
   * wallet straight into its own. Now scope-checked, and `enforce` can no
   * longer be switched off by the caller — only ISP-level accounts may
   * overdraw an account deliberately.
   */
  @Post('pricing/settle/:subscriberId')
  async settlePricing(
    @Param('subscriberId') subscriberId: string,
    @Body() body: { enforce?: boolean; event?: string },
    @Request() req: any,
  ) {
    await this.scope.assertSubscriber(req.user, +subscriberId);
    const isAdmin = this.scope.isAdmin(req.user?.role);
    return this.pricing.settleActivation(+subscriberId, {
      // Only an ISP may deliberately allow an overdraft.
      enforce: isAdmin ? body?.enforce !== false : true,
      byUserId: req.user?.sub,
      event: body?.event,
    });
  }

  /** Consolidated reversals across the caller's dealer tree (Disputes module). */
  @Get('pricing/reversals')
  listReversals(@Request() req: any) {
    return this.pricing.listReversals(req.user);
  }

  @Post('pricing/reverse/:subscriberId')
  async reversePricing(
    @Param('subscriberId') subscriberId: string,
    @Body() body: { reference?: string; reason?: string; reasonCode?: string; revertService?: boolean },
    @Request() req: any,
  ) {
    await this.scope.assertSubscriber(req.user, +subscriberId);
    return this.pricing.reverseActivation(+subscriberId, {
      reference: body?.reference,
      reason: body?.reason,
      reasonCode: body?.reasonCode,   // DUPLICATE | DEALER_ERROR | SYSTEM_BUG | CUSTOMER_DISPUTE | CANCELLED
      revertService: body?.revertService,
      actorId: req.user?.sub,
    });
  }

  // ── ISPs ──────────────────────────────────────────────────────
  @Get('isps')
  isps() {
    return this.org.getIsps();
  }
  @Post('isps')
  createIsp(@Body() body: any) {
    return this.org.createIsp(body);
  }
  @Put('isps/:id')
  updateIsp(@Param('id') id: string, @Body() body: any) {
    return this.org.updateIsp(+id, body);
  }
  @Delete('isps/:id')
  deleteIsp(@Param('id') id: string) {
    return this.org.deleteIsp(+id);
  }

  // ── Branches ──────────────────────────────────────────────────
  @Get('branches')
  branches(@Query('ispId') ispId?: string) {
    return this.org.getBranches(ispId ? +ispId : undefined);
  }
  @Post('branches')
  createBranch(@Body() body: any) {
    return this.org.createBranch(body);
  }
  @Put('branches/:id')
  updateBranch(@Param('id') id: string, @Body() body: any) {
    return this.org.updateBranch(+id, body);
  }
  @Delete('branches/:id')
  deleteBranch(@Param('id') id: string) {
    return this.org.deleteBranch(+id);
  }
  @Post('branches/:id/assign')
  assign(@Param('id') id: string, @Body() body: { subscriberIds?: number[]; userIds?: number[] }) {
    return this.org.assign(+id, body);
  }

  // ── Resellers ─────────────────────────────────────────────────
  @Get('resellers')
  resellers(@Request() req: any) {
    return this.org.resellerTree(req.user);
  }
  /** Display currency for this deployment (PKR / INR / BDT / USD …). */
  @Put('isps/:id/currency')
  setCurrency(
    @Param('id') id: string,
    @Body() body: { currency: string; currencySymbol?: string },
    @Request() req: any,
  ) {
    return this.org.setCurrency(req.user, +id, body.currency, body.currencySymbol || body.currency);
  }

  /** Buy price, sell price and margin for every tier on one package. */
  @Get('pricing/ladder/:packageId')
  priceLadder(@Param('packageId') packageId: string, @Request() req: any) {
    return this.pricing.priceLadder(req.user, +packageId);
  }

  /** Delegate (or revoke) a child's right to price for its own downline. */
  @Put('resellers/:id/price-permission')
  pricePermission(
    @Param('id') id: string,
    @Body() body: { allowed: boolean },
    @Request() req: any,
  ) {
    return this.org.setPricePermission(req.user, +id, !!body.allowed);
  }

  /** Assign several packages to several resellers at once, with prices. */
  @Post('pricing/assign-bulk')
  assignPricingBulk(
    @Body() body: { packageIds: number[]; userIds: number[]; price?: number; prices?: Record<string, number> },
    @Request() req: any,
  ) {
    return this.pricing.assignBulk(req.user, body);
  }

  /**
   * Set MY OWN retail price — what my end subscribers pay.
   * No :id, deliberately: this only ever applies to the caller. Nobody sets
   * anybody else's customer-facing price.
   */
  @Put('pricing/retail')
  setRetail(@Body() body: { packageId: number; retailPrice: number }, @Request() req: any) {
    return this.pricing.setRetailPrice(req.user, Number(body.packageId), Number(body.retailPrice));
  }

  @Put('resellers/:id/commission')
  commission(@Param('id') id: string, @Body() body: { percent: number }, @Request() req: any) {
    // Pass the actor so the service can enforce subtree scope and block self-edit.
    return this.org.setCommission(+id, Number(body.percent), req.user);
  }
  @Put('resellers/:id/topup-permission')
  topupPermission(@Param('id') id: string, @Body() body: { allowed: boolean }, @Request() req: any) {
    return this.org.setTopupPermission(req.user, +id, !!body.allowed);
  }
  /** Set a dealer's credit limit (permitted overdraft). Parent/ISP only. */
  @Put('resellers/:id/credit-limit')
  creditLimit(@Param('id') id: string, @Body() body: { limit: number }, @Request() req: any) {
    return this.org.setCreditLimit(req.user, +id, Number(body?.limit));
  }
  @Put('resellers/:id/nas-permission')
  nasPermission(@Param('id') id: string, @Body() body: { allowed: boolean }, @Request() req: any) {
    return this.org.setNasPermission(req.user, +id, !!body.allowed);
  }

  @Get('resellers/:id/wallet')
  wallet(@Param('id') id: string, @Request() req: any) {
    // Scoped: reading someone else's ledger exposes their whole trading position.
    return this.org.walletHistory(+id, req.user);
  }
  @Post('resellers/:id/wallet')
  walletAdjust(
    @Param('id') id: string,
    @Body() body: { amount: number; type: 'TOPUP' | 'WITHDRAWAL'; notes?: string },
    @Request() req: any,
  ) {
    // TOPUP = prepaid transfer from the logged-in giver's wallet (scope-enforced).
    // WITHDRAWAL = pull balance back out of a downline account.
    if ((body.type || 'TOPUP') === 'TOPUP') {
      return this.org.walletTopupScoped(req.user, +id, Number(body.amount), body.notes);
    }
    // WITHDRAWAL was calling the unscoped walletAdjust(), which let any account
    // drain any other account by id. Same guards as top-up now apply.
    return this.org.walletWithdrawScoped(req.user, +id, Number(body.amount), body.notes);
  }

  // ── FRANCHISE GROUP PRICING (ISP → multiple franchises, different prices) ──

  @Get('franchise-pricing/:packageId')
  franchisePricing(@Param('packageId') packageId: string, @Request() req: any) {
    return this.org.listFranchisePricing(req.user, +packageId);
  }

  @Put('franchise-pricing')
  setFranchisePricing(@Body() body: { userId: number; packageId: number; price: number }, @Request() req: any) {
    return this.org.setFranchisePricing(req.user, body);
  }

  @Delete('franchise-pricing/:userId/:packageId')
  removeFranchisePricing(@Param('userId') userId: string, @Param('packageId') packageId: string, @Request() req: any) {
    return this.org.removeFranchisePricing(req.user, +userId, +packageId);
  }
}
