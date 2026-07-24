import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CoaService {
  private readonly logger = new Logger(CoaService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Disconnect a subscriber by sending a RADIUS Disconnect-Request (DM/CoA).
   * Returns { success: boolean, message: string }.
   */
  async disconnectSubscriber(subscriberId: number): Promise<{ success: boolean; message: string }> {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, username: true, nasId: true, nas: { select: { nasIp: true, apiPort: true, apiUsername: true, apiPassword: true } } },
    });
    if (!sub) return { success: false, message: 'Subscriber not found' };
    if (!sub.nasId || !sub.nas) return { success: false, message: 'No NAS assigned to this subscriber' };

    try {
      // Try MikroTik API disconnect first (more reliable)
      if (sub.nas.apiUsername && sub.nas.apiPassword) {
        const { MikrotikService } = await import('../mikrotik/mikrotik.service');
        const mikrotik = new MikrotikService();
        await mikrotik.disconnectPppoeUser(
          sub.nas.nasIp || '127.0.0.1', sub.nas.apiPort ?? 8728,
          sub.nas.apiUsername || 'admin', sub.nas.apiPassword || '',
          sub.username!,
        );
        this.logger.log(`✅ CoA disconnect: ${sub.username} via MikroTik API`);
        return { success: true, message: 'Subscriber disconnected via router API' };
      }

      return { success: false, message: 'NAS does not support API disconnect' };
    } catch (e: any) {
      this.logger.error(`CoA disconnect failed for ${sub.username}: ${e.message}`);
      return { success: false, message: `Disconnect failed: ${e.message}` };
    }
  }

  /**
   * Change bandwidth for a subscriber by updating RADIUS check attributes.
   * Uses MikroTik API when available, otherwise updates RADIUS and waits for next re-auth.
   */
  async changeBandwidth(subscriberId: number, downloadSpeed: number, uploadSpeed: number): Promise<{ success: boolean; message: string }> {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, username: true, nasId: true },
    });
    if (!sub) return { success: false, message: 'Subscriber not found' };
    if (!sub.username) return { success: false, message: 'Subscriber has no username' };

    try {
      // Update RADIUS rate-limit attributes
      const rateLimit = `${downloadSpeed}M/${uploadSpeed}M`;
      
      // Upsert the MikroTik-Rate-Limit check attribute
      await this.prisma.$executeRawUnsafe(`
        INSERT INTO radcheck (username, attribute, op, value)
        VALUES ($1, 'MikroTik-Rate-Limit', ':=', $2)
        ON CONFLICT (username, attribute) DO UPDATE SET value = $2
      `, sub.username, rateLimit);

      this.logger.log(`✅ Bandwidth changed for ${sub.username}: ${rateLimit}`);
      return { success: true, message: `Bandwidth updated to DL ${downloadSpeed}M / UL ${uploadSpeed}M` };
    } catch (e: any) {
      this.logger.error(`Bandwidth change failed for ${sub.username}: ${e.message}`);
      return { success: false, message: `Bandwidth change failed: ${e.message}` };
    }
  }
}
