/**
 * Jointbox end-to-end API test — real ISP workflow, dependency-free.
 *
 * Run (backend must be running on :3001):
 *   set ADMIN_EMAIL=you@example.com
 *   set ADMIN_PASSWORD=yourpassword
 *   node test/e2e.mjs
 *
 * It creates test data (prefixed E2E-/e2e_) so it's easy to spot and delete later.
 * Each step prints PASS/FAIL. Exits 1 if any step fails.
 */

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD env vars first.');
  process.exit(1);
}

let token = '';
let pass = 0, fail = 0;
const tag = Date.now().toString().slice(-6);
const P = (n) => `E2E-${n}-${tag}`;

async function api(method, path, body, useToken = true) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(useToken && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

function check(name, cond, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}  ${detail}`); fail++; }
  return cond;
}

const ctx = {};

async function run() {
  console.log(`\nJointbox E2E → ${BASE}\n`);

  // 0. LOGIN
  console.log('0. Auth');
  {
    const r = await api('POST', '/auth/login', { email: EMAIL, password: PASSWORD }, false);
    if (r.data?.requires2fa) { console.error('  Admin has 2FA on — use an account without 2FA for this script.'); process.exit(1); }
    token = r.data?.token || '';
    check('login returns token', !!token, `status ${r.status}`);
    if (!token) { summary(); process.exit(1); }
  }

  // 1. ORGANIZATION
  console.log('1. Organization');
  {
    const isp = await api('POST', '/organization/isps', { name: P('ISP') });
    ctx.ispId = isp.data?.id;
    check('create ISP', !!ctx.ispId, JSON.stringify(isp.data));
    const br = await api('POST', '/organization/branches', { name: P('Branch'), ispId: ctx.ispId });
    ctx.branchId = br.data?.id;
    check('create branch', !!ctx.branchId, JSON.stringify(br.data));
  }

  // 2. POOL + PACKAGE + AREA
  console.log('2. Package / Pool / Area');
  {
    const pool = await api('POST', '/ip-pools', { name: P('pool'), network: '10.66.0.0', subnet: '255.255.255.0' });
    ctx.poolId = pool.data?.id;
    check('create IP pool', !!ctx.poolId, JSON.stringify(pool.data));
    const pkg = await api('POST', '/packages', { name: P('pkg'), price: 1000, duration: 30, downloadSpeed: 20, uploadSpeed: 10, poolId: ctx.poolId });
    ctx.pkgId = pkg.data?.id;
    check('create package', !!ctx.pkgId, JSON.stringify(pkg.data));
    const area = await api('POST', '/areas', { name: P('area'), city: 'Testville' });
    ctx.areaId = area.data?.id;
    check('create area', !!ctx.areaId, JSON.stringify(area.data));
  }

  // 3. RESELLER + COMMISSION
  console.log('3. Reseller');
  {
    const u = await api('POST', '/users', { name: P('Reseller'), email: `e2e_${tag}@test.local`, password: 'Passw0rd1', role: 'RESELLER', phone: '01700000000' });
    ctx.resellerId = u.data?.id;
    check('create reseller (password policy ok)', !!ctx.resellerId, JSON.stringify(u.data));
    if (ctx.resellerId) {
      const c = await api('PUT', `/organization/resellers/${ctx.resellerId}/commission`, { percent: 10 });
      check('set commission 10%', c.data?.commissionPercent === 10, JSON.stringify(c.data));
    }
    const weak = await api('POST', '/users', { name: P('Weak'), email: `e2e_weak_${tag}@test.local`, password: 'abc', role: 'SALES' });
    check('weak password rejected', weak.status >= 400, `status ${weak.status}`);
  }

  // 4. SUBSCRIBER
  console.log('4. Subscriber');
  {
    const s = await api('POST', '/subscribers', {
      fullName: P('Customer'), phone: `019${tag}`, username: `e2e_${tag}`, password: 'netpass123',
      packageId: ctx.pkgId, areaId: ctx.areaId, salespersonId: ctx.resellerId, status: 'ACTIVE',
    });
    ctx.subId = s.data?.id;
    ctx.subUser = s.data?.username;
    check('create subscriber', !!ctx.subId, JSON.stringify(s.data));
    if (ctx.subId) {
      const rs = await api('GET', `/subscribers/radius-status/${ctx.subUser}`);
      check('subscriber synced to RADIUS', rs.data?.existsInRadius === true, JSON.stringify(rs.data));
    }
  }

  // 5. INVOICE + LEDGER
  console.log('5. Invoice → Ledger');
  {
    const due = new Date(Date.now() + 30 * 864e5).toISOString();
    const inv = await api('POST', '/invoices', { subscriberId: ctx.subId, amount: 1000, dueDate: due });
    ctx.invId = inv.data?.id;
    ctx.invNo = inv.data?.invoiceNo;
    check('create invoice', !!ctx.invId, JSON.stringify(inv.data));
    const led = await api('GET', `/accounting/ledger?refType=INVOICE&limit=20`);
    const rows = led.data?.items || [];
    const hit = rows.filter((r) => r.refId === ctx.invId);
    const dr = hit.find((r) => r.account === 'ACCOUNTS_RECEIVABLE' && r.debit === 1000);
    const cr = hit.find((r) => r.account === 'REVENUE' && r.credit === 1000);
    check('ledger: AR debit + REVENUE credit posted', !!dr && !!cr, JSON.stringify(hit));
  }

  // 6. PAYMENT + COMMISSION
  console.log('6. Payment → Commission');
  {
    const pay = await api('POST', '/payments', { invoiceId: ctx.invId, subscriberId: ctx.subId, amount: 1000, method: 'CASH' });
    check('record payment', pay.status < 400, JSON.stringify(pay.data));
    await new Promise((r) => setTimeout(r, 400)); // let async commission settle
    const inv = await api('GET', `/invoices/${ctx.invId}`);
    check('invoice now PAID', inv.data?.status === 'PAID', `status ${inv.data?.status}`);
    const tree = await api('GET', '/organization/resellers');
    const flat = JSON.stringify(tree.data);
    const reseller = findUser(tree.data, ctx.resellerId);
    check('reseller earned 100 commission (10% of 1000)', reseller && Math.abs(reseller.balance - 100) < 0.01, `balance ${reseller?.balance}`);
  }

  // 7. ACCOUNTING EXTRAS
  console.log('7. Accounting');
  {
    const exp = await api('POST', '/accounting/expenses', { category: P('exp'), amount: 500 });
    check('create expense', exp.status < 400, JSON.stringify(exp.data));
    const cf = await api('GET', '/accounting/cashflow?days=7');
    check('cashflow has inflow ≥ 1000', (cf.data?.totals?.inflow || 0) >= 1000, JSON.stringify(cf.data?.totals));
    const top = await api('POST', `/accounting/balances/${ctx.subId}/topup`, { amount: 500 });
    check('subscriber wallet top-up', top.data?.balance === 500, JSON.stringify(top.data));
  }

  // 8. COMMUNICATION
  console.log('8. Communication');
  {
    const tpl = await api('POST', '/communication/templates', { name: P('tpl'), channel: 'SMS', event: 'MANUAL', body: 'Hi {name}' });
    check('create template', !!tpl.data?.id, JSON.stringify(tpl.data));
    const test = await api('POST', '/communication/test', { channel: 'SMS', recipient: '01711111111', message: 'e2e test' });
    check('queue test message', !!test.data?.id, JSON.stringify(test.data));
    await new Promise((r) => setTimeout(r, 400));
    const log = await api('GET', '/communication/messages?limit=5');
    const msg = (log.data?.items || []).find((m) => m.id === test.data?.id);
    check('message logged (SENT/SIMULATED)', msg && ['SENT', 'SIMULATED', 'QUEUED'].includes(msg.status), JSON.stringify(msg));
  }

  // 9. PORTAL + SANDBOX PAYMENT
  console.log('9. Subscriber portal');
  {
    const login = await api('POST', '/portal/login', { username: ctx.subUser, password: 'netpass123' }, false);
    const ptoken = login.data?.token;
    check('portal login (separate scope)', !!ptoken, JSON.stringify(login.data));
    if (ptoken) {
      const me = await fetch(`${BASE}/portal/me`, { headers: { Authorization: `Bearer ${ptoken}` } }).then((r) => r.json());
      check('portal /me returns profile', me?.username === ctx.subUser, JSON.stringify(me));
      // admin token must be rejected by portal
      const cross = await fetch(`${BASE}/portal/me`, { headers: { Authorization: `Bearer ${token}` } });
      check('admin token rejected by portal', cross.status === 401, `status ${cross.status}`);
    }
    // second invoice + sandbox pay
    const due = new Date(Date.now() + 30 * 864e5).toISOString();
    const inv2 = await api('POST', '/invoices', { subscriberId: ctx.subId, amount: 1000, dueDate: due });
    const init = await api('POST', `/gateway/initiate/${inv2.data?.id}/SANDBOX`);
    check('gateway initiate (sandbox)', !!init.data?.key, JSON.stringify(init.data));
    if (init.data?.key) {
      const confirm = await fetch(`${BASE}/gateway/sandbox/confirm/${init.data.key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: 'success' }), redirect: 'manual',
      });
      check('sandbox payment processed', confirm.status >= 200 && confirm.status < 400, `status ${confirm.status}`);
      await new Promise((r) => setTimeout(r, 400));
      const inv2b = await api('GET', `/invoices/${inv2.data.id}`);
      check('sandbox invoice now PAID', inv2b.data?.status === 'PAID', `status ${inv2b.data?.status}`);
    }
  }

  // 10. AUTOMATION DRY-RUN
  console.log('10. Billing automation (dry-run)');
  {
    for (const type of ['auto-invoice', 'auto-renewal', 'suspension']) {
      const r = await api('POST', `/billing/run/${type}?dryRun=1`);
      check(`${type} dry-run queued`, !!r.data?.jobId || r.status < 400, JSON.stringify(r.data));
    }
    await new Promise((r) => setTimeout(r, 800));
    const runs = await api('GET', '/billing/runs');
    check('billing run rows recorded', (runs.data || []).length > 0, `runs ${runs.data?.length}`);
  }

  // 11. TRACE SEARCH
  console.log('11. Trace search');
  {
    const r = await api('GET', `/insights/search?q=${ctx.subUser}`);
    check('trace finds subscriber', (r.data?.subscribers || []).some((s) => s.id === ctx.subId), JSON.stringify(r.data?.subscribers));
    const tl = await api('GET', `/insights/timeline/${ctx.subId}`);
    const types = new Set((tl.data?.events || []).map((e) => e.type));
    check('timeline has invoice+payment+created events', types.has('INVOICE') && types.has('PAYMENT') && types.has('CREATED'), [...types].join(','));
  }

  summary();
}

function findUser(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const f = findUser(n.children, id);
    if (f) return f;
  }
  return null;
}

function summary() {
  console.log(`\n──────────────\n${pass} passed, ${fail} failed`);
  console.log(`Test data tagged "${tag}" (search E2E-...-${tag} to clean up).`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('Runner crashed:', e); process.exit(1); });
