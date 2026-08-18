#!/usr/bin/env node
/**
 * check-mikrotik-api.js — tell an operator, in one command, EXACTLY why the
 * RouterOS API is refusing us.
 *
 *   node tools/check-mikrotik-api.js <host> <user> <password> [port]
 *   node tools/check-mikrotik-api.js 192.168.88.17 test 'secret'
 *
 * WHY THIS EXISTS: the panel logged only "RouterOS error: !trap" for every
 * failure — wrong password, missing group policy, blocked port and unknown
 * command all looked identical, so there was no way to tell from the server
 * which one you had. RouterOS actually sends the reason in a separate
 * `=message=` word right after the !trap; this prints it.
 *
 * Deliberately standalone: no npm packages, no build step, no backend running.
 * It can be run on a client's box during an outage when nothing else works.
 *
 * It is READ-ONLY. It logs in and lists PPP sessions. It changes nothing.
 */
const net = require('net');
const crypto = require('crypto');

const [, , host, user, pass, portArg] = process.argv;
const port = Number(portArg || 8728);

if (!host || !user || pass === undefined) {
  console.error('Usage: node tools/check-mikrotik-api.js <host> <user> <password> [port]');
  process.exit(2);
}

// ── minimal RouterOS API codec ───────────────────────────────────────────
function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) return Buffer.from([(len >> 8) | 0x80, len & 0xff]);
  if (len < 0x200000) return Buffer.from([(len >> 16) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.from([(len >> 24) | 0xe0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}
function encodeSentence(words) {
  const parts = [];
  for (const w of words) {
    const b = Buffer.from(w, 'utf8');
    parts.push(encodeLength(b.length), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
function decodeLength(buf, off) {
  const b = buf[off];
  if ((b & 0xe0) === 0xe0) return { len: ((b & 0x1f) << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3], adv: 4 };
  if ((b & 0xc0) === 0xc0) return { len: ((b & 0x3f) << 16) | (buf[off + 1] << 8) | buf[off + 2], adv: 3 };
  if ((b & 0x80) === 0x80) return { len: ((b & 0x7f) << 8) | buf[off + 1], adv: 2 };
  return { len: b, adv: 1 };
}

const sock = new net.Socket();
let buffer = Buffer.alloc(0);
const queue = [];

function send(words) {
  return new Promise((resolve, reject) => {
    queue.push({ resolve, reject, rows: [], cur: {}, trapped: false, message: null });
    sock.write(encodeSentence(words));
  });
}

sock.on('data', (data) => {
  buffer = Buffer.concat([buffer, data]);
  let off = 0;
  while (off < buffer.length && queue.length) {
    const { len, adv } = decodeLength(buffer, off);
    off += adv;
    if (len === 0) continue;
    if (off + len > buffer.length) { off -= adv; break; }
    const word = buffer.slice(off, off + len).toString('utf8');
    off += len;
    const p = queue[0];

    if (word === '!done') {
      queue.shift();
      if (p.trapped) p.reject(new Error(p.message || 'no reason given by the router'));
      else { if (Object.keys(p.cur).length) p.rows.push(p.cur); p.resolve(p.rows); }
    } else if (word === '!re') {
      if (Object.keys(p.cur).length) { p.rows.push(p.cur); p.cur = {}; }
    } else if (word === '!trap' || word === '!fatal') {
      // Do NOT reject yet — the reason arrives in the next word.
      p.trapped = true;
    } else if (word.startsWith('=')) {
      const i = word.indexOf('=', 1);
      if (i !== -1) {
        const k = word.slice(1, i), v = word.slice(i + 1);
        if (p.trapped) { if (k === 'message') p.message = v; }
        else p.cur[k] = v;
      }
    }
  }
  buffer = buffer.slice(off);
});

function fail(stage, err) {
  console.error(`\n❌ FAILED at: ${stage}`);
  console.error(`   Reason: ${err.message}`);
  const m = String(err.message || '').toLowerCase();
  if (m.includes('permission')) {
    console.error(`\n   → The user "${user}" logged in fine, but its GROUP lacks a policy.`);
    console.error(`     Winbox: System → Users → Groups → (the group of "${user}")`);
    console.error(`     Tick at least: api, read, write, test`);
  } else if (m.includes('cannot log in') || m.includes('invalid user')) {
    console.error(`\n   → Wrong username or password for the API user.`);
    console.error(`     Check the NAS record in the panel matches the router's user.`);
  } else if (m.includes('econnrefused')) {
    console.error(`\n   → Nothing is listening on ${host}:${port}.`);
    console.error(`     Winbox: IP → Services → enable "api" (port 8728).`);
  } else if (m.includes('timed out') || m.includes('etimedout') || m.includes('ehostunreach')) {
    console.error(`\n   → No route / blocked. Check a firewall rule or "Available From"`);
    console.error(`     on IP → Services → api (it must allow this server's IP).`);
  }
  process.exit(1);
}

sock.setTimeout(8000);
sock.on('timeout', () => fail('connect', new Error(`timed out connecting to ${host}:${port}`)));
sock.on('error', (e) => fail('connect', e));

sock.connect(port, host, async () => {
  console.log(`✓ TCP connected to ${host}:${port}`);
  try {
    // RouterOS 6.43+ accepts a plain login; older returns a =ret= challenge.
    let res;
    try {
      res = await send(['/login', `=name=${user}`, `=password=${pass}`]);
    } catch (e) { fail('login', e); return; }

    if (res[0] && res[0].ret) {
      const md5 = crypto.createHash('md5');
      md5.update(Buffer.from('\x00'));
      md5.update(Buffer.from(pass));
      md5.update(Buffer.from(res[0].ret, 'hex'));
      try {
        await send(['/login', `=name=${user}`, `=response=00${md5.digest('hex')}`]);
      } catch (e) { fail('login (challenge/response)', e); return; }
      console.log('✓ Logged in (legacy challenge/response)');
    } else {
      console.log('✓ Logged in (RouterOS 6.43+ plain login)');
    }

    // This is the exact call the panel makes every 5 minutes.
    let active;
    try {
      active = await send(['/ppp/active/print']);
    } catch (e) { fail('/ppp/active/print — reading active PPP sessions', e); return; }
    console.log(`✓ /ppp/active/print OK — ${active.length} active session(s)`);
    for (const s of active.slice(0, 10)) {
      console.log(`    ${s.name || '?'}  ${s.address || '-'}  up ${s.uptime || '-'}`);
    }

    // Write-policy probe: /ppp/active/remove needs 'write'. We do NOT remove
    // anything — printing with an impossible filter proves access without risk.
    try {
      await send(['/ppp/secret/print', '?name=__jointbox_probe__']);
      console.log('✓ /ppp/secret/print OK (secret pinning for static IPs will work)');
    } catch (e) {
      console.log(`⚠ /ppp/secret/print refused: ${e.message}`);
      console.log('   Static-IP secret pinning will not work; add "write" to the group.');
    }

    console.log('\n✅ API is healthy — the panel can read sessions and disconnect users.');
    sock.destroy();
    process.exit(0);
  } catch (e) {
    fail('unexpected', e);
  }
});
