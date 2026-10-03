import { TopologyController } from './topology.controller';
import { TopologyService } from './topology.service';
import { DeviceIntelService } from './device-intel.service';

/**
 * TOPOLOGY TENANCY — POST /topology/mac and POST /topology/parse.
 *
 * Both are deliberately tenant-free: an in-memory OUI lookup and a regex
 * parse of the posted string. This pins that neither touches the database,
 * the scope service or the network, so neither can leak another company's
 * data or probe its equipment.
 */
const untouchable = (name: string) =>
  new Proxy({}, { get: (_t, prop) => { throw new Error(`${name}.${String(prop)} must not be used`); } });

const ISP_A = { sub: 10, role: 'ADMIN' };

describe('Topology tenancy', () => {
  const ctl = new TopologyController(
    new TopologyService(untouchable('prisma') as any, untouchable('scope') as any),
    new DeviceIntelService(untouchable('prisma') as any, untouchable('scope') as any),
  );

  it('mac is a pure OUI lookup', () => {
    const r = ctl.mac({ mac: 'aa-bb-cc-dd-ee-ff' }, { user: ISP_A });
    expect(r).toMatchObject({ mac: 'AA:BB:CC:DD:EE:FF', oui: 'AABBCC' });
  });

  it('parse is a pure circuit-id parse', () => {
    const r = ctl.parse({ circuitId: 'gpon-onu_1/2/3:4' }, { user: ISP_A });
    expect(r).toMatchObject({ matched: true, vendorGuess: 'zte', onuIndex: '4' });
  });
});
