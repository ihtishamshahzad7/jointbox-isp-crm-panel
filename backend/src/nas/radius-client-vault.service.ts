import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../common/secrets.service';
import { chmod, mkdir, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';

/**
 * Owns the boundary between Jointbox encrypted NAS secrets and FreeRADIUS.
 * FreeRADIUS never reads the application nas table for shared secrets.
 */
@Injectable()
export class RadiusClientVaultService {
  private readonly logger = new Logger(RadiusClientVaultService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
  ) {}

  private get filePath() {
    return process.env.FREERADIUS_CLIENTS_FILE ||
      '/etc/freeradius/3.0/clients.d/jointbox-nas.conf';
  }

  async migrateLegacySecrets(): Promise<number> {
    const rows = await this.prisma.nas.findMany({
      where: { radiusSecretEnc: null, secret: { not: null } },
      select: { id: true, secret: true },
    });
    let migrated = 0;
    for (const row of rows) {
      if (!row.secret) continue;
      await this.prisma.nas.update({
        where: { id: row.id },
        data: { radiusSecretEnc: this.secrets.encryptValue(row.secret), secret: null },
      });
      migrated++;
    }
    if (migrated) this.logger.log(`Migrated ${migrated} legacy RADIUS shared secret(s) to encrypted storage`);
    return migrated;
  }

  private escape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  async syncClients(): Promise<void> {
    await this.migrateLegacySecrets();
    const rows = await this.prisma.nas.findMany({
      where: { isActive: true, nasIp: { not: null } },
      select: { id: true, nasIp: true, nasname: true, shortname: true, radiusSecretEnc: true },
      orderBy: { id: 'asc' },
    });
    const lines = [
      '# Managed by Jointbox. Do not edit manually.',
      '# Client secrets come from encrypted application storage.',
      '',
    ];
    for (const row of rows) {
      const secret = row.radiusSecretEnc ? this.secrets.decryptValue(row.radiusSecretEnc) : null;
      if (!row.nasIp || !secret) {
        this.logger.warn(`Skipping NAS #${row.id}: encrypted RADIUS secret is missing or unreadable`);
        continue;
      }
      lines.push(
        `client jointbox-nas-${row.id} {`,
        `  ipaddr = ${row.nasIp}`,
        `  secret = "${this.escape(secret)}"`,
        `  shortname = "${this.escape(row.shortname || row.nasname || row.nasIp)}"`,
        '  proto = udp',
        '}',
        '',
      );
    }
    const file = this.filePath;
    try {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      await writeFile(tmp, lines.join('\n'), { mode: 0o640 });
      await chmod(tmp, 0o640);
      await rename(tmp, file);
    } catch (error: any) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(`Unable to write FreeRADIUS client file: ${error.message}`);
      }
      this.logger.warn(`FreeRADIUS client file not writable; skipped sync: ${error.message}`);
    }
  }
}
