# ISP CRM — application flowcharts

These diagrams describe the current implementation in `ispcrm.py` and its `crm_*.py` modules. They cover the main application steps, decisions, and business rules, rather than every individual SQL statement. Open this file in a Markdown viewer with Mermaid support to render the charts.

## 1. Whole application

```mermaid
flowchart TD
    A[Run python ispcrm.py] --> B[Initialize PostgreSQL schema and migrations]
    B --> C{Initialization succeeds?}
    C -->|No| D[Exit with database configuration error]
    C -->|Yes| E[Listen on 127.0.0.1 port 3000]
    E --> F[Start background billing and expiry worker]
    E --> G[Open localhost:3000]
    G --> H[Load staff login and authentication status]
    H --> I{First administrator exists?}
    I -->|No| J[Create first administrator]
    I -->|Yes| K[Sign in]
    J --> L[Session cookie and CSRF token]
    K --> L
    L --> M[Load permitted schemas and records]
    M --> N[Dashboard and module navigation]
    N --> O[Customers and profiles]
    N --> P[Payments, invoices and ledger]
    N --> Q[Inventory, QR and stock issues]
    N --> R[Tickets and equipment recovery]
    N --> S[Staff, expenses and settings]
    N --> T[Reports and assistant]
    O & P & Q & R & S --> U[Validate permissions and business rules]
    U --> V[Commit database transaction]
    V --> M
    E --> W[Customer portal at /customer]
    W --> X[Separate customer login and own-account dashboard]
    E --> Y{Ctrl+C?}
    Y -->|Yes| Z[Signal worker stop, wait up to 5 seconds, close server]
```

## 2. HTTP routing and access checks

```mermaid
flowchart TD
    A[Incoming HTTP request] --> B{GET or POST?}
    B -->|GET| C{Requested resource}
    C -->|Known static asset| D[Serve file from web directory]
    C -->|Auth status| E[Return setup flag, current user and token]
    C -->|Customer app| F[Check customer session]
    C -->|Staff API| G[Check staff session and route permissions]
    G --> H[State, profile, billing, invoice, receipt, documents or QR]
    B -->|POST| I{Special public entry point?}
    I -->|Customer app| J[Customer origin, session and CSRF checks as applicable]
    I -->|Incoming payment| K[Verify signed bridge request]
    I -->|Authentication| L[Authentication token checks]
    I -->|Other staff endpoint| M{Valid staff session?}
    M -->|No| N[401: sign in again]
    M -->|Yes| O{X-CRM-Token matches session CSRF?}
    O -->|No| P[403: reload before saving]
    O -->|Yes| Q[Dispatch to endpoint]
    Q --> R[Check role, payload and endpoint-specific rules]
    R --> S[Execute transaction and respond]
    C -->|Unknown| T[404: not found]
    Q -->|Unknown| T
```

Staff POST endpoints: `/api/record`, `/api/users`, `/api/invoices`, `/api/customer-documents`, `/api/customers/terminate`, `/api/inventory-qr`, `/api/customer-services`, `/api/customer-portal/access`, `/api/customer-portal/notify`, and `/api/assistant`.

## 3. Staff authentication and account administration

```mermaid
flowchart TD
    A[Authentication request] --> B[Validate request and expected CSRF token]
    B --> C{Action}
    C -->|Setup| D[Create first active administrator and session]
    C -->|Login| E[Check login throttle]
    E --> F{Active user and valid password?}
    F -->|No| G[Record failed attempt and reject]
    F -->|Yes| H[Create 8-hour session and return cookie]
    C -->|Logout| I[Delete current session and clear cookie]
    C -->|Change password| J[Verify current password and validate new password]
    J --> K[Save password hash, revoke sessions and reset tokens]
    C -->|Forgot password| L[Validate recovery request and linked employee email]
    L --> M[Create single-use recovery link and send through configured SMTP]
    M --> N[Reset using valid unexpired token]
    N --> K
    O[Administrator manages user] --> P[Validate username, role, employee link and status]
    P --> Q[Preserve last active administrator and employee account uniqueness]
    Q --> R[Save account and revoke affected sessions]
```

Roles are enforced on the server: Administrator, Manager, Accountant, Support, Technician, Storekeeper, and Viewer. Technician writes are assignment scoped. Staff designation and reporting hierarchy do not independently grant application access. User accounts are deactivated rather than deleted.

## 4. Loading the dashboard and customer profile

```mermaid
flowchart TD
    A[GET /api/state] --> B[Require staff session]
    B --> C[Generate eligible expiry recovery tickets]
    C --> D[Generate current-month invoices for active subscriptions]
    D --> E[Read role-scoped records]
    E --> F[Add permitted balances, invoices, collectors and recharges]
    F --> G[Add inventory units, recovery items and ticket events]
    G --> H[Filter schemas and private staff fields]
    H --> I[Return user, permissions, token, schemas and records]
    I --> J[Browser renders dashboard, lists and reports]
    K[Open customer profile] --> L[Require Customers read access and existing customer]
    L --> M[Load related permitted payments, tickets and hardware]
    M --> N[Include finance, documents and activation costs only when permitted]
    N --> O[Render profile tabs]
```

## 5. Common create, update, delete and return logic

```mermaid
flowchart TD
    A[POST /api/record] --> B[Validate body size, JSON object, section, action and record ID]
    B --> C[Check write or delete permission]
    C --> D[Open transaction and validate attached documents]
    D --> E{Section or action}
    E -->|Payments| F[Payment and recharge workflow]
    E -->|Stock issues| G[Issue or return workflow]
    E -->|TAT settings| H[Existing rule only; preserve ticket type and priority]
    E -->|Delete| I[Apply deletion protections and foreign-key constraints]
    E -->|Other save| J[Check scoped access and section-specific rules]
    H --> J
    J --> K[Validate required fields, choices, numbers and dates]
    K --> L{Record ID supplied?}
    L -->|Yes| M[Update existing row]
    L -->|No| N[Insert row and obtain ID]
    M & N --> O[Store documents or update ticket timestamps and activity]
    F & G & I & O --> P[Commit and return success]
    B & C & D & J & K -->|Failure| Q[Reject request; roll back transaction if open]
```

Tickets cannot be deleted. Used packages cannot be deleted or renamed; used designations cannot be deleted. Stock issues cannot be edited or deleted. Saved payment receipts protect their source payments from editing/deletion. Database constraints protect linked records.

## 6. Customer creation and editing

```mermaid
flowchart TD
    A[Create or edit customer] --> B[Check Customers write access and lock existing customer]
    B --> C{Existing account?}
    C -->|No| D[Require deployment latitude and longitude]
    D --> E[Reject initial Terminated status]
    C -->|Yes| F[Preserve omitted existing details and expiry]
    F --> G[Block reactivation while termination equipment recovery is pending]
    E & G --> H[Resolve selected package]
    H --> I{Same existing package?}
    I -->|Yes| J[Preserve agreed monthly fee; allow retained inactive package]
    I -->|No| K[Require active package and use its monthly price]
    H -->|Existing legacy package retained| J
    J & K --> L[Set new installation default or validate existing installation charge]
    L --> M[Default missing expiry to Joined plus 30 days]
    M --> N[Validate dates, contact fields, coordinates and schema]
    N --> O[Save customer and package link; database generates permanent Payment ID]
    O --> P[Store validated documents in same transaction]
    P --> Q{Changing to Terminated?}
    Q -->|Yes| R[Run termination and recovery logic]
    Q -->|No| S[Commit customer]
    R --> S
```

Expiry cannot precede Joined. Coordinates must be paired and within geographic bounds; an existing saved pin cannot be cleared through the editor. Installation charge cannot be reduced below installation payments already received.

## 7. Monthly invoices and account balances

```mermaid
flowchart TD
    A[Background check or state load] --> B[Find active customers joined by today with no current-month invoice]
    B --> C[Lock customer and ensure invoice]
    D[Print invoice or process eligible recharge] --> C
    C --> E{Invoice already exists?}
    E -->|Yes| F[Reuse saved snapshot]
    E -->|No| G{Customer terminated?}
    G -->|Yes| H[Reject new subscription invoice]
    G -->|No| I[Save customer, package, monthly fee, issue date and expiry due date]
    I --> F
    F --> J[Calculate earlier invoiced MRC charges minus matching MRC receipts]
    J --> K[Add relevant service charges and previous service balance for display]
    K --> L[Show bill total, paid and remaining balance]
    L --> M[Print or save PDF through browser]
```

One subscription invoice exists per customer/month. Earlier uninvoiced months are not invented as arrears. Carry-forward debt is not counted again as new subscription sales. Saved snapshots are preserved while balance displays use current payments.

## 8. Payments, receipts and recharge decisions

```mermaid
flowchart TD
    A[Confirmed manual cash/card or verified bridge payment] --> B[Check permissions, amount, date and customer]
    B --> C[Lock customer and enforce receipt immutability]
    C --> D{Previously saved request key?}
    D -->|Same details| E[Return existing payment and receipt; no new renewal]
    D -->|Different details| F[Reject reused key]
    D -->|No| G[Validate service, installation and MRC allocation limits]
    G --> H[Save payment]
    H --> I{Revenue type?}
    I -->|OTC| J[Keep subscription activation unchanged]
    I -->|MRC| K{Terminated customer?}
    K -->|Yes| J
    K -->|No| L{Current billing month?}
    L -->|No| J
    L -->|Yes| M{Already recharged this month?}
    M -->|Yes| J
    M -->|No| N[Ensure invoice; calculate monthly fee plus previous MRC balance]
    N --> O{Positive monthly fee?}
    O -->|No| J
    O -->|Yes| P{Current-month MRC receipts cover total due?}
    P -->|Yes| Q[Activate customer]
    P -->|No| R{Authorized partial activation approved?}
    R -->|No| J
    R -->|Yes| S[Record outstanding amount and approving user]
    S --> Q
    Q --> T[Expiry = later of today and existing expiry, plus 30 days]
    T --> U[Save once-per-month recharge and resolve expiry recovery tickets]
    J & U --> V[Save permanent receipt snapshot in same transaction]
    V --> W[Commit and return receipt and recharge result]
```

OTC needs a reference and cannot use partial activation. Administrator, Manager, and Accountant may approve partial activation; the bridge cannot. A terminated account may receive payments but is not automatically reactivated. Stock returns do not automatically refund charges.

## 9. Signed incoming payment bridge

```mermaid
flowchart TD
    A[POST /api/payments/incoming] --> B[Read bounded raw body]
    B --> C[Check supported provider and configured secret]
    C --> D[Verify timestamp window and HMAC signature]
    D --> E[Require paid status, 9-digit Payment ID and transaction ID]
    E --> F[Validate timezone-aware confirmed payment time]
    F --> G[Convert payment date and month to Pakistan time]
    G --> H[Find customer by Payment ID]
    H --> I[Derive stable request key from provider and transaction ID]
    I --> J[Run trusted MRC payment workflow]
    J --> K[Commit once and return receipt]
    C & D & E & F & H -->|Invalid| L[Reject without saving payment]
```

This is an internal signed bridge contract. Native 1LINK, Easypaisa and JazzCash merchant integrations require separate configuration/onboarding.

## 10. Inventory issue and return

```mermaid
flowchart TD
    A[Stock issue request] --> B{Return existing issue?}
    B -->|Yes| C[Lock customer if linked, then lock issue]
    C --> D{Already returned?}
    D -->|Yes| E[Success without another stock increase]
    D -->|No| F[Restore full issue quantity and mark Returned]
    F --> G[Mark tracked devices Available and log movements]
    G --> H[Refresh equipment recovery status]
    B -->|No| I[Reject edits/deletes; validate new issue and request key]
    I --> J[Lock request key; compare any previous request]
    J -->|Identical retry| E
    J -->|New request| K[Lock customer and inventory; reject terminated customer]
    K --> L{QR supplied?}
    L -->|Yes| M[Require matching Available device in Good condition and quantity 1]
    L -->|No| N[Ensure untracked available stock covers quantity]
    M & N --> O[Require sufficient stock and destination or customer]
    O --> P[Customer issue requires positive unit selling price]
    P --> Q[Capture business unit cost and save issue]
    Q --> R[Create customer equipment charge when applicable]
    R --> S[Update tracked movement and subtract stock quantity]
    E & H & S --> T[Commit atomically]
```

System/network issues do not bill customers. Returns cover the entire saved issue quantity. Request locks and record locks prevent retry deductions and concurrent overselling.

## 11. QR registration, condition and stocktake

```mermaid
flowchart TD
    A[Inventory QR action] --> B[Check Inventory permission]
    B --> C{Action}
    C -->|Register| D[Validate item, serial and request key]
    D --> E{Receive new device?}
    E -->|Yes| F[Increase item quantity by one]
    E -->|No| G[Require existing stock not already QR registered]
    F & G --> H[Create Available unit, unique QR and movement]
    C -->|Lookup or print| I[Find registered QR; return unit history or SVG label]
    C -->|Condition| J[Validate Good, Damaged or Under repair and inspection notes]
    J --> K[Update condition and log change]
    C -->|Start stocktake| L[Reuse open run or snapshot Available units]
    L --> M[Scan registered QRs and mark seen]
    M --> N[Compare expected, seen and movement changes]
    N --> O[Close run with saved report snapshot]
```

Stocktake reports differences without automatically adjusting inventory quantities. Damaged and under-repair devices cannot be issued.

## 12. Tickets and turnaround targets

```mermaid
flowchart TD
    A[Create or manage ticket] --> B[Check role and assignment scope]
    B --> C[Prepare TAT from type and priority or permitted override]
    C --> D[Validate target between 1 and 720 hours]
    D --> E[Validate customer and employee assignment]
    E --> F{Starting, resolving or closing?}
    F -->|Yes| G[Require assigned employee]
    F -->|No| H[Validate remaining fields]
    G --> I{Resolving or closing?}
    I -->|No| H
    I -->|Yes| J[Require resolution notes]
    J --> K[Block manual expiry-recovery completion and outstanding required equipment]
    K --> H
    H --> L[Save ticket, target and precise due timestamp]
    L --> M[Update resolved timestamp and append named activity]
    M --> N[Display elapsed, remaining or overdue time]
    N --> O[Resolved within target or breached indicator]
```

The TAT clock runs continuously. Reopening preserves the original clock. New assignments cannot use staff on leave. Jobs are archived legacy data consolidated into Tickets; the current interface excludes the Jobs schema.

## 13. Termination and automatic expiry recovery

```mermaid
flowchart TD
    A[Authorized termination request] --> B[Lock customer and check previous termination]
    B --> C{Already terminated with saved event?}
    C -->|Yes| D[Return existing event]
    C -->|No| E[Validate reason and optional available employee]
    E --> F[Record termination event and monthly MRC run-rate loss]
    F --> G[Mark customer Terminated]
    G --> H{Required issued equipment remains?}
    H -->|Yes| I[Mark recovery pending and create linked recovery ticket]
    H -->|No| J[Mark no equipment to recover]
    I --> K[Physically recover and return full stock issues]
    K --> L{All required issues returned?}
    L -->|No| K
    L -->|Yes| M[Mark Recovered and resolve linked recovery tickets]
    M --> N[Customer remains Terminated until authorized reactivation]
    O[Every worker cycle or state load] --> P[Find nonterminated customers expired at least 5 days]
    P --> Q{Same-expiry ticket or open expiry ticket exists?}
    Q -->|Yes| R[Skip duplicate]
    Q -->|No| S[Create Open expiry recovery ticket with TAT and equipment list]
    S --> T[Assign employee and follow up]
    T --> U{Successful recharge or all required equipment returned?}
    U -->|Yes| V[Automatically resolve expiry recovery tickets]
    U -->|No| T
```

Termination itself never restores stock. Expiry recovery tickets can be generated even when no recoverable equipment is recorded. Automatic expiry checks do not implement router suspension.

## 14. Customer portal

```mermaid
flowchart TD
    A[Staff with Customers write access] --> B[Provision separate customer credentials]
    B --> C[Return temporary password]
    C --> D[Customer opens /customer]
    D --> E[Same-origin login with Payment ID and password]
    E --> F[Throttle attempts and verify enabled account]
    F --> G[Create separate 8-hour customer session]
    G --> H{Temporary password must change?}
    H -->|Yes| I[Return password-change state without dashboard data]
    I --> J[Verify current password and save new hash]
    J --> K[Revoke other customer sessions]
    K --> L[Load own-account dashboard]
    H -->|No| L
    L --> M[View own bills, receipts, expiry, tickets and notifications]
    M --> N[Mark own notification read with customer CSRF token]
    M --> O[Logout: delete customer session and clear cookie]
    A --> P[Send validated in-app notification to selected customer]
    P --> M
```

## 15. Documents, extra charges, expenses and administration

```mermaid
flowchart TD
    A[Authorized module operation] --> B{Module}
    B -->|Documents| C[Require document role and existing customer]
    C --> D[Validate file count, size, type and matching signature]
    D --> E[Store private files and metadata in PostgreSQL]
    C --> F[Download or delete existing document by ID]
    B -->|Extra service charge| G[Require Payments write access and validate charge]
    G --> H[Save customer service charge]
    H --> I[Collect linked OTC payment against remaining charge]
    B -->|Expenses| J[Validate positive amount, status and optional customer allocation]
    J --> K[Require payment date when Paid; clear it otherwise]
    K --> L[Save expense and update timestamp]
    L --> M[Include noncancelled allocated expense in activation costs]
    B -->|Staff| N[Validate employment details, salary and reporting hierarchy]
    N --> O[Prevent reporting cycles; preserve generated employee code]
    O --> P[Save employee; restrict private fields in reads]
    B -->|Settings| Q[Manage packages, categories, designations or existing TAT rules]
    Q --> R[Apply uniqueness, active selection and in-use protections]
```

Documents accept PDF, JPEG, PNG and WebP: up to 5 files, 5 MB each and 20 MB combined per upload. Activation costs combine net issued inventory at captured business cost with allocated noncancelled expenses; monthly package costs are separate.

## 16. Assistant, reports and background processing

```mermaid
flowchart TD
    A[Assistant question] --> B[Check staff session, CSRF, origin and payload size]
    B --> C[Build permission-scoped CRM context]
    C --> D[Run supported local lookup, guide or configured AI answer path]
    D --> E[Return read-only answer and supported visual summary]
    F[Open report or dashboard] --> G[Use permitted records and selected period/filters]
    G --> H[Calculate collections, bills, balances, stock and ticket metrics]
    H --> I[Render charts, export or print as supported by report]
    J[Background worker starts] --> K[Open database transaction]
    K --> L[Generate expiry recovery tickets]
    L --> M[Generate active current-month subscription invoices]
    M --> N[Commit]
    K & L & M -->|Exception| O[Log failure]
    N & O --> P[Wait 60 seconds or until stop signal]
    P --> Q{Stop requested?}
    Q -->|No| K
    Q -->|Yes| R[Exit worker]
```

Financial reports distinguish invoice sales, receipt collections and paid expenses. Net cash is collections minus paid expenses. Dates and billing decisions use Asia/Karachi. CRM activation updates database state; live router/RADIUS provisioning is separate.

## 17. Common failure outcomes

| Condition | Usual response |
| --- | --- |
| Invalid input or protected business operation | 400 with explanatory message |
| Missing or expired session | 401 |
| Role, origin, signature or CSRF check fails | 403 |
| Unknown route or missing resource | 404 where explicitly handled |
| Database unavailable | Usually 503; generic record database failures return 500 |
| Database transaction fails | Roll back transactional changes |
| Background processing fails | Log error and retry after the next wait |

## Source map

| Workflow | Implementation |
| --- | --- |
| Startup, routing, records, profile and validation | `ispcrm.py` |
| Database schema and migrations | `crm_data.py` and migration modules |
| Roles, sessions and user management | `crm_auth.py` |
| Password recovery | `crm_password_recovery.py` |
| Monthly invoices and arrears | `crm_billing.py` |
| Confirmed payments and recharge | `crm_recharge.py`, `crm_receipts.py` |
| Signed payment bridge | `crm_gateway.py` |
| Services, hardware charges and ledger | `crm_customer_ledger.py` |
| Device tracking and stocktake | `crm_inventory_qr.py` |
| Ticket targets | `crm_tat.py` |
| Termination and expiry recovery | `crm_termination.py` |
| Customer access and notifications | `crm_customer_portal.py` |
| Private documents and activation costs | `crm_documents.py`, `crm_costs.py` |
| Employee reporting and generated codes | `crm_employee_hierarchy.py`, `crm_employee_codes.py` |
| Assistant answers and visuals | `crm_assistant*.py` |
| Dashboard, reports and forms | `web/` |
