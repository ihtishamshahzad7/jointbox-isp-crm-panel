# UPLINKO AI and Advanced CRM Integration Mapping

## Status and source notes

This is the reconstructed master feature matrix for the available reference
source trees and UPLINKO integration work. The previous contents of this file
were entirely NUL bytes and could not be recovered as readable text. This
document is rebuilt from the readable progress record and inspected source
files; it is not represented as a byte-for-byte recovery of the lost matrix.

The requested `ai.example.zip` and `advanceispcrm.zip` archives were not
available in the workspace. The extracted read-only source trees
`ai-engine/ai.example/` and `ai-engine/crm/advanceispcrm/` were used. The two
references contain overlapping CRM operations code. Reference auth, database,
subscriber, employee and inventory systems are not copied into UPLINKO.
Statuses below describe implementation scope, not runtime verification.

Status definitions:

- **Already implemented** — an existing UPLINKO workflow is reused without
  claiming new integration.
- **Integrated** — the relevant end-to-end workflow is represented in
  persistence, authorization, service and UI; deferred verification is called
  out separately.
- **Partially integrated** — a useful connected workflow exists, with listed
  gaps.
- **Pending** — not implemented.
- **Blocked** — cannot safely proceed without a prerequisite or a decision.
- **Not applicable** — the reference capability does not fit UPLINKO's
  existing architecture; reason is stated.

## Master feature matrix

| Reference capability | Reference source locations | Existing UPLINKO system | Integration/status | Remaining gaps |
|---|---|---|---|---|
| ISP subscriber, service, package and billing records | Both trees: native CRM/subscriber and billing modules | `Subscriber`, `Package`, existing billing/payment services | **Already implemented**; remain authoritative | No parallel customer or billing database |
| Deterministic CRM assistant queries and summaries | Both trees: `crm_assistant_queries.py` | Existing AI Agent native query service and scoped CRM records | **Partially integrated** | Some source query parity, historical formulas and record-level intents remain |
| Urdu/Roman Urdu assistant language | Both trees: `crm_assistant_language.py` | Existing AI Agent parsing and local summaries | **Partially integrated** | Vocabulary and language coverage remain bounded |
| Assistant chart/visual output | Both trees: `crm_assistant_visuals.py` | Existing server-generated AI summaries/charts | **Partially integrated** | Additional supported metrics and comparisons remain |
| Connection leads and sales conversion | Both trees: `crm_operations.py` `Connection leads` module | UPLINKO CRM Lead pipeline, Subscriber and SubscribersService | **Integrated — verification deferred** | Customer-request intake and explicit Ticket/FieldJob handoff remain; lead conversion does not activate service or bill |
| Internal employee profiles and HR | Both trees: `crm_operations.py` People modules | Existing `EmployeeProfile`, HR module and UPLINKO user tree | **Partially integrated** | Payroll and normalized catalogs remain |
| Attendance and leave | Both trees: `crm_operations.py` People modules | Existing HR attendance/leave records and workflows | **Integrated — verification deferred** | No verification in this implementation phase |
| Payroll, appraisals and salary-related data | Both trees: `crm_operations.py` Payroll/Appraisals | Existing HR profile, expense and audit systems | **Pending** | Restricted salary model, calculations, approvals, payment/audit workflow |
| Internal tasks separate from support tickets | Both trees: `crm_operations.py` `Tasks` module; `web/operations.js` Tasks view; `tests/test_operations.py` | Added UPLINKO `Task`, `TaskActivity`, existing `EmployeeProfile`, audit and task UI | **Integrated — verification deferred** | Searchable related-record pickers remain; task/notification delivery verification deferred |
| Assigned technician can update own task but not manager fields | Both trees: `crm_operations.py` task `save` authorization and technician listing | Task service role/employee checks, company scope and status permissions | **Integrated — verification deferred** | Must verify employee identity and forbidden-field cases |
| Task reminder scheduling and notification delivery | Requested UPLINKO requirement; not a copied reference database feature | `TaskReminder`, `NotificationsService`, employee contact preferences, existing queue | **Partially integrated** | Schedules and state are persisted; delivery durability depends on BullMQ/Redis. Inline fallback is non-durable; sending notifications cannot be recalled |
| Field work orders and dispatch | UPLINKO's existing `FieldJob`; reference operations module does not replace it | Existing `FieldJob`, controller, subscriber/ticket/lead relations | **Partially integrated** | FieldJob has no direct companyId; visibility derives from existing linked/assigned/created records |
| Appointment scheduling and technician conflicts | User requirements; existing FieldJob and employee leave records | `FieldJob`, `EmployeeProfile`, approved leave | **Integrated — verification deferred** | Concurrency, time-zone and overlap behavior require focused verification |
| Arrival, start, visit outcomes and work history | User requirements; reference Tasks remain separate from work orders | Existing `FieldJobVisit`, `FieldJobActivity`, audit log | **Integrated — verification deferred** | Private photo evidence and optional GPS visits are prepared in source; route optimization remains pending |
| Checklists, work notes, completion review and ticket handoff | User requirements; existing support ticket and work-order model | `FieldJob`, `Ticket`, operational activity | **Integrated — verification deferred** | Ticket resolution remains intentionally deferred until dispatcher approval |
| Field-job inventory reservation and materials custody | User requirements; reference has separate inventory/purchasing modules, not a second UPLINKO ledger | Existing `InventoryItem` and `InventoryMovement` | **Partially integrated** | Serialized stock only; bulk quantity/warehouse semantics and ownership for unowned legacy stock remain |
| Vendor, requisition and purchase-bill workflows | Both trees: `crm_operations.py` Purchasing modules and operations UI | Existing inventory, expense and accounting records | **Pending** | No integrated vendor/procurement approval/receipt workflow |
| Warehouses, transfers, stocktakes and minimum stock | Both trees: `crm_operations.py` Warehouses and inventory workflows | Existing `InventoryItem`/`InventoryMovement` | **Partially integrated** | Warehouse/quantity model and transfers/stocktakes/minimums remain |
| Asset maintenance lifecycle | Both trees: `crm_operations.py` Assets module | Existing inventory and NAS/network device records | **Pending** | Needs connected asset/service/maintenance lifecycle |
| Network topology, fiber, POPs and devices | Both trees: network modules and network UI | Existing UPLINKO NAS/fiber/topology records | **Partially integrated** | Relationship and topology coverage remains; no fabricated data |
| Bandwidth provider contracts and cost history | Both trees: provider/bandwidth operations | Existing expenses and accounting | **Pending** | Provider contracts, rate history and accounting linkage |
| Reseller/dealer allocation and performance | Both trees: reseller/client assignment and reports | Existing user hierarchy, packages, payments and reports | **Partially integrated** | Additional scoped reporting and allocation workflows remain |
| Cashbook, payables and receivables | Both trees: operations/accounting modules | Existing UPLINKO accounting, expenses and cashflow | **Partially integrated** | Do not claim unsupported double-entry accounting |
| Customer support, portal and notifications | Both trees: support/customer-facing workflows | Existing Ticket, portal, notification and subscriber systems | **Partially integrated** | New support interactions must continue to reuse existing records |
| Customer requests, schedule changes and approvals | Both trees: `crm_operations.py` `Customer requests` and `Client schedules`; `web/operations.js` approval/ticket/apply actions | Existing Ticket, Subscriber, Package, billing and notification systems | **Pending** | No dedicated validated customer-request intake and approval/handoff workflow |
| SNMP/router polling | Reference inventory only | Existing network interfaces | **Not applicable** | Explicitly excluded from implementation |

## Phase 6 — Tasks and Field Operations implementation matrix

| Feature | Reference and original source location | Existing UPLINKO implementation reused | Missing capability before this phase | Files changed/prepared | Status, remaining gaps and deferred verification |
|---|---|---|---|---|---|
| Task record fields and lifecycle | Both trees: `ai-engine/ai.example/crm_operations.py` and `ai-engine/crm/advanceispcrm/crm_operations.py`, `Tasks` module (title, employee, due date, priority, status, description) | UPLINKO Task/TaskActivity, EmployeeProfile, company scoping | Dedicated task UI and company-scoped APIs | `backend/src/tasks/`, `frontend/app/tasks/page.tsx`, schema and migration | **Integrated — verification deferred**; verify fields, legal transitions and scope |
| Task/field-ticket distinction | Both trees: `crm_operations.py` Tasks module note; `web/operations.js` Tasks view | UPLINKO Tasks separate from Ticket and FieldJob | Avoid collapsing internal work into support cases | Task service/UI and FieldJob service/UI | **Integrated — verification deferred**; records remain separate and may link to existing records |
| Technician task restrictions | Both trees: `crm_operations.py` task `save` authorization/listing | Existing employee identity, role permissions, company scope | Enforce assigned employee owns changes; prevent assignment/schedule edits | `backend/src/tasks/tasks.service.ts`, task routes and permissions | **Implemented — verification deferred**; `tasks.readAll` is distinct from `tasks.assign`, explicit user denial overrides role grants, and task object scope is shared across reads/comments/assignment |
| Task search, filters, pagination, summaries and history | Both trees: `web/operations.js` Operations view and `crm_operations.py` record queries | TaskActivity and ActivityLog | Server-side task workflow and history | `backend/src/tasks/`, `frontend/app/tasks/page.tsx` | **Integrated — verification deferred**; searchable related-record pickers remain |
| Task reminders | UPLINKO task-reminder requirement; existing NotificationsService/QueueService | Existing company plans, employee preferences and messages | Durable schedule, retry claim and idempotent delivery state | `Task.reminderAt`, `TaskReminder`, `tasks.service.ts`, `notifications.service.ts`, source-only delivery-claim migration | **Partially integrated**; persistent reminder recovery and bounded retries are implemented in source. Persisted queued messages are re-enqueued after restart in inline mode; BullMQ/Redis retains its queue. Stale sends become `UNKNOWN`, not automatically retried; simulated sends are not marked delivered. Provider-side exactly-once behavior is unavailable unless the gateway supports idempotency |
| Job listing, filters, pagination and details | UPLINKO FieldJob controller/service contract; existing `FieldJob` | Existing subscriber/ticket/lead/user-tree relations | Replacement for NUL-corrupted service and UI | `backend/src/field-jobs/field-jobs.service.ts`, controller, `frontend/app/field-jobs/page.tsx` | **Integrated — verification deferred**; backend list is bounded and scoped; UI filter coverage and payload compatibility need browser/API checks |
| Job creation and related records | UPLINKO FieldJob and Ticket/CRM Lead/Subscribers services | Existing `FieldJob`, Ticket, Subscriber, CRM lead | Safe create/edit/link validation and ticket handoff | FieldJobs service/controller/page | **Integrated — verification deferred**; only one subscriber/ticket/lead can be linked; consume requires subscriber link |
| Technician assignment and scheduling | UPLINKO User/EmployeeProfile, approved leave and FieldJob schedule | Existing active employee and leave records | Company-scoped assignment, overlap and reschedule checks | FieldJobs service/controller/page | **Integrated — verification deferred**; verify concurrent schedule claims, status transitions and timezone behavior |
| Arrival, start, visits and assistance | UPLINKO FieldJob and technician permissions | Existing FieldJobVisit/FieldJobActivity/Audit | Work-order visit workflow and real UI actions | FieldJobs service/controller/page and route permissions | **Integrated — verification deferred**; private photo evidence and optional user-triggered GPS check-in/out are prepared; route optimization is not integrated |
| Checklist, work notes and completion/review | UPLINKO FieldJob/Ticket | Existing checklist/activity and ticket resolution workflow | Technician completion and dispatcher review | FieldJobs service/controller/page | **Integrated — verification deferred**; ticket completion is deferred until dispatcher approval; verify authorization and review |
| Reserve stock | UPLINKO InventoryItem/InventoryMovement | Existing serialized inventory ledger | FieldJob relationship and atomic reservation | Schema/migration and `inventory.service.ts`, Field Jobs UI | **Implemented for serialized units — verification deferred**; the job view exposes available and reserved items; unowned legacy stock remains unavailable |
| Issue materials to technician | UPLINKO InventoryItem/InventoryMovement and EmployeeProfile | Existing inventory owner/status and movement history | Work-order/employee-linked issue operation | `inventory.service.ts`, Field Jobs service/controller/page, permission map | **Implemented for serialized units — verification deferred**; issue is selectable for available or this job's reserved items, with assigned active employee required |
| Consume materials | UPLINKO InventoryItem/InventoryMovement and Subscriber | Existing subscriber and inventory status | Actual-consumption movement and subscriber linkage | Inventory service and field-job UI | **Implemented for serialized units — verification deferred**; only job-issued items on subscriber-linked work in progress/review can be consumed; no service activation or billing is created |
| Return unused materials | UPLINKO InventoryItem/InventoryMovement | Existing inventory status and ownership | Return to company stock with work-order history | Inventory service and field-job UI | **Implemented for serialized units — verification deferred**; only job-issued items can be returned; bulk quantities are out of scope |
| Damaged/missing materials and reservation release | UPLINKO InventoryItem/InventoryMovement | Existing faulty/lost statuses | Distinct reported outcome and explicit unreserve action | Inventory service, controller permission route, UI, migration | **Implemented for serialized units — verification deferred**; UI limits release/report transitions to this job's reserved/issued items; reassignment and closure require material resolution |
| Audit, permissions and tenant boundaries | UPLINKO PermissionGuard, entitlement guard, ScopeService, ActivityLog | Existing auth, company tree, product entitlements and audit | Granular route/service enforcement for new actions | `route-permissions.ts`, `security.service.ts`, FieldJobs/Tasks/Inventory services | **Integrated — verification deferred**; FieldJob lacks companyId and derives scope from related company-owned records; unowned inventory is unavailable until safely reconciled |
| Schema and migration | Existing Prisma schema and PostgreSQL migration history | Existing schema and relationships | Add FieldJob material links, movement metadata, reminder schedules, notification keys/claim leases and advanced field-execution records | `backend/prisma/schema.prisma`, source migrations including `backend/prisma/migrations/20261103180000_advanced_field_execution/migration.sql` | **Prepared, unapplied**; schema and SQL sources were edited but not checked with Prisma or a database |

## Phase 6 source and architecture details

- The corrupted `backend/src/field-jobs/field-jobs.service.ts` and
  `frontend/app/field-jobs/page.tsx` were intentionally replaced, not restored
  from Git or backups.
- No new subscriber, employee, billing, notification, inventory or database
  system was created. Materials use serialized `InventoryItem` rows and
  `InventoryMovement`; quantities are not fabricated.
- `InventoryItem.companyId` is nullable to preserve existing stock. New
  material actions require an existing company-tree owner; only eligible
  unowned serialized stock with matching company custody evidence can be
  reconciled. Unowned items without that evidence remain unavailable.
- `FieldJob` has no direct `companyId`; service visibility derives from
  company-owned leads, subscriber/ticket scope, assigned user and creator.
- Reminder schedule state is persisted in `TaskReminder` and atomically leased.
  Notifications use the existing employee SMS/email opt-ins and stable
  idempotency keys. Message claims expire after five minutes and stale sends
  become `UNKNOWN`; automatic retry is stopped when delivery may already have
  reached the provider. Three delivery attempts are permitted. Simulated
  delivery is not recorded as delivered. Database-persisted queued messages
  are re-enqueued after restart in inline mode; BullMQ/Redis retains its queue.
  Legacy `SENDING` records without a claim timestamp cannot be classified
  safely and require operator reconciliation. Inline queue execution itself
  remains non-durable.
  Exactly-once external delivery cannot be guaranteed without provider
  idempotency, and an operator retry of an unknown outcome may duplicate a send.
- Task company-wide read scope requires effective `tasks.readAll`; an explicit
  inherited user denial wins over role grants. Company-wide task management
  also requires `tasks.assign`.
- Field Jobs exposes material options by custody state. Reassignment blocks
  while reserved or issued items remain; cancellation releases reservations
  and blocks issued items; successful closure blocks on any unresolved
  reservation or issuance. All disposition actions require the existing
  materials permission and keep the serialized inventory movement history.
- The permission mappings
  `GET /field-jobs/mine` → `field-jobs.read` and
  `POST /field-jobs` → `field-jobs.write` remain explicit and are not duplicated.
- Related task records currently use validated scoped IDs instead of
  searchable pickers. Route optimization and travel-time estimates remain
  unavailable because no routing provider is integrated.

## Advanced Field Execution — source prepared, verification deferred

| Capability | Existing UPLINKO integration | Source status and limitations |
|---|---|---|
| Private photo evidence | Reuses `/uploads`, uploaded-file ownership, file signature/size checks and private media-token access. Evidence metadata links the job, uploader, evidence type, note and timestamp; viewing requires job visibility and `field-jobs.read`. | Image-only job evidence, bounded per-job attachments, no public file URLs. Access enforcement is not runtime-verified. |
| Optional GPS visits | Extends FieldJobVisit with check-in/check-out result, technician, timestamp, coordinates and accuracy. UI requests location only after an explicit user action. | Denied, unavailable, error and not-requested outcomes do not invent coordinates. No continuous tracking; capture remains optional. |
| Recurring work orders | New company-scoped FieldJobSchedule and FieldJobOccurrence records create ordinary FieldJobs and preserve generated-job history. A primary-instance cron, existing QueueService, ten-minute persisted lease and unique `(scheduleId, occurrenceAt)` key coordinate due occurrences. | Create, edit, pause and terminal cancel are represented in source. A validated `PATCH /field-jobs/schedules/:id` updates supported job details, recurrence/date/timezone and related subscriber/ticket/lead fields, recalculates the next due run when recurrence configuration changes, and audits changed field names with the actor. Edits affect jobs generated after saving; existing jobs/occurrences are unchanged. Recurrence edits rebase to the first matching time at or after the edit, skipping overdue ungenerated slots. Valid worker claims cause edit/status conflicts, while expired claims are conditionally cleared. No company-wide timezone setting exists; each schedule carries its chosen timezone. Assignment/template fields are not present in the schedule model. |
| Dispatch and technician scheduling | Existing active EmployeeProfile, leave checks, assignment history and overlap checks are reused. The UI shows workload, job priority/due state, unassigned/overdue work and planned visit order. | Visit-order conflict grouping uses UTC calendar dates; no route optimization or travel-time claim is made. |
| Serialized ownership reconciliation | Adds nullable InventoryItem company ownership and an audited company-admin flow. Only matching company custody evidence is eligible; existing serialized movement history remains the source of truth. | Items without sufficient ownership evidence remain unowned and unavailable. Quantity inventory behavior is unchanged; no quantity-based field-job workflow was added. |
| New permissions | `field-jobs.evidence`, `field-jobs.location`, `field-jobs.schedules`, `inventory.reconcile`; existing `field-jobs.read`, technician/dispatch/material and company-scope rules are reused. | Route, role and object-level behavior requires later authorized verification. |
| Migration source | `backend/prisma/migrations/20261103180000_advanced_field_execution/migration.sql` adds visit order/location fields, attachment/schedule/occurrence tables, schedule claim lease columns/indexes and InventoryItem company ownership. | Source only; unapplied. |

## Verification deferred

No tests, typechecks, lint, builds, browser workflows, Prisma commands, database
commands or migrations were run for this phase. Later authorized verification
must cover:

1. Prisma schema/client compatibility and all four relevant migration sources
   against the target PostgreSQL schema.
2. Task company/employee permissions, status transitions, reminder delivery
   preferences, idempotency, retries, reschedule/reassignment/cancellation and
   concurrent schedule claims.
3. FieldJob visibility, private attachment access, optional location outcomes,
   recurring schedule lease/restart/duplicate handling, related-record validation, technician assignment,
   overlap/leave conflicts, arrival/start concurrency, checklist, assistance,
   completion/review, ticket handoff and audit behavior.
4. Inventory reservation/issue/consume/unreserve/return/damaged/lost
   idempotency, concurrent stock updates, tenant ownership and bypass through
   generic inventory endpoints.
5. Backend/frontend typechecks and focused lint, followed by authorized
   migration/database integration and browser workflows for task reminders and
   dispatcher/technician materials-to-completion operations.

The current implementation status is also tracked in
[`uplinko-ai-advanced-crm-progress.md`](./uplinko-ai-advanced-crm-progress.md).

## Field operations reporting workspace — source matched and wired

| Capability | Existing UPLINKO integration | Source status and limitations |
|---|---|---|
| Shared filters | `FieldJobReportsService` parses date, technician, status, priority, type and subscriber filters for both report routes. | UTC inclusive dates are bounded to 366 calendar days. The UI keeps draft and applied filters separately; summary, every drill-down and pagination use the same applied snapshot. Apply Filters refreshes the summary. Breakdown category constraints do not mutate shared filters, and stale responses are ignored. Subscriber filter/details require `subscribers.read`; IDs are scope checked. |
| Operations overview | Reuses `FieldJob` status aggregates and valid job timestamps. | Summary contains total/open/assigned/in-progress/completed/overdue/unassigned/cancelled/awaiting-review, approaching deadlines, completion rate and average duration. Completion rate denominator is non-cancelled jobs. |
| Technician performance | Reuses assigned `FieldJob` and `EmployeeProfile` records. | Includes assigned/completed/open/overdue counts, completion rate (completed divided by assigned excluding cancelled), and valid average duration. Report period/workload are visible; no attendance is inferred. |
| SLA and delay reporting | Reuses `appointmentEndsAt`, `scheduledAt`, `completedAt`, `priority`, `type` and `FieldJobActivity`. | Overdue is open work past its recorded deadline; approaching means within 24 hours. Delay groups/average use current time for open work and completion time for completed work. Repeated rescheduling requires more than one `SCHEDULED` activity. No contractual SLA or dedicated delay-reason field exists. |
| Schedule performance | Reuses `FieldJobSchedule` and unique `FieldJobOccurrence` records. | Generated and completed occurrences use persisted occurrence/job records. Upcoming counts active schedules whose `nextRunAt` falls within the selected date range; it is not an occurrence count. State counts are current schedule states for schedules created in the selected date range, not status changes during that period. Upcoming and state counts are informational and have no drill-down. Skipped and failed generation are unavailable because no corresponding records are persisted. |
| Reporting API | Extends the existing controller/module and route permission mapping. | `GET /field-jobs/reports/summary` and `GET /field-jobs/reports/jobs` retain JWT, `PermissionsGuard` and `crm-advanced` guards, require `field-jobs.report`, and recheck permission/company scope in each service request. |
| Drill-down and UI | Reuses the Field Jobs page route and Uplinko application shell/theme. | Summary and all job-list drill-downs use the identical applied filter snapshot, including pagination; draft edits take effect only after Apply Filters refreshes the summary. Category-specific constraints do not change shared filters. KPI/status/delay/priority/type/schedule-occurrence/technician drill-downs return paginated job details capped at 100 per page. Upcoming and schedule-state metrics are not clickable. A report-permission-gated button in the Field Jobs header opens four report sections; filter state persists when switching sections. Stale summary/detail responses are ignored. Mobile uses responsive cards and labeled technician metrics. |
| Dispatch workspace | Extends `FieldJobsService`, existing assignment endpoint, `FieldJobActivity`/`ActivityLog`, employee profiles, field-job schedules and approved leave records. | Adds `GET /field-jobs/dispatch` (filtered page/workload aggregates), `GET /field-jobs/:id/dispatch` (recommendations and first history page), and `GET /field-jobs/:id/dispatch/history?cursor=...` (history continuation); existing `PATCH /field-jobs/:id/assign/:technicianId` remains the confirmation path. Uses `field-jobs.dispatch` and `crm-advanced`; subscriber filtering/names and the potentially subscriber/site-bearing queue address additionally require `subscribers.read`. The queue selects/returns `address` only with that permission; detail and mutation responses never return the job address, and omit subscriber identity/address without the permission. Queue filters cover job creation date range, technician, status, priority, type and subscriber; rows are paginated (max 100). Workload is aggregated from company-visible current open/overdue jobs, scheduled jobs in range, and completions by `completedAt`. |
| Dispatch recommendations and assignment | Reuses active company `EmployeeProfile`, `FieldJob` ownership relations/status/schedule/priority/type/requiredSkills, approved employee leave, inventory checks and existing transaction/audit behavior. | Job company ownership cross-validates every available lead, direct subscriber, ticket-linked subscriber, assigned-user and creator relationship after normalizing each with `companyRootId`; absent optional links are allowed, while unresolved or conflicting roots fail closed. Queue/detail technician profile and name details are returned only for active employee profiles eligible in the resolved job company and dispatcher-visible user tree; creator/assignment actor details are withheld when not eligible. Recommendations only use active employee profiles in that same company/user tree, and workload/conflict queries use the same company-visible job scope. Assignment re-resolves ownership in the write transaction and rechecks the technician's active same-company profile. Ordering transparently uses eligibility, conflicts/leave, open workload, overdue workload, upcoming scheduled commitment counts, and recorded same-type completions; no numeric score is fabricated. Priority is shown but not weighted because no priority policy exists. Employee skill and work-hours/availability records do not exist; same-type history is not certification, and attendance is not inferred. Reassignment reason is required and recorded. Assignment rechecks the expected assignee, job `updatedAt`/status, active company technician, schedule/leave conflicts and material restrictions in existing serializable assignment logic; activity and audit log writes are unchanged. No automatic assignment or new notification is added. Location/proximity is not used; no routing provider is present. |
| Dispatch history | Reuses `FieldJobActivity` assignment/reassignment/unassignment/schedule entries and the dispatch visibility/permission checks. | History is returned in server-side cursor pages of up to 100 entries, ordered by descending activity ID. Responses include `returned`, `hasMore` and `nextCursor`; the UI offers older pages and clearly indicates whether older entries remain. Each history request rechecks `field-jobs.dispatch`, job visibility and company ownership. A detail refresh or job switch invalidates pending history requests; visible entries are retained on refresh and deduplicated by stable activity ID when merging refreshed or older pages. |
| Dispatch UI and data limits | Adds `/field-jobs/dispatch` and a permission-gated link from the existing Field Jobs workspace. | Displays queue KPIs, bounded job cards, workload comparison, recommendation explanations, assignment confirmation and activity history, with responsive mobile cards and existing Uplinko theme variables. Employee lists are capped at 500 and report truncation. No schema/migration source is added. |
| Privacy and migration | Uses existing models and permission checks; no new schema. | Database aggregates are company-scoped; dispatch queue address is selected/returned only with `subscribers.read`; dispatch detail/mutation responses never return the job address and omit subscriber identity/address without that permission. Technician and activity actor details are limited to active employee profiles in the resolved job company and dispatcher-visible user tree. Details select no GPS/evidence. No migration source was added. |
| Verification | Implementation is complete in source only. | No tests, typechecks, lint, builds, browser checks, Prisma/database operations, or migrations were run; runtime compatibility remains unverified. |

This reporting work extends the existing field-jobs module and does not create parallel job, technician, schedule, inventory, or analytics systems.

## SLA and service-quality workspace — source matched, runtime unverified

| Capability | Existing UPLINKO integration | Source status and limitations |
|---|---|---|
| Workspace and authorization | Reuses the existing Ticket and Field Jobs modules, permissions, company scope, app shell and command palette. | `/sla` presents ticket and field-job metrics. Ticket SLA routes require JWT/permission checks, `tickets.sla` to view, `tickets.sla.manage` to create policy versions, and the `crm-advanced` entitlement. Field-job SLA records require `field-jobs.report` and the existing Field Jobs `crm-advanced` guard. Ticket records are scoped by the subscriber's company tree; field-job records reuse `FieldJobReportsService` company visibility. Ticket subjects, subscriber identities and assignee names require their existing read permissions; assignee details are further limited to the caller's visible company-user tree. |
| Versioned policy snapshots | Adds `SlaPolicyVersion` records, policy version series, effective dates, warning thresholds, UTC clock mode and snapshot fields on `Ticket` and `FieldJob`. | Policies are company-root-owned, priority/record-type-specific, and audited in `ActivityLog`. New records persist the applicable policy version, targets and due timestamps; policy changes do not recompute existing deadlines. A policy version cannot change record type or priority and must start after the latest version in its series. Historical backfill is disabled rather than assigning inferred targets. The migration source is `backend/prisma/migrations/20261103190000_sla_policy_snapshots/migration.sql` and remains unapplied. |
| Ticket measurements | Reuses `TicketMessage.createdAt` for first staff response and ticket status transitions for first resolution/reopen tracking. | First response is the first recorded staff message, persisted in the same transaction as the message. Resolution is the first recorded transition to `RESOLVED`; the first resolution timestamp remains the SLA event after later reopenings, while reopen count/time are recorded. Only recorded timestamps are measured. Unknown/unconfigured targets, invalid timestamps preceding ticket creation and not-yet-due outcomes are excluded from compliance; zero eligible records yields `null` compliance. Ticket subject/assignee/subscriber details remain permission-gated. |
| Field-job measurements | Reuses field-job policy snapshots and dispatcher review lifecycle. | Resolution is recorded at dispatcher approval (`reviewCompletion`), not technician submission or customer confirmation. No first customer-response event or reliable reopen event exists, so those metrics are reported unavailable. Average/median durations require recorded non-negative intervals; timestamps preceding job creation are classified unavailable and excluded from compliance aggregates. |
| Metrics and pagination | Adds ticket report/records and field-job SLA records endpoints, integrated with company-scoped filters. | Date and priority filters apply to ticket summaries/records; field-job summaries and records additionally accept type and existing report filters. Date ranges are capped at 366 calendar days. Record lists are filtered and counted server-side, capped at 100 entries per page, and report total/`hasMore`. At-risk and breached counts use persisted due timestamps and policy snapshots. |
| UI and alert limitations | Adds a responsive `/sla` page using existing Uplinko theme variables and navigation. | Sections include overview, at-risk, breached, meeting-target, performance history and policies. Filters include date, priority, record type and field-job type. Policy create/version controls require the management permission. Clocks use elapsed UTC; business-hours calendars, pause/resume accounting and internal operator alerts are not available. SLA events do not send subscriber notifications. |
| Verification | Source-only implementation and migration source. | No tests, typechecks, lint, builds, browser checks, Prisma/database operations or migrations were run; migration remains unapplied and runtime behavior is unverified. |
