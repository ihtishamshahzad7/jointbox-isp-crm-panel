-- ============================================================================
--  JOINTBOX — pre-R1 data check.  READ ONLY.  Safe on production.
-- ============================================================================
--
--  R1 adds three UNIQUE indexes that turn idempotency from a hope into a rule:
--
--      balance_tx_sub_ref_uq         ("subscriberId", reference)
--      user_balance_tx_ref_uq        ("userId", reference)
--      network_log_session_event_uq  ("sessionId", "eventType")
--
--  Each is created at boot by DatabaseSetupService.ensureMoneyConstraints().
--  If duplicates already exist the creation FAILS — logged loudly, boot
--  continues, and the hole stays open until somebody reconciles the rows.
--
--  Run this BEFORE deploying. Two possible answers, both worth having:
--
--    (0 rows everywhere)  The races never fired in practice. Deploy; the
--                         constraints apply cleanly and close the hole.
--
--    (any rows)           Those are real customers whose ledger is wrong.
--                         That is a refund conversation before it is a schema
--                         decision. Reconcile, then deploy.
--
--  Run it on the SERVER, where the production database lives:
--      sudo -u postgres psql -d jointbox -f backend/scripts/check-duplicates.sql
-- ============================================================================

\echo ''
\echo '=== 1. SUBSCRIBER WALLET — same reference charged more than once ==='
SELECT "subscriberId", reference, count(*) AS copies, sum(amount) AS total_amount,
       min("createdAt") AS first_seen, max("createdAt") AS last_seen
  FROM "BalanceTransaction"
 WHERE reference IS NOT NULL AND reference <> ''
 GROUP BY 1, 2 HAVING count(*) > 1
 ORDER BY 3 DESC LIMIT 20;

\echo ''
\echo '=== 2. RESELLER WALLET — same reference charged more than once ==='
SELECT "userId", reference, count(*) AS copies, sum(amount) AS total_amount,
       min("createdAt") AS first_seen, max("createdAt") AS last_seen
  FROM "UserBalanceTransaction"
 WHERE reference IS NOT NULL AND reference <> ''
 GROUP BY 1, 2 HAVING count(*) > 1
 ORDER BY 3 DESC LIMIT 20;

\echo ''
\echo '=== 3. DUPLICATE SESSION EVENTS — blocks the A2 idempotency index ==='
SELECT "sessionId", "eventType", count(*) AS copies, min("loggedAt") AS first_seen
  FROM "NetworkLog"
 WHERE "sessionId" IS NOT NULL
   AND "eventType" IN ('CONNECTION', 'DISCONNECTION')
 GROUP BY 1, 2 HAVING count(*) > 1
 ORDER BY 3 DESC LIMIT 20;

\echo ''
\echo '=== 4. WALLETS CURRENTLY BELOW ZERO — the symptom of the A4 bug ==='
SELECT 'User' AS entity, id, name AS label, balance FROM "User" WHERE balance < 0
UNION ALL
SELECT 'Subscriber', id, username, balance FROM "Subscriber" WHERE balance < 0
 ORDER BY balance ASC LIMIT 20;

\echo ''
\echo '=== 5. INVOICE NUMBER FORMATS IN USE — A5 must preserve these ==='
SELECT CASE
         WHEN "invoiceNo" ~ '^INV-[0-9]{4}-[0-9]{5}$'        THEN 'INV-YYYY-NNNNN       invoices.service (COUNT+1)'
         WHEN "invoiceNo" ~ '^INV-[0-9]{4}-[0-9]{6}-[0-9]+$' THEN 'INV-YYYY-NNNNNN-sub  billing.service'
         WHEN "invoiceNo" ~ '^INV-[0-9]{4}-[0-9]{13,}$'      THEN 'INV-YYYY-epoch+rand  subscribers.service'
         WHEN "invoiceNo" ~ '^ACT-'                          THEN 'ACT-epoch-sub        portal.service'
         ELSE 'OTHER / unrecognised'
       END AS format,
       count(*) AS invoices,
       min("invoiceNo") AS example,
       max("invoiceDate") AS most_recent
  FROM "Invoice"
 GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo 'Empty results for 1, 2 and 3 means the R1 constraints will apply cleanly.'
\echo ''
