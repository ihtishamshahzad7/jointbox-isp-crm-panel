import * as fs from 'fs';
import * as path from 'path';
import { RouterLogScope } from './logs.service';

/**
 * A router's log names every customer on it — the ISP's and every franchise
 * the router is shared with. A subscriber's log shows only lines naming that
 * subscriber; an account the router was shared with sees only its customers.
 */
describe('router log scoping', () => {
  it('matches the username as a whole word, including the pppoe- form', () => {
    expect(RouterLogScope.mentions('<pppoe-ali01>: authenticated', 'ali01')).toBe(true);
    expect(RouterLogScope.mentions('ali01 logged in, 10.50.0.9', 'ALI01')).toBe(true);
    expect(RouterLogScope.mentions('ali012 logged in', 'ali01')).toBe(false);
    expect(RouterLogScope.mentions('sara02 logged out', 'ali01')).toBe(false);
  });

  it('the per-subscriber log is filtered; the router console scopes shared routers', () => {
    const src = fs.readFileSync(path.join(__dirname, 'logs.service.ts'), 'utf8');
    expect(src).toMatch(/\.filter\(\(line: any\) => !!uname && RouterLogScope\.mentions\(line\?\.message, uname\)\)/);
    expect(src).toMatch(/getRouterLogsForNas[\s\S]{0,200}assertNas\(actor, nasId\)/);
    expect(src).toMatch(/const ownsRouter = this\.scope\.isOwner/);
  });
});

describe('rate limits', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
  it('the tight bucket covers credential attempts only, not the profile check every screen makes', () => {
    expect(main).toMatch(/req\.method === 'POST' &&/);
    expect(main).toMatch(/auth\\\/\(login\|refresh\|verify\|change-password\)/);
    expect(main).not.toMatch(/const sensitive = \/\^\\\/\(auth\|demo\)\\b\/\.test\(path\)/);
  });
  it('event streams are not throttled', () => {
    expect(main).toMatch(/if \(path\.startsWith\('\/events'\)\) return next\(\);/);
  });
});
