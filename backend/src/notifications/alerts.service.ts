import { Injectable, Logger } from '@nestjs/common';
import { SecretsService } from '../common/secrets.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * AlertsService — operational alerts to Discord and WhatsApp.
 *
 * DISCORD (free, no account/API key needed beyond the webhook):
 *   In Discord: Server Settings → Integrations → Webhooks → New Webhook →
 *   pick a channel → Copy Webhook URL. Put it in .env:
 *     DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/XXX/YYY
 *   This is the same mechanism Uptime Kuma uses for its Discord notifications.
 *
 * WHATSAPP (choose one, both optional):
 *   • CallMeBot (free, personal use):
 *       WHATSAPP_PROVIDER=callmebot
 *       WHATSAPP_PHONE=923001234567
 *       WHATSAPP_APIKEY=123456          (from CallMeBot's activation message)
 *   • Meta WhatsApp Cloud API (business):
 *       WHATSAPP_PROVIDER=meta
 *       WHATSAPP_PHONE=923001234567     (recipient)
 *       WHATSAPP_TOKEN=EAAG...          (permanent token)
 *       WHATSAPP_PHONE_ID=123456789     (sender phone-number id)
 *
 * Every send is best-effort: a failing webhook must never break the job that
 * raised the alert, so errors are logged and swallowed.
 */
@Injectable()
export class AlertsService {
  private readonly log = new Logger('Alerts');

  constructor(private secrets: SecretsService, private prisma: PrismaService) {}

  /** Keys managed from the panel (each falls back to its env var). */
  static readonly KEYS = [
    { key: 'DISCORD_WEBHOOK_URL', env: 'DISCORD_WEBHOOK_URL' },
    { key: 'WHATSAPP_PROVIDER', env: 'WHATSAPP_PROVIDER' },
    { key: 'WHATSAPP_PHONE', env: 'WHATSAPP_PHONE' },
    { key: 'WHATSAPP_APIKEY', env: 'WHATSAPP_APIKEY' },
    { key: 'WHATSAPP_TOKEN', env: 'WHATSAPP_TOKEN' },
    { key: 'WHATSAPP_PHONE_ID', env: 'WHATSAPP_PHONE_ID' },
  ];

  /** Colour per severity for the Discord embed stripe. */
  private colour(level: string) {
    switch ((level || '').toUpperCase()) {
      case 'CRITICAL':
      case 'ERROR': return 0xef4444; // red
      case 'WARN':  return 0xf59e0b; // amber
      case 'OK':
      case 'RESOLVED': return 0x22c55e; // green
      default: return 0x4a9eff; // blue
    }
  }

  /**
   * Fire an operational alert to every configured channel.
   * Returns which channels accepted it, so callers can log delivery.
   */
  async send(opts: { title: string; message: string; level?: string; fields?: Record<string, string> }) {
    const results: Record<string, boolean> = {};
    results.discord = await this.toDiscord(opts).catch(() => false);
    results.whatsapp = await this.toWhatsApp(opts).catch(() => false);
    return results;
  }

  // ══════════════════════════════════════════════════════════════════
  //  PER-ACCOUNT CHANNELS — every user can route alerts about their own
  //  network to their own Discord/WhatsApp, independent of the ISP owner's.
  // ══════════════════════════════════════════════════════════════════

  /** Save (or clear, when value is blank) this user's own alert channel. */
  async setUserChannel(userId: number, kind: 'DISCORD' | 'WHATSAPP', value: string, opts: { provider?: string; extra?: string } = {}) {
    const v = (value ?? '').trim();
    if (!v) {
      await this.prisma.userAlertChannel.deleteMany({ where: { userId, kind } });
      return { kind, configured: false };
    }
    const data = {
      valueEnc: this.secrets.encryptValue(v),
      extraEnc: opts.extra ? this.secrets.encryptValue(opts.extra) : null,
      provider: opts.provider ?? null,
      maskedHint: this.secrets.maskValue(v),
      enabled: true,
    };
    await this.prisma.userAlertChannel.upsert({
      where: { userId_kind: { userId, kind } },
      update: data,
      create: { userId, kind, ...data },
    });
    return { kind, configured: true, maskedHint: data.maskedHint };
  }

  /** Masked list of this user's own channels, for their settings screen. */
  async userChannels(userId: number) {
    const rows = await this.prisma.userAlertChannel.findMany({ where: { userId } }).catch(() => []);
    return rows.map((r) => ({
      kind: r.kind, provider: r.provider, enabled: r.enabled,
      maskedHint: r.maskedHint, updatedAt: r.updatedAt, configured: true,
    }));
  }

  /**
   * Send an alert to ONE account's own channels (used when the event belongs to
   * that account's network — their NAS, their area, their subscribers).
   */
  async sendToUser(userId: number, opts: { title: string; message: string; level?: string; fields?: Record<string, string> }) {
    const rows = await this.prisma.userAlertChannel.findMany({ where: { userId, enabled: true } }).catch(() => []);
    const out: Record<string, boolean> = {};
    for (const r of rows) {
      const value = this.secrets.decryptValue(r.valueEnc);
      if (!value) continue;
      if (r.kind === 'DISCORD') {
        out.discord = await this.postDiscord(value, opts).catch(() => false);
      } else if (r.kind === 'WHATSAPP') {
        const extra = r.extraEnc ? this.secrets.decryptValue(r.extraEnc) : null;
        out.whatsapp = await this.postWhatsApp(r.provider || 'callmebot', value, extra, opts).catch(() => false);
      }
    }
    return out;
  }

  /**
   * Notify the owner of a piece of the network AND the ISP owner: the account's
   * own channel gets it (so a franchise sees only their own alerts) and the
   * system-wide channel still gets everything.
   */
  async sendScoped(ownerUserId: number | null | undefined, opts: { title: string; message: string; level?: string; fields?: Record<string, string> }) {
    const system = await this.send(opts);
    const owner = ownerUserId ? await this.sendToUser(ownerUserId, opts).catch(() => ({})) : {};
    return { system, owner };
  }

  /** Discord webhook — rich embed, exactly like an Uptime Kuma alert. */
  private async toDiscord(opts: { title: string; message: string; level?: string; fields?: Record<string, string> }) {
    const url = await this.secrets.get('DISCORD_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL');
    if (!url) return false;
    return this.postDiscord(url, opts);
  }

  /** Low-level Discord post — shared by the system and per-user channels. */
  private async postDiscord(url: string, opts: { title: string; message: string; level?: string; fields?: Record<string, string> }) {
    const body = {
      username: 'Jointbox',
      embeds: [{
        title: opts.title,
        description: opts.message,
        color: this.colour(opts.level || 'WARN'),
        timestamp: new Date().toISOString(),
        footer: { text: 'Jointbox ISP monitoring' },
        fields: Object.entries(opts.fields || {}).map(([name, value]) => ({ name, value: String(value), inline: true })),
      }],
    };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { this.log.warn(`Discord alert failed: HTTP ${res.status}`); return false; }
      return true;
    } catch (e: any) {
      this.log.warn(`Discord alert error: ${e?.message || e}`);
      return false;
    }
  }

  /** WhatsApp via CallMeBot (free) or Meta Cloud API. */
  private async toWhatsApp(opts: { title: string; message: string }) {
    const provider = ((await this.secrets.get('WHATSAPP_PROVIDER', 'WHATSAPP_PROVIDER')) || '').toLowerCase();
    const phone = await this.secrets.get('WHATSAPP_PHONE', 'WHATSAPP_PHONE');
    if (!provider || !phone) return false;
    const extra = provider === 'meta'
      ? await this.secrets.get('WHATSAPP_TOKEN', 'WHATSAPP_TOKEN')
      : await this.secrets.get('WHATSAPP_APIKEY', 'WHATSAPP_APIKEY');
    return this.postWhatsApp(provider, phone, extra, opts);
  }

  /** Low-level WhatsApp send — shared by the system and per-user channels. */
  private async postWhatsApp(provider: string, phone: string, extra: string | null, opts: { title: string; message: string }) {
    const text = `*${opts.title}*\n${opts.message}`;
    try {
      if (provider.toLowerCase() === 'callmebot') {
        if (!extra) return false;
        const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(extra)}`;
        const res = await fetch(url);
        return res.ok;
      }
      if (provider.toLowerCase() === 'meta') {
        const phoneId = await this.secrets.get('WHATSAPP_PHONE_ID', 'WHATSAPP_PHONE_ID');
        if (!extra || !phoneId) return false;
        const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${extra}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text } }),
        });
        if (!res.ok) this.log.warn(`WhatsApp (meta) failed: HTTP ${res.status}`);
        return res.ok;
      }
      return false;
    } catch (e: any) {
      this.log.warn(`WhatsApp alert error: ${e?.message || e}`);
      return false;
    }
  }

  /** Which channels are configured — masked, never the actual values. */
  async status() {
    const [discord, provider, phone] = await Promise.all([
      this.secrets.get('DISCORD_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL'),
      this.secrets.get('WHATSAPP_PROVIDER', 'WHATSAPP_PROVIDER'),
      this.secrets.get('WHATSAPP_PHONE', 'WHATSAPP_PHONE'),
    ]);
    return {
      discord: !!discord,
      whatsapp: !!(provider && phone),
      whatsappProvider: provider || null,
      keys: await this.secrets.status(AlertsService.KEYS),
    };
  }

  /** Save a managed alert secret from the panel (value is encrypted at rest). */
  async setSecret(key: string, value: string, byUserId?: number) {
    if (!AlertsService.KEYS.some((k) => k.key === key)) {
      throw new Error(`"${key}" is not a managed alert setting.`);
    }
    return this.secrets.set(key, value, byUserId);
  }
}
