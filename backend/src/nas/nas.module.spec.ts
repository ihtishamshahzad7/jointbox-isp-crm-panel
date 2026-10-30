import { Test, TestingModule } from '@nestjs/testing';
import { ScheduleModule } from '@nestjs/schedule';
import { NasL2tpConfigService } from './nas-l2tp-config.service';
import { NasModule } from './nas.module';
import { VpnService } from '../vpn/vpn.service';
import { LicenceModule } from '../licence/licence.module';

describe('NasModule dependency injection', () => {
  let moduleRef: TestingModule | undefined;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot(), LicenceModule, NasModule],
    }).compile();
  });

  afterAll(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it('resolves NasL2tpConfigService with the VpnService from VpnModule', () => {
    if (!moduleRef) {
      throw new Error('NasModule test module was not compiled');
    }

    const nasL2tpConfig = moduleRef.get(NasL2tpConfigService);
    const vpn = moduleRef.get(VpnService);

    expect(nasL2tpConfig).toBeInstanceOf(NasL2tpConfigService);
    expect(Reflect.get(nasL2tpConfig, 'vpn')).toBe(vpn);
  });
});
