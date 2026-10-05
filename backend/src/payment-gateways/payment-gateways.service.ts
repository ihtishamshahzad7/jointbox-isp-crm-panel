import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';
import { CurrencyService } from '../common/currency.service';
import { ScopeService } from '../common/scope.service';

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
    private scope: ScopeService,
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
    const providerKey = String(provider || '').toUpperCase();
    const reference =
      body?.reference || body?.orderRefNum || body?.BillReference || body?.pp_BillReference;
    if (!reference) return { ok: false, reason: 'missing reference' };

    const tx = await this.prisma.paymentTransaction.findUnique({
      where: { reference: String(reference) }, include: { gateway: true },
    });
    if (!tx) return { ok: false, reason: 'unknown reference' };

    /**
     * NOTHING CHANGES UNTIL THE CALLBACK IS PROVEN TO COME FROM THE GATEWAY.
     *
     * This endpoint is public, and `verifySignature` used to answer ok for
     * every request. Together with the public checkout that meant anyone could
     * create a PENDING transaction for any invoice and then post
     * `{reference, status: "SUCCESS"}` here — and the invoice was marked PAID,
     * with a Payment row, without a rupee changing hands.
     *
     * The transaction's OWN gateway decides how it is verified, never the
     * provider named in the URL, so a JazzCash payment cannot be "confirmed"
     * through a laxer path.
     */
    if (String(tx.gateway?.provider || '').toUpperCase() !== providerKey) {
      return { ok: false, reason: 'provider does not match this transaction' };
    }
    const verified = await this.verifySignature(providerKey, body, req, tx);
    if (!verified.ok) {
      return { ok: false, reason: verified.reason };
    }
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

  /**
   * Proves a callback came from the gateway. FAILS CLOSED: a provider with no
   * verification configured is refused, never waved through.
   *
   *   JAZZCASH  pp_SecureHash — HMAC-SHA256, keyed with the integrity salt,
   *             over the salt and every non-empty pp_ field in key order,
   *             joined with '&' (JazzCash's documented scheme). The signed
   *             pp_Amount must also equal the amount this transaction was
   *             opened for, in paisa.
   *   others    a shared `webhookSecret` in the gateway's secretConfig:
   *             X-Signature / X-Webhook-Signature = hex HMAC-SHA256 of the raw
   *             request body.
   *
   * Local testing only: PAYMENT_WEBHOOK_INSECURE=1 with NODE_ENV not
   * 'production' skips the check, loudly.
   */
  private async verifySignature(
    provider: string,
    body: any,
    req: any,
    tx: any,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (process.env.PAYMENT_WEBHOOK_INSECURE === '1' && process.env.NODE_ENV !== 'production') {
      console.warn(`⚠️  payment webhook for ${provider} accepted WITHOUT verification (PAYMENT_WEBHOOK_INSECURE=1)`);
      return { ok: true };
    }
    const secret = ((tx?.gateway?.secretConfig ?? {}) as Record<string, any>) || {};
    const equal = (a: string, b: string) => {
      const x = Buffer.from(String(a || '').toLowerCase());
      const y = Buffer.from(String(b || '').toLowerCase());
      return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
    };

    if (provider === 'JAZZCASH') {
      const salt = String(secret.integritySalt || secret.salt || '');
      if (!salt) return { ok: false, reason: 'JazzCash integrity salt is not configured' };
      const given = String(body?.pp_SecureHash || '');
      const keys = Object.keys(body || {})
        .filter((k) => /^pp_/i.test(k) && k !== 'pp_SecureHash')
        .filter((k) => body[k] !== '' && body[k] != null)
        .sort();
      const material = [salt, ...keys.map((k) => String(body[k]))].join('&');
      const expected = crypto.createHmac('sha256', salt).update(material).digest('hex');
      if (!equal(given, expected)) return { ok: false, reason: 'bad signature' };
      const paisa = Math.round(Number(tx?.amount || 0) * 100);
      if (body?.pp_Amount != null && Number(body.pp_Amount) !== paisa) {
        return { ok: false, reason: 'amount does not match the transaction' };
      }
      return { ok: true };
    }

    const whsec = String(secret.webhookSecret || '');
    if (!whsec) {
      return { ok: false, reason: `webhook verification is not configured for ${provider}` };
    }
    const raw: string = req?.rawBody ? req.rawBody.toString('utf8') : '';
    if (!raw) return { ok: false, reason: 'raw body unavailable' };
    const given = String(
      req?.headers?.['x-signature'] || req?.headers?.['x-webhook-signature'] || '',
    ).replace(/^sha256=/i, '');
    const expected = crypto.createHmac('sha256', whsec).update(raw).digest('hex');
    return equal(given, expected) ? { ok: true } : { ok: false, reason: 'bad signature' };
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
  //
  // PaymentGateway has no owner: one row (with its provider secretConfig)
  // collects money for EVERY company on the installation, and its transaction
  // log spans all of them. Every admin method is therefore platform-owner only
  // — reading exposes credentials and other companies' payments, and writing
  // could redirect every company's customer payments.

  /**
   * Provider secrets (webhook secrets, salts) never leave the server: list and
   * read show which secret keys are set, not their values. Updates replace a
   * key only when a new value is sent.
   */
  private static masked(g: any) {
    if (!g) return g;
    const secret = (g.secretConfig ?? {}) as Record<string, any>;
    const { secretConfig: _s, ...rest } = g;
    return { ...rest, secretKeysSet: Object.keys(secret).filter((k) => secret[k] != null && secret[k] !== '') };
  }

  async adminList(query: any, actor: any) {
    this.scope.assertPlatformOwner(actor);
    const rows = await this.prisma.paymentGateway.findMany({
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
    return rows.map((g) => PaymentGatewaysService.masked(g));
  }

  async adminGet(id: number, actor: any) {
    this.scope.assertPlatformOwner(actor);
    const g = await this.prisma.paymentGateway.findUnique({ where: { id } });
    if (!g) throw new NotFoundException(`Gateway ${id} not found`);
    return PaymentGatewaysService.masked(g);
  }

  async adminCreate(body: any, actor: any) {
    this.scope.assertPlatformOwner(actor);
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
    }).then((g) => PaymentGatewaysService.masked(g));
  }

  async adminUpdate(id: number, body: any, actor: any) {
    this.scope.assertPlatformOwner(actor);
    const existing = await this.prisma.paymentGateway.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Gateway ${id} not found`);
    // The form never receives current secret values, so it sends only the
    // keys being changed: merge them over what is stored.
    let secretConfig: any;
    if (body.secretConfig && typeof body.secretConfig === 'object') {
      secretConfig = { ...((existing.secretConfig ?? {}) as any) };
      for (const [k, v] of Object.entries(body.secretConfig)) {
        if (v === null) delete secretConfig[k];
        else if (v !== '' && v !== undefined) secretConfig[k] = v;
      }
    }
    const updated = await this.prisma.paymentGateway.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.publicConfig ? { publicConfig: body.publicConfig } : {}),
        ...(secretConfig ? { secretConfig } : {}),
        ...(body.webhookUrl !== undefined ? { webhookUrl: body.webhookUrl } : {}),
        ...(typeof body.feePercent === 'number' ? { feePercent: body.feePercent } : {}),
        ...(typeof body.feeFixed === 'number' ? { feeFixed: body.feeFixed } : {}),
        ...(typeof body.displayOrder === 'number' ? { displayOrder: body.displayOrder } : {}),
        ...(typeof body.isActive === 'boolean' ? { isActive: body.isActive } : {}),
        ...(body.supportedCurrencies !== undefined ? { supportedCurrencies: body.supportedCurrencies } : {}),
      },
    });
    return PaymentGatewaysService.masked(updated);
  }

  async adminRemove(id: number, actor: any) {
    this.scope.assertPlatformOwner(actor);
    await this.prisma.paymentGateway.delete({ where: { id } });
    return { ok: true };
  }

  async adminToggle(id: number, actor: any) {
    this.scope.assertPlatformOwner(actor);
    const g = await this.prisma.paymentGateway.findUnique({ where: { id } });
    if (!g) throw new NotFoundException(`Gateway ${id} not found`);
    return this.prisma.paymentGateway.update({ where: { id }, data: { isActive: !g.isActive } });
  }

  async adminTransactions(gatewayId: number, query: any, actor: any) {
    this.scope.assertPlatformOwner(actor);
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
