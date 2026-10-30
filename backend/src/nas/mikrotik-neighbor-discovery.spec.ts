import { MikrotikSyncService } from './mikrotik-sync.service';

const mockSend = jest.fn();
jest.mock('./mikrotik.client', () => ({
  withMikrotik: jest.fn(async (_config: unknown, run: (client: unknown) => unknown) =>
    run({ send: mockSend }),
  ),
}));

describe('MikroTik neighbor discovery', () => {
  beforeEach(() => mockSend.mockReset());

  it('merges the router-reported neighbor and ARP tables without scanning addresses', async () => {
    mockSend
      .mockResolvedValueOnce([
        {
          address: '10.0.0.8',
          'mac-address': 'AA:BB:CC:DD:EE:FF',
          interface: 'ether1',
          identity: 'olt-west',
          platform: 'GPON OLT',
        },
      ])
      .mockResolvedValueOnce([
        {
          address: '10.0.0.8',
          'mac-address': 'AA:BB:CC:DD:EE:FF',
          interface: 'vlan100',
        },
        {
          address: '10.0.0.9',
          'mac-address': '11:22:33:44:55:66',
          interface: 'vlan100',
        },
      ]);

    const service = new MikrotikSyncService();
    const result = await service.discoverNeighbors(
      '10.0.0.1',
      8728,
      'readonly',
      'encrypted-password',
    );

    expect(mockSend.mock.calls.map(([command]) => command)).toEqual([
      ['/ip/neighbor/print'],
      ['/ip/arp/print'],
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      address: '10.0.0.8',
      identity: 'olt-west',
      kind: 'olt',
      source: ['router-neighbor', 'arp'],
    });
    expect(result[1]).toMatchObject({
      address: '10.0.0.9',
      kind: 'unknown',
      source: ['arp'],
    });
  });

  it('rejects on a router table error instead of returning a success-shaped empty list', async () => {
    mockSend.mockRejectedValueOnce(new Error('read permission denied'));

    await expect(
      new MikrotikSyncService().discoverNeighbors(
        '10.0.0.1',
        8728,
        'readonly',
        'encrypted-password',
      ),
    ).rejects.toThrow('read permission denied');
  });
});
