#!/usr/bin/env node
/**
 * FreeRADIUS client file from the encrypted router vault — outside the app.
 *
 * Used by scripts/radius-vault-cutover.sh (run by the update script). Uses the
 * same rendering and decryption code as the backend (from the compiled dist/),
 * so the file is byte-for-byte what the running app would write.
 *
 *   node scripts/radius-clients.js render --out <file> [--clients-conf <path>] [--group-of <dir>]
 *       Encrypt any router secret that only exists in plaintext (the plaintext
 *       is kept), then write the client file atomically, 0640, group of <dir>.
 *       Exit 3 — and write nothing — if any active router's secret cannot be
 *       decrypted (SECRETS_KEY changed).
 *
 *   node scripts/radius-clients.js mark-cutover
 *       Record that FreeRADIUS now reads routers from the file (the start of
 *       the proof window below). Kept if already recorded.
 *
 *   node scripts/radius-clients.js finalize [--all]
 *       Retire LEGACY plaintext secrets. Default: only routers FreeRADIUS has
 *       accepted accounting from since the cutover (that proves the router's
 *       secret in the file is right). --all: every copy whose encrypted twin
 *       decrypts to exactly the same value — after logins were tested by hand.
 *
 *   node scripts/radius-clients.js restore-plaintext
 *       For a rollback to SQL clients: give every ACTIVE router whose
 *       plaintext column is empty its secret back from the vault (FreeRADIUS
 *       reads that column when read_clients = yes). Disabled routers stay
 *       withheld. Prints counts only.
 *
 *   node scripts/radius-clients.js mark-rollback
 *       Record that FreeRADIUS reads routers from SQL again (clears the
 *       cutover time, so a later switch starts a new proof window).
 *
 *   node scripts/radius-clients.js status
 *       Counts only.
 *
 *   node scripts/radius-clients.js keycheck
 *       Exit 0 when every stored router secret decrypts with the key in
 *       backend/.env, 3 when any does not. Prints counts only.
 *
 * Never prints a secret. Uses DATABASE_URL (and SECRETS_KEY / JWT_SECRET) from
 * backend/.env.
 */
const path = require('path');
const fs = require('fs');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true }); } catch { /* env already set */ }

const dist = path.join(__dirname, '..', 'dist');
let render, box, host;
try {
  render = require(path.join(dist, 'nas', 'radius-clients-render.js'));
  box = require(path.join(dist, 'common', 'crypto-box.js'));
  host = require(path.join(dist, 'nas', 'radius-host.js'));
} catch (e) {
  console.error('The backend is not built (dist/ is missing) — run this after "npm run build".');
  process.exit(2);
}
const { PrismaClient } = require('@prisma/client');

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

async function main() {
  const prisma = new PrismaClient();
  try {
    if (cmd === 'render') {
      const file = opt('out');
      if (!file) throw new Error('--out <file> is required');
      // A working encrypted copy for every router that still has its
      // plaintext: added where missing, re-made where the stored one no longer
      // decrypts (key changed while the plaintext was kept). Plaintext kept.
      const withPlain = await prisma.nas.findMany({
        where: { secret: { not: null } },
        select: { id: true, secret: true, radiusSecretEnc: true },
      });
      const plainOnly = withPlain.filter(
        (r) => r.secret && !render.secretProblem(r.secret) && !(r.radiusSecretEnc && box.decryptSecret(r.radiusSecretEnc) != null),
      );
      for (const r of plainOnly) {
        await prisma.nas.update({ where: { id: r.id }, data: { radiusSecretEnc: box.encryptSecret(r.secret) } });
      }
      const rows = await prisma.nas.findMany({
        select: { id: true, nasIp: true, nasname: true, shortname: true, isActive: true, secret: true, radiusSecretEnc: true },
      });
      const confPath = opt('clients-conf');
      const reserved = render.staticClientIps(confPath && fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : '');
      const r = render.renderClients(rows, { decrypt: (p) => box.decryptSecret(p), reservedIps: reserved });
      const active = rows.filter((x) => x.isActive).length;
      if (r.undecryptable.length) {
        out({ ok: false, reason: 'undecryptable', routers: r.undecryptable, encrypted: plainOnly.length });
        process.exitCode = 3;
        return;
      }
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      const fd = fs.openSync(tmp, 'wx', 0o640);
      try {
        fs.writeSync(fd, r.content);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const groupOf = opt('group-of');
      if (groupOf && fs.existsSync(groupOf)) {
        const gid = fs.statSync(groupOf).gid;
        try { fs.chownSync(tmp, 0, gid); } catch { /* not root: leave as is */ }
      }
      fs.chmodSync(tmp, 0o640);
      fs.renameSync(tmp, file);
      out({ ok: true, active, clients: r.clients.length, skipped: r.skipped, encrypted: plainOnly.length });
      return;
    }

    if (cmd === 'mark-cutover') {
      const st = host.readState();
      const next = st.cutoverAt ? st : host.writeState({ cutoverAt: new Date().toISOString() });
      out({ ok: true, cutoverAt: next.cutoverAt });
      return;
    }

    if (cmd === 'finalize') {
      const all = args.includes('--all');
      const since = host.readState().cutoverAt ? new Date(host.readState().cutoverAt) : null;
      const rows = await prisma.nas.findMany({
        where: { secret: { not: null }, radiusSecretEnc: { not: null } },
        select: { id: true, nasIp: true, secret: true, radiusSecretEnc: true },
      });
      let cleared = 0;
      const kept = [];
      for (const r of rows) {
        if (box.decryptSecret(r.radiusSecretEnc) !== r.secret) {
          kept.push({ id: r.id, reason: 'encrypted copy differs' });
          continue;
        }
        let proven = all;
        if (!proven && since && r.nasIp) {
          const seen = await prisma.$queryRaw`
            SELECT 1 AS x FROM radacct
            WHERE nasipaddress = ${r.nasIp}::inet
              AND (acctstarttime > ${since} OR acctstoptime > ${since}
                   OR (acctstoptime IS NULL AND acctupdatetime > ${since}))
            LIMIT 1`.catch(() => []);
          proven = seen.length > 0;
        }
        if (!proven) {
          kept.push({ id: r.id, reason: since ? 'no accounting through the vault file yet' : 'no cutover recorded' });
          continue;
        }
        await prisma.nas.update({ where: { id: r.id }, data: { secret: null } });
        cleared++;
      }
      host.writeState({ retired: { at: new Date().toISOString(), count: cleared, kept: kept.length } });
      out({ ok: true, cleared, kept });
      return;
    }

    if (cmd === 'restore-plaintext') {
      const rows = await prisma.nas.findMany({
        where: { isActive: true, secret: null, radiusSecretEnc: { not: null } },
        select: { id: true, radiusSecretEnc: true },
      });
      let restored = 0;
      const failed = [];
      for (const r of rows) {
        const plain = box.decryptSecret(r.radiusSecretEnc);
        if (plain == null || render.secretProblem(plain)) { failed.push(r.id); continue; }
        await prisma.nas.update({ where: { id: r.id }, data: { secret: plain } });
        restored++;
      }
      out({ ok: failed.length === 0, restored, undecryptable: failed });
      if (failed.length) process.exitCode = 3;
      return;
    }

    if (cmd === 'mark-rollback') {
      const next = host.writeState({ cutoverAt: undefined, rolledBackAt: new Date().toISOString() });
      out({ ok: true, rolledBackAt: next.rolledBackAt });
      return;
    }

    if (cmd === 'keycheck') {
      const rows = await prisma.nas.findMany({
        where: { radiusSecretEnc: { not: null } },
        select: { radiusSecretEnc: true },
      });
      const bad = rows.filter((r) => box.decryptSecret(r.radiusSecretEnc) == null).length;
      out({ ok: bad === 0, encrypted: rows.length, undecryptable: bad });
      if (bad) process.exitCode = 3;
      return;
    }

    if (cmd === 'status') {
      const [active, encrypted, plaintext] = await Promise.all([
        prisma.nas.count({ where: { isActive: true } }),
        prisma.nas.count({ where: { radiusSecretEnc: { not: null } } }),
        prisma.nas.count({ where: { secret: { not: null } } }),
      ]);
      out({ ok: true, active, encrypted, plaintext });
      return;
    }

    console.error('usage: radius-clients.js render --out <file> [--clients-conf <path>] [--group-of <dir>] | mark-cutover | finalize [--all] | restore-plaintext | mark-rollback | keycheck | status');
    process.exitCode = 1;
  } catch (e) {
    const msg = String((e && e.message) || e).split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'unknown error';
    out({ ok: false, reason: 'error', message: msg.slice(0, 300) });
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main();
