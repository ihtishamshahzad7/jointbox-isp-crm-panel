import { Controller, Get, Post, Module, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LicenceGuard } from './licence.guard';
import { LicenceService, LicenceState } from './licence.service';

/**
 * Proves the guard actually intercepts.
 *
 * The unit tests call `canActivate` directly, which tells us the logic is
 * right but not that it RUNS. An APP_GUARD registered inside a @Global()
 * module applying to controllers in other modules is a Nest wiring detail —
 * if it silently did not apply, every unit test would still pass and
 * enforcement would simply never happen in production.
 *
 * So this boots a real Nest app with controllers in a separate module and
 * makes real HTTP requests.
 */

@Controller('subscribers')
class FakeSubscribersController {
  @Get()
  list() {
    return { ok: true, via: 'read' };
  }

  @Post()
  create() {
    return { ok: true, via: 'write' };
  }

  @Post(':id/sync-to-radius')
  syncToRadius() {
    return { ok: true, via: 'radius-sync' };
  }
}

@Controller('network')
class FakeNetworkController {
  @Post('disconnect/:username')
  disconnect() {
    return { ok: true, via: 'coa' };
  }

  @Post('bandwidth/:id')
  bandwidth() {
    return { ok: true, via: 'coa' };
  }
}

@Controller('gateway')
class FakeGatewayController {
  @Post('callback/easypaisa')
  callback() {
    return { ok: true, via: 'webhook' };
  }
}

/** A module that knows nothing about licensing — the realistic case. */
@Module({
  controllers: [FakeSubscribersController, FakeNetworkController, FakeGatewayController],
})
class FeatureModule {}

/** Lets a test drive the licence state without a real agent. */
class StubLicenceService {
  current: LicenceState = 'ACTIVE';
  get state(): LicenceState {
    return this.current;
  }
  get banner() {
    return { level: 'error' as const, message: 'This licence has expired.' };
  }
}

describe('LicenceGuard applied globally (integration)', () => {
  let app: INestApplication;
  let licence: StubLicenceService;

  beforeAll(async () => {
    delete process.env.JBX_LICENCE_ENFORCE;
    licence = new StubLicenceService();

    const moduleRef = await Test.createTestingModule({
      imports: [FeatureModule],
      providers: [
        { provide: LicenceService, useValue: licence },
        { provide: APP_GUARD, useClass: LicenceGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('when licensed', () => {
    beforeEach(() => {
      licence.current = 'ACTIVE';
    });

    it('allows reads', async () => {
      await request(app.getHttpServer()).get('/subscribers').expect(200);
    });

    it('allows writes', async () => {
      await request(app.getHttpServer()).post('/subscribers').expect(201);
    });
  });

  describe('when the licence has expired', () => {
    beforeEach(() => {
      licence.current = 'EXPIRED';
    });

    it('THE GUARD ACTUALLY RUNS: creating a subscriber is refused with 402', async () => {
      const res = await request(app.getHttpServer()).post('/subscribers').expect(402);
      expect(res.body.error).toBe('LICENCE_REQUIRED');
      expect(res.body.state).toBe('EXPIRED');
    });

    it('reading subscribers still works', async () => {
      const res = await request(app.getHttpServer()).get('/subscribers').expect(200);
      expect(res.body.via).toBe('read');
    });

    // ── the ones that must never break ──────────────────────────────────
    it('RADIUS sync still works', async () => {
      const res = await request(app.getHttpServer())
        .post('/subscribers/1234/sync-to-radius')
        .expect(201);
      expect(res.body.via).toBe('radius-sync');
    });

    it('CoA disconnect still works', async () => {
      const res = await request(app.getHttpServer())
        .post('/network/disconnect/ali')
        .expect(201);
      expect(res.body.via).toBe('coa');
    });

    it('CoA bandwidth change still works', async () => {
      await request(app.getHttpServer()).post('/network/bandwidth/99').expect(201);
    });

    it('payment gateway callbacks still work', async () => {
      // If this broke, an expired customer could not even pay to renew.
      await request(app.getHttpServer()).post('/gateway/callback/easypaisa').expect(201);
    });
  });

  describe('when the agent is unavailable', () => {
    beforeEach(() => {
      licence.current = 'UNAVAILABLE';
    });

    it('everything still works — our outage is not the customer’s problem', async () => {
      await request(app.getHttpServer()).get('/subscribers').expect(200);
      await request(app.getHttpServer()).post('/subscribers').expect(201);
      await request(app.getHttpServer()).post('/network/disconnect/ali').expect(201);
    });
  });

  describe('when the panel has been tampered with', () => {
    beforeEach(() => {
      licence.current = 'TAMPERED';
    });

    it('writes are refused but the network is untouched', async () => {
      await request(app.getHttpServer()).post('/subscribers').expect(402);
      await request(app.getHttpServer()).post('/network/disconnect/ali').expect(201);
      await request(app.getHttpServer()).post('/subscribers/1/sync-to-radius').expect(201);
    });
  });

  describe('the kill switch', () => {
    afterEach(() => {
      delete process.env.JBX_LICENCE_ENFORCE;
    });

    it('JBX_LICENCE_ENFORCE=false lets everything through', async () => {
      licence.current = 'EXPIRED';
      process.env.JBX_LICENCE_ENFORCE = 'false';
      await request(app.getHttpServer()).post('/subscribers').expect(201);
    });
  });
});
