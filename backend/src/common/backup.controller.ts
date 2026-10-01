import {
  Controller,
  Get,
  Post,
  Param,
  Request,
  Res,
  UseGuards,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { createReadStream } from 'fs';
import { basename } from 'path';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../security/permissions.guard';
import { BackupService } from './backup.service';

/**
 * Exposes BackupService for the Settings → Database Backups panel.
 *
 * Every route here — including the GETs — is restricted to the ISP owner
 * (ADMIN/SUPER_ADMIN), checked explicitly in this controller rather than
 * left to PermissionsGuard alone. That guard's `ISP_ONLY_WRITE` floor (see
 * security/permissions.guard.ts) only forces writes to be ISP-only; GET is
 * classified "read" and, on an unconfigured RolePermission table, fails
 * OPEN. A raw pg_dump contains every subscriber's data, every invoice, and
 * password hashes — reading the backup list or downloading a dump is exactly
 * as sensitive as triggering one, so it gets the same explicit floor.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('backup')
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  /**
   * PLATFORM OWNER ONLY — not the ISP.
   *
   * This used to admit ADMIN as well, on the reading that an ISP owner should
   * be able to back up "their" data. That reading stopped being true when one
   * panel began serving several unrelated ISP companies: a pg_dump is not one
   * company's data, it is the WHOLE DATABASE — every tenant's subscribers,
   * their invoices, their credentials, their reseller trees. Handing it to one
   * ISP hands them their competitors' customer list.
   *
   * There is no scoped version of this to offer instead. A per-tenant export
   * is a different feature with a different shape (selected tables, filtered by
   * subtree, no credential columns); it is not a restriction of pg_dump, so
   * this stays shut until that exists.
   */
  private assertIspOwner(req: any) {
    const role = req?.user?.role;
    if (role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only the platform owner can view or manage database backups.');
    }
  }

  @Get('status')
  status(@Request() req: any) {
    this.assertIspOwner(req);
    return this.backups.status();
  }

  @Get('list')
  list(@Request() req: any) {
    this.assertIspOwner(req);
    return this.backups.list();
  }

  /** Take a dump right now, outside the 02:00 schedule. */
  @Post('run')
  run(@Request() req: any) {
    this.assertIspOwner(req);
    return this.backups.run();
  }

  /**
   * Streamed rather than buffered — a large database's dump should not have
   * to sit in memory to be served.
   */
  @Get('download/:file')
  download(@Param('file') file: string, @Request() req: any, @Res() res: any) {
    this.assertIspOwner(req);
    const full = this.backups.resolveBackupFile(file);
    if (!full) throw new NotFoundException('Backup file not found.');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${basename(full)}"`);
    createReadStream(full).pipe(res);
  }

  /** The pg_restore command for a given dump — shown, never auto-run. */
  @Get('restore-command/:file')
  restoreCommand(@Param('file') file: string, @Request() req: any) {
    this.assertIspOwner(req);
    if (!this.backups.resolveBackupFile(file)) throw new NotFoundException('Backup file not found.');
    const command = this.backups.restoreCommand(file);
    if (!command) throw new NotFoundException('Could not build a restore command (DATABASE_URL not parseable).');
    return { file, command };
  }
}
