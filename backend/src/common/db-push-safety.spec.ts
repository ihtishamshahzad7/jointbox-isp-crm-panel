import * as fs from 'fs';
import * as path from 'path';

/**
 * THE DB-PUSH SAFETY RATCHET (verification-phase Priority 1).
 *
 * `prisma db push --accept-data-loss` must never be reachable from an
 * unattended deployment path. A failed migration MUST fail the deployment.
 * These tests pin the three executable surfaces that used to violate that:
 *
 *   1. backend/scripts/db-push-safe.js  — hard-coded `--accept-data-loss`
 *      (removed; now also refuses NODE_ENV=production).
 *   2. update-jointbox.sh               — bare `prisma db push` fallback when
 *      `migrate deploy` failed (removed; migrate deploy failure now stops the
 *      update via the ERR trap).
 *   3. backend/package.json scripts     — any re-introduced flag/script.
 *
 * Why a guard needs its own tests: the CI grep is the only other net, and a
 * silent re-introduction (new script, renamed command, nested helper) would
 * ship with no symptom until the next destructive deploy.
 */
describe('db push safety ratchet', () => {
  const backend = path.join(__dirname, '..', '..');
  const root = path.join(backend, '..');
  const pushScript = path.join(backend, 'scripts', 'db-push-safe.js');
  const updateScript = path.join(root, 'update-jointbox.sh');
  const pkg = JSON.parse(fs.readFileSync(path.join(backend, 'package.json'), 'utf8'));

  const read = (p: string) => fs.readFileSync(p, 'utf8');

  it('db-push-safe.js never passes the data-loss acceptance flag', () => {
    // Match the executable arg form only (quoted), so explanatory comments
    // cannot trip the ratchet — the same self-matching failure the unbounded
    // query guard documented.
    expect(read(pushScript)).not.toMatch(/["']--accept-data-loss["']/);
    expect(read(pushScript)).not.toMatch(/accept-data-loss/);
  });

  it('db-push-safe.js refuses to run when NODE_ENV=production', () => {
    const src = read(pushScript);
    expect(src).toMatch(/NODE_ENV\s*===\s*['"]production['"]/);
  });

  it('db-push-safe.js still blocks while the RADIUS schema is present', () => {
    const src = read(pushScript);
    expect(src).toMatch(/nspname\s*=\s*'radius'/);
  });

  it('update-jointbox.sh never falls back to the Prisma push tool', () => {
    const src = read(updateScript);
    expect(src).not.toMatch(/prisma db push|db:push/);
    expect(src).not.toMatch(/accept-data-loss/);
  });

  it('update-jointbox.sh still applies migrations via migrate deploy', () => {
    const src = read(updateScript);
    expect(src).toMatch(/prisma migrate deploy/);
  });

  it('update-jointbox.sh stops the deployment when migrate deploy fails', () => {
    const src = read(updateScript);
    // The `prisma migrate deploy` line must NOT be guarded by an `if` that
    // swallows the failure — a plain command failing under `set -e` trips the
    // ERR trap (fail()) and exits 1, stopping the update safely.
    const window = src.slice(src.indexOf('Applying database migrations'), src.indexOf('Building backend'));
    expect(window).toMatch(/^\(cd backend && npx prisma migrate deploy\)$/m);
    expect(window).not.toMatch(/^if !/m);
  });

  it('package.json scripts never contain --accept-data-loss', () => {
    const scripts = JSON.stringify(pkg.scripts ?? {});
    expect(scripts).not.toMatch(/accept-data-loss/);
  });

  it('package.json keeps db:deploy as the canonical production migration path', () => {
    expect(pkg.scripts['db:deploy'] ?? '').toContain('db-deploy.sh');
  });
});