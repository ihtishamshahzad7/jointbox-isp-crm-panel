#!/usr/bin/env node
/**
 * One-shot backfill: encrypt any Nas.apiPassword still stored in plaintext.
 *
 * Encryption was deployed lazily on purpose — MikrotikClient decrypts on use
 * and passes plaintext through unchanged, so nothing broke on the deploy and
 * rows convert themselves as routers are edited. This script converts the rest
 * so the column reaches a uniform state instead of lingering half-encrypted.
 *
 * Safe to run repeatedly: already-encrypted rows are detected and skipped.
 * Read-only unless --apply is passed.
 *
 *   node tools/encrypt-nas-passwords.js            # report what would change
 *   node tools/encrypt-nas-passwords.js --apply    # actually write
 *
 * IMPORTANT: run this on the server, with the same SECRETS_KEY / JWT_SECRET the
 * backend uses. Encrypting with a different key makes every router credential
 * unreadable, and the failure mode is "no router will connect" — take a
 * database backup before --apply.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');

const IV_BYTES = 12;
const TAG_BYTES = 16;

function key() {
  const material =
    process.env.SECRETS_KEY || process.env.JWT_SECRET || 'jointbox-fallback-key';
  return crypto.createHash('sha256').update(material).digest();
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function looksEncrypted(v) {
  const parts = String(v).split(':');
  if (parts.length !== 3) return false;
  try {
    return (
      Buffer.from(parts[0], 'base64').length === IV_BYTES &&
      Buffer.from(parts[1], 'base64').length === TAG_BYTES &&
      parts[2].length > 0
    );
  } catch {
    return false;
  }
}

(async () => {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.nas.findMany({
      select: { id: true, nasname: true, shortname: true, apiPassword: true },
      orderBy: { id: 'asc' },
    });

    const plain = rows.filter((r) => r.apiPassword && !looksEncrypted(r.apiPassword));
    const already = rows.filter((r) => r.apiPassword && looksEncrypted(r.apiPassword));
    const empty = rows.filter((r) => !r.apiPassword);

    console.log(`Routers: ${rows.length}`);
    console.log(`  already encrypted : ${already.length}`);
    console.log(`  no API password   : ${empty.length}`);
    console.log(`  plaintext         : ${plain.length}`);

    if (!plain.length) {
      console.log('\nNothing to do.');
      return;
    }

    for (const r of plain) {
      console.log(`  - #${r.id} ${r.shortname || r.nasname}`);
    }

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to encrypt these rows.');
      return;
    }

    let done = 0;
    for (const r of plain) {
      await prisma.nas.update({
        where: { id: r.id },
        data: { apiPassword: encryptSecret(r.apiPassword) },
      });
      done++;
    }
    console.log(`\nEncrypted ${done} row(s).`);
    console.log('Verify before walking away: open a router in the panel and run');
    console.log('its connection test. If it fails, SECRETS_KEY does not match the');
    console.log('backend and you should restore the backup.');
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
