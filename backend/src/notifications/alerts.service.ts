import { Injectable, Logger } from '@nestjs/common';

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

  /** Discord webhook — rich embed, exactly like an Uptime Kuma alert. */
  private async toDiscord(opts: { title: string; message: string; level?: string; fields?: Record<string, string> }) {
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) return false;
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
    const provider = (process.env.WHATSAPP_PROVIDER || '').toLowerCase();
    const phone = process.env.WHATSAPP_PHONE;
    if (!provider || !phone) return false;
    const text = `*${opts.title}*\n${opts.message}`;

    try {
      if (provider === 'callmebot') {
        const key = process.env.WHATSAPP_APIKEY;
        if (!key) return false;
        const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`;
        const res = await fetch(url);
        return res.ok;
      }
      if (provider === 'meta') {
        const token = process.env.WHATSAPP_TOKEN;
        const phoneId = process.env.WHATSAPP_PHONE_ID;
        if (!token || !phoneId) return false;
        const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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

  /** Which channels are configured — surfaced in settings/health. */
  status() {
    return {
      discord: !!process.env.DISCORD_WEBHOOK_URL,
      whatsapp: !!(process.env.WHATSAPP_PROVIDER && process.env.WHATSAPP_PHONE),
      whatsappProvider: process.env.WHATSAPP_PROVIDER || null,
    };
  }
}
