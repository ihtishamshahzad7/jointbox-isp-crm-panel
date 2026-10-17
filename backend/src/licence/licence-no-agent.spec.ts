import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { LicenceGuard } from './licence.guard';
import { LicenceService } from './licence.service';

/**
 * No working licence (agent missing, or installed but never activated):
 * writes keep working for 48 hours from installation or from the last valid
 * licence, then stop. Reads, RADIUS and payment callbacks never stop.
 */
const DAY = 24 * 3600 * 1000;
type Inner = {
  installedAt: number | null;
  lastGood: number | null;
  current: {
    state: string;
    licensed: boolean;
    writable: boolean;
    message: string;
  } | null;
  writable: boolean;
  noLicenceDeadline: number | null;
  markGood(): void;
  loadLastGood(): void;
};
const inner = (s: LicenceService) => s as unknown as Inner;
const ctx = (method: string, url: string): ExecutionContext => {
  const c = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ method, url, originalUrl: url }),
    }),
  };
  return c as unknown as ExecutionContext;
};

function svcInstalled(ago: number, lastGoodAgo?: number): LicenceService {
  const s = new LicenceService();
  inner(s).installedAt = Date.now() - ago;
  inner(s).lastGood =
    lastGoodAgo === undefined ? null : Date.now() - lastGoodAgo;
  return s;
}

describe('licence: no agent / not activated', () => {
  it('a new install without the agent still writes during the first 2 days', () => {
    const s = svcInstalled(1 * DAY);
    expect(s.writable).toBe(true);
    expect(new LicenceGuard(s).canActivate(ctx('POST', '/subscribers'))).toBe(
      true,
    );
    expect(s.noLicenceDeadline).toBeGreaterThan(Date.now());
  });

  it('after 2 days with no agent, adding and changing records is refused', () => {
    const s = svcInstalled(3 * DAY);
    expect(s.writable).toBe(false);
    expect(() =>
      new LicenceGuard(s).canActivate(ctx('POST', '/subscribers')),
    ).toThrow(HttpException);
    expect(s.banner.level).toBe('error');
  });

  it('reads are locked too, but RADIUS sync and sign-in never are', () => {
    const g = new LicenceGuard(svcInstalled(30 * DAY));
    expect(() => g.canActivate(ctx('GET', '/subscribers'))).toThrow(
      HttpException,
    );
    expect(g.canActivate(ctx('POST', '/auth/login'))).toBe(true);
    expect(g.canActivate(ctx('POST', '/radius/sync'))).toBe(true);
  });

  it('an agent that is installed but never activated is treated the same', () => {
    const s = svcInstalled(3 * DAY);
    inner(s).current = {
      state: 'UNLICENSED',
      licensed: false,
      writable: true,
      message: '',
    };
    expect(s.writable).toBe(false);
  });

  it('a licence that was valid recently gives 2 days from that moment', () => {
    expect(svcInstalled(300 * DAY, 1 * DAY).writable).toBe(true);
    expect(svcInstalled(300 * DAY, 3 * DAY).writable).toBe(false);
  });

  it('an active licence never counts down', () => {
    const s = svcInstalled(300 * DAY);
    inner(s).current = {
      state: 'ACTIVE',
      licensed: true,
      writable: true,
      message: '',
    };
    expect(inner(s).noLicenceDeadline).toBeNull();
    expect(s.writable).toBe(true);
  });

  it('JBX_LICENCE_ENFORCE=false is ignored on a production server', () => {
    const env = { ...process.env };
    process.env.JBX_LICENCE_ENFORCE = 'false';
    process.env.NODE_ENV = 'production';
    expect(svcInstalled(30 * DAY).writable).toBe(false);
    process.env.NODE_ENV = 'test';
    expect(svcInstalled(30 * DAY).writable).toBe(true);
    process.env = env;
  });

  it('records the last valid licence on disk, and reads it back', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jbx-')), 'last');
    process.env.JBX_LICENCE_LAST_GOOD_FILE = f;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./licence.service') as {
        LicenceService: typeof LicenceService;
      };
      inner(new mod.LicenceService()).markGood();
      const b = inner(new mod.LicenceService());
      b.loadLastGood();
      expect(Math.abs((b.lastGood ?? 0) - Date.now())).toBeLessThan(5000);
    });
    delete process.env.JBX_LICENCE_LAST_GOOD_FILE;
  });
});
