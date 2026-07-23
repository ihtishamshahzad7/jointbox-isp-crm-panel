/**
 * Phase 0 performance budget test — dependency-free.
 *
 * Usage:
 *   1. Start the backend (npm run start:dev)
 *   2. node test/perf.mjs               (anonymous — only public endpoints)
 *      TOKEN=<jwt> node test/perf.mjs   (authenticated — full suite)
 *
 * Budgets: list endpoints p95 < 100ms, detail/stats endpoints p95 < 50ms.
 * Exits 1 if any budget is broken → usable in CI.
 */

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const TOKEN = process.env.TOKEN || '';
const RUNS = Number(process.env.RUNS || 20);

// [path, budgetMs, kind]
const ENDPOINTS = [
  ['/subscribers?limit=50', 100, 'list'],
  ['/subscribers/stats', 50, 'stats'],
  ['/subscribers/overview', 50, 'stats'],
  ['/packages', 100, 'list'],
  ['/packages/stats', 50, 'stats'],
  ['/areas', 100, 'list'],
  ['/nas', 100, 'list'],
  ['/invoices', 100, 'list'],
  ['/payments', 100, 'list'],
  ['/vouchers', 100, 'list'],
  ['/tickets', 100, 'list'],
  ['/logs/login?cursor=0&limit=50', 100, 'list'],
  ['/logs/activity?cursor=0&limit=50', 100, 'list'],
  ['/logs/system?cursor=0&limit=50', 100, 'list'],
];

function p95(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

async function timeOnce(path) {
  const start = performance.now();
  const res = await fetch(BASE + path, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
  });
  await res.arrayBuffer(); // include body download time
  return { ms: performance.now() - start, status: res.status };
}

let failed = false;
console.log(`Perf test → ${BASE} (${RUNS} runs per endpoint)\n`);

for (const [path, budget] of ENDPOINTS) {
  const samples = [];
  let status = 0;
  try {
    // warm-up (JIT, connection, cache)
    await timeOnce(path);
    for (let i = 0; i < RUNS; i++) {
      const r = await timeOnce(path);
      samples.push(r.ms);
      status = r.status;
    }
  } catch (e) {
    console.log(`✗ ${path} — request failed: ${e.message}`);
    failed = true;
    continue;
  }
  if (status === 401) {
    console.log(`~ ${path} — 401 (set TOKEN=<jwt> to test authenticated endpoints)`);
    continue;
  }
  if (status >= 400) {
    console.log(`✗ ${path} — HTTP ${status}`);
    failed = true;
    continue;
  }
  const p = p95(samples);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const ok = p <= budget;
  if (!ok) failed = true;
  console.log(
    `${ok ? '✓' : '✗'} ${path.padEnd(42)} p95 ${p.toFixed(1)}ms  avg ${avg.toFixed(1)}ms  (budget ${budget}ms)`,
  );
}

console.log(failed ? '\n❌ Budget broken.' : '\n✅ All endpoints within budget.');
process.exit(failed ? 1 : 0);
