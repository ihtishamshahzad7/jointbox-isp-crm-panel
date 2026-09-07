#!/usr/bin/env node
/**
 * UNBOUNDED QUERY RATCHET.
 *
 * THE BUG CLASS
 * `prisma.<model>.findMany({ where })` with no `take` and no `cursor` loads
 * every matching row into the Node heap. On a config table that is nothing. On
 * a table that grows with subscriber count or with time it is an outage — the
 * worker exceeds `max_memory_restart: 600M` and is killed, taking every other
 * in-flight request with it. Two instances of this have already been fixed
 * (`getRevenueReport`, `InvoicesService.findAll`); the pattern recurs because
 * nothing stops it recurring.
 *
 * WHY A RATCHET AND NOT A LINT RULE THAT FAILS THE BUILD
 * There are ~268 unbounded `findMany` calls in this codebase today, of which
 * ~36 are on risk-bearing tables. A rule that fails on all of them is a rule
 * that gets switched off in week one — the same mistake as pointing a blocking
 * lint gate at 1,300 pre-existing errors. So this tool compares against a
 * committed baseline: everything already here is tolerated, and anything NEW
 * fails. The count can go down and never up, and the fix costs one line at the
 * moment the code is written rather than an archaeology exercise later.
 *
 * WHY IT ONLY WATCHES SOME MODELS
 * `package.findMany()` returns as many rows as the ISP has packages — dozens.
 * Flagging it is noise, and noise is what makes people stop reading the
 * output. Only tables whose size is driven by subscribers or by elapsed time
 * are watched.
 *
 *   node scripts/audit-unbounded-queries.js            # check against baseline
 *   node scripts/audit-unbounded-queries.js --update   # accept current state
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const BASELINE = path.join(__dirname, 'unbounded-queries-baseline.json');

/**
 * Tables that grow with subscriber count or with time. Everything absent from
 * this list is configuration, bounded by the size of the ISP's own catalogue.
 */
const RISK_MODELS = new Set([
  'subscriber', 'payment', 'invoice', 'userBalanceTransaction', 'sessionLog',
  'pppoeSession', 'networkEvent', 'interfaceTrafficHistory', 'deviceHealthMetric',
  'nasTrafficSample', 'monitorSample', 'onuTelemetry', 'onuSignalSample',
  'interfaceStatusHistory', 'networkLog', 'gatewayTransaction', 'alert',
  'radCheck', 'radAcct', 'radPostAuth', 'voucher', 'staticIp', 'ticket',
  'profitEntry', 'proRatedBilling', 'inventoryMovement', 'subscriberTransfer',
  'creditExtension', 'recordNote', 'auditLog',
]);

/**
 * Narrowing to a single owner bounds the result however large the table gets.
 *
 * Matches BOTH `{ subscriberId: x }` and the shorthand `{ subscriberId }`.
 * Requiring the colon missed every shorthand usage — `findBySubscriber` was
 * reported as unbounded when `where: { subscriberId }` makes it one of the
 * safest queries in the file. False positives on correct code are what teach
 * people to ignore the tool.
 */
const NARROWING_KEY =
  /\b(id|subscriberId|userId|username|invoiceId|nasId|deviceId|ticketId|packageId)\s*[:,}]/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

/**
 * Blank out comments and string literals, preserving byte offsets.
 *
 * Without this the scanner matches its own documentation. `reports.service.ts`
 * carries a comment explaining the original `payment.findMany()` defect, and
 * the naive regex flagged that prose as a live unbounded query — reporting a
 * bug in a file where the bug had just been fixed. A tool that cries wolf on
 * the very comment describing the fix is a tool people stop running.
 *
 * Offsets are preserved (characters are replaced, never removed) so reported
 * positions still line up with the real file.
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
      out += quote + blank(src.slice(i + 1, j)) + (src[j] ?? '');
      i = j + 1;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

function findingsFor(file) {
  const src = stripCommentsAndStrings(fs.readFileSync(file, 'utf8'));
  const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
  const out = [];
  const re = /(\w+)\.findMany\(/g;
  let m;
  while ((m = re.exec(src))) {
    const model = m[1];
    if (!RISK_MODELS.has(model)) continue;

    // Walk the balanced parentheses so a nested object or arrow function in the
    // argument list cannot truncate what we inspect. A regex to the next ')'
    // would stop inside `select: { user: { ... } }` and report a false hit.
    let i = re.lastIndex - 1;
    let depth = 0;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (!depth) break; }
    }
    const args = src.slice(start + 1, i);
    if (/\btake\b|\bcursor\b/.test(args)) continue;
    if (NARROWING_KEY.test(args)) continue;

    // Keyed by file+model, NOT by line number: a finding must not "move" every
    // time somebody adds an import above it, or the baseline churns on every
    // unrelated edit and stops meaning anything.
    out.push(`${rel}::${model}`);
  }
  return out;
}

const current = [...new Set(walk(SRC).flatMap(findingsFor))].sort();

if (process.argv.includes('--update')) {
  fs.writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  console.log(`Baseline updated: ${current.length} tolerated finding(s).`);
  process.exit(0);
}

const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : [];
const known = new Set(baseline);
const added = current.filter((f) => !known.has(f));
const fixed = baseline.filter((f) => !current.includes(f));

if (fixed.length) {
  console.log(`✅ ${fixed.length} unbounded query/queries fixed since the baseline:`);
  for (const f of fixed) console.log(`     ${f}`);
  console.log('   Run with --update to lock the improvement in.\n');
}

if (!added.length) {
  console.log(`✅ No new unbounded queries. (${current.length} pre-existing, tracked in the baseline.)`);
  process.exit(0);
}

console.error(`❌ ${added.length} NEW unbounded findMany on a growth table:\n`);
for (const f of added) {
  const [file, model] = f.split('::');
  console.error(`   ${file}  →  ${model}.findMany() with no take/cursor`);
}
console.error(
  `\n   These tables grow with subscriber count or with time, so this query gets\n` +
    `   slower and heavier forever and eventually exceeds the worker's memory cap.\n\n` +
    `   Fix by adding one of:\n` +
    `     • take: <n>                                  a hard cap\n` +
    `     • parseCursor(query) / buildCursorPage(...)   from src/common/pagination.ts\n` +
    `     • a narrowing where clause (subscriberId, userId, …)\n\n` +
    `   If the query is genuinely bounded for a reason the scanner cannot see,\n` +
    `   run: npm run audit:queries -- --update\n`,
);
process.exit(1);
