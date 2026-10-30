import { BadGatewayException, ForbiddenException } from '@nestjs/common';
import { NasService } from './nas.service';

describe('NAS VPN neighbor discovery', () => {
  const owner = { sub: 10, role: 'ADMIN' };

  function makeService(ownerId = 10) {
    const nas = {
      id: 42,
      ownerId,
      shortname: 'branch-42',
    };
    const prisma: any = {
      nas: {
        findFirst: jest.fn().mockResolvedValue(nas),
        findUnique: jest.fn().mockResolvedValue({
          id: 42,
          shortname: 'branch-42',
          nasIp: '10.0.0.42',
          apiEnabled: true,
          apiPort: 8728,
          apiUsername: 'router-api',
          apiPassword: 'enc:router-password',
          isActive: true,
        }),
      },
    };
    const mikrotikSync: any = {
      discoverNeighbors: jest.fn().mockResolvedValue([
        {
          address: '10.0.0.8',
          macAddress: 'AA:BB:CC:DD:EE:FF',
          interface: 'ether1',
          identity: 'olt-west',
          platform: 'GPON OLT',
          version: null,
          source: ['router-neighbor'],
          kind: 'olt',
        },
      ]),
    };
    const scope: any = {
      isAdmin: (role: string) => role === 'SUPER_ADMIN',
      nasWhere: jest.fn().mockResolvedValue({ ownerId: 10 }),
      actorId: (actor: any) => Number(actor?.sub),
    };
    const service = new NasService(
      prisma,
      mikrotikSync,
      {} as any,
      scope,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, prisma, mikrotikSync };
  }

  it('reads only the selected NAS tables and labels results as non-scanning discovery', async () => {
    const { service, mikrotikSync } = makeService();
    const result = await service.discoverNeighbors(42, owner);

    expect(mikrotikSync.discoverNeighbors).toHaveBeenCalledWith(
      '10.0.0.42',
      8728,
      'router-api',
      'enc:router-password',
    );
    expect(result).toMatchObject({
      nasId: 42,
      source: ['RouterOS neighbor table', 'RouterOS ARP table'],
      activeScan: false,
      count: 1,
      neighbors: [{ kind: 'olt', address: '10.0.0.8' }],
    });
  });

  it('refuses discovery on a NAS the caller does not own', async () => {
    const { service, mikrotikSync, prisma } = makeService(99);

    await expect(service.discoverNeighbors(42, owner)).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.nas.findUnique).not.toHaveBeenCalled();
    expect(mikrotikSync.discoverNeighbors).not.toHaveBeenCalled();
  });

  it('does not turn a failed RouterOS connection into an empty success', async () => {
    const { service, mikrotikSync } = makeService();
    mikrotikSync.discoverNeighbors.mockRejectedValue(new Error('permission denied'));

    await expect(service.discoverNeighbors(42, owner)).rejects.toThrow(
      BadGatewayException,
    );
  });
});
