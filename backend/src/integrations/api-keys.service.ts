import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import * as crypto from 'crypto';

/**
 * ApiKeysService — machine credentials for the public API.
 *
 * Used by anything that isn't a person logging in: a mobile app backend, a
 * reseller's own billing system, an automation script.
 *
 * Security posture:
 *   • Only a SHA-256 hash is stored. The plaintext key is returned once at
 *     creation and cannot be recovered — a database leak yields nothing usable.
 *   • Lookup is by hash, so we never need the plaintext to authenticate.
 *   • Every key carries scopes, an optional expiry, and last-used tracking so
 *     abandoned keys are visible and revocable.
 */
@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  private hash(key: string) {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  async list(actor?: Actor) {
    const where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.ownerId = { in: await this.scope.descendantIds(await this.scope.rootId(actor)) };
    }
    // keyHash is deliberately never returned.
    return this.prisma.apiKey.findMany({
      where,
      select: {
        id: true, name: true, prefix: true, scopes: true, isActive: true,
        lastUsedAt: true, lastUsedIp: true, expiresAt: true, createdAt: true, ownerId: true,
      },
      orderBy: { id: 'desc' },
    });
  }

  /**
   * Create a key. The plaintext is shown ONCE — make that clear to the caller,
   * because there is no way to retrieve it afterwards.
   */
  async create(
    data: { name: string; scopes?: string[]; expiresInDays?: number },
    actor?: Actor,
  ) {
    const raw = `jb_live_${crypto.randomBytes(24).toString('hex')}`;
    const rec = await this.prisma.apiKey.create({
      data: {
        name: data.name?.trim() || 'API key',
        keyHash: this.hash(raw),
        prefix: raw.slice(0, 12),
        scopes: data.scopes?.length ? data.scopes.join(',') : 'read',
        ownerId: actor ? this.scope.actorId(actor) : null,
        expiresAt: data.expiresInDays
          ? new Date(Date.now() + data.expiresInDays * 86400_000)
          : null,
      },
    });

    return {
      id: rec.id,
      name: rec.name,
      prefix: rec.prefix,
      scopes: rec.scopes,
      expiresAt: rec.expiresAt,
      key: raw,
      warning: 'Store this key now — it cannot be shown again.',
    };
  }

  async revoke(id: number, actor?: Actor) {
    const key = await this.prisma.apiKey.findUnique({ where: { id } });
    if (!key) throw new NotFoundException(`API key ${id} not found`);
    if (actor && !this.scope.isAdmin(actor.role) && key.ownerId) {
      await this.scope.assertUser(actor, key.ownerId);
    }
    await this.prisma.apiKey.update({ where: { id }, data: { isActive: false } });
    return { revoked: true, id };
  }

  /**
   * Validate an incoming key. Returns the record, or throws.
   * Called by ApiKeyGuard on every public-API request.
   */
  async validate(rawKey: string, ip?: string) {
    if (!rawKey) throw new UnauthorizedException('API key required');

    const key = await this.prisma.apiKey.findUnique({
      where: { keyHash: this.hash(rawKey) },
    });
    if (!key || !key.isActive) throw new UnauthorizedException('Invalid or revoked API key');
    if (key.expiresAt && key.expiresAt < new Date()) {
      throw new UnauthorizedException('This API key has expired');
    }

    // Best-effort usage tracking — must never block the request.
    this.prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date(), lastUsedIp: ip ?? null } })
      .catch(() => {});

    return key;
  }

  hasScope(key: { scopes: string }, required: string) {
    const scopes = (key.scopes || '').split(',').map((s) => s.trim());
    return scopes.includes('*') || scopes.includes(required);
  }
}
