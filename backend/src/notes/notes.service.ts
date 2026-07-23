import { Injectable, ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

/**
 * NotesService — free-text notes on any record.
 *
 * Polymorphic: a note is (entityType, entityId, body). One table, one API, used
 * by every detail screen. Isolation follows the rest of the app — you see notes
 * written by you or anyone in your downline; a parent sees its dealers' notes; a
 * sibling never sees another sibling's. The ISP sees all.
 */
const TYPES = new Set(['SUBSCRIBER', 'USER', 'PACKAGE', 'IP_POOL', 'NAS', 'AREA', 'INVOICE', 'PAYMENT', 'TICKET']);

@Injectable()
export class NotesService {
  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  private norm(entityType: string): string {
    const t = String(entityType || '').toUpperCase();
    if (!TYPES.has(t)) throw new BadRequestException(`Unknown record type "${entityType}".`);
    return t;
  }

  /** Notes on one record, newest first (pinned float to the top). */
  async list(actor: Actor, entityType: string, entityId: number) {
    const type = this.norm(entityType);
    const where: any = { entityType: type, entityId: Number(entityId) };
    if (!this.scope.isAdmin(actor?.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.createdById = { in: ids.length ? ids : [-1] };
    }
    return this.prisma.recordNote.findMany({
      where,
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async add(actor: Actor, body: { entityType: string; entityId: number; body: string; pinned?: boolean }) {
    const type = this.norm(body?.entityType);
    const text = (body?.body || '').trim();
    if (!text) throw new BadRequestException('Note text is required.');
    if (!body?.entityId) throw new BadRequestException('entityId is required.');

    const me = this.scope.actorId(actor);
    const author = me ? await this.prisma.user.findUnique({ where: { id: me }, select: { name: true } }) : null;
    return this.prisma.recordNote.create({
      data: {
        entityType: type, entityId: Number(body.entityId), body: text.slice(0, 4000),
        pinned: !!body.pinned, createdById: me ?? null, createdByName: author?.name ?? null,
      },
    });
  }

  async update(actor: Actor, id: number, body: { body?: string; pinned?: boolean }) {
    const note = await this.prisma.recordNote.findUnique({ where: { id: Number(id) } });
    if (!note) throw new NotFoundException('Note not found.');
    await this.assertOwnerOrAdmin(actor, note.createdById);
    return this.prisma.recordNote.update({
      where: { id: note.id },
      data: {
        ...(body.body !== undefined ? { body: String(body.body).trim().slice(0, 4000) } : {}),
        ...(body.pinned !== undefined ? { pinned: !!body.pinned } : {}),
      },
    });
  }

  async remove(actor: Actor, id: number) {
    const note = await this.prisma.recordNote.findUnique({ where: { id: Number(id) } });
    if (!note) return { deleted: false };
    await this.assertOwnerOrAdmin(actor, note.createdById);
    await this.prisma.recordNote.delete({ where: { id: note.id } }).catch(() => null);
    return { deleted: true };
  }

  /** Author may edit/delete their own note; a parent (or ISP) may moderate a downline note. */
  private async assertOwnerOrAdmin(actor: Actor, authorId: number | null) {
    if (this.scope.isAdmin(actor?.role)) return;
    const me = this.scope.actorId(actor);
    if (authorId === me) return;
    const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
    if (authorId != null && ids.includes(authorId)) return;
    throw new ForbiddenException('You can only edit or remove your own notes (or your downline\'s).');
  }
}
