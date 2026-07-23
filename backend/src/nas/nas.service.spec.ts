import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NasType } from '@prisma/client';
import { MikrotikSyncService } from './mikrotik-sync.service';
import { RadiusSyncService } from './radius-sync.service';

@Injectable()
export class NasService {
  private readonly logger = new Logger(NasService.name);

  constructor(
    private prisma: PrismaService,
    private mikrotikSync: MikrotikSyncService,
    private radiusSync: RadiusSyncService,
  ) {}

  async findAll() {
    return this.prisma.nas.findMany({
      orderBy: { id: 'desc' },
      include: {
        _count: { select: { subscribers: true } },
      },
    });
  }

  async findOne(id: number) {
    const nas = await this.prisma.nas.findUnique({
      where: { id },
      include: {
        subscribers: true,
        _count: { select: { subscribers: true } },
      },
    });
    
    if (!nas) {
      throw new NotFoundException(`NAS with ID ${id} not found`);
    }
    
    return nas;
  }

  private resolveNasType(raw?: string): NasType {
    const map: Record<string, NasType> = {
      CISCO:    NasType.CISCO,
      HUAWEI:   NasType.HUAWEI,
      OTHER:    NasType.OTHER,
      MIKROTIK: NasType.MIKROTIK,
    };
    return map[raw?.toUpperCase() ?? ''] ?? NasType.MIKROTIK;
  }

  async create(data: {
    nasIp:        string;
    nasName:      string;
    secret:       string;
    apiPort?:     number;
    incomingPort?: number;
    apiUsername?: string;
    apiPassword?: string;
    nasType?:     string;
    isActive?:    boolean;
    description?: string;
  }) {
    // Create in Prisma first
    const nas = await this.prisma.nas.create({
      data: {
        nasIp:        data.nasIp,
        nasname:      data.nasName,
        secret:       data.secret,
        apiPort:      data.apiPort      ?? 8728,
        incomingPort: data.incomingPort ?? 3799,
        apiUsername:  data.apiUsername,
        apiPassword:  data.apiPassword,
        type:         this.resolveNasType(data.nasType),
        isActive:     data.isActive     ?? true,
        description:  data.description,
      },
    });

    // THEN sync to FreeRADIUS database (only if nasIp exists)
    if (data.nasIp && data.secret) {
      try {
        await this.radiusSync.addNasToRadius(data.nasIp, data.nasName, data.secret);
        this.logger.log(`✅ NAS "${data.nasName}" synced to FreeRADIUS`);
      } catch (error: any) {
        this.logger.error(`Failed to sync NAS to RADIUS: ${error.message}`);
      }
    }

    return nas;
  }

  async update(id: number, data: {
    nasIp?:        string;
    nasName?:      string;
    secret?:       string;
    apiPort?:      number;
    incomingPort?: number;
    apiUsername?:  string;
    apiPassword?:  string;
    nasType?:      string;
    isActive?:     boolean;
    description?:  string;
  }) {
    const existingNas = await this.prisma.nas.findUnique({ where: { id } });
    if (!existingNas) {
      throw new NotFoundException(`NAS with ID ${id} not found`);
    }

    const updateData: any = {};
    
    if (data.nasIp !== undefined) updateData.nasIp = data.nasIp;
    if (data.nasName !== undefined) updateData.nasname = data.nasName;
    if (data.secret !== undefined) updateData.secret = data.secret;
    if (data.apiPort !== undefined) updateData.apiPort = data.apiPort;
    if (data.incomingPort !== undefined) updateData.incomingPort = data.incomingPort;
    if (data.apiUsername !== undefined) updateData.apiUsername = data.apiUsername;
    if (data.apiPassword !== undefined) updateData.apiPassword = data.apiPassword;
    if (data.nasType !== undefined) updateData.type = this.resolveNasType(data.nasType);
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.description !== undefined) updateData.description = data.description;
    
    const updatedNas = await this.prisma.nas.update({ 
      where: { id }, 
      data: updateData 
    });

    const ipChanged = data.nasIp && data.nasIp !== existingNas.nasIp && existingNas.nasIp;
    const secretChanged = data.secret && data.secret !== existingNas.secret;
    const nameChanged = data.nasName && data.nasName !== existingNas.nasname;

    if ((ipChanged || secretChanged || nameChanged) && existingNas.nasIp) {
      try {
        await this.radiusSync.removeNasFromRadius(existingNas.nasIp);
        const newIp = data.nasIp || existingNas.nasIp;
        const newName = data.nasName || existingNas.nasname;
        const newSecret = data.secret || existingNas.secret;
        if (newIp && newSecret) {
          await this.radiusSync.addNasToRadius(newIp, newName, newSecret);
          this.logger.log(`✅ NAS "${updatedNas.nasname}" updated in FreeRADIUS`);
        }
      } catch (error: any) {
        this.logger.error(`Failed to update NAS in RADIUS: ${error.message}`);
      }
    }

    return updatedNas;
  }

  async remove(id: number) {
    const nas = await this.prisma.nas.findUnique({ where: { id } });
    if (!nas) {
      throw new NotFoundException(`NAS with ID ${id} not found`);
    }
    
    if (nas.nasIp) {
      try {
        await this.radiusSync.removeNasFromRadius(nas.nasIp);
        this.logger.log(`✅ NAS "${nas.nasname}" removed from FreeRADIUS`);
      } catch (error: any) {
        this.logger.error(`Failed to remove NAS from RADIUS: ${error.message}`);
      }
    }
    
    return this.prisma.nas.delete({ where: { id } });
  }

  async toggleStatus(id: number) {
    const nas = await this.prisma.nas.findUnique({ where: { id } });
    if (!nas) throw new NotFoundException(`NAS with ID ${id} not found`);
    return this.prisma.nas.update({ 
      where: { id }, 
      data: { isActive: !nas.isActive } 
    });
  }

  async getStats() {
    const [total, active, inactive, mikrotik, cisco, other] = await Promise.all([
      this.prisma.nas.count(),
      this.prisma.nas.count({ where: { isActive: true } }),
      this.prisma.nas.count({ where: { isActive: false } }),
      this.prisma.nas.count({ where: { type: 'MIKROTIK' } }),
      this.prisma.nas.count({ where: { type: 'CISCO' } }),
      this.prisma.nas.count({ where: { type: { notIn: ['MIKROTIK', 'CISCO'] } } }),
    ]);
    
    return { total, active, inactive, mikrotik, cisco, other };
  }

  async checkReachability(id: number) {
    const nas = await this.prisma.nas.findUnique({ where: { id } });
    if (!nas) throw new NotFoundException(`NAS with ID ${id} not found`);
    if (!nas.nasIp) throw new Error('NAS IP address not configured');
    
    const apiPort = nas.apiPort ?? 8728;
    const incomingPort = (nas as any).incomingPort ?? 3799;
    
    this.logger.log(`Checking reachability for ${nas.nasname} (${nas.nasIp})`);
    this.logger.log(`  API Port: ${apiPort}`);
    this.logger.log(`  RADIUS CoA Port: ${incomingPort}`);
    
    return this.mikrotikSync.checkReachability(nas.nasIp, apiPort, incomingPort);
  }

  async syncDetails(id: number) {
    const nas = await this.prisma.nas.findUnique({ where: { id } });
    if (!nas) throw new NotFoundException(`NAS with ID ${id} not found`);
    if (!nas.nasIp) throw new Error('NAS IP address not configured');
    if (!nas.apiUsername || !nas.apiPassword) {
      throw new Error('API credentials not configured for this NAS');
    }
    
    const apiPort = nas.apiPort ?? 8728;
    return this.mikrotikSync.syncDetails(nas.nasIp, apiPort, nas.apiUsername, nas.apiPassword);
  }

  async quickCheck(id: number) {
    const nas = await this.prisma.nas.findUnique({ where: { id } });
    if (!nas) throw new NotFoundException(`NAS with ID ${id} not found`);
    if (!nas.nasIp) return { online: false, identity: '', version: '', cpuLoad: '', uptime: '', activeConnections: 0 };
    if (!nas.apiUsername || !nas.apiPassword) {
      return { online: false, identity: '', version: '', cpuLoad: '', uptime: '', activeConnections: 0 };
    }
    
    const apiPort = nas.apiPort ?? 8728;
    return this.mikrotikSync.quickCheck(nas.nasIp, apiPort, nas.apiUsername, nas.apiPassword);
  }

  // ========== RADIUS DATABASE METHODS ==========

  async getActiveSessions() {
    try {
      const sessions = await this.radiusSync.getActiveSessions();
      return {
        success: true,
        count: sessions.length,
        sessions,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get active sessions: ${error.message}`);
      return { success: false, error: error.message, sessions: [] };
    }
  }

  async getRadiusHealth() {
    try {
      const health = await this.radiusSync.isRadiusAlive();
      return {
        success: true,
        ...health,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get RADIUS health: ${error.message}`);
      return { success: false, error: error.message, alive: false };
    }
  }

  async isNasRegistered(nasIp: string) {
    try {
      const isRegistered = await this.radiusSync.isNasRegistered(nasIp);
      return { success: true, nasIp, registered: isRegistered };
    } catch (error: any) {
      this.logger.error(`Failed to check NAS registration: ${error.message}`);
      return { success: false, error: error.message, registered: false };
    }
  }

  async getAuthStats() {
    try {
      const stats = await this.radiusSync.getAuthStats();
      return { success: true, ...stats };
    } catch (error: any) {
      this.logger.error(`Failed to get auth stats: ${error.message}`);
      return { success: false, error: error.message, accepts: 0, rejects: 0 };
    }
  }
}