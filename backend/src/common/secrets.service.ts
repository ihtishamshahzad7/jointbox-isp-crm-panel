import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { encryptSecret, decryptSecret } from './crypto-box';

/**
 * SecretsService — operator-managed secrets, encrypted at rest.
 *
 * Values (Discord webhook URL, WhatsApp tokens…) are stored AES-256-GCM
 * encrypted and are never returned to the browser in plaintext: the UI only
 * ever sees a masked hint like "https://discord.com/api/webhooks/…4f2a".
 *
 * The encryption key is derived from SECRETS_KEY (or JWT_SECRET as a fallback),
 * so nothing extra has to be configured for it to work on an existing install.
 */
@Injectable()
export class SecretsService {
  private readonly log = new Logger('Secrets');
  private cache = new Map<string, string>(); // decrypted, in-memory only

  constructor(private prisma: PrismaService) {}

  /** Public wrappers so other services can store their own encrypted rows. */
  encryptValue(plain: string): string { return this.encrypt(plain); }
  decryptValue(payload: string): string | null { return this.decrypt(payload); }
  maskValue(v: string): string { return this.mask(v); }

  // The actual crypto lives in common/crypto-box.ts so that plain modules
  // (the MikroTik client, which is not a Nest provider) can decrypt stored
  // router credentials using the exact same key and payload format. Two copies
  // of an encryption scheme is how you end up with data you cannot read back.
  private encrypt(plain: string): string { return encryptSecret(plain); }

  private decrypt(payload: string): string | null { return decryptSecret(payload); }

  /** Show enough to recognise the value, never enough to use it. */
  private mask(v: string): string {
    if (v.length <= 12) return `${v.slice(0, 2)}…${v.slice(-2)}`;
    return `${v.slice(0, 34)}…${v.slice(-4)}`;
  }

  /** Save (or clear, when value is empty) a secret. */
  async set(key: string, value: string, byUserId?: number) {
    const v = (value ?? '').trim();
    this.cache.delete(key);
    if (!v) {
      await this.prisma.appSecret.deleteMany({ where: { key } });
      return { key, configured: false };
    }
    const data = { valueEnc: this.encrypt(v), maskedHint: this.mask(v), updatedById: byUserId ?? null };
    await this.prisma.appSecret.upsert({ where: { key }, update: data, create: { key, ...data } });
    return { key, configured: true, maskedHint: data.maskedHint };
  }

  /**
   * Resolve a secret: the DB value wins; otherwise fall back to the matching
   * environment variable, so existing .env installs keep working unchanged.
   */
  async get(key: string, envFallback?: string): Promise<string | null> {
    if (this.cache.has(key)) return this.cache.get(key)!;
    const row = await this.prisma.appSecret.findUnique({ where: { key } }).catch(() => null);
    if (row?.valueEnc) {
      const plain = this.decrypt(row.valueEnc);
      if (plain) { this.cache.set(key, plain); return plain; }
      this.log.warn(`Secret "${key}" could not be decrypted — has SECRETS_KEY changed?`);
    }
    const env = envFallback ? process.env[envFallback] : undefined;
    return env || null;
  }

  /** Masked status for the UI: configured or not, plus where it came from. */
  async status(keys: Array<{ key: string; env?: string }>) {
    const rows: any[] = await this.prisma.appSecret.findMany({ where: { key: { in: keys.map((k) => k.key) } } }).catch(() => []);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return keys.map(({ key, env }) => {
      const row = byKey.get(key);
      const fromEnv = !row && !!(env && process.env[env]);
      return {
        key,
        configured: !!row || fromEnv,
        source: row ? 'panel' : fromEnv ? 'env' : null,
        maskedHint: row?.maskedHint ?? (fromEnv ? 'set in .env' : null),
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }
}
