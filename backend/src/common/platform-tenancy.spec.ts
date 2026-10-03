import * as fs from 'fs';
import * as path from 'path';

/**
 * ONE PANEL, SEVERAL ISP COMPANIES.
 *
 * SUPER_ADMIN is the platform operator. ADMIN is a tenant: an ISP company with
 * its own franchise/dealer/retailer tree, invisible to every other ADMIN.
 *
 * Isolation between tenants comes from ScopeService — ADMIN is deliberately
 * NOT in ADMIN_ROLES, so it is scoped by its own subtree like any other
 * account. That one line is load-bearing for the whole product: adding 'ADMIN'
 * to it would, in a single edit, show every ISP every other ISP's subscribers,
 * money and routers. The first test here exists to make that edit impossible
 * to make quietly.
 *
 * The rest guard the surfaces that belong to the INSTALLATION rather than to
 * any company on it. These are checked by reading the source, not by calling
 * the routes, because the failure being prevented is someone widening a role
 * check while refactoring — a behavioural test on one route cannot see that.
 */
const SRC = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');

describe('platform owner vs ISP tenant', () => {
  it('does not treat ADMIN as unscoped — tenant isolation depends on it', () => {
    const src = read('common/scope.service.ts');
    const m = src.match(/const ADMIN_ROLES = \[([^\]]*)\]/);
    expect(m).toBeTruthy();
    expect(m![1]).toContain('SUPER_ADMIN');
    expect(m![1]).not.toContain('ADMIN_'); // guard against a renamed constant
    expect(m![1].replace(/SUPER_ADMIN/g, '')).not.toMatch(/'ADMIN'/);
  });

  /**
   * A pg_dump is the whole database, every tenant in it. There is no scoped
   * version of this route to fall back to, so it must stay shut to ADMIN.
   */
  it('keeps database backups to the platform owner', () => {
    const src = read('common/backup.controller.ts');
    expect(src).toMatch(/role !== 'SUPER_ADMIN'/);
    expect(src).not.toMatch(/role !== 'ADMIN'/);
  });

  /**
   * The licence covers the installation, and its subscriber count is the total
   * across every company on the panel — publishing it to one tenant tells them
   * how large their competitors are.
   */
  it('keeps licence status, refresh and activation to the platform owner', () => {
    const src = read('licence/licence.controller.ts');
    expect(src).toMatch(/assertPlatformOwner/);
    // Every route in the controller calls it.
    const routes = src.match(/@(Get|Post)\(/g) || [];
    const calls = src.match(/this\.assertPlatformOwner\(req\)/g) || [];
    expect(calls.length).toBe(routes.length);
  });

  it('keeps server stats and queue depth to the platform owner', () => {
    const src = read('app.controller.ts');
    expect(src).not.toMatch(/role !== 'SUPER_ADMIN' && role !== 'ADMIN'/);
  });

  /**
   * An ADMIN creating an ADMIN would place a second company INSIDE the first
   * one's subtree, which is exactly the containment the tree provides.
   */
  it('lets only the platform owner create an ISP company', () => {
    const src = read('users/users.service.ts');
    const m = src.match(/NEXT_ROLE[^=]*=\s*\{([\s\S]*?)\};/);
    expect(m).toBeTruthy();
    const map = m![1];
    const superLine =
      map.split('\n').find((l) => l.includes('SUPER_ADMIN:')) || '';
    const adminLine = map.split('\n').find((l) => /^\s*ADMIN:/.test(l)) || '';
    expect(superLine).toContain("'ADMIN'");
    expect(adminLine).not.toContain("'ADMIN'");
  });

  /**
   * Singletons are the trap this whole separation keeps walking into: a table
   * with `id: 1`, or a settings key with no owner column, is by definition
   * shared by every company on the panel. Letting a tenant write one does not
   * give them their own copy — it gives them everyone's.
   */
  it('closes books per company, never one company for all', () => {
    const acct = read('accounting/accounting.controller.ts');
    const periodLock = acct.slice(acct.indexOf("@Put('period-lock')"), acct.indexOf("@Put('period-lock')") + 300);
    expect(periodLock).toMatch(/setPeriodLock\([^)]*req\.user\)/);
    const svc = read('accounting/accounting.service.ts');
    expect(svc).toMatch(/companyPeriodLock\.upsert/);
    expect(svc).toMatch(/configOwnerForCreate\(actor\)/); // franchises/dealers refused

    const notif = read('notifications/notifications.controller.ts');
    expect(notif).not.toMatch(/role !== 'SUPER_ADMIN' && role !== 'ADMIN'/);
  });

  /**
   * The refund queue returns money records. Unscoped, it showed one ISP the
   * refunds pending inside another.
   */
  it('scopes the refund approval queue to the caller subtree', () => {
    const src = read('accounting/accounting.service.ts');
    expect(src).toMatch(/approvalScope/);
    expect(src).toMatch(/getPendingApprovals\(actor\?: Actor\)/);
    expect(src).toMatch(
      /listRefundRequests\(status = 'PENDING', actor\?: Actor\)/,
    );
    const ctl = read('accounting/accounting.controller.ts');
    expect(ctl).toMatch(/getPendingApprovals\(req\.user\)/);
    expect(ctl).toMatch(/listRefundRequests\([^)]*req\.user\)/);
  });

  /**
   * A public sign-up used to land on the platform owner, because the owner was
   * found with `role: 'SUPER_ADMIN'` and `orderBy: { id: 'asc' }`. With several
   * ISPs on one panel that files a real paying customer under the wrong
   * business — quietly, surfacing weeks later as a billing dispute.
   */
  it('attributes a portal sign-up to the package owner, not the platform owner', () => {
    const src = read('portal/portal.service.ts');
    expect(src).toMatch(/resolveSignupOwner/);
    expect(src).toMatch(/userId: ownerId/);
    // The old shortcut must be gone from the registration path.
    const reg = src.slice(
      src.indexOf('async selfRegister'),
      src.indexOf('resolveSignupOwner('),
    );
    expect(reg).not.toMatch(/role: 'SUPER_ADMIN'/);
  });

  /**
   * 500 synthetic routers appeared in a real operator's NAS list although the
   * owner-based filter was correct: the flag it trusted (owner.isDemo) was
   * gone. The row-level marker makes exclusion independent of ownership — but
   * only while the seeder and the filter spell it the same way.
   */
  it('pins the seeder demo marker to the constant the filters use', () => {
    const scope = read('common/scope.service.ts');
    const m = scope.match(/export const DEMO_NAS_SERVER = '([^']+)'/);
    expect(m).toBeTruthy();
    const seeder = read('demo/demo-data.service.ts');
    const usesConst = /server:\s*DEMO_NAS_SERVER/.test(seeder);
    const usesLiteral = seeder.includes(`server: '${m![1]}'`);
    expect(usesConst || usesLiteral).toBe(true);
  });

  it('excludes marked demo routers from the pollers and the platform view', () => {
    const scope = read('common/scope.service.ts');
    const fragment = scope.slice(
      scope.indexOf('export const NON_DEMO_OWNED'),
      scope.indexOf('export const NON_DEMO_OWNED') + 400,
    );
    expect(fragment).toMatch(/NOT_DEMO_MARKED/);
    const nasWhere = scope.slice(
      scope.indexOf('async nasWhere'),
      scope.indexOf('async poolWhere'),
    );
    expect(nasWhere).toMatch(/NOT_DEMO_MARKED/);
    // Nullable column: the marker filter must keep NULL server rows explicitly.
    expect(scope).toMatch(/\{ server: null \}/);
  });

  /**
   * radpostauth carries no owner. Unscoped accept/reject totals showed every
   * company's login traffic to all of them.
   */
  it('scopes RADIUS accept/reject totals to the caller', () => {
    const sync = read('nas/radius-sync.service.ts');
    expect(sync).toMatch(/getAuthStats\(scope\?: number\[\] \| null\)/);
    const nas = read('nas/nas.service.ts');
    expect(nas).toMatch(/getAuthStats\(scope\)/);
  });

  /**
   * Nothing in the auth path read isActive, so every "suspend" and
   * "deactivate" in the product changed a column no request consulted.
   */
  it('refuses suspended accounts at login, refresh and on every request', () => {
    const auth = read('auth/auth.service.ts');
    const login = auth.slice(
      auth.indexOf('async login('),
      auth.indexOf('async refreshToken'),
    );
    expect(login).toMatch(/user\.isActive === false/);
    const refresh = auth.slice(auth.indexOf('async refreshToken'));
    expect(refresh.slice(0, 900)).toMatch(/user\.isActive === false/);
    // Refresh must keep the demo claim, or a demo session sheds its guard.
    expect(refresh.slice(0, 1400)).toMatch(/isDemo:/);
    const strat = read('auth/jwt.strategy.ts');
    expect(strat).toMatch(/accountStatus\(/);
    expect(strat).toMatch(/!status\.active/);
    expect(strat).toMatch(/PASSWORD_CHANGE_REQUIRED/);
  });

  it('suspends a whole subtree, not just one login', () => {
    expect(read('auth/account-status.ts')).toMatch(/bool_and\("isActive"\)/);
  });

  it('never prints the bootstrap password and forces it to be changed', () => {
    const main = read('main.ts');
    const boot = main.slice(
      main.indexOf('async function ensureDefaultAdmin'),
      main.indexOf('function validateEnv'),
    );
    expect(boot).not.toMatch(/\$\{password\}/);
    expect(boot).toMatch(/mustChangePassword: true/);
  });

  /**
   * The capacity query named "Nas", but the model maps to the FreeRADIUS table
   * `nas` — so it threw, failed open, and the router cap never applied.
   */
  it('checks plan capacity against the real tables, without the sandbox', () => {
    const cap = read('licence/licence-capacity.service.ts');
    expect(cap).not.toMatch(/FROM "\$\{table\}"/);
    expect(cap).not.toMatch(/FROM "Nas"/);
    expect(cap).toMatch(/FROM nas n/);
    expect(cap).toMatch(/isDemo" = true/);
    const counts = read('licence/licence-counts.service.ts');
    expect(counts).toMatch(/NON_DEMO_SUBSCRIBER/);
    expect(counts).toMatch(/NON_DEMO_OWNED/);
  });

  /**
   * On by default, the sandbox put 10,000 invented subscribers and a published
   * login into every customer's production database.
   */
  it('keeps the demo sandbox opt-in', () => {
    const demo = read('demo/demo.service.ts');
    expect(demo).toMatch(/DEMO_PUBLIC === '1'/);
    expect(demo).not.toMatch(/DEMO_PUBLIC !== '0'/);
    expect(read('demo/demo-repair.service.ts')).not.toMatch(
      /DEMO_PUBLIC === '0'/,
    );
  });
});
