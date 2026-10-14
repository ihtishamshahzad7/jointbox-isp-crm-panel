# Database migrations — the one workflow that stops schema drift forever

**The problem this solves:** the schema on your Windows PC used to get ahead of
the Ubuntu server. You changed `schema.prisma`, `db push`-ed it locally, but the
server never got those columns — so the app 500'd on "column does not exist".

The fix is a single rule: **every schema change becomes a committed migration
file, and every server applies migrations on deploy.** Nothing is applied by
hand ever again.

---

## On Windows — after ANY change to `schema.prisma`

```cmd
cd "F:\Jointbox panel\backend"
npx prisma migrate dev --name what_you_changed
```

`migrate dev` writes a new folder under `prisma/migrations/`, applies it to your
local DB, and regenerates the client. Then commit it — **the migration file is
what carries the change to the server**:

```cmd
git add -A
git commit -m "db: what_you_changed"
git push
```

Do **not** use `prisma db push` for real changes anymore — it mutates your local
DB without leaving a migration file, which is exactly what caused the drift.

---

## On Ubuntu — every deploy

```bash
./update-jointbox.sh
```

That runs `npm run db:deploy` (→ `backend/scripts/db-deploy.sh`), which runs
**`prisma migrate deploy` and nothing else** (plus the RADIUS schema split,
`scripts/radius-schema-apply.sh`). It applies every committed migration that
is not yet recorded. A failed migration **stops the deployment** — there is no
automatic baseline and no `prisma db push` safety net any more (that net ran
`--accept-data-loss` after a refused migration).

Earlier versions did run `db push` on every deploy, which is why the
migration chain alone could not build an empty database until
`20260827235959_fresh_install_baseline` and
`20261013120000_fresh_install_reconcile` — see
[docs/MIGRATIONS-FRESH-INSTALL.md](docs/MIGRATIONS-FRESH-INSTALL.md), including
how to diagnose and recover a server whose deploys stop with `P3009` (for
example a first install that stopped at
`20260828000000_outage_intelligence_attribution`) — diagnose before any
`prisma migrate resolve`.

---

## One-time: capture the current outstanding drift as a migration

Some columns (`nasIdentifier`, `ipv6Prefix`, `ipv6DelegatedPrefix`,
`expenseApprovalThreshold`, the `RefundRequest` / `AccountingLock` / `Job`
tables, `Expense.approvedById`, …) were added with `db push` and have no
migration file yet. The server's `db:deploy` safety net already heals them, but
to keep the migration history complete, capture them once on **Windows**:

```cmd
cd "F:\Jointbox panel\backend"
npx prisma migrate dev --name reconcile_ipv6_nas_accounting_drift
```

Prisma compares your local DB against the migration history and writes exactly
the missing SQL into a new migration folder. Commit and push it. From then on
the history is complete and every fresh clone rebuilds an identical database
from migrations alone.

> If `migrate dev` warns about drift and offers to **reset**, and you don't want
> to wipe your local dev data, use the non-destructive capture instead:
> ```cmd
> npx prisma migrate diff --from-migrations prisma/migrations ^
>   --to-schema-datamodel prisma/schema.prisma --script > drift.sql
> ```
> then create `prisma/migrations/<timestamp>_reconcile_drift/migration.sql` from
> `drift.sql`, run `npx prisma migrate resolve --applied <timestamp>_reconcile_drift`,
> and commit.

---

## Fresh server from a git clone

`install.sh` runs the same `npm run db:deploy`, so a brand-new Ubuntu box builds
the database purely from committed migrations — no special steps (PostgreSQL 12
or newer). See the top of `install.sh` for the full one-command bootstrap.
