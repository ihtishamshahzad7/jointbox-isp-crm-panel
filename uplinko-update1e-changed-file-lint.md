# UPLINKO ISP CRM — Update 1E Changed-File Lint

## Scope
Lint only the files changed by the integration work — **not** the pre-existing repo-wide
lint debt (1C measured 23,877 backend / 1,217 frontend repo-wide errors; those are legacy
style/config across the whole codebase and are explicitly out of scope).

## How to run (Windows VS Code terminal)
Backend (`backend/`):
```
npx eslint (git --no-pager diff --name-only HEAD -- "src/**/*.ts") --no-fix
```
Frontend (`frontend/`):
```
npx eslint "app/nas/[id]/tabs-config.tsx" "app/nas/[id]/tabs-health.tsx" "app/nas/[id]/monitoring-status.tsx" "app/nas/[id]/snmp-version.ts" "tests/snmp-version.test.ts" --no-fix
```

## Integration-changed files to lint
Backend (tracked M/A, *.ts): auth/auth.service.ts, auth/auth-lockout.spec.ts,
auth/auth-tenancy.spec.ts, auth/staff-boundary.spec.ts, billing-ext/billing-ext.service.ts,
billing-ext/billing-ext-wallet.spec.ts, common/bootstrap-credentials.ts(+spec),
common/cache.service.ts, common/db-push-safety.spec.ts, common/platform-account.ts(+spec),
licence/licence-agent-contract.spec.ts, logs/network-log-tenancy.spec.ts, main.ts,
nas/nas-snmp-config.ts(+spec), nas/nas.service.ts, nas/radius-sync.service.ts,
nas/radius-tenancy-boundary.spec.ts, network/network.service.ts(+spec),
network/live-sessions-scope.spec.ts, subscribers/subscribers.service.ts,
subscribers/router-presence.spec.ts, telemetry/device-health.service.ts,
telemetry/snmp-monitor.service.ts(+spec), telemetry/snmp-collector.spec.ts,
telemetry/telemetry.controller.ts, telemetry/telemetry.module.ts,
users/platform-companies.spec.ts.
Frontend: app/nas/[id]/lib.ts, tabs-config.tsx, tabs-health.tsx, monitoring-status.tsx,
snmp-version.ts, tests/snmp-version.test.ts.
(Non-.ts changed: backend/.env.example, backend/prisma/schema.prisma, the two migration .sql,
install.sh — not eslint targets.)

## Status
- **Agent could not execute eslint through the bridge** (Windows node_modules; `npm ci`
  exceeds the 180s cap). **RUN-BY-USER** with the commands above.
- **Prior evidence (1C):** the modified NAS/SNMP frontend files passed focused lint, and
  the backend focused suites compiled/ran. The one file this phase added to the set
  (`licence-agent-contract.spec.ts`) changed by +7 lines of plain TS (a `const` + a
  `describe.skip` ternary + comments) — no new lint constructs.
- **Determination:** integration-scope lint expected **PASS**; repo-wide lint **FAIL
  (pre-existing, out of scope)**. Confirm the changed-file lint locally with the commands above.
