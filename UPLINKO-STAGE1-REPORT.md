# UPLINKO ISP CRM — Stage 1: Security, Financial Integrity & Performance Fixes

**Scope:** Stage 1 only (D2, S1, S3, P1, P2 implemented; D3/D4 investigated).
**Deliverable:** `uplinko-stage1-fixes.patch` (applies to base commit `1d76830`).
**Not committed / not pushed.** No Stage 2 (SNMP) work. No Float→Decimal migration (D1 is separate).
**Branding, colours, shell and navigation unchanged.** Application name: UPLINKO ISP CRM.

---

## A. Executive summary

Five fixes were implemented and one area investigated, in the requested priority order.

| # | Area | What was wrong | What changed |
|---|------|----------------|--------------|
| **D2** | Wallet financial integrity | Balance updated by read-modify-write (lost updates under concurrency); no idempotency, so a retried/duplicated payment or callback double-applied; refund path not atomic | Atomic DB increment + ledger write in ONE transaction; exactly-once via a new `idempotencyKey` unique column; non-negative guard; rounding preserved |
| **S1** | Login brute-force lockout | Counter was a process-local `Map` → bypassable by hitting another instance, rotating IP, or email-spraying; an attacker-triggered global `.clear()` could wipe everyone's lock | Shared Redis atomic counters (email+IP, per-account, per-IP); fail-closed when Redis required but down; no global reset |
| **S3** | First-boot admin | Hardcoded `admin123` default (installer, backend, and the privileged SUPER_ADMIN had no env requirement); password re-hashed to the default and printed on every restart | No hardcoded default: operator-set, reused existing hash on upgrade, or a cryptographically random one-time secret in a 0600 file; cleared on first change; never logged on restart |
| **P1** | Router presence fan-out | Unbounded `Promise.all` opened an API socket to every NAS at once and stalled behind the slowest; no per-NAS timeout; demo NAS included | Bounded concurrency (`mapLimit`), per-NAS `withTimeout`, demo NAS excluded in-query, Redis cache kept, single-flight added |
| **P2** | Reseller session scoping | Non-admin fetched ALL active sessions server-wide, then filtered in Node and sliced for pagination | Tenant scope pushed into the radacct SQL (`username = ANY(...)`), true `LIMIT/OFFSET`, matching `COUNT`; no fetch-all-then-filter |
| **D3/D4** | radacct / traffic-sample growth | Investigation only | D3 already mitigated (batched archival + partial indexes); D4 real risk identified with a safe, non-destructive migration proposal (no migration run) |

All 51 Stage‑1 unit tests pass, including from a clean checkout of the base commit with only this patch applied. The D2 concurrency guarantee is additionally proven against a real PostgreSQL instance.

---

## B. Issue-by-issue verification

| Issue | Status | Evidence |
|-------|--------|----------|
| **D2** lost-update race on wallet balance | **VERIFIED → FIXED** | Base code used `upsert`/update with read-then-write semantics; real-PG proof shows read-modify-write loses updates (7/100) while atomic increment is correct (100/100). Fix uses `{ balance: { increment } }` inside `$transaction`. |
| **D2** duplicate payment/callback double-applies | **VERIFIED → FIXED** | No dedup existed. Added `idempotencyKey` unique column + fast-path check + P2002→`ConflictException`. Unit tests cover duplicate reference and concurrent unique-race. |
| **D2** balance can go negative where prohibited | **VERIFIED → FIXED** | `disallowNegative` guard inside the transaction rolls back a deduction that would breach zero. |
| **S1** lockout is process-local | **VERIFIED → FIXED** | `private loginAttempts = new Map()` in base. Replaced with `CacheService.incr` Redis counters; multi-instance test proves a lock set on instance A blocks instance B. |
| **S1** IP-rotation / email-spraying bypass | **VERIFIED → FIXED** | Base keyed email+IP and email+* only. Added a per-IP counter (50/15 min); tests prove account cap across changing IPs and IP cap across invented emails. |
| **S1** attacker-controlled global reset | **VERIFIED → FIXED** | Base had `if (size > 50_000) this.loginAttempts.clear()`. Removed; replaced with expiry-only pruning. |
| **S1** Redis down silently disables protection | **VERIFIED → FIXED** | New behaviour: fail-closed (`ServiceUnavailableException`) when `redisIsRequired()`; local fallback only for single-instance installs that opted out. Test covers both. |
| **S3** hardcoded `admin123` default | **VERIFIED → FIXED** | Present in `install.sh`, `main.ts`, `platform-account.ts`, `.env.example`. All removed; random one-time secret generated and persisted 0600. |
| **S3** privileged platform account had no password requirement | **VERIFIED → FIXED** | `PLATFORM_ADMIN_PASSWORD` was unchecked and fell back to `admin123`. Now generated if unset. |
| **S3** password reset + printed on every restart | **VERIFIED → FIXED** | `ensurePlatformLogin` re-hashed to the default and logged it each boot; that block removed (email normalisation only). |
| **P1** unbounded NAS fan-out, no timeout | **VERIFIED → FIXED** | Base `Promise.all(nases.map(...))`. Replaced with bounded `mapLimit` + `withTimeout`; tests prove peak concurrency ≤ limit and a hung NAS does not stall the sweep. |
| **P1** demo NAS polled | **VERIFIED → FIXED** | Demo NAS now excluded at the query level; test asserts the `where` clause. |
| **P2** fetch-all-then-filter for non-admins | **VERIFIED → FIXED** | Base fetched all sessions then `mine.slice(offset, offset+take)`. Now scoped usernames go into the SQL with real LIMIT/OFFSET and matching COUNT. |
| **D3** radacct unbounded growth | **NOT REPRODUCED (already mitigated)** | Batched archival (`archive_radacct_batch`, 10k/batch, `RADACCT_RETAIN_DAYS` default 90) + partial indexes + aggressive autovacuum already exist. Native partitioning documented as an optional maintenance-window upgrade. |
| **D4** subscriber_traffic_sample growth | **NEEDS INVESTIGATION → root cause confirmed, safe proposal provided (no migration run)** | The highest-growth table is NOT a TimescaleDB hypertable and is pruned row-wise; at 1M online ≈ 4.3B rows/30 days. See section F. |

---

## C. Files changed

**Implementation (backend/src):**
- `billing-ext/billing-ext.service.ts` — D2 atomic wallet + idempotency + non-negative guard.
- `auth/auth.service.ts` — S1 Redis-backed lockout; S3 clear bootstrap secret on first change; constructor gains `CacheService`.
- `common/cache.service.ts` — S1 `getCount()` / `ttlSeconds()` helpers (additive).
- `common/bootstrap-credentials.ts` *(new)* — S3 generate / persist (0600) / reuse / clear.
- `common/platform-account.ts` — S3 no hardcoded default; reuse existing hash on split; `ensurePlatformLogin` no longer touches the password.
- `main.ts` — S3 first-boot uses generated secrets; announces the file path, not the password.
- `subscribers/subscribers.service.ts` — P1 bounded `routerPresence` + single-flight.
- `nas/radius-sync.service.ts` — P2 `usernames` scope filter on `getActiveSessions` / `countActiveSessions`.
- `network/network.service.ts` — P2 scope pushed into SQL; `scopedUsernames()` helper.

**Schema / migration:**
- `prisma/schema.prisma` — one line: `idempotencyKey String? @unique @db.VarChar(120)` on `SubscriberBalanceLedger` (D2). *(The VPN schema changes in the working tree are deliberately NOT in this patch.)*
- `prisma/migrations/20261101120000_ledger_idempotency_key/migration.sql` *(new)* — additive column + partial unique index.

**Installer / config:**
- `install.sh` — generates random first-boot passwords; keeps existing non-default ones on re-install; banner no longer prints `admin123`.
- `backend/.env.example` — documents the new behaviour; no `admin123`.

**Tests (new):** `auth/auth-lockout.spec.ts`, `billing-ext/billing-ext-wallet.spec.ts`, `billing-ext/billing-ext-wallet.concurrency.int.mjs`, `common/bootstrap-credentials.spec.ts`, `subscribers/router-presence.spec.ts`, `network/live-sessions-scope.spec.ts`.
**Tests (updated for the new AuthService constructor arg):** `auth/auth-tenancy.spec.ts`, `auth/staff-boundary.spec.ts`, `users/platform-companies.spec.ts`.

---

## D. Migrations

**New, additive, safe on a live DB** — `20261101120000_ledger_idempotency_key`:

```sql
ALTER TABLE "subscriber_balance_ledger" ADD COLUMN IF NOT EXISTS "idempotencyKey" VARCHAR(120);
CREATE UNIQUE INDEX IF NOT EXISTS "subscriber_balance_ledger_idempotencyKey_key"
  ON "subscriber_balance_ledger" ("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
```

- Nullable column: every existing row is NULL; Postgres permits many NULLs under a unique index, so the partial unique index is safe to add online.
- No data rewrite, no backfill, no semantic change to existing rows.
- **Rollback:** `DROP INDEX IF EXISTS "subscriber_balance_ledger_idempotencyKey_key"; ALTER TABLE "subscriber_balance_ledger" DROP COLUMN IF EXISTS "idempotencyKey";`

No other migrations. **No Float→Decimal migration was performed (D1 remains separate).**

---

## E. Test results

### Passed (ran and passed here)
- **D2 wallet (service):** 6/6 — atomic increment + matching ledger; uses `{increment}` not absolute write; idempotent duplicate reference; rollback on ledger failure; P2002→Conflict rollback; non-negative guard.
- **D2 concurrency (real PostgreSQL 16, disposable cluster):** atomic increment **100/100 CORRECT**; read-modify-write **7/100 (lost updates)** — proves the race the fix removes.
- **S1 lockout:** 9/9 — shared counter across instances; per-account across IPs; per-IP email-spraying; reset on success; window expiry; fail-closed when Redis required; single-instance fallback; no global reset; prune evicts only expired.
- **S3 bootstrap credentials:** 6/6 — env used as-is; legacy default refused; generated + persisted 0600 + reused next boot; per-scope secrets; cleared after first change; high-entropy URL-safe output.
- **P1 router presence:** 5/5 — concurrency bounded to limit; hung NAS times out; demo NAS excluded in-query; result cached; single-flight collapses concurrent misses.
- **P2 session scoping:** 5/5 — scope + LIMIT/OFFSET pushed to both page and count; empty scope; admin unrestricted; legacy path scoped; page size capped at 200.
- **Regression (existing specs touched by the AuthService constructor change):** 20/20 — `platform-companies`, `staff-boundary`, `auth-tenancy`.
- **Patch self-containment:** applied to a clean checkout of base `1d76830`; the full 51-test Stage‑1 suite passes with only this patch applied.

**Total: 51/51 unit tests + the real-PG concurrency proof.**

### Failed
None.

### Blocked (could not run here — environment limit)
- `prisma generate` / `prisma validate`, full `tsc`, full backend Jest, `npm run build`: the Prisma engine download is firewalled in this environment (`binaries.prisma.sh` returns 403). The unit tests above run via ts-jest transpile-only with the Prisma client mocked, so they are unaffected; but the whole-project typecheck and build must be run on your server/CI, which has engine access.

### Not run (out of Stage‑1 scope)
- End-to-end login/lockout against a live Redis cluster and multiple app instances.
- First-boot bootstrap against a brand-new production database.
- Live radacct load test for P1/P2 at scale.

---

## F. Remaining risks & D3/D4 findings

**D4 — `subscriber_traffic_sample` growth (confirmed real; no migration run):**
- `sampleSubscribers()` inserts one row per ONLINE subscriber every 10 minutes. At 100k online ≈ 432M rows / 30 days; at 1M online ≈ 4.3B rows. Row ≈ 40–50 B + index.
- The TimescaleDB migration made `monitor_sample` and `device_health_metric` hypertables but **left `subscriber_traffic_sample` (and `nas_traffic_sample`) as ordinary tables**, pruned row-wise by `deleteMany({ ts < cutoff })` — ~144M dead tuples/day at 1M online, heavy autovacuum/bloat. These two tables are also absent from the aggressive-autovacuum list in `scale.sql`.
- **Safe migration proposal (NOT applied):**
  1. Follow the *exact* pattern of `20260829020000_timescaledb_telemetry`: Part 1 (unconditional) widen the PK to include `ts`; Part 2 (guarded by `pg_available_extensions`) `create_hypertable('subscriber_traffic_sample','ts', migrate_data => true)` and likewise `nas_traffic_sample`. No-op where TimescaleDB is absent, so it is safe on every existing server.
  2. Once hypertables, the nightly prune drops whole chunks instead of row-deleting (optionally `drop_chunks`), eliminating the bloat.
  3. Cheap, non-migration stopgap for non-Timescale servers: add `subscriber_traffic_sample`/`nas_traffic_sample` to the aggressive-autovacuum block in `scale.sql`.
  4. Optional knobs to cap volume: make the 10-min sample interval and 30-day retention operator-configurable; consider a continuous aggregate for the graph read path.

**D3 — radacct partitioning (already mitigated; no action required now):**
- Batched archival already exists and runs (`archive_radacct_batch`, 10k rows/batch, `RADACCT_RETAIN_DAYS` default 90), plus partial indexes on open sessions and aggressive autovacuum (`scale.sql`). Growth of the live table is bounded.
- Native range partitioning of radacct remains the documented **optional** maintenance-window upgrade in `scale.sql` for installs that must retain years of raw accounting online. It requires a table rewrite and is deliberately not automated.

**Other residual risks:**
- **S1 fail-closed:** on a multi-instance deployment, a Redis outage now blocks logins (by design — protection must not silently disable). Operators who truly want single-instance tolerance set `REDIS_REQUIRED=false`.
- **P2 scope list size:** a very large reseller's username list is loaded to build the `ANY(...)` filter. This is bounded by that reseller's own subscribers (far smaller than the whole install) and is a large improvement over fetching every session; a future optimisation is a same-DB join of radacct to `Subscriber` when `RADIUS_DATABASE_URL` points at the main DB.
- **S3 unwritable state dir:** if the 0600 file cannot be written and no env password is set, the generated password is printed once with an instruction to set the env var — the only channel left in that edge case.

---

## G. Deployment instructions

1. **Apply the patch** on a clean checkout of base `1d76830` (or rebase onto it):
   ```bash
   git apply uplinko-stage1-fixes.patch
   # verify first with:  git apply --check uplinko-stage1-fixes.patch
   ```
   **Revert:** `git apply -R uplinko-stage1-fixes.patch`

2. **Backend build & migrate** (on a host with Prisma engine access):
   ```bash
   cd backend
   npx prisma generate
   npm run typecheck && npm test && npm run build
   npm run db:deploy        # applies the additive idempotencyKey migration
   ```

3. **Redis (S1):** multi-instance / production deployments should run Redis and set `REDIS_URL` (and `REDIS_REQUIRED=true`). Single-instance installs may set `REDIS_REQUIRED=false` to keep in-memory lockout.

4. **First-boot credentials (S3):** set strong `ADMIN_PASSWORD` and `PLATFORM_ADMIN_PASSWORD` in `.env`. If unset, a random one-time password is written to the bootstrap file (`UPLINKO_STATE_DIR`, default `/var/lib/jointbox`, mode 0600) — ensure that directory is writable by the backend user. Both accounts must change their password at first sign-in.

5. **Existing installs on `admin123`:** the boot-time scan already flags any owner still on the published default (`mustChangePassword`), forcing a change at next login; re-running `install.sh` replaces a stored `admin123` with a fresh random value.

---

## H. Patch

`uplinko-stage1-fixes.patch` — Stage‑1 changes only, applicable to base commit `1d76830`, verified with `git apply --check` and by running the full Stage‑1 test suite from a clean base. The working tree's VPN and QA changes are intentionally excluded (including the VPN portion of `schema.prisma`).
