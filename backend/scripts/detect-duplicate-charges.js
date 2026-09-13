#!/usr/bin/env node
/**
 * HAS A CUSTOMER ALREADY BEEN CHARGED TWICE FOR THE SAME THING?
 *
 * ── Why this runs BEFORE the fix, not after ──────────────────────────────
 * R1 puts a unique index on ("subscriberId", reference) so the database
 * refuses a duplicate charge. That migration FAILS if duplicates already
 * exist — and the failure message will name one pair, not the problem. Worse,
 * a failed migration at deploy time is the moment you least want to be
 * discovering that some customers were double-billed months ago.
 *
 * So this runs first, read-only, against production. Two possible answers,
 * both worth having:
 *
 *   Zero rows  — the race never fired in practice. Apply the index with
 *                confidence; it costs nothing and closes the hole for good.
 *
 *   Some rows  — those are real double charges sitting in real customers'
 *                ledgers right now. They need reconciling by a human who
 *                understands the business before any constraint goes on, and
 *                that is a refund conversation, not a schema decision.
 *
 * ── Read-only, by construction ───────────────────────────────────────────
 * The session is opened in a READ ONLY transaction, so this cannot modify
 * anything even if the query were wrong. Safe to point at production.
 *
 * Usage:
 *   npm run db:duplicate-charges
 *   DATABASE_URL=postgres://... node scripts/detect-duplicate-charges.js --json
 */
const { Client } = require('pg');

const JSON_OUT = process.argv.includes('--json');

/**
 * Three independent questions. A duplicate can hide in any of them, and the
 * three tables are written by different code paths — subscriber wallets by
 * accounting.service.ts, reseller wallets by users.service.ts (which has no
 * idempotency at all), invoices by four different generators.
 */
const CHECKS = [
  {
    id: 'subscriber-wallet',
    title: 'Subscriber wallet: same reference charged more than once',
    sql: `
      SELECT "subscriberId", reference, count(*) AS copies,
             sum(amount)      AS total_amount,
             min("createdAt") AS first_seen,
             max("createdAt") AS last_seen
        FROM "BalanceTransaction"
       WHERE reference IS NOT NULL AND reference <> ''
       GROUP BY "subscriberId", reference
      HAVING count(*) > 1
       ORDER BY count(*) DESC, max("createdAt") DESC
       LIMIT 200`,
  },
  {
    id: 'reseller-wallet',
    title: 'Reseller wallet: same reference charged more than once',
    sql: `
      SELECT "userId", reference, count(*) AS copies,
             sum(amount)      AS total_amount,
             min("createdAt") AS first_seen,
             max("createdAt") AS last_seen
        FROM "UserBalanceTransaction"
       WHERE reference IS NOT NULL AND reference <> ''
       GROUP BY "userId", reference
      HAVING count(*) > 1
       ORDER BY count(*) DESC
       LIMIT 200`,
  },
  {
    id: 'negative-wallets',
    title: 'Wallets currently below zero',
    sql: `
      SELECT 'User'  AS entity, id, name AS label, balance FROM "User"       WHERE balance < 0
      UNION ALL
      SELECT 'Subscriber',      id, username,      balance FROM "Subscriber" WHERE balance < 0
       ORDER BY balance ASC
       LIMIT 200`,
  },
];

/**
 * The invoice-number survey is separate: it is not looking for corruption but
 * for FORMAT, because the R1 sequence must preserve whatever customers already
 * see on their bills. Four different generators were found in the source; this
 * reports which of them actually produced the rows in this database.
 */
const INVOICE_SURVEY = `
  SELECT CASE
           WHEN "invoiceNo" ~ '^INV-[0-9]{4}-[0-9]{5}$'        THEN 'INV-YYYY-NNNNN      (invoices.service.ts, COUNT+1)'
           WHEN "invoiceNo" ~ '^INV-[0-9]{4}-[0-9]{6}-[0-9]+$' THEN 'INV-YYYY-NNNNNN-sub (billing.service.ts)'
           WHEN "invoiceNo" ~ '^INV-[0-9]{4}-[0-9]{13,}$'      THEN 'INV-YYYY-epoch+rand (subscribers.service.ts)'
           WHEN "invoiceNo" ~ '^ACT-'                          THEN 'ACT-epoch-sub       (portal.service.ts)'
           ELSE 'OTHER / unrecognised'
         END AS format,
         count(*) AS invoices,
         min("invoiceNo") AS example,
         max("invoiceDate") AS most_recent
    FROM "Invoice"
   GROUP BY 1
   ORDER BY 2 DESC`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Point it at the database you want to inspect.');
    process.exit(2);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  // Belt and braces: this script must be incapable of writing.
  await client.query('BEGIN READ ONLY');

  const report = { checkedAt: new Date().toISOString(), checks: [], invoiceFormats: [] };
  let findings = 0;

  for (const check of CHECKS) {
    try {
      const { rows } = await client.query(check.sql);
      report.checks.push({ id: check.id, title: check.title, count: rows.length, rows });
      findings += rows.length;
    } catch (e) {
      // A missing table is information, not a crash: it tells the operator
      // this database predates that model.
      report.checks.push({ id: check.id, title: check.title, error: e.message.split('\n')[0] });
    }
  }

  try {
    const { rows } = await client.query(INVOICE_SURVEY);
    report.invoiceFormats = rows;
  } catch (e) {
    report.invoiceFormats = [{ error: e.message.split('\n')[0] }];
  }

  await client.query('ROLLBACK');
  await client.end();

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    print(report);
  }
  // Exit 1 when something was found, so CI or a cron can act on it.
  process.exit(findings > 0 ? 1 : 0);
}

function print(report) {
  const line = '-'.repeat(74);
  console.log(`\n${line}\n  JOINTBOX - DUPLICATE CHARGE AND WALLET INTEGRITY CHECK`);
  console.log(`  ${report.checkedAt}  ·  read-only\n${line}\n`);

  for (const c of report.checks) {
    if (c.error) {
      console.log(`  ?  ${c.title}\n     could not run: ${c.error}\n`);
      continue;
    }
    if (c.count === 0) {
      console.log(`  OK ${c.title}\n     nothing found.\n`);
      continue;
    }
    console.log(`  !! ${c.title}`);
    console.log(`     ${c.count} affected group(s). First 10:\n`);
    console.table(c.rows.slice(0, 10));
    console.log('');
  }

  console.log(`${line}\n  INVOICE NUMBER FORMATS IN USE\n${line}`);
  console.log('  The R1 sequence must preserve what customers already see on their bills.\n');
  if (report.invoiceFormats.length) console.table(report.invoiceFormats);
  else console.log('  No invoices found.\n');

  const total = report.checks.reduce((n, c) => n + (c.count || 0), 0);
  console.log(`${line}`);
  if (total === 0) {
    console.log('  RESULT: clean. The unique index in R1 can be applied safely.\n');
  } else {
    console.log(`  RESULT: ${total} group(s) need a human decision BEFORE the unique index is`);
    console.log('  applied - the migration will fail while duplicates remain, and each one is\n' +
                '  a real customer whose ledger is wrong.\n');
  }
}

main().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(2);
});
