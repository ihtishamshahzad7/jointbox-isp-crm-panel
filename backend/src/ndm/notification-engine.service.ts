import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from '../notifications/alerts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { fmtDuration } from './ndm.constants';

/**
 * Notification engine — turns a freshly opened/resolved/scaled alert into
 * actual deliveries and records each one in the `notification` table.
 *
 * channel selection comes from the rule's `channels` JSON:
 *   { "discord": true, "whatsapp": false, "sms": "+34612345678", "email": "ops@corp.com" }
 * booleans = use the system-wide channel; strings = the recipient for SMS/EMAIL.
 * Discord/WhatsApp reuse the existing AlertsService (system + per-owner
 * routing); SMS/EMAIL reuse the existing queued NotificationsService.
 *
 * Every call is best-effort: a dead webhook or missing env var logs a row with
 * status FAILED but never interrupts the polling/syslog pipeline.
 */
@Injectable()
export class NdmNotificationEngine {
  private readonly log = new Logger('NdmNotify');

  constructor(
    private prisma: PrismaService,
    private alerts: AlertsService,
    private notifications: NotificationsService,
  ) {}

  /**
   * Deliver an alert/hard-dependency message. `event` is either 'OPEN' (the
   * incident started), 'UPGRADE' (duration/flap escalation) or 'RESOLVE'.
   * Returns which channels accepted it.
   */
  async notify(opts: {
    alertId: number;
    title: string;
    message: string;
    severity: string;
    channels: Record<string, any>;
    ownerId?: number | null;
    deviceIp?: string | null;
    deviceName?: string | null;
    event: 'OPEN' | 'UPGRADE' | 'RESOLVE';
    extraFields?: Record<string, string>;
  }) {
    const { alertId, title, message, severity, channels, ownerId } = opts;
    const ch = channels || {};
    const level = severity === 'CRITICAL' ? 'CRITICAL' : severity === 'INFO' ? 'OK' : 'WARN';
    const fields = {
      Device: opts.deviceName || opts.deviceIp || '—',
      Event: opts.event,
      ...(opts.extraFields || {}),
    };
    const out: Record<string, boolean> = {};

    const record = async (channel: string, ok: boolean, error?: string) => {
      await this.prisma.notification.create({ data: { alertId, channel, title, message, status: ok ? 'SENT' : 'FAILED', error: error || null } }).catch(() => {});
    };

    // Discord + WhatsApp → existing AlertsService (system + per-owner channels).
    if (ch.discord) {
      const res = await this.alerts.sendScoped(ownerId, { title, message, level, fields }).catch(() => ({ system: { discord: false }, owner: {} }));
      const ok = !!(res as any).system?.discord || !!(res as any).owner?.discord;
      await record('DISCORD', ok, ok ? undefined : 'no Discord webhook configured');
      out.discord = ok;
    }
    if (ch.whatsapp) {
      const res = await this.alerts.sendScoped(ownerId, { title, message, level, fields }).catch(() => ({ system: { whatsapp: false }, owner: {} }));
      const ok = !!(res as any).system?.whatsapp || !!(res as any).owner?.whatsapp;
      await record('WHATSAPP', ok, ok ? undefined : 'no WhatsApp channel configured');
      out.whatsapp = ok;
    }

    // SMS / EMAIL → existing queued notifications (channel value IS the recipient).
    if (typeof ch.sms === 'string' && ch.sms) {
      try {
        await this.notifications.send({ channel: 'SMS', recipient: ch.sms, body: message, subject: title, event: `monitoring.${opts.event.toLowerCase()}` });
        await record('SMS', true);
        out.sms = true;
      } catch (e: any) {
        await record('SMS', false, e?.message || 'queue failed');
        out.sms = false;
      }
    }
    if (typeof ch.email === 'string' && ch.email) {
      try {
        await this.notifications.send({ channel: 'EMAIL', recipient: ch.email, body: message, subject: title, event: `monitoring.${opts.event.toLowerCase()}` });
        await record('EMAIL', true);
        out.email = true;
      } catch (e: any) {
        await record('EMAIL', false, e?.message || 'queue failed');
        out.email = false;
      }
    }

    // Sound/desktop in-channel toasts travel over SSE — logged too for audit.
    if (ch.sound || ch.desktop) {
      await record(ch.sound ? 'SOUND' : 'DESKTOP', true);
    }
    if (!Object.keys(out).length) {
      // At minimum the live UI toast exists; record SOUND honestly so the
      // alert history shows whether the alarm could have gone off.
      await record('SOUND', !!ch.sound, ch.sound ? undefined : 'sound disabled for this alert (rule/device/port settings)');
    }
    return out;
  }

  /** Title/message template interpolation used by the UI when previewing rules. */
  static template(kind: 'OPEN' | 'UPGRADE' | 'RESOLVE', rule: { name?: string }, ev: Record<string, any>): { title: string; message: string } {
    const who = ev.deviceName || ev.deviceIp || 'device';
    const port = ev.interfaceName ? ` (${ev.interfaceName})` : '';
    switch (kind) {
      case 'RESOLVE':
        return { title: `✅ Resolved — ${rule.name || 'alert'}`, message: `${who}${port} recovered at ${new Date().toLocaleString()}.` };
      case 'UPGRADE':
        return { title: `🔺 Escalated — ${rule.name || 'alert'}`, message: `${who}${port} still down (${fmtDuration(ev.durationSec || 0)}).` };
      default:
        return { title: `🚨 ${rule.name || 'alert'}`, message: `${who}${port}: ${ev.message || ''}` };
    }
  }
}