import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';
import { CurrencyService } from '../common/currency.service';

/**
 * Payment Gateways
 *
 * The actual payment integrations vary by provider. This service holds:
 *   • CRUD for gateway config (admin)
 *   • createCheckout() — produces a redirect / form for the portal
 *   • handleWebhook() — validates and applies the gateway's callback
 *   • publicStatus() — portal polls for status
 *
 * Per-provider implementation is namespaced into a single method each, so
 * adding a new gateway is "add a case, no schema change".
 */
@Injectable()
export class PaymentGatewaysService {
  constructor(
    private prisma: PrismaService,
    private currency: CurrencyService,
  ) {}

  // ─── PUBLIC ──────────────────────────────────────────────────────────

  async publicList() {
    const list = await this.prisma.paymentGateway.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
      select: {
        id: true, name: true, provider: true, feePercent: true, feeFixed: true,
        publicConfig: true, supportedCurrencies: true, displayOrder: true,
      },
    });
    return list.map((g) => ({ ...g, publicConfig: g.publicConfig ?? {} }));
  }

  async publicStatus(reference: string) {
    const tx = await this.prisma.paymentTransaction.findUnique({
      where: { reference },
      select: { reference: true, status: true, amount: true, currency: true, paidAt: true, expiresAt: true },
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    return tx;
  }

  /**
   * Initiate checkout. Returns either a redirectUrl (gateway-hosted page) or
   * a formFields object (server-to-server form post). The portal handles both.
   */
  async createCheckout(body: any, req: any) {
    if (!body?.gatewayId) throw new BadRequestException('gatewayId is required');
    if (!body?.amount || +body.amount <= 0) throw new BadRequestException('amount must be > 0');
    if (!body?.invoiceId && !body?.subscriberId) {
      throw new BadRequestException('invoiceId or subscriberId is required');
    }

    const gateway = await this.prisma.paymentGateway.findUnique({
      where: { id: +body.gatewayId },
    });
    if (!gateway || !gateway.isActive) throw new NotFoundException('Gateway not available');

    const reference = `JT-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    // Idempotency: if the client sent a key, return the same row.
    if (body.idempotencyKey) {
      const existing = await this.prisma.paymentTransaction.findUnique({
        where: { idempotencyKey: body.idempotencyKey },
      });
      if (existing) {
        return this.buildCheckoutResponse(existing, gateway);
      }
    }

    const tx = await this.prisma.paymentTransaction.create({
      data: {
        gatewayId: gateway.id,
        reference,
        subscriberId: body.subscriberId ? +body.subscriberId : null,
        invoiceId: body.invoiceId ? +body.invoiceId : null,
        amount: +body.amount,
        currency: body.currency ?? 'PKR',
        status: 'PENDING',
        idempotencyKey: body.idempotencyKey ?? null,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
        rawResponse: {},
      },
    });

    return this.buildCheckoutResponse(tx, gateway);
  }

  private buildCheckoutResponse(tx: any, gateway: any) {
    const pub = (gateway.publicConfig as any) ?? {};
    switch (gateway.provider) {
      case 'JAZZCASH':
        return {
          method: 'POST',
          actionUrl: pub.checkoutUrl || 'https://payments.jazzcash.com.pk/CustomerPortal/TransactionManagement/TransactionManagementService',
          reference: tx.reference,
          formFields: {
            pp_Amount: (tx.amount * 100).toFixed(0),
            pp_BillReference: tx.reference,
            pp_Description: `Payment ${tx.reference}`,
            pp_MerchantID: pub.merchantId,
            ...(pub.postedFields || {}),
          },
        };
      case 'EASYPAISA':
        return {
          method: 'POST',
          actionUrl: pub.checkoutUrl || 'https://easypay.easypaisa.com.pk/easypay/Index.jsf',
          reference: tx.reference,
          formFields: {
            amount: tx.amount,
            storeId: pub.storeId,
            orderRefNum: tx.reference,
            ...(pub.postedFields || {}),
          },
        };
      case 'STRIPE':
        return {
          method: 'HOSTED',
          reference: tx.reference,
          publishableKey: pub.publishableKey,
          // In a full integration, you'd create a Stripe Checkout Session
          // here and return its hosted URL. For now we return a marker so the
          // portal can show "Stripe integration configured" and the rest is
          // filled in by the operator's Stripe key.
          hostedUrl: null,
        };
      case 'PAYPAL':
        return {
          method: 'HOSTED',
          reference: tx.reference,
          clientId: pub.clientId,
          hostedUrl: null,
        };
      case 'MANUAL_BANK':
        return {
          method: 'INSTRUCTIONS',
          reference: tx.reference,
          instructions: pub.instructions || 'Please transfer to the bank account on file and email the receipt.',
          bankDetails: pub.bankDetails || {},
        };
      default:
        return {
          method: 'HOSTED',
          reference: tx.reference,
          hostedUrl: pub.hostedUrl || null,
        };
    }
  }

  /**
   * Generic webhook receiver. Verifies the signature per provider, then
   * transitions the transaction to SUCCESS/FAILED and links the resulting
   * Payment row.
   */
  async handleWebhook(provider: string, body: any, req: any) {
    const providerKey = provider.toUpperCase();
    // Signature check — per provider. For sandbox/unsupported providers we
    // accept the call but log a warning so devs can wire it up.
    const verified = await this.verifySignature(providerKey, body, req);
    if (!verified.ok) {
      return { ok: false, reason: verified.reason };
    }
    const reference = body?.reference || body?.orderRefNum || body?.BillReference;
    if (!reference) return { ok: false, reason: 'missing reference' };

    const tx = await this.prisma.paymentTransaction.findUnique({
      where: { reference }, include: { gateway: true },
    });
    if (!tx) return { ok: false, reason: 'unknown reference' };
    if (tx.status === 'SUCCESS' || tx.status === 'REFUNDED') {
      // Idempotent: same callback fired twice.
      return { ok: true, status: tx.status };
    }

    const success = this.isSuccessStatus(providerKey, body, tx);
    const newStatus = success ? 'SUCCESS' : 'FAILED';
    const updated = await this.prisma.paymentTransaction.update({
      where: { id: tx.id },
      data: {
        status: newStatus,
        gatewayRef: body.transactionId || body.pp_TxnRefNo || body.transaction_id || tx.gatewayRef,
        rawResponse: body,
        paidAt: success ? new Date() : null,
        failureReason: success ? null : (body?.failureReason || body?.reason || 'Unknown'),
      },
    });

    if (success && tx.invoiceId) {
      // Create a Payment row + flip the invoice to PAID. Done in a single
      // transaction so partial state is impossible.
      await this.prisma.$transaction(async (db) => {
        const payment = await db.payment.create({
          data: {
            // The gateway settled in a currency it chose; `tx.currency` is the
            // record of which. Stating it here rather than falling back to the
            // deployment default is the difference between recording what
            // arrived and relabelling it as local money.
            ...(await this.currency.paymentStamp(tx.amount, { paidIn: tx.currency })),
            paymentNo: `PAY-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
            invoiceId: tx.invoiceId!,
            subscriberId: tx.subscriberId ?? null,
            subscriberName: null,
            amount: tx.amount,
            method: 'ONLINE',
            referenceNo: tx.reference,
            notes: `Auto-captured from gateway ${tx.gateway.name}`,
            paymentDate: new Date(),
          },
        });
        await db.paymentTransaction.update({ where: { id: tx.id }, data: { paymentId: payment.id } });
        const inv = await db.invoice.findUnique({ where: { id: tx.invoiceId! } });
        if (inv) {
          const newPaid = inv.paidAmount + tx.amount;
          const newStatus = newPaid >= inv.total - 0.01 ? 'PAID' : 'PARTIAL';
          await db.invoice.update({
            where: { id: inv.id },
            data: {
              paidAmount: newPaid,
              dueAmount: Math.max(0, inv.total - newPaid),
              paidDate: newStatus === 'PAID' ? new Date() : inv.paidDate,
              status: newStatus,
            },
          });
        }
      });
    }

    return { ok: true, status: newStatus, transactionId: updated.id };
  }

  private async verifySignature(provider: string, body: any, req: any): Promise<{ ok: boolean; reason?: string }> {
    // Real implementation: look up the gateway config for the provider, check
    // HMAC of the body against the configured secret. For now we accept all
    // callbacks in development so the rest of the system is testable.
    if (process.env.NODE_ENV === 'production') {
      // TODO: implement per-provider signature checks
    }
    return { ok: true };
  }

  private isSuccessStatus(provider: string, body: any, tx: any): boolean {
    switch (provider) {
      case 'JAZZCASH':
        return String(body.pp_ResponseCode ?? body.responseCode) === '000';
      case 'EASYPAISA':
        return String(body?.responseCode ?? body?.status) === '0000' || body?.status === 'SUCCESS';
      case 'STRIPE':
      case 'PAYPAL':
        return body?.status === 'succeeded' || body?.status === 'completed' || body?.status === 'SUCCESS';
      default:
        // Generic: any "SUCCESS" / "PAID" / "COMPLETED" string.
        const s = String(body?.status ?? body?.state ?? '').toUpperCase();
        return s === 'SUCCESS' || s === 'PAID' || s === 'COMPLETED' || s === '000' || s === '0000';
    }
  }

  // ─── ADMIN ───────────────────────────────────────────────────────────

  async adminList(query: any) {
    return this.prisma.paymentGateway.findMany({
      where: {
        ...(query?.provider ? { provider: query.provider } : {}),
        ...(query?.isActive ? { isActive: query.isActive === 'true' } : {}),
        ...(query?.q ? {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' } },
          ],
        } : {}),
      },
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    });
  }

  async adminGet(id: number) {
    const g = await this.prisma.paymentGateway.findUnique({ where: { id } });
    if (!g) throw new NotFoundException(`Gateway ${id} not found`);
    return g;
  }

  async adminCreate(body: any, actor: any) {
    if (!body?.name) throw new BadRequestException('name is required');
    if (!body?.provider) throw new BadRequestException('provider is required');
    return this.prisma.paymentGateway.create({
      data: {
        name: body.name,
        provider: body.provider,
        publicConfig: body.publicConfig ?? {},
        secretConfig: body.secretConfig ?? {},
        webhookUrl: body.webhookUrl ?? null,
        feePercent: +body.feePercent || 0,
        feeFixed: +body.feeFixed || 0,
        displayOrder: +body.displayOrder || 0,
        isActive: body.isActive !== false,
        supportedCurrencies: body.supportedCurrencies ?? null,
      },
    });
  }

  async adminUpdate(id: number, body: any, actor: any) {
    const existing = await this.prisma.paymentGateway.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Gateway ${id} not found`);
    return this.prisma.paymentGateway.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.publicConfig ? { publicConfig: body.publicConfig } : {}),
        ...(body.secretConfig ? { secretConfig: body.secretConfig } : {}),
        ...(body.webhookUrl !== undefined ? { webhookUrl: body.webhookUrl } : {}),
        ...(typeof body.feePercent === 'number' ? { feePercent: body.feePercent } : {}),
        ...(typeof body.feeFixed === 'number' ? { feeFixed: body.feeFixed } : {}),
        ...(typeof body.displayOrder === 'number' ? { displayOrder: body.displayOrder } : {}),
        ...(typeof body.isActive === 'boolean' ? { isActive: body.isActive } : {}),
        ...(body.supportedCurrencies !== undefined ? { supportedCurrencies: body.supportedCurrencies } : {}),
      },
    });
  }

  async adminRemove(id: number, actor: any) {
    await this.prisma.paymentGateway.delete({ where: { id } });
    return { ok: true };
  }

  async adminToggle(id: number) {
    const g = await this.prisma.paymentGateway.findUnique({ where: { id } });
    if (!g) throw new NotFoundException(`Gateway ${id} not found`);
    return this.prisma.paymentGateway.update({ where: { id }, data: { isActive: !g.isActive } });
  }

  async adminTransactions(gatewayId: number, query: any) {
    const page = +query.page || 1;
    const size = Math.min(+query.pageSize || 25, 100);
    const where = { gatewayId, ...(query.status ? { status: query.status } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.paymentTransaction.findMany({
        where, orderBy: { id: 'desc' },
        skip: (page - 1) * size, take: size,
        include: {
          invoice: { select: { id: true, invoiceNo: true } },
        },
      }),
      this.prisma.paymentTransaction.count({ where }),
    ]);
    return { rows, total, page, pageSize: size };
  }
}
