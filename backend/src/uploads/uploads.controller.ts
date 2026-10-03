import {
  Controller, Get, Post, UploadedFile, UseInterceptors, UseGuards, BadRequestException,
  NotFoundException, UnauthorizedException, Param, Query, Req, Res, Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService } from '../common/scope.service';
import { accountStatus } from '../auth/account-status';

// Files are written to <cwd>/uploads and served by GET /uploads/:file below.
export const UPLOAD_DIR = join(process.cwd(), 'uploads');
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

/** What a stored name may look like — no path separators, no dot-files. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** How long a media token lives. The panel renews it well before this. */
const MEDIA_TOKEN_TTL_S = 12 * 3600;

/**
 * UPLOADED FILES — CNIC scans, customer photos, identity documents.
 *
 * These used to be served by a static mount with no authentication at all:
 * anyone holding (or guessing) a URL got a national-ID scan. They are now
 * served only to signed-in staff, and a file recorded in `uploaded_file` only
 * to staff of the COMPANY that uploaded it. The platform account sees only
 * its own uploads — company files are opened by signing in as the company.
 *
 * <img src> cannot send an Authorization header, so the panel appends a MEDIA
 * token (`?mt=`): a short-lived token whose only valid use is this route. The
 * operator API refuses it (JwtStrategy rejects any scope other than 'admin'),
 * so a token copied out of an image URL opens pictures and nothing else.
 */
@Controller('uploads')
export class UploadsController {
  private readonly logger = new Logger('Uploads');
  private readonly roleCache = new Map<number, { role: string; company: number | null; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly jwt: JwtService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: UPLOAD_DIR,
        filename: (_req, file, cb) => {
          const unique = `${Date.now()}-${randomBytes(16).toString('hex')}`;
          cb(null, `${unique}${extname(file.originalname).toLowerCase()}`);
        },
      }),
      limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
      fileFilter: (_req, file, cb) => {
        // Images (photo/CNIC scans) + PDF (uploaded identity documents).
        if (/^image\/(png|jpe?g|webp|gif|heic|heif)$/i.test(file.mimetype) || file.mimetype === 'application/pdf') cb(null, true);
        else cb(new BadRequestException('Only image or PDF files are allowed'), false);
      },
    }),
  )
  async upload(@UploadedFile() file: any, @Req() req: any) {
    if (!file) throw new BadRequestException('No file uploaded');
    const uploader = Number(req?.user?.sub ?? req?.user?.id) || null;
    this.logger.log(`Upload ${file.filename} by user ${uploader ?? 'unknown'}`);
    try {
      await this.prisma.uploadedFile.create({
        data: {
          filename: file.filename,
          ownerId: uploader ? await this.scope.companyRootId(uploader) : null,
          uploadedBy: uploader,
          mimeType: file.mimetype ?? null,
          size: typeof file.size === 'number' ? file.size : null,
        },
      });
    } catch (e: any) {
      // The file is stored either way; an unrecorded file falls back to
      // "any signed-in operator", never to public.
      this.logger.warn(`could not record upload ${file.filename}: ${e?.message || e}`);
    }
    return { url: `/uploads/${file.filename}`, filename: file.filename };
  }

  /** A media token for the signed-in user. See the class comment. */
  @UseGuards(JwtAuthGuard)
  @Get('media-token')
  mediaToken(@Req() req: any) {
    const sub = Number(req?.user?.sub);
    const token = this.jwt.sign(
      { sub, scope: 'media', ...(req?.user?.imp ? { imp: true } : {}) },
      { expiresIn: MEDIA_TOKEN_TTL_S },
    );
    return { token, sub, expiresAt: new Date(Date.now() + MEDIA_TOKEN_TTL_S * 1000).toISOString() };
  }

  /**
   * Serve one stored file. Unguarded at the framework level on purpose — the
   * token arrives in the query string — and checked by hand below. Every
   * refusal looks the same (404), so a file outside the caller's company is
   * indistinguishable from one that does not exist.
   */
  @Get(':file')
  async serve(@Param('file') file: string, @Query('mt') mt: string, @Req() req: any, @Res() res: any) {
    const name = String(file || '');
    if (!SAFE_NAME.test(name) || name.includes('..')) throw new NotFoundException('File not found');

    const bearer = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    const token = String(mt || bearer || '');
    if (!token) throw new UnauthorizedException('Sign in to view this file.');
    let payload: any;
    try {
      payload = this.jwt.verify(token);
    } catch {
      throw new UnauthorizedException('This link has expired. Reload the page.');
    }
    // Only a media token. A full operator token must never travel in a URL,
    // and a customer-portal token is not staff.
    if (payload?.scope !== 'media') throw new UnauthorizedException('Not a media token.');
    const sub = Number(payload.sub);

    const status = await accountStatus(this.prisma, sub);
    if (!status || (!payload.imp && !status.active)) throw new UnauthorizedException('Account not active.');

    const row = await this.prisma.uploadedFile.findUnique({
      where: { filename: name },
      select: { ownerId: true },
    });
    const me = await this.who(sub);
    if (me.role === 'SUPER_ADMIN') {
      // The platform account sees no company's customers: only files it
      // uploaded itself (recorded, no company). CNIC scans and photos belong
      // to the company — reach them by signing in as the company.
      if (!row || row.ownerId != null) throw new NotFoundException('File not found');
    } else if (row && (row.ownerId == null || row.ownerId !== me.company)) {
      throw new NotFoundException('File not found');
    }

    const path = join(UPLOAD_DIR, name);
    if (!existsSync(path)) throw new NotFoundException('File not found');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    return res.sendFile(path, { dotfiles: 'deny' });
  }

  /** Role and company of a viewer, cached for a minute (a page of avatars is many requests). */
  private async who(sub: number): Promise<{ role: string; company: number | null }> {
    const hit = this.roleCache.get(sub);
    if (hit && Date.now() - hit.at < 60_000) return hit;
    const u = await this.prisma.user.findUnique({ where: { id: sub }, select: { role: true } });
    const entry = { role: String(u?.role ?? ''), company: await this.scope.companyRootId(sub), at: Date.now() };
    if (this.roleCache.size > 5000) this.roleCache.clear();
    this.roleCache.set(sub, entry);
    return entry;
  }
}
