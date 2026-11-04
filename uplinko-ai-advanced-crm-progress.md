# Uplinko AI and Advanced CRM Progress

This is the implementation checklist, not a claim of feature parity. A feature
is **IMPLEMENTED** only when persistence, server authorization, UI/workflow,
and integration with Uplinko's actual records are connected. **TESTED** means
the relevant test was run and passed.

## Stage 1 — Inspect and map

| Capability | Status | Notes |
|---|---|---|
| Inspect branch, HEAD, staged/unstaged/untracked work | TESTED | `main`, `3a0bc22d191ae78a6b782ab0ff6e31db1aea03a9`; preserved pre-existing untracked `ai-engine/`. |
| Inspect requested AI/Advanced CRM ZIP archives | BLOCKED | No matching source archives found. Existing extracted read-only reference trees inspected; unrelated licence ZIPs excluded. |
| Inventory AI source architecture and capabilities | MAPPED | Source-code inventory of the available extracted tree is recorded in `uplinko-ai-advanced-crm-integration-mapping.md`; the named ZIP archive was absent. |
| Inventory Advanced CRM modules and Uplinko reuse | MAPPED | Source-code inventory and per-feature UPLINKO destinations/statuses are recorded in `uplinko-ai-advanced-crm-integration-mapping.md`; this is not runtime verification. |
| Preserve damaged AI files before recovery | TESTED | Exact zero-filled service and old mapping files backed up outside the worktree and SHA-256 verified. |
| Create source-to-Uplinko mapping | MAPPED | Unified comparison records source evidence, duplicate/overlapping features, current destinations, gaps, dependencies, and roadmap status. |

## Stage 2 — Entitlement and native foundation

| Capability | Status | Notes |
|---|---|---|
| Independent global `ai-assistant` switch | TESTED | Database-backed Super Admin control; focused service/controller tests pass. |
| Independent global `crm-advanced` switch | TESTED | Separate database-backed switch; it does not depend on AI. |
| Per-plan feature inclusion for both flags | TESTED | Uses existing PlatformPlan/CompanyPlan records and plan snapshots. |
| Per-company enable/disable enforcement | TESTED | Company plan controls plus backend entitlement service/guard; not only frontend navigation. |
| Company/reseller/role permission enforcement | TESTED | AI native queries enforce role grants, inherited per-user denials, and existing scopes. |
| Provider unavailable does not affect core CRM | TESTED | AI returns deterministic local metrics when its separately configured provider fails. |
| Native CRM extension architecture | IN PROGRESS | Foundation reuses Uplinko records and scopes; Advanced CRM business modules remain. |

## Stage 3 — AI assistant

| Capability | Status | Notes |
|---|---|---|
| English deterministic query intents | IN PROGRESS | Phase 1 adds receipt, stock-movement, employee, attendance, comparison and protected-data intents; new/changed parser behavior is unverified. |
| Urdu and Roman Urdu intent support | IN PROGRESS | Phase 1 adds selected receipt, staff, attendance, stock and comparison vocabulary; bounded translation only, and the changed behavior is unverified. |
| Date/period parsing and comparisons | IN PROGRESS | Existing Pakistan-time date windows remain; Phase 1 adds equal-length prior-window comparisons and date-only attendance boundaries. New behavior is unverified. |
| Subscribers/status/expiry queries | IN PROGRESS | Existing native aggregates remain; Phase 1 adds a server chart and selected period comparison. The new behavior was not verified. |
| Payments/invoices/receipts/revenue | IN PROGRESS | Receipt aliases query existing payments by `paymentDate`; amounts and invoice dues are separated by currency. Refund-timing, recovery and sales/revenue formula parity remain gaps. |
| Package performance | IN PROGRESS | Existing package/subscriber scope remains; Phase 1 adds a server-generated top-package chart. Current-state comparisons are rejected; new behavior was not verified. |
| PPPoE/session history and auth failures | IN PROGRESS | Native session summaries exist; broader auth failure/event parity remains. |
| NAS/network records and events | IN PROGRESS | Existing scoped network event summaries remain; Phase 1 adds event charts/comparisons. No router polling; new behavior was not verified. |
| Tickets/tasks/technician workload | IN PROGRESS | Reuses Ticket and FieldJob with existing scopes and read permissions; Phase 1 adds selected period comparisons. New behavior was not verified. |
| Inventory/stock/procurement/expenses | IN PROGRESS | Inventory status and scoped stock movement summaries/comparisons plus expense aggregates/charts use existing records. No dedicated per-item issue, recovery, vendor or procurement workflow exists. |
| Employees/attendance/payroll | IN PROGRESS | Aggregate employee status and attendance queries use company scope, `crm-advanced`, `hr.read`/`hr.attendance.read`; payroll/identity/salary data is refused. Per-person lookup, payroll, catalogs and appraisal parity remain. Attendance/Leave database verification is outstanding. |
| Authoritative KPIs and charts | IN PROGRESS | AI response now includes server-generated, unit-aware chart series and optional equal-window comparisons; UI renders them. This phase's changes are unverified. Snapshot-only comparisons are rejected. |
| Temporary chat, no stored prompts/history | TESTED | Browser-only conversation; audit redacts prompts/answers; usage ledger stores metadata only. |
| Provider failure/timeout fallback | TESTED | Local summaries remain available; provider uses separate AI_AGENT_* configuration and receives aggregate metrics, not raw questions. |

## Phase 1 — AI parity implementation

**Status: PARTIALLY IMPLEMENTED — VERIFICATION DEFERRED**

- **Reference scope:** Extended the existing deterministic assistant based on
  `crm_assistant_queries.py`, `crm_assistant_language.py`, and
  `crm_assistant_visuals.py` in both read-only reference trees. Reference
  authorization, customer database, credentials and runtime were not copied.
- **Queries:** Receipt terms reuse `Payment`; payment totals use the recorded
  `paymentDate` and actual receipt currency. Invoice due totals are grouped by
  invoice currency and require `invoices.read`. Existing inventory records are
  summarized by status; `InventoryMovement` is summarized by destination
  status under the existing owner-tree scope. Employee status and attendance
  aggregates reuse `EmployeeProfile` and `EmployeeAttendance`. Expense charts
  label the stored amount as currency-unspecified because `Expense` has no
  currency column.
- **Security:** Employee summaries require both the native `hr.read` and
  `crm-advanced` entitlement; attendance requires `hr.attendance.read` and the
  same entitlement. Company ID comes from the entitlement service. No employee
  names, salaries, bank/identity data, or credentials are returned. Requests
  explicitly asking for payroll/salary, credentials, identity documents, or
  bank details are rejected before quota reservation or provider use. Other
  topics keep their existing UPLINKO role-denial and tenant/reseller scope.
- **Reporting/UI:** The server now supplies aggregate chart series, and the
  existing AI Agent conversation renders these in UPLINKO styling. Optional
  equal-length period comparisons cover received payments by currency, new
  subscribers, ticket/field-job counts, stock movements, approved expense
  amounts, employee hires, attendance and network events. Comparisons for
  sessions, package performance and current inventory snapshots are rejected.
  Comparisons of current subscriber/employee status or historical ticket SLA
  state are also rejected; only supported creation/event metrics are compared.
  The provider receives only the resulting aggregate metrics/visuals, never
  the raw question.
- **Known remaining AI gaps:** Named customer/subscriber record lookups,
  dedicated equipment-recovery and per-item stock-issue records, refund-date
  reporting, broader RADIUS authentication failure parity, full revenue/sales
  formulas, and payroll remain pending. Unsupported record-list, recovery,
  stock-issue, revenue/sales and sensitive-data requests are rejected rather
  than being answered with an unrelated default summary. UPLINKO has no
  authoritative equipment-recovery or stock-issue lifecycle record; no such
  data is fabricated. Unrelated Advanced CRM modules remain in the roadmap.
- **Schema/migrations:** No Prisma schema or migration changes were made for
  this phase. Existing uncommitted Attendance/Leave schema and migration files
  remain unapplied.
- **Tests added but not run:** Parser coverage for new intents/protected data
  and query-service coverage for company-scoped employees, entitlement denial,
  and owner-tree-scoped stock movement.
- **Deferred verification (not performed):** From `backend`, run the focused
  Jest suites `src/ai/ai-agent-query.spec.ts`,
  `src/ai/ai-agent-query.service.spec.ts`, and
  `src/ai/ai-agent.service.spec.ts`; run `npm run typecheck`; run targeted
  ESLint on the changed AI TypeScript files. From `frontend`, run
  `npm run typecheck` and ESLint on `app/ai-agent/page.tsx`. In a separately
  authorized environment, verify chart labels/units and comparison windows,
  HR entitlement/permission denial, company/reseller isolation, provider
  aggregate-only payload, loading/error/empty states, and a browser workflow.
  No Prisma, database, migration, test, typecheck, lint or browser command was
  run in this phase.

## Stage 4 — Advanced CRM modules

| Module/capability | Status | Current Uplinko relationship |
|---|---|---|
| Subscriber, billing and payments | IMPLEMENTED | Existing source-of-truth modules; reuse, do not duplicate. |
| HR employee profiles/departments/designations | IN PROGRESS | Added company-scoped employee profile CRUD with optional link to an existing Uplinko user, audit logging, and `crm-advanced` enforcement. Payroll and normalized HR catalogs remain. |
| Attendance management | IMPLEMENTED — NOT VERIFIED | Company-scoped records, server-timestamp check-in/out, reports, correction history, `crm-advanced` entitlement, HR permissions, audit events, and linked approved-leave attendance are implemented. No live database/browser workflow was run. |
| Leave management | IMPLEMENTED — NOT VERIFIED | Company-scoped leave types, date-specific self-service requests, department-scoped approvals, explicit yearly balances, immutable decision/balance history, audit events, email queue notifications, and reversible attendance integration are implemented. No live database/browser workflow was run. |
| Payroll management | NOT STARTED | Depends on employee profiles, attendance, and leave; requires restricted salary APIs, decimal-safe calculations, approval/payment workflow, and audit coverage. |
| Tasks/technician operations | PARTIALLY IMPLEMENTED — VERIFICATION DEFERRED | Added company-scoped Tasks CRUD/status/assignment/comments and persisted reminders; extended existing FieldJob dispatch with appointment windows, conflict checks, visits/activity, technician completion review, checklist/reporting, and transactional serialized-item reserve/issue/consume/return/damaged/lost movements. Private photo evidence, optional GPS visits, recurring schedules and ownership reconciliation are prepared in source; quantity-based stock and route optimization remain pending. |
| Vendor directory/procurement approvals | NOT STARTED | Expense/inventory exist, but no procurement workflow verified. |
| Warehouses/transfers/stocktakes/minimum stock | IN PROGRESS | Extend InventoryItem/InventoryMovement; movement ledger is authoritative. |
| Asset lifecycle and maintenance | NOT STARTED | Link assets to existing NAS/network devices and inventory. |
| CRM leads/sales pipeline | INTEGRATED — VERIFICATION DEFERRED | Company-scoped CRUD/archive, seven-stage pipeline, employee assignment, follow-up timeline/reminders, filters/summaries and duplicate-reviewed conversion into the existing Subscriber record are implemented. Customer request and explicit Ticket/FieldJob handoff remain pending. |
| Network topology/fiber and POPs | IN PROGRESS | Reuse native topology, OLT/fiber and NAS records; no fabricated coordinates/status. |
| Bandwidth providers/contracts/cost history | NOT STARTED | Integrate with native expenses/accounting. |
| Reseller/dealer performance and allocation | IN PROGRESS | Reuse user tree, pricing, payments and existing reports. |
| Cashbook/payables/receivables | IN PROGRESS | Existing accounting/cashflow/expense systems; no unsupported double-entry claim. |
| Customer support/portal | IN PROGRESS | Reuse ticket, ticket message, portal and notification systems. |
| Scheduled jobs and execution history | IN PROGRESS | Existing scheduler/job systems; new jobs require retries and failure reporting. |
| Advanced operational reports | IN PROGRESS | Extend permission-controlled scoped reports. |

## Phase 2 — CRM Leads & Sales Pipeline

**Status: INTEGRATED — VERIFICATION DEFERRED**

- **Reference features:** Unified the duplicated `Connection leads` module from
  both references. Source fields (name, phone, address, package, status and
  notes) are represented; source `Approved` maps to UPLINKO `WON` and `Closed`
  maps to `LOST`. Added requested email, service area, acquisition source and
  channel, estimated monthly value, priority, employee assignment, stage
  history, lost reason, archive and server-side filtering/pagination.
- **Pipeline and interactions:** Implemented New, Contacted, Qualified,
  Follow-up, Interested, Won and Lost stages, stage counts and estimated
  totals, lead detail and interaction timeline, employee assignment,
  follow-up scheduling, and lost reason. An hourly singleton reminder job
  records due follow-ups in the existing ActivityLog/notification feed; it
  does not send SMS/email.
- **Duplicate-safe conversion:** Reviews company-scoped candidates using
  normalized phone and email; names alone are never matched. The operator
  explicitly links a selected existing subscriber without changing it.
  Any contact conflict blocks creation until the lead contact is resolved.
  Otherwise conversion calls the existing subscriber creation service with
  a cryptographically random per-lead idempotency key stored separately
  from lead API responses and `activateNow: false`, generating credentials
  that are not returned. Retries recover a subscriber created before an
  interrupted lead-link operation. New records remain inactive; no invoice,
  payment, wallet charge, RADIUS sync, service activation or welcome message
  is triggered. Lead row/advisory locks protect repeat and competing CRM
  conversion calls.
- **Existing UPLINKO systems reused:** `Subscriber` and
  `SubscribersService`, `Package`, company `EmployeeProfile`, the
  `crm-advanced` entitlement, JWT/PermissionsGuard, company isolation,
  ActivityLog and the existing notification feed. No second user,
  subscriber, billing, support or employee database was created.
- **Permissions:** Added `crm.leads.read/create/edit/activity/assign/pipeline/
  archive/convert`. Duplicate candidate lookup additionally requires
  `subscribers.read`; conversion requires `subscribers.write`. Existing role
  presets include the CRM actions; company/role/child-deny enforcement stays
  server-side.
- **Source changes:** Added `CrmLead`, `CrmLeadActivity` and private
  `CrmLeadConversionKey` schema models and
  `20261103100000_crm_leads_pipeline` migration source; added CRM API module,
  service/controller and the UPLINKO `/crm/leads` screen/navigation entry;
  updated security routes/catalog, notification-feed labels, and the
  subscriber service to suppress welcome notifications for register-only
  conversion. Migration is **not applied**.
- **Partial/pending:** Customer request intake and explicit Ticket/FieldJob
  handoff remain pending. No username/CNIC is present on the reference lead,
  so those identifiers are not compared. Subscriber phone/email uniqueness
  is intentionally not added because valid sharing is supported. Stage
  configuration is fixed to the seven requested stages.
- **Testing/database operations:** None performed. No tests, typechecks,
  lint, browser workflows, Prisma commands/client generation, database
  commands, migrations, commits, pushes or deployments were run.
- **Deferred verification:** Run Prisma schema validation/client generation;
  add and run focused CRM service tests for tenant and permission boundaries,
  normalized duplicate candidates, name-only non-matching, matched-record
  immutability, register-only side effects, repeat/concurrent conversion,
  reminder deduplication and filters/pagination. Then run backend typecheck
  and targeted lint, frontend typecheck and page lint, authorized migration
  integration, and browser workflows for create/edit/assignment/stage/archive,
  reminders, duplicate review and both conversion paths.
- **Next recommended phase:** Continue Phase 2 with customer-request intake
  and explicit handoff into existing Tickets/FieldJobs. Do not auto-create
  tickets, field jobs, charges or activated services from lead conversion.

## Stage 5 — Synchronization

| Workflow | Status | Notes |
|---|---|---|
| Subscriber registration → installation task | NOT STARTED | Must call existing subscriber and FieldJob services; subscriber registration does not automatically create a work order. |
| Field job → inventory issue/return | PARTIALLY IMPLEMENTED — VERIFICATION DEFERRED | Field jobs link serialized inventory movements for reservation, issue, consumption, return, damaged and lost outcomes; subscriber registration is not yet a work-order trigger. |
| Installation → network/POP/fiber relationship | NOT STARTED | Persist only operator-verified relationships. |
| Existing RADIUS/PPPoE and billing | IMPLEMENTED | Existing systems remain authoritative; integration must not alter their behavior. |
| Procurement receipt → inventory | NOT STARTED | Atomic, idempotent receipt and stock movement required. |
| Finance payment → vendor/payable/cashbook | NOT STARTED | Reuse ledger and prevent duplicate financial posting. |
| Integrated records → AI queries | NOT STARTED | Add only after source permissions/scope are covered by tests. |

## Stage 6 — Administration, deployment and verification

| Capability | Status | Notes |
|---|---|---|
| Super Admin global feature controls | TESTED | Separate AI and Advanced CRM controls in Plans & Pricing. |
| Company entitlement controls | TESTED | Separate product inclusion/overrides in existing company plan workflow. |
| Provider/model, quota and cost administration | IN PROGRESS | Atomic company quota reservation and usage visibility exist; provider settings are environment-only and separately named. |
| Installation/update migration path | IN PROGRESS | Additive Prisma migration is authored and reviewed; not applied to any database. |
| Health/job status and audit history | IN PROGRESS | Usage ledger and audit redaction exist; operational health/history remains. |
| Focused backend tests/typecheck/lint | IN PROGRESS | Earlier sessions reported focused unit tests/typecheck/lint results; no test, typecheck, lint, migration, or database command was run for the source-inventory phase. Attendance/Leave database verification remains outstanding. |
| Frontend checks/build | IN PROGRESS | Earlier sessions reported frontend typecheck/page-lint results; no frontend check or browser workflow was run for the source-inventory phase. |
| Production DB/router/deploy safety | TESTED | No production database, router, migration, commit, push, merge, or deploy was used. |

## Current recovery notes

- Original AI service and prior mapping were zero-filled. Their exact byte
  contents are preserved in session-state backups.
- They are untracked and absent from Git history; reconstruction must be
  labeled as reconstruction.
- `ai-engine/ai.example/` and `ai-engine/crm/advanceispcrm/` remain read-only.
- No SNMP work is in scope for this integration task.
- Current implementation is a foundation milestone, not full roadmap completion.
- No migration was applied; no production database/router, commit, push, merge,
  or deployment was used.
- The HR migration is additive and unexecuted. Employee profiles do not create
  authentication users or store payroll/salary data.
- The new Leave Management migration is additive and unexecuted. No payroll
  implementation, database migration, production deployment, or browser
  verification is included in Module B.

## Phase 6 — Internal Tasks and Field Operations

**Status: PARTIALLY IMPLEMENTED — VERIFICATION DEFERRED**

- **Reference behavior:** Both extracted reference trees
  (`ai-engine/crm/advanceispcrm/` and `ai-engine/ai.example/`) define internal
  assigned tasks separately from support tickets. Their
  `crm_operations.py`/`web/operations.js` workflow uses title/description,
  employee, due date, priority, status and operational history; a technician
  can update only their own task and cannot change manager-owned assignment or
  schedule fields. No dedicated replacement work-order model was copied; the
  UPLINKO FieldJob is the source of truth.
- **Internal Tasks:** Added company-scoped task records with title, description,
  category, priority, due date, employee assignment, status transitions,
  comments/activity, search/filter/pagination, summary counts and optional
  links to existing Subscriber, CRM lead, Ticket or FieldJob records. Reuses
  existing `EmployeeProfile`, tenant scope, permissions, audit log and CRM
  records. The UI provides task listing, creation/editing, assignment, status
  actions and activity detail.
- **Field Operations:** Extended existing `FieldJob` rather than introducing a
  second work-order system. Added appointment windows, active-technician and
  approved-leave checks, overlap prevention, operational activity history,
  multiple visit records, arrival-before-start, technician checklist,
  completion submission and dispatcher review, assistance requests,
  cancellation reasons and date/status/type/technician/search filters.
  Ticket resolution remains deferred until a dispatcher approves successful
  completion. The corrupted FieldJobs service and page were intentionally
  replaced. The rebuilt service supports company-scoped listing/details,
  bounded pagination, create/edit, ticket handoff, assignment/reassignment/
  unassignment, scheduling, legal work transitions, arrival, visits, checklist,
  completion/failure, review, cancellation, assistance, audit/activity and
  reports. The UPLINKO page exposes job, technician, checklist, assistance,
  materials, completion and activity workflows. Editing a related record
  preserves exactly one subscriber, ticket or lead relationship.
- **Inventory workflow:** Added transactional operations using existing
  InventoryItem and InventoryMovement records: reserve, issue to the assigned
  technician, consume, unreserve, return unused, damaged and lost. Conditional
  stock updates, serializable transactions, unique idempotency keys, job/
  employee linkage, movement history and audit entries prevent duplicate
  movements and negative or cross-company use. Generic inventory assignment,
  installation, return and delete paths reject items already tied to a field
  job. The Field Jobs UI now selects from available, job-reserved and
  job-issued serialized items and presents custody and movement history.
  Reassignment requires material resolution; cancellation releases reservations
  but blocks unresolved issued items; dispatcher closure blocks any outstanding
  reservation or issuance. Consumption requires a subscriber link and does not
  activate service or create a charge.
- **Durable reminders:** Task.reminderAt and TaskReminder persist schedules,
  assignment, delivery state, lease, retry count and message idempotency key.
  A database-claimed scheduler rechecks current task/assignee and company
  entitlement, honors the assigned employee's enabled SMS/email preferences,
  and reconciles queued, sent, simulated, failed, cancelled and unknown
  notifications. Message sending claims expire after five minutes; stale
  claims become `UNKNOWN` rather than being resent automatically because the
  provider may already have accepted them. Delivery attempts are bounded to
  three. Simulated delivery is not recorded as delivered. Exactly-once external
  delivery cannot be guaranteed without provider idempotency; an operator may
  explicitly retry an unknown result while attempts remain after a duplicate-
  risk confirmation. Database-persisted queued messages are re-enqueued after
  restart in inline queue mode; BullMQ/Redis retains its own queue. Schedule
  changes, reassignment, completion and cancellation cancel eligible queued
  messages. Legacy `SENDING` records without a recorded claim timestamp cannot
  be classified safely and need operator reconciliation.
- **Access and audit:** Task operations are company-scoped and use the existing
  `crm-advanced` entitlement, HR employee profiles, role permissions, task-specific
  route permissions and ActivityLog. FieldJob visibility remains tied to
  existing subscriber/user-tree scope; dispatch, technician, review and report
  actions use granular route permissions and service-side authorization.
  Important task and field-job state changes write activity records and audit
  entries.
- **Source changes:** Added `backend/src/tasks/` and
  `frontend/app/tasks/page.tsx`; updated
  `backend/prisma/schema.prisma`,
  both task/field-job and materials/reminders migration sources,
  `backend/src/field-jobs/field-jobs.service.ts`,
  `backend/src/field-jobs/field-jobs.controller.ts`,
  `backend/src/field-jobs/field-jobs.module.ts`,
  `backend/src/inventory/inventory.service.ts`,
  `backend/src/tasks/`, notification service/feed, security permission
  catalog/route mappings, `frontend/app/field-jobs/page.tsx`,
  `frontend/app/tasks/page.tsx`, application navigation and the progress/
  integration-mapping documents.
- **Remaining gaps:** InventoryItem is serialized-unit based; bulk quantity
  stock, warehouse transfers/stocktakes and vendor procurement are separate
  pending workflows. A nullable InventoryItem company owner was added for
  explicit ownership; legacy unowned stock remains unavailable until safely
  reconciled. FieldJob has no direct companyId and derives visibility from
  linked/assigned/created records. Related-task records use scoped IDs rather
  than searchable pickers. Route optimization requires a real routing
  provider. Reminder schedule state is durable, but actual message delivery
  is durable only with BullMQ/Redis; UPLINKO's inline queue fallback is not
  durable. A notification already being sent cannot be recalled after a
  concurrent cancellation.
- **Schema/migration:** Additive inventory movement/item links, Task.reminderAt,
  TaskReminder and Message.idempotencyKey are source-only in
  `backend/prisma/schema.prisma` and
  `backend/prisma/migrations/20261103140000_field_jobs_materials_task_reminders/migration.sql`.
  A source-only notification-claim migration adds `Message.queuedAt` and
  `Message.sendingAt` in
  `backend/prisma/migrations/20261103160000_notification_delivery_claim_recovery/migration.sql`;
  FieldJob and InventoryItem Prisma indexes now declare the matching indexes
  already present in the earlier SQL. The source-only advanced field execution
  migration adds private evidence metadata, optional visit-location fields,
  recurring schedule/occurrence records and claim-lease columns, visit order,
  and nullable inventory company ownership. All migrations remain unapplied.
- **Deferred verification:** Validate the Prisma schema/client and all four
  relevant migration sources against the deployed PostgreSQL schema; add focused tests
  for company/employee permission boundaries, legal transitions, reminder
  deduplication/retries/reschedule/cancellation races, concurrent assignment
  and schedule overlap, visit/checklist/review behavior, inventory operation
  idempotency and stock races, reservation release, and generic inventory
  bypass protection. Then run backend/frontend typechecks and focused lint,
  authorized migration/database integration, and browser workflows for task
  reminders and dispatcher/technician materials-to-completion. None of these
  checks were run for this phase.
- **Next recommended phase:** Safely reconcile remaining legacy unowned
  serialized items and define warehouse/quantity semantics before extending
  field-job material workflows to bulk stock. Route planning remains dependent
  on selecting and integrating a real routing provider.

## Field Operations reliability hardening — source changes, verification deferred

| Area | Source change | Remaining limitation |
|---|---|---|
| Task visibility | `tasks.readAll` alone controls company-wide reads; its inherited explicit user denial overrides role grants. Company-wide management additionally requires `tasks.assign`. List, summary, detail, comments and assignment use the same object scope. | Runtime authorization behavior remains unverified. |
| Serialized materials | The job detail exposes available/reserved/issued items and movement attribution. Only state-appropriate actions are selectable; API transitions retain existing company, permission, transaction and idempotency checks. | Bulk quantities and warehouse workflows are out of scope. |
| Material custody | Reassignment blocks while reserved/issued items remain; cancellation releases reservations and blocks issued items; successful dispatcher closure requires all items resolved. | Previously closed jobs with unresolved custody may need explicit cleanup. |
| Notification recovery | `Message.queuedAt` allows recovery of queued delivery after restart in inline mode; `Message.sendingAt` supports a five-minute stale-claim lease. Three delivery attempts maximum; ambiguous stale sends become `UNKNOWN` for explicit operator review, not automatic retry. Simulated sends are not marked delivered. | Exactly-once delivery depends on external provider idempotency; unknown-result retries can duplicate delivery. Legacy `SENDING` rows without a claim timestamp require operator reconciliation. Inline queue execution itself remains non-durable. |
| Schema | Added declarations for migration-created FieldJob/InventoryItem indexes and a source-only migration for the message lease column/index. | Prisma/database compatibility and migration application are unverified and remain prohibited for this phase. |

No tests, typechecks, lint, builds, browser workflows, Prisma commands,
database commands, migrations, commits, pushes or deployments were performed
for this hardening phase.

## Advanced Field Execution — source prepared, verification deferred

| Capability | Source implementation | Status and limitations |
|---|---|---|
| Technician evidence | Field Jobs uses the existing private upload path, image checks/size limits, uploader/company ownership, job authorization, evidence type, notes, timestamps and movement/audit history. | Photo attachment and private-preview flows are implemented in source; no public file URL is introduced. Runtime access controls remain unverified. |
| Optional location | User-triggered check-in/check-out records store outcome, server timestamp, technician, coordinates and accuracy when permission is granted. Failed/unavailable/denied/not-requested outcomes are recorded without fabricated coordinates or continuous tracking. | Optional GPS only; device/browser permission and location accuracy remain external conditions. |
| Recurring work orders | Persistent DAILY/WEEKLY/MONTHLY schedules include interval, start/end, explicit IANA timezone, pause/cancel state, occurrence-to-job history, and a validated company-scoped edit endpoint/UI. Edits are audited and affect only jobs generated after saving; generated jobs and occurrence history are not rewritten. Recurrence changes recalculate the next run to the first matching time at or after the edit, skipping overdue ungenerated slots. A primary-instance cron uses a ten-minute persisted claim lease and unique occurrence key before queue processing. | Cancelled schedules remain terminal; paused schedules remain paused. Edits/status changes are rejected while a valid worker lease is held, and stale leases are conditionally cleared. Schedule times use the explicitly selected timezone because no company timezone setting exists. DST gap times resolve to the first real minute after the requested wall time. Assignment/template fields are not present on the schedule model. |
| Dispatch | Technician workload, unassigned/overdue visibility, priority/due-date information, assignment history and planned visit order are exposed in the existing Field Jobs workflow; existing assignment overlap and approved-leave checks remain in use. | Visit-order conflict grouping uses UTC calendar dates; no route optimization or travel-time estimate is provided without a routing provider. |
| Serialized ownership | InventoryItem has nullable company ownership; company admins can reconcile only eligible unowned serialized items supported by matching company custody history. Field-job movements retain item/job/employee/actor history and transaction protections. | Unowned items without matching evidence remain unavailable for tenant workflows. Existing quantity-based inventory is preserved; no quantity or warehouse workflow was added. |
| Schema, permissions and migration | Added `field-jobs.evidence`, `field-jobs.location`, `field-jobs.schedules` and `inventory.reconcile` permission mappings; schema and source migration cover evidence, visit locations, recurring schedules/occurrences/leases, visit order and inventory company ownership. | `backend/prisma/migrations/20261103180000_advanced_field_execution/migration.sql` is source only and unapplied. No Prisma/client/database verification was performed. |

Relevant source files include `backend/src/field-jobs/field-jobs.service.ts`,
`backend/src/field-jobs/field-job-schedules.service.ts`,
`backend/src/field-jobs/field-jobs.controller.ts`,
`backend/src/inventory/inventory.service.ts`,
`backend/src/uploads/uploads.controller.ts`,
`frontend/app/field-jobs/page.tsx`, and
`frontend/app/inventory/page.tsx`. No tests, typechecks, lint, builds, browser
workflows, Prisma commands, database operations, migrations, commits, pushes,
merges or deployments were performed for this phase.

## Phase 5 — Module A: Attendance Management

**Status: IMPLEMENTED — NOT VERIFIED**

- **Persistence:** Added `EmployeeAttendance` and
  `EmployeeAttendanceCorrection`, linked to the existing company-scoped
  `EmployeeProfile`; unique employee/date constraint and safe additive migration
  `20261102120000_crm_advanced_attendance`.
- **Backend:** Added `GET /hr/attendance` with bounded date filters, department
  and employee filters, pagination, and status/duration summaries; employee
  history, correction history, check-in, check-out, and correction APIs.
- **Frontend:** Added the attendance page, company navigation entry, filters,
  summary cards, punch controls, correction form, and correction history.
- **Access:** All routes enforce `crm-advanced`; granular
  `hr.attendance.read`, `hr.attendance.write`, and `hr.attendance.correct`
  permissions are mapped. Employees can record only their own attendance;
  corrections are company-admin-only. The Super Admin cannot use the business
  attendance service.
- **Audit:** Check-in, check-out, and corrections write ActivityLog entries in
  the same transaction. Corrections also retain previous/new status and
  timestamp snapshots with actor and reason.
- **Tests run:** 7 focused backend suites passed (37 tests), covering attendance,
  employee-directory, entitlement, route permissions, and AI Agent regressions.
  Backend/frontend typechecks, focused attendance/service lint, frontend
  attendance-page lint, Prisma validation/generation, and `git diff --check`
  passed.
- **Not verified:** No PostgreSQL migration or database-backed integration test
  was run; no browser workflow was run. Prisma validation reports four
  `SetNull` relation warnings. Broader linting of pre-existing permission
  catalog/app-shell files reports legacy lint violations; the new attendance
  page and focused backend implementation lint cleanly.
- **Limitations:** Attendance dates use Asia/Karachi calendar days. Late,
  absent, and half-day statuses require an authorized correction; no shift
  policy or automatic attendance inference exists. Approved leave is linked by
  Leave Management without fabricated punch times. The broader feature
  roadmap is maintained in `uplinko-ai-advanced-crm-integration-mapping.md`.

## Phase 5 — Module B: Leave Management

**Status: IMPLEMENTED — NOT VERIFIED**

- **Persistence:** Added tenant-safe leave types, leave requests with explicit
  selected calendar dates, request history, yearly balance records, immutable
  balance entries, and a linked attendance leave status. Migration
  `20261102140000_crm_advanced_leave` is additive and unapplied.
- **Workflow:** Employees submit and cancel their own requests. Approvers can
  act only within their department; self-approval is rejected. Requests reject
  overlapping pending/approved dates. Decisions, attendance updates, balance
  deductions/reversals, and audit entries share database transactions with
  employee-row locking.
- **Balances and policy:** Companies must create leave types and explicit
  allocations; no type, policy allocation, holiday calendar, or starting
  balance is invented. Multi-year requests require a balance for each year.
  Adjustments require a reason and cannot make available balance negative.
- **Attendance:** Approval creates leave-only attendance rows with no
  check-in/out times and never overwrites existing attendance. Cancellation
  before any selected date begins reverses the balance and marks only
  leave-originated attendance as `CANCELLED_LEAVE`; manually corrected linked
  attendance blocks cancellation rather than being overwritten.
- **Access and UI:** Routes enforce `crm-advanced`, granular leave permissions,
  company scope, and department scope. The Leave workspace includes requests,
  approvals, balances, and permission-gated type/allocation controls. Existing
  queued email notifications are used where a recipient email is available;
  queue failures are logged without undoing a committed leave decision.
- **Not verified / limitations:** No PostgreSQL migration, database-backed
  integration, or browser workflow was run. Selected leave dates are
  calendar-date specific; no work schedule, holiday calendar, half-day leave,
  automatic recurring allocation, or payroll integration is implemented.

## Phase 0 — Complete reference feature inventory

**Status: MAPPED — IMPLEMENTATION PENDING**

- Inspected the read-only extracted source trees
  `ai-engine/ai.example/` and `ai-engine/crm/advanceispcrm/`. The requested ZIP
  files were not present in the workspace.
- Added a unified feature-by-feature matrix to
  `uplinko-ai-advanced-crm-integration-mapping.md`, including source locations,
  functional behavior, dependencies, UPLINKO equivalents/gaps, destinations,
  status, duplicates, external blockers and phased implementation sequence.
- The inventory covers the assistant, CRM/customer and lead workflows,
  billing/receipts/recovery, accounting, support/portal, workforce/payroll,
  procurement/inventory/assets, network/fiber/bandwidth, operations,
  automation/notifications, reports and supporting utilities.
- Key overlap decisions: preserve UPLINKO's existing subscriber, user, ticket,
  payment/accounting, inventory, network and portal authorities; do not copy
  reference authentication or tenant handling; the Advanced CRM reference's
  “Leave” is an attendance status rather than leave-request/approval workflow.
- **Code changes in this phase:** documentation only; no runtime feature or
  Prisma schema/migration file was changed. Existing uncommitted schema and
  migration work remains unapplied.
- **Checks in this phase:** none. No tests, typechecks, lint, browser workflows,
  Prisma commands, database commands, migrations, commits, pushes or
  deployments were run.
- **Next:** execute the mapped integration phases from the matrix without
  duplicating UPLINKO systems; preserve dedicated test/migration/browser
  verification for a separately authorized phase.

## Phase 6 — Field operations reporting and performance workspace

**Status: PARTIALLY IMPLEMENTED — VERIFICATION DEFERRED**

- **Endpoints:** Reuses the existing Field Jobs module and permission map:
  `GET /field-jobs/reports/summary` and `GET /field-jobs/reports/jobs`. Both
  retain the controller's JWT, `PermissionsGuard` and `crm-advanced`
  entitlement guards, and require `field-jobs.report`; the summary and detail
  service methods check that permission and resolve company scope per request.
- **Shared filters:** Both endpoints accept inclusive UTC `from`/`to` dates
  (maximum 366 calendar days), technician, status, priority, job type and
  subscriber ID. Invalid dates/enums/IDs and cross-company technician or
  subscriber IDs are rejected. The page keeps draft inputs separate from the
  applied filter snapshot: Apply Filters refreshes the summary with that
  snapshot, and every drill-down and detail page uses the same snapshot.
  Breakdown categories add a category constraint without changing shared
  filters. Stale summary/detail responses cannot replace newer results.
  Subscriber filtering and subscriber details additionally require
  `subscribers.read`.
- **Overview and technician metrics:** Uses `FieldJob` grouped counts and
  counts for statuses, open/overdue/unassigned/approaching work. Completion
  rate is completed jobs divided by non-cancelled jobs. Average duration uses
  completed jobs with non-null, non-negative `startedAt`/`completedAt`, via
  database-side aggregation. Technician counts, completion rates (completed
  divided by assigned jobs excluding cancelled jobs), valid average durations,
  period and workload are shown; attendance is not inferred.
- **SLA and delays:** Deadline is `appointmentEndsAt`, falling back to
  `scheduledAt`; overdue means an open job past that deadline and approaching
  means within 24 hours. Delay groups/average use current time for overdue open
  jobs and recorded completion time for late completed jobs. Priority/type
  breakdowns use overdue open jobs. Repeated rescheduling is based on more than
  one recorded `SCHEDULED` `FieldJobActivity`. No contractual SLA target or
  distinct delay-reason field is present; delay reasons are not fabricated.
- **Schedule performance:** Uses unique `FieldJobOccurrence` records for
  generated/completed occurrence counts. Upcoming counts are active schedules
  whose `nextRunAt` falls within the selected date range; they are not generated
  occurrences. Schedule-state counts are each schedule's current state for
  schedules created within the selected date range, not status changes during
  that period. These upcoming and state metrics are informational, not
  clickable drill-downs. Skipped occurrences and failed-generation attempts
  are unavailable because no such records are persisted. Upcoming and schedule
  state metrics are unavailable when a technician/status filter cannot be
  meaningfully applied to an ungenerated schedule.
- **Drill-down and UI:** KPI cards, status breakdowns, delay groups,
  priority/type groups, schedule generated/completed metrics, technicians and
  repeated reschedules open bounded paginated job details. Detail requests and
  pagination reuse the applied filters, while the draft filter controls do not
  change a drill-down until Apply Filters is selected. Section switching
  retains both filter states. The page includes Operations Overview,
  Technician Performance, SLA & Delays and Schedule Performance. A
  permission-gated link in the existing Field Jobs header opens the report
  page. Filter loading/error/permission-denied/empty states and responsive
  cards/charts are provided.
- **Privacy and performance:** Raw SQL aggregates are parameterized and use
  the same company relationship scope as the Prisma job queries. Detail
  records use server pagination capped at 100 and select only job identifiers,
  status/type/priority, recorded deadlines/completion, technician and
  permission-gated subscriber labels; GPS and evidence data are not selected.
- **Migration:** No schema change or migration source was added; existing Field
  Job, Field Job Activity, Schedule and Occurrence data are reused.
- **Verification:** Not runtime verified. No tests, typechecks, lint, builds,
  browser checks, Prisma commands, database commands or migrations were run.
  The change has not been committed, pushed, merged or deployed.

## Phase 7 — Dispatch intelligence and technician workload

**Status: IMPLEMENTED IN SOURCE — VERIFICATION DEFERRED**

- **Workspace and endpoints:** Adds `/field-jobs/dispatch` for dispatchers and
  `GET /field-jobs/dispatch`, `GET /field-jobs/:id/dispatch` for a paginated
  queue/workload response and a scoped advisory recommendation/history
  response. Existing `PATCH /field-jobs/:id/assign/:technicianId` confirms
  assignment or reassignment; no automatic assignment is performed.
- **Permissions and isolation:** Reuses `field-jobs.dispatch` for the
  workspace, recommendation/history reads and assignment actions, plus the
  existing JWT, `PermissionsGuard` and `crm-advanced` guards. Service methods
  resolve company scope and constrain jobs to company-descendant users,
  subscribers/tickets or company leads. The owning company is resolved by
  cross-validating every available linked lead, direct subscriber, ticket
  subscriber, assigned-user and creator relationship after normalizing each
  with the existing company-root rule.
  Missing optional links are allowed; unresolved ownership or conflicting
  roots fail closed. A job whose resolved owner does not match the caller's
  company is not dispatchable. Queue/detail technician profile and name details
  are returned only for active employee profiles eligible in the resolved job
  company and visible dispatcher user tree; creator/assignment actor details
  are similarly withheld when not eligible. Technician filters/candidates
  require active employee profiles in that same company scope and visible user
  tree. Subscriber filtering, names and the potentially subscriber/site-bearing
  job address require `subscribers.read`; the queue selects/returns the job
  address only with that permission. Dispatch detail and mutation responses
  never return the job address, and omit subscriber identity and address
  without `subscribers.read`.
- **Queue and workload:** Queue filters include created-date range, technician,
  status, priority, job type and permission-gated subscriber. Results are
  database-filtered and paginated (maximum 100). Date range applies to job
  `createdAt`; overdue and due-soon use recorded appointment end, falling back
  to scheduled time. Workload aggregates current open, in-progress and overdue
  jobs, future scheduled jobs in the selected range, and completions whose
  `completedAt` is in the range. Technician profiles are capped at 500 and the
  response identifies truncation.
- **Recommendations:** Advisory ordering uses active company employees,
  assignment eligibility, current open/overdue workload, recorded completed
  jobs of the same type, upcoming scheduled commitment counts, scheduled
  overlaps and approved leave. Explanations state each workload/conflict and
  data limitation. Priority is shown but is not assigned a fabricated
  weighting; no company priority-ranking policy exists. Recommendations never
  mutate jobs. Workload and conflicts are restricted to jobs visible within
  the same company scope; technicians from other companies are not candidates.
- **Assignment audit/safety:** Existing assignment logic continues to enforce
  closed/active-job restrictions, approved-leave and schedule conflicts,
  inventory custody, and company-active technician eligibility. The update
  uses a serializable transaction and an optimistic condition on job
  `updatedAt`, status and prior assignee; ownership is re-resolved inside the
  write transaction and the technician's active same-company profile is
  rechecked before updating. The dispatch caller supplies the expected
  assignee. Reassignment requires a reason. Assignment and
  reassignment are recorded in `FieldJobActivity` and `ActivityLog`. History
  is available through the scoped `GET /field-jobs/:id/dispatch/history`
  endpoint in descending activity-ID cursor pages of up to 100 entries; each
  response reports `returned`, `hasMore` and `nextCursor`. The UI invalidates
  pending history requests whenever detail refreshes or the selected job
  changes, deduplicates entries by activity ID, and retains already visible
  history when refreshing the first page. No new notification behavior is
  added.
- **Data limits/privacy:** `EmployeeProfile` has no skill or working-hours
  availability records; job `requiredSkills` cannot be matched to technicians.
  Existing attendance is not treated as future availability. Approved leave
  can block a recommendation when an appointment is scheduled. Proximity is
  not calculated, no GPS/location evidence is returned or used, and no routing
  provider or travel-time claim is introduced. Same-type completed counts are
  history, not skill certification. No schema or migration source was added.
- **UI:** The Field Jobs header offers a dispatch-permission-gated workspace
  link. The page has shared filters, KPI counts, a bounded job queue,
  technician workload cards, recommendation explanations, assignment history,
  manual assignment confirmation and a reason field for reassignment. It
  follows existing theme variables and stacks job/workload cards on narrow
  screens.
- **Verification:** Not runtime verified. No tests, typechecks, lint, builds,
  browser checks, Prisma/database operations or migrations were run. No
  commit, push, merge or deployment was performed.

## Phase 8 — SLA and service-quality management

**Status: IMPLEMENTED IN SOURCE — VERIFICATION DEFERRED**

- **Workspace and access:** Adds the responsive `/sla` workspace to the
  existing navigation and command palette. Ticket SLA routes require the
  existing JWT and permission guards, `tickets.sla` for viewing,
  `tickets.sla.manage` for policy changes, and the `crm-advanced` entitlement.
  Field-job SLA records reuse the `field-jobs.report` permission and the
  existing Field Jobs `crm-advanced` guard. Ticket data is scoped through the
  subscriber's company tree; field-job records reuse the report service's
  company scope. Ticket subjects, subscriber identities and assignee names
  remain permission-gated; assignee details must also belong to the visible
  company user tree.
- **Policy snapshots:** Adds `SlaPolicyVersion` series and version history,
  company-root policy ownership, effective dates, priority/record-type targets,
  warning thresholds and elapsed-UTC clock mode. New tickets and field jobs
  snapshot their applicable policy version, targets and due timestamps when
  created, so later policy versions do not recalculate existing records.
  Policy create/version actions are audited in `ActivityLog`; historical
  backfill is disabled rather than assigning invented targets.
- **Recorded events and limits:** Ticket first response is the first recorded
  staff message, persisted in the same transaction as the message. Ticket
  resolution is the first recorded transition to
  `RESOLVED`; the first resolution clock is retained after reopening, and
  reopen count/time are tracked. Field-job resolution is dispatcher-approved
  completion, not technician submission or customer confirmation. Field jobs
  have no recorded customer-response event or reliable reopen lifecycle.
  Durations use recorded timestamps only; timestamps preceding record creation
  are unavailable and excluded from compliance and duration aggregates.
  Business-hours calendars, pause/resume accounting and internal
  operator alerts are unavailable. SLA milestones do not send subscriber
  notifications.
- **Metrics and records:** Ticket and field-job summaries distinguish
  unconfigured/unavailable targets from eligible outcomes. Compliance
  denominators include configured targets only after the outcome is recorded
  or its deadline has elapsed; not-yet-due and unknown outcomes are not counted
  as successes. Compliance is unavailable (`null`) when no records are
  eligible. Ticket records and field-job SLA records are server-filtered and
  paginated (maximum 100 per page) with total/`hasMore` metadata and stable
  created-time/ID ordering. Date ranges are limited to 366 calendar days.
- **UI and migration:** The workspace provides overview, at-risk, breached,
  meeting-target, performance-history and policy sections; date, priority,
  record-type and field-job type filters; bounded records; and policy
  versioning controls. It uses existing Uplinko theme variables and responsive
  layouts. The schema change is represented by
  `backend/prisma/migrations/20261103190000_sla_policy_snapshots/migration.sql`;
  this migration source has not been applied.
- **Verification:** Source changes only; no tests, typechecks, lint, builds,
  browser checks, Prisma/database operations or migrations were run. The
  implementation is not runtime verified, and no Git staging, commit, push,
  merge or deployment was performed.
