/** Every router is monitored automatically (Network Monitoring follows the router list). */
import { NasService } from './nas.service';

function make(monitors: any[] = []) {
  const rows = [...monitors];
  const mt: any = {
    findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.nasId === where.nasId) ?? null),
    findFirst: jest.fn(async ({ where }: any) => rows.find((r) => r.host === where.host && r.ownerId === where.ownerId && r.nasId == null) ?? null),
    create: jest.fn(async ({ data }: any) => { rows.push({ id: rows.length + 1, ...data }); }),
    update: jest.fn(async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id), data)),
  };
  const svc = new NasService({ monitorTarget: mt } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { sync: (n: any) => (svc as any).syncMonitor(n), rows, mt };
}

describe('NAS → Network Monitoring', () => {
  it('a new router gets a ping monitor, owned like the router', async () => {
    const { sync, rows } = make();
    await sync({ id: 7, nasIp: '10.68.0.2', shortname: 'Eht-M', ownerId: 3 });
    expect(rows).toEqual([expect.objectContaining({ host: '10.68.0.2', name: 'Eht-M', groupName: 'Routers', ownerId: 3, nasId: 7 })]);
  });
  it('follows a changed IP or name, never duplicates', async () => {
    const { sync, rows } = make();
    await sync({ id: 7, nasIp: '10.68.0.2', shortname: 'A', ownerId: 3 });
    await sync({ id: 7, nasIp: '10.68.0.9', shortname: 'B', ownerId: 3 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ host: '10.68.0.9', name: 'B' });
  });
  it('links a monitor the owner already had for that IP instead of adding a second', async () => {
    const { sync, rows } = make([{ id: 1, host: '192.168.1.15', ownerId: 3, nasId: null, name: 'mine' }]);
    await sync({ id: 7, nasIp: '192.168.1.15', shortname: 'R', ownerId: 3 });
    expect(rows).toHaveLength(1);
    expect(rows[0].nasId).toBe(7);
  });
  it('a monitoring failure never blocks saving the router', async () => {
    const { sync, mt } = make();
    mt.create.mockRejectedValue(new Error('db down'));
    await expect(sync({ id: 7, nasIp: '1.2.3.4', ownerId: 3 })).resolves.toBeUndefined();
  });
});
