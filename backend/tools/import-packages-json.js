#!/usr/bin/env node
/**
 * One-shot data move: backend/data/packages-management.json → PostgreSQL.
 *
 * Run ONCE, after the schema migration, before (or right after) restarting the
 * backend. Safe to run again: it skips rows whose id already exists, so a
 * half-finished run can simply be repeated.
 *
 *   node tools/import-packages-json.js           # report what would be moved
 *   node tools/import-packages-json.js --apply   # actually insert
 *
 * WHY IDS ARE PRESERVED
 *
 * A package's settings reference taxes, policies and allocations by id
 * (taxIds: [3], policyIds: [1,4]). Letting Postgres assign fresh ids during the
 * move would leave those references pointing at whatever happened to land on
 * that number — every package silently attached to the wrong tax, with nothing
 * to indicate anything went wrong. So ids are inserted explicitly and the
 * sequences are advanced past them afterwards.
 *
 * The JSON file is NOT deleted. Keep it until you have confirmed the panel
 * shows the right taxes, policies and per-package settings; it is the only
 * copy of this data that predates the move.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const FILE = path.join(process.cwd(), 'data', 'packages-management.json');

(async () => {
  const apply = process.argv.includes('--apply');
  if (!fs.existsSync(FILE)) {
    console.log(`No ${FILE} — nothing to import. (Fresh install: this is normal.)`);
    return;
  }

  let store;
  try {
    store = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch (e) {
    console.error(`Could not parse ${FILE}: ${e.message}`);
    process.exit(1);
  }

  const taxes = Array.isArray(store.taxes) ? store.taxes : [];
  const policies = Array.isArray(store.policies) ? store.policies : [];
  const allocations = Array.isArray(store.allocations) ? store.allocations : [];
  const settings = Array.isArray(store.packageSettings) ? store.packageSettings : [];

  console.log(`Found in ${path.basename(FILE)}:`);
  console.log(`  taxes            ${taxes.length}`);
  console.log(`  policies         ${policies.length}`);
  console.log(`  allocations      ${allocations.length}`);
  console.log(`  package settings ${settings.length}`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to import.');
    return;
  }

  const prisma = new PrismaClient();
  const counts = { taxes: 0, policies: 0, allocations: 0, settings: 0, skipped: 0, orphaned: 0 };

  try {
    for (const t of taxes) {
      if (await prisma.packageTax.findUnique({ where: { id: t.id } })) { counts.skipped++; continue; }
      await prisma.packageTax.create({
        data: {
          id: t.id,
          groupName: String(t.groupName ?? ''),
          name: String(t.name ?? ''),
          type: String(t.type ?? 'PERCENTAGE'),
          value: String(t.value ?? '0'),
          description: t.description ? String(t.description) : null,
          isActive: t.isActive !== false,
          createdAt: t.createdAt ? new Date(t.createdAt) : new Date(),
        },
      });
      counts.taxes++;
    }

    for (const p of policies) {
      if (await prisma.packagePolicy.findUnique({ where: { id: p.id } })) { counts.skipped++; continue; }
      await prisma.packagePolicy.create({
        data: {
          id: p.id,
          groupName: String(p.groupName ?? ''),
          attributeName: String(p.attributeName ?? ''),
          attributeType: String(p.attributeType ?? ''),
          attributeOp: String(p.attributeOp ?? '='),
          attributeValue: String(p.attributeValue ?? ''),
          description: p.description ? String(p.description) : null,
          createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
        },
      });
      counts.policies++;
    }

    for (const a of allocations) {
      if (await prisma.packageAllocation.findUnique({ where: { id: a.id } })) { counts.skipped++; continue; }
      await prisma.packageAllocation.create({
        data: {
          id: a.id,
          groupName: String(a.groupName ?? ''),
          isActive: a.isActive !== false,
          days: Array.isArray(a.days) ? a.days : [],
          startTime: String(a.startTime ?? '00:00'),
          endTime: String(a.endTime ?? '23:59'),
          policyId: a.policyId == null ? null : Number(a.policyId),
          description: a.description ? String(a.description) : null,
          createdAt: a.createdAt ? new Date(a.createdAt) : new Date(),
        },
      });
      counts.allocations++;
    }

    for (const s of settings) {
      const packageId = Number(s.packageId);
      if (!packageId) continue;
      // A settings row for a package that no longer exists cannot be inserted
      // (the FK would reject it) and is not worth failing the import over —
      // report it so the operator knows the JSON had stale entries.
      const pkg = await prisma.package.findUnique({ where: { id: packageId }, select: { id: true } });
      if (!pkg) { counts.orphaned++; continue; }
      if (await prisma.packageSetting.findUnique({ where: { packageId } })) { counts.skipped++; continue; }
      await prisma.packageSetting.create({ data: { packageId, settings: s } });
      counts.settings++;
    }

    // Advance the sequences past the explicit ids, or the next INSERT collides.
    for (const table of ['package_tax', 'package_policy', 'package_allocation', 'package_setting']) {
      await prisma.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'),
                       COALESCE((SELECT MAX(id) FROM "${table}"), 1), true)`,
      );
    }

    console.log('\nImported:');
    console.log(`  taxes            ${counts.taxes}`);
    console.log(`  policies         ${counts.policies}`);
    console.log(`  allocations      ${counts.allocations}`);
    console.log(`  package settings ${counts.settings}`);
    if (counts.skipped) console.log(`  skipped (already present) ${counts.skipped}`);
    if (counts.orphaned) console.log(`  skipped (package no longer exists) ${counts.orphaned}`);
    console.log('\nSequences reset. Keep the JSON file until you have verified the panel.');
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
