import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * THE UNBOUNDED-QUERY RATCHET, TESTED.
 *
 * WHY A GUARD NEEDS ITS OWN TESTS
 * This script is the only thing standing between the codebase and the next
 * `findMany` that loads a million rows into the worker heap. If it silently
 * stops detecting anything — a regex that matches nothing, a baseline that
 * swallows everything — the build stays green and the protection is gone with
 * no symptom at all. A guard that fails open is worse than no guard, because
 * it is trusted.
 *
 * TWO BUGS THESE TESTS EXIST BECAUSE OF
 * Both were found while building the tool, and both made it report the
 * opposite of the truth:
 *
 *   1. It matched its OWN DOCUMENTATION. `reports.service.ts` contains a
 *      comment explaining the original `payment.findMany()` defect, and the
 *      scanner flagged that prose as a live query — reporting a bug in the
 *      one file where it had just been fixed.
 *
 *   2. It missed SHORTHAND narrowing. `where: { subscriberId }` is one of the
 *      safest queries you can write, and the narrowing check required a colon,
 *      so every shorthand usage was reported as unbounded.
 *
 * Between them those two produced 10 false positives out of 28 findings. False
 * positives are the specific failure that kills a tool like this: people stop
 * reading the output, then stop running it.
 */
describe('unbounded query ratchet', () => {
  const backend = path.join(__dirname, '..', '..');
  const script = path.join(backend, 'scripts', 'audit-unbounded-queries.js');
  const probe = path.join(backend, 'src', '__ratchet_probe_spec.ts');

  const run = () => {
    try {
      return { code: 0, out: execFileSync('node', [script], { cwd: backend, encoding: 'utf8' }) };
    } catch (e: any) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  const withProbe = (source: string) => {
    fs.writeFileSync(probe, source);
    try {
      return run();
    } finally {
      fs.rmSync(probe, { force: true });
    }
  };

  afterEach(() => fs.rmSync(probe, { force: true }));

  it('the committed baseline is currently clean', () => {
    // If this fails, someone added an unbounded query on a growth table.
    const { code, out } = run();
    expect(out).toMatch(/No new unbounded queries/);
    expect(code).toBe(0);
  });

  it('catches a NEW unbounded query on a growth table', () => {
    const { code, out } = withProbe(
      `export const f = (p: any) => p.payment.findMany({ where: { method: 'CASH' } });`,
    );
    expect(code).toBe(1);
    expect(out).toMatch(/payment\.findMany/);
  });

  it('accepts the same query once it has a take', () => {
    const { code } = withProbe(
      `export const f = (p: any) => p.payment.findMany({ where: { method: 'CASH' }, take: 100 });`,
    );
    expect(code).toBe(0);
  });

  it('accepts a query narrowed by an owning id', () => {
    const { code } = withProbe(`export const f = (p: any) => p.payment.findMany({ where: { subscriberId: 7 } });`);
    expect(code).toBe(0);
  });

  it('REGRESSION: accepts SHORTHAND narrowing', () => {
    // `where: { subscriberId }` — the form used by findBySubscriber, and the
    // one the first version of the narrowing regex could not see.
    const { code, out } = withProbe(
      `export const f = (p: any, subscriberId: number) => p.invoice.findMany({ where: { subscriberId } });`,
    );
    expect(out).not.toMatch(/invoice\.findMany/);
    expect(code).toBe(0);
  });

  it('REGRESSION: does not match a query written inside a COMMENT', () => {
    const { code, out } = withProbe(
      `/** This used to call payment.findMany() with no take — see the audit. */\n` +
        `export const f = (p: any) => p.payment.findMany({ take: 10 });`,
    );
    expect(out).not.toMatch(/__ratchet_probe/);
    expect(code).toBe(0);
  });

  it('does not match a query written inside a STRING', () => {
    const { code } = withProbe(
      `export const doc = "avoid payment.findMany({ where }) without take";\nexport const n = 1;`,
    );
    expect(code).toBe(0);
  });

  it('ignores config tables, which are bounded by the ISP catalogue', () => {
    // `package.findMany()` returns dozens of rows. Flagging it is noise, and
    // noise is what stops people reading real findings.
    const { code } = withProbe(`export const f = (p: any) => p.package.findMany({ where: { active: true } });`);
    expect(code).toBe(0);
  });

  it('is not confused by nested objects in the argument list', () => {
    // A regex scanning to the next ')' would stop inside the nested select and
    // conclude there is no `take`, reporting a bounded query as unbounded.
    const { code } = withProbe(
      `export const f = (p: any) => p.payment.findMany({ ` +
        `where: { method: 'CASH' }, select: { user: { select: { name: true } } }, take: 50 });`,
    );
    expect(code).toBe(0);
  });

  it('reports how to fix it, not merely that it is wrong', () => {
    // An error that does not say what to do next gets worked around by
    // whatever is quickest, which here means adding it to the baseline.
    const { out } = withProbe(`export const f = (p: any) => p.subscriber.findMany({ where: {} });`);
    expect(out).toMatch(/take:/);
    expect(out).toMatch(/parseCursor/);
  });

  it('the baseline is a list of strings, not line numbers', () => {
    /**
     * Keyed by file+model deliberately. Keying on line numbers would make the
     * baseline churn on every unrelated edit above a finding, producing
     * conflicts on every merge until somebody deleted the file.
     */
    const baseline = JSON.parse(
      fs.readFileSync(path.join(backend, 'scripts', 'unbounded-queries-baseline.json'), 'utf8'),
    );
    expect(Array.isArray(baseline)).toBe(true);
    expect(baseline.every((e: string) => /^src\/.+::\w+$/.test(e))).toBe(true);
    expect(baseline.join()).not.toMatch(/:\d+/);
  });
});
