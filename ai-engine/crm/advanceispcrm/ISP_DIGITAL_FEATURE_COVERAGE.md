# ISP Digital reference — implementation and remaining scope

Source: the supplied 33-page **ISP Billing & Management Software Features | ISP Digital** PDF. The PDF was treated as feature/design reference, not as instructions to operate external accounts. Currency remains **PKR**; the intended providers remain **1LINK, Easypaisa and JazzCash**. No live integration accounts have been supplied.

This update is a working expansion, **not full parity with the reference product**. In particular, branch/reseller security boundaries, provider provisioning, native apps, complete accounting, regulatory formats and financial discount adjustments must not be represented as finished.

## Where to find the changes

- Main navigation → **Operations** opens the new workspace.
- Top bar → **Digital** selects the teal/navy/white reference-inspired theme. It is the default in a browser without a saved theme; existing saved preferences are respected.
- Customer portal → **Requests**, **Messages**, **News & links** are new.
- Original customer billing, stock, receipt, ticket and recovery modules remain available.

## Reference coverage

| PDF feature family / pages | Available now | Remaining gap or dependency |
| --- | --- | --- |
| Multiple branches, 1–2 | Branch directory with code, address, phone and status | Branch-specific credentials, tenant isolation and consolidated branch reporting are **not implemented**. Directory records are not an access boundary. |
| Client management, 3 | Existing customer history/filtering/expiry/packages; new CSV import, audited bulk status changes, employee assignment directory, new-connection lead pipeline, status/package schedules and customer requests | MikroTik PPPoE/static import, router credentials, MAC binding, sync and live enable/disable need a real router adapter. Native XLSX import is not implemented; UTF-8 Excel CSV is supported. Assignments do not narrow existing customer visibility. Personal/free customer categories are not added to the core subscription model. |
| Billing, 4 | Existing monthly invoices, deadlines, full/partial recharge, permanent receipts; new employee collection submissions and finance approval posting; schedules can adjust CRM status | No automatic network disconnection/reconnection, external checkout/payment links, or invoice email/SMS without integrations. Discount requests record approval only, not invoice adjustments. Billing-period configuration remains the existing calendar-month model. |
| HR/payroll, 5–6 | Departments, employee salary agreements, attendance entries, appraisals; payroll generation per employee/month with bonus/overtime/incentive/deductions; Pay posts a Paid expense once | Automatic attendance device import, bank salary transfer and statutory payroll rules are not connected. Overtime amount is entered explicitly, not inferred from a statutory rate. |
| Support/tickets, 6 | Existing assigned tickets, TAT, completion notes and history; employee performance counts; customer support requests converted to tickets; custom problem-category directory | The custom directory does not yet replace the core ticket-type selector. SMS/push delivery needs providers. |
| Task management, 7–8 | Internal tasks with employee, schedule, priority/status, notes and audit history; technicians can edit only assigned task status/description | Recurrence and calendar drag/drop are not implemented. |
| Sales/services, 8 | Existing installation collection, service charges, equipment sales charges, invoice print and receipts | General-purpose multi-line sales orders/credit notes are not implemented. |
| Purchasing, 9 | Vendors, requisitions with manager approval, purchase bills; atomic/idempotent stock receipt; finance payment posts expense; vendor outstanding summary | Purchase bills currently contain one inventory item. A multi-line purchase document and partial delivery/payment are not implemented. Supplier purchase printing can use the current Operations table print. |
| Inventory, 10 | Existing catalog, issue/return, customer hardware, QR, inspection/stocktake; new purchase receiving and asset records | Invoice/receipt dispatch requires messaging providers; multi-line purchasing and noncustomer product sales are not implemented. |
| Network diagram, 11 | Zones, sub-zones, POPs, device/link catalog and a rendered topology diagram; saved device/POP coordinates | Live client monitoring and traffic need router access. No geographic tile-map/topology overlay is implemented; customer deployment map links remain available. |
| Accounts, 12 | Existing customer ledger, receipts/expenses and financial reports; new manual cash/bank cashbook, vendor/provider payables, reseller receivables | This is **not** a complete double-entry general ledger, statutory balance sheet or automatic profit/loss. Cashbook entries are not automatically imported from all existing collections. |
| Assets, 13 | Asset catalog, serial/location/value and Good/Repair/Damaged/Destroyed conditions | Depreciation and disposal accounting are not implemented. |
| Bandwidth purchase, 14 | Items/providers, monthly bills, outstanding payable summary, payment-to-expense posting and audit history | Purchase bills are local agreements, not upstream provisioning. |
| Bandwidth sales, 14–15 | Reseller directory, invoices, immutable receipts, overpayment checks and outstanding summary | Email/SMS dispatch needs integrations; existing customer reports do not merge reseller revenue automatically. |
| Bandwidth reseller portal, 16 | Local reseller records/invoices/receipts | Separate reseller authentication, profile/purchase/support portal and tenant isolation are **not implemented**. |
| MAC reseller portal, 16–17 | MAC reseller records with daily tariff; active resellers with a positive tariff get one dated local reseller invoice per day | Full reseller administration, own clients, permissions/tenant isolation and network control are **not implemented**. No past-day backfill is inferred. |
| Admin/employee app, 18–19 | Responsive role-based web workspace, existing receipt browser print, new collection approvals and internal tasks | Native Android binaries, store distribution, direct Bluetooth/POS protocol integration and live router monitoring are not implemented. Browser print remains available. |
| Client portal, 20–21 | Existing own-account dashboard/bills/receipts; new package/status/profile/support requests, persistent support messages, published news and FTP/TV/support links | No direct customer online payment until provider checkout exists. Messages refresh with the portal; this is not websocket/push chat. Speed test and real-time traffic monitoring are not implemented. Existing installable customer web-app support is not a native APK. |
| BTRC, 21 | Existing CSV/print exports | The PDF is Bangladesh-specific. No BTRC/DIS-compliant export is claimed or implemented. A required Pakistan reporting specification has not been supplied. |
| MikroTik, 22–23 | Device/host/topology records and visible integration status | Router adapter, credentials, PPPoE/static sync, MAC control, backups and real-time monitoring are **not implemented/configured**. Saving a host does not connect a router. |
| Dashboard, 23–24 | Existing customer/finance/expiry/work/stock charts; new operational cards, reseller balances and staff resolution/within-target performance | Live online/router/SMS balances require integrations. No complete historical churn or automatic accounting profit is claimed. |
| OTT, 25 | Customer subscription tracking, manual/automatic preference, start/renewal dates and status | Provider activation, auto-renewal execution and ISP balance deductions are **not connected**. Tracking status is not proof of provider activation. |
| Business configuration, 26 | Existing packages/categories/designations/TAT; new zones/sub-zones/POPs/devices and company details/receipt-footer records | New company settings are stored records and do not yet rewrite existing invoice/receipt templates. Flexible invoice periods/custom client-code schemes are not implemented; existing permanent Payment IDs remain. |
| Payment gateway, 27 | Existing signed receipt bridge and permanent receipts; PKR/Pakistan providers retained | Provider-native checkout/callback onboarding, hosted payment links and verified production connectivity are not configured. Bangladesh gateways were not substituted. |
| Android, 28–29 | Responsive web and existing customer web-app installation support | Separate native admin/employee/customer Android applications are not implemented. |
| SMS/mail, 30 | Templates, individual message queue, explicit in-app delivery, notices and customer/staff messages | SMS/email records are labelled **Not configured**. No provider dispatch, bulk campaign delivery or scheduled invoice email/SMS is performed. Existing password-recovery email configuration is separate. |
| Roles/approval, 31 | Existing seven roles plus explicit per-module Operations grants; finance-only collection approval, manager requisition approval, immutable posted records and activity history | No arbitrary permission editor, ComAdmin branch isolation or reseller-role model has been added. |

## Working workflows

### Payroll

Operations → Payroll → Generate month. Missing employee/month records are created from salary agreements. Review salary, allowances, bonus, overtime amount, incentive and deductions. **Pay / post expense** records a Paid Staff salaries expense using the confirmed method/date. It does not initiate a bank transfer. Retrying does not create a second expense. Salary history remains in Payroll.

### Purchasing

Create a Vendor and an optional Requisition. A manager approves the requisition. Create a Purchase bill with one item, quantity and unit cost. **Receive stock** confirms physical receipt and increases inventory once. **Pay / post expense** is separately restricted to finance and posts the outgoing payment once. The record retains both stock-receipt and expense references.

### Employee collections

Support/Technician or finance staff submit Collection approvals with confirmed money, customer, billing month/date/method. Only Administrator, Manager or Accountant can approve. Approval runs the existing MRC payment/recharge/receipt workflow atomically. Rejection does not post a payment. A repeated approval returns the saved posting.

### Customer requests and conversations

Customer login and temporary-password changes remain required. A request is always attached to the signed-in customer's ID, regardless of submitted fields. Staff review requests under Operations → Customer requests. Support requests can create one ticket; package/status requests can apply the permitted CRM change. The Messages tab stores a conversation; staff reply using Operations → Customer messages. Message authors are assigned server-side, and records are immutable.

### Schedules and daily tariffs

The existing background worker checks due Client schedules every minute. Permitted package/status changes apply once; a terminated account blocks the schedule and retains the error/history. No router action occurs. The same worker raises one local daily invoice for each Active MAC reseller with a positive daily tariff, preserving already-raised daily snapshots.

### Import and bulk changes

Operations → Customer tools → Import customers CSV accepts up to 200 UTF-8 rows. Required fields: `name,phone,username,package,latitude,longitude`. Package is an existing active name or ID; its catalog monthly price is used. Import is atomic: an invalid/duplicate row rolls back the batch. CSV is not native `.xlsx` or MikroTik sync.

Bulk customer status takes an explicit selection, permits Active/Suspended/Disconnected, blocks all changes if any selected customer is Terminated, and records a history entry for every changed account. It changes CRM state only.

## Authorization and persistence

- Administrator/Manager can maintain the Operations catalogs and workflows, subject to posting restrictions.
- Accountant can maintain payroll and relevant finance/vendor/bandwidth/reseller/cashbook records, and approve collections/discount decisions.
- Storekeeper can maintain vendors, requisitions, purchase bills and assets; receiving stock is available, finance payment posting is not.
- Support can maintain internal work, customer requests/assignments/messages, OTT tracking, notices and message drafts, and submit collections.
- Technician can read/update assigned tasks (status/description only) and submit/view own collection requests. No approval or posting actions are granted.
- Viewer gets read access to nonprivate Operations modules; Payroll, Attendance, Appraisals and Collection approvals are excluded.
- Posted money records and customer conversation messages are immutable. Version checks reject stale edits. Request keys and row locks prevent duplicate stock/money effects.
- New tables: `operations_records` and `operations_events`, initialized with the normal CRM schema migration. No fictional records are added to the real database.

## Verification

`tests/test_operations.py` exercises payroll posting, purchase receiving, collection approval authorization, receipts/recharge, in-app delivery, schedule rules, reseller overpayment, idempotency, stale edits, customer request/message ownership, immutable records, atomic CSV import and protected bulk status changes in isolated PostgreSQL schemas.

`tests/browser_operations.py` exercises the real login, Digital theme, persisted vendor/payroll records, expense posting, desktop/mobile navigation and customer password/request flow against a disposable schema. Screenshots use fictional training records.
