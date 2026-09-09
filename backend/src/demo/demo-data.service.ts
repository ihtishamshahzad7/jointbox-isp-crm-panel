import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DemoDataService {
  private readonly log = new Logger('DemoData');
  private readonly batchSize = 500;
  private readonly areaCatalog = [
    ['ISB-01', 'Islamabad'], ['RWP-01', 'Rawalpindi'], ['LHR-01', 'Lahore'],
    ['KHI-01', 'Karachi'], ['PEW-01', 'Peshawar'], ['CHT-01', 'Chitral'],
    ['QTA-01', 'Quetta'], ['MUX-01', 'Multan'], ['FSD-01', 'Faisalabad'],
    ['ABT-01', 'Abbottabad'], ['SWT-01', 'Swat'], ['GRW-01', 'Gujranwala'],
    ['GJW-01', 'Gujrat'], ['SKT-01', 'Sialkot'], ['MZD-01', 'Muzaffarabad'],
    ['HYD-01', 'Hyderabad'], ['SKZ-01', 'Sukkur'], ['BAH-01', 'Bahawalpur'],
    ['RAH-01', 'Rahim Yar Khan'], ['DIK-01', 'Dera Ismail Khan'],
  ] as const;

  constructor(private readonly prisma: PrismaService) {}

  async seedForUser(ownerId: number, subscriberTarget = 10_000) {
    const existing = await this.prisma.subscriber.count({ where: { userId: ownerId } });
    const existingNas = await this.prisma.nas.count({ where: { ownerId } });
    if (existing >= subscriberTarget && existingNas >= 500) return { seeded: false, subscribers: existing, nas: existingNas };
    if (existing > 0 || existingNas > 0) await this.clearCore(ownerId);

    const areas = await this.prisma.area.createManyAndReturn({
      data: this.areaCatalog.map(([code, city]) => ({ name: `${code} — ${city} Demo Area`, city, description: `Synthetic Pakistan ISP coverage area ${code}`, ownerId, isActive: true })),
      select: { id: true, name: true },
    });

    const nasData = Array.from({ length: 500 }, (_, i) => {
      const n = i + 1, area = this.areaCatalog[i % this.areaCatalog.length];
      const type = n % 7 === 0 ? 'CISCO' : n % 5 === 0 ? 'HUAWEI' : 'MIKROTIK';
      const deviceType = n % 7 === 0 ? 'SWITCH' : n % 5 === 0 ? 'OLT_HUAWEI' : 'MIKROTIK';
      const ip = `10.255.${Math.floor(i / 250)}.${(i % 250) + 1}`;
      return { nasname: ip, shortname: `${area[0]}-NAS-${String(n).padStart(3, '0')}`, type, ports: type === 'MIKROTIK' ? 48 : 24, secret: 'demo-secret-not-for-production', server: 'demo-radius', community: 'public', description: `Synthetic ${type} device for ${area[1]} (${area[0]})`, nasIp: ip, isActive: n % 37 !== 0, deviceType, apiEnabled: type === 'MIKROTIK', apiPollSec: 60, snmpEnabled: true, snmpPort: 161, snmpCommunity: 'public', snmpPollSec: 30, snmpTimeoutMs: 4000, snmpRetries: 1, syslogEnabled: true, syslogPort: 514, ownerId } as any;
    });
    await this.createBatches('nas', nasData);
    const nas = await this.prisma.nas.findMany({ where: { ownerId }, select: { id: true, nasIp: true }, orderBy: { id: 'asc' } });

    const poolData = Array.from({ length: 50 }, (_, i) => ({ name: `PK-${String(i + 1).padStart(2, '0')}-PPPoE-Pool`, network: `10.250.${i}.0/24`, subnet: '255.255.255.0', nasId: nas[i * 10]?.id ?? nas[0]?.id, ownerId }));
    await this.createBatches('ipPool', poolData);
    const pools = await this.prisma.ipPool.findMany({ where: { ownerId }, select: { id: true }, orderBy: { id: 'asc' } });

    const packageCatalog = [
      ['Home 10', 10, 5, 999], ['Home 20', 20, 10, 1499], ['Home 30', 30, 15, 1999], ['Home 50', 50, 25, 2799],
      ['Home 75', 75, 35, 3499], ['Home 100', 100, 50, 4499], ['Home 150', 150, 75, 5999], ['Home 200', 200, 100, 7499],
      ['Business 50', 50, 50, 5999], ['Business 100', 100, 100, 8999], ['Business 200', 200, 150, 12999], ['Corporate 500', 500, 300, 24999],
    ] as const;
    const packageData = packageCatalog.map(([name, down, up, price], i) => ({ name: `${name} — Demo`, price, duration: 30, isActive: true, description: `Synthetic ${name} Pakistan ISP package`, downloadSpeed: down, uploadSpeed: up, fupDownloadSpeed: Math.max(2, Math.floor(down / 2)), fupUploadSpeed: Math.max(1, Math.floor(up / 2)), fupAction: 'THROTTLE', dataQuotaGb: 4000, poolId: pools[i % pools.length]?.id, ownerId }));
    await this.createBatches('package', packageData);
    const packages = await this.prisma.package.findMany({ where: { ownerId }, select: { id: true, price: true }, orderBy: { id: 'asc' } });

    const subscriberData = Array.from({ length: subscriberTarget }, (_, i) => {
      const n = i + 1, area = areas[i % areas.length], device = nas[i % nas.length], pkg = packages[i % packages.length];
      const status = i % 29 === 0 ? 'SUSPENDED' : i % 23 === 0 ? 'EXPIRED' : i % 17 === 0 ? 'INACTIVE' : 'ACTIVE';
      const username = `demo-${String(n).padStart(5, '0')}`, sell = pkg.price, cost = Math.round(sell * 0.72);
      return { fullName: `Demo Subscriber ${String(n).padStart(5, '0')}`, phone: `+92-000-${String(1000000 + n).slice(-7)}`, email: `${username}@example.invalid`, address: `${area.name}, Pakistan`, username, password: `DemoPass-${String(n).padStart(5, '0')}`, identity: `DEMO-CNIC-${String(n).padStart(7, '0')}`, cnicNumber: `00000${String(n).padStart(8, '0').slice(-8)}`, connectionType: 'FTTH', authMethod: 'PPPOE', status, balance: status === 'ACTIVE' ? 500 + (n % 1500) : 0, packageId: pkg.id, areaId: area.id, nasId: device.id, userId: ownerId, installationDate: new Date(Date.now() - (30 + (n % 600)) * 86400_000), latitude: 24 + ((i * 13) % 900) / 100, longitude: 66 + ((i * 17) % 1400) / 100, sellPrice: sell, costPrice: cost, profit: sell - cost, kycStatus: 'VERIFIED' } as any;
    });
    await this.createBatches('subscriber', subscriberData);
    const subscribers = await this.prisma.subscriber.findMany({ where: { userId: ownerId }, select: { id: true, username: true, nasId: true, status: true }, orderBy: { id: 'asc' } });

    await this.createBatches('radCheck', subscribers.map((s) => ({ username: s.username, attribute: 'Cleartext-Password', op: ':=', value: `DemoPass-${s.username.slice(5)}` })));
    await this.createBatches('radReply', subscribers.map((s, i) => ({ username: s.username, attribute: 'Framed-IP-Address', op: ':=', value: `10.250.${i % 50}.${(i % 250) + 2}` })));

    const online = subscribers.filter((_, i) => i % 5 !== 0).slice(0, 2500), now = Date.now();
    await this.createBatches('radAcct', online.map((s, i) => {
      const started = new Date(now - (10 + (i % 720)) * 60_000);
      return { acctsessionid: `demo-${ownerId}-${i + 1}`, acctuniqueid: `d${ownerId}${String(i + 1).padStart(12, '0')}`.slice(0, 32), username: s.username, nasipaddress: nas[i % nas.length]?.nasIp || '10.255.0.1', nasportid: String((i % 48) + 1), nasporttype: 'Virtual', acctstarttime: started, acctstoptime: null, acctsessiontime: Math.floor((now - started.getTime()) / 1000), acctauthentic: 'RADIUS', acctinputoctets: BigInt((i + 1) * 8_000_000), acctoutputoctets: BigInt((i + 1) * 35_000_000), callingstationid: `AA:BB:CC:${String(i % 100).padStart(2, '0')}:DD:EE`, servicetype: 'Framed-User', framedprotocol: 'PPP', framedipaddress: `10.250.${i % 50}.${(i % 250) + 2}`, acctupdatetime: new Date(now - (i % 10) * 60_000), acctinterval: BigInt(600) } as any;
    }));

    const nasSamples: any[] = [];
    for (const d of nas) for (let p = 11; p >= 0; p--) nasSamples.push({ nasId: d.id, ts: new Date(now - p * 30 * 60_000), inBytes: BigInt((12 - p) * 25_000_000_000), outBytes: BigInt((12 - p) * 80_000_000_000), online: 800 + ((d.id * 17 + p * 31) % 600), vlan: null });
    await this.createBatches('nasTrafficSample', nasSamples);

    const subSamples: any[] = [];
    for (let i = 0; i < subscribers.length; i++) {
      const baseIn = BigInt((i % 100 + 1) * 10_000_000), baseOut = BigInt((i % 150 + 1) * 50_000_000);
      for (let p = 11; p >= 0; p--) subSamples.push({ subscriberId: subscribers[i].id, ts: new Date(now - p * 30 * 60_000), inBytes: baseIn * BigInt(12 - p), outBytes: baseOut * BigInt(12 - p) });
      if (subSamples.length >= this.batchSize * 4) { const chunk = subSamples.splice(0); await this.createBatches('subscriberTrafficSample', chunk); }
    }
    if (subSamples.length) await this.createBatches('subscriberTrafficSample', subSamples);

    const signals = subscribers.filter((_, i) => i % 2 === 0).map((s, i) => ({ nasId: s.nasId!, subscriberId: s.id, username: s.username, kind: 'ONT_RX', ifIndex: (i % 16) + 1, port: `pon${(i % 16) + 1}`, dbm: -17 - ((i * 7) % 100) / 10, status: i % 19 === 0 ? 'CRITICAL' : i % 7 === 0 ? 'WEAK' : 'GOOD', readAt: new Date(now - (i % 120) * 60_000) }));
    await this.createBatches('linkSignal', signals);

    this.log.log(`Seeded demo #${ownerId}: ${nas.length} NAS, ${areas.length} areas, ${pools.length} pools, ${packages.length} packages, ${subscribers.length} subscribers, ${online.length} active sessions.`);
    return { seeded: true, nas: nas.length, areas: areas.length, pools: pools.length, packages: packages.length, subscribers: subscribers.length, online: online.length };
  }

  async resetForUser(ownerId: number) {
    await this.clearCore(ownerId);
    return this.seedForUser(ownerId, 10_000);
  }

  private async clearCore(ownerId: number) {
    const subs = await this.prisma.subscriber.findMany({ where: { userId: ownerId }, select: { id: true, username: true } });
    const usernames = subs.map((s) => s.username), ids = subs.map((s) => s.id);
    if (usernames.length) {
      await this.prisma.$executeRawUnsafe(`DELETE FROM radcheck WHERE username = ANY($1)`, usernames).catch(() => null);
      await this.prisma.$executeRawUnsafe(`DELETE FROM radreply WHERE username = ANY($1)`, usernames).catch(() => null);
      await this.prisma.$executeRawUnsafe(`DELETE FROM radacct WHERE username = ANY($1)`, usernames).catch(() => null);
    }
    if (ids.length) {
      await this.prisma.subscriberTrafficSample.deleteMany({ where: { subscriberId: { in: ids } } }).catch(() => null);
      await this.prisma.linkSignal.deleteMany({ where: { subscriberId: { in: ids } } }).catch(() => null);
      await this.prisma.subscriber.deleteMany({ where: { id: { in: ids } } });
    }
    const nas = await this.prisma.nas.findMany({ where: { ownerId }, select: { id: true } });
    if (nas.length) await this.prisma.nasTrafficSample.deleteMany({ where: { nasId: { in: nas.map((n) => n.id) } } }).catch(() => null);
    await this.prisma.nas.deleteMany({ where: { ownerId } }).catch(() => null);
    await this.prisma.package.deleteMany({ where: { ownerId } }).catch(() => null);
    await this.prisma.ipPool.deleteMany({ where: { ownerId } }).catch(() => null);
    await this.prisma.area.deleteMany({ where: { ownerId } }).catch(() => null);
  }

  private async createBatches(model: string, data: any[]) {
    if (!data.length) return;
    for (let i = 0; i < data.length; i += this.batchSize) await (this.prisma as any)[model].createMany({ data: data.slice(i, i + this.batchSize), skipDuplicates: true });
  }
}
