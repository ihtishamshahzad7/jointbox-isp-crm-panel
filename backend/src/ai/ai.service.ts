import * as fs from 'fs';
import * as path from 'path';
import { Injectable, Logger } from '@nestjs/common';

/**
 * In-app assistant that answers "how do I…" questions about Jointbox.
 *
 * DEFAULT MODE = local knowledge-base search. No LLM, no model in RAM, no data
 * leaves the server, free forever — it matches the question against a built-in
 * set of Jointbox guidance entries and returns the best one with the menu path.
 * Uses effectively zero extra RAM, so it never competes with the backend,
 * Postgres or FreeRADIUS.
 *
 * OPTIONAL upgrade: if AI_API_KEY (or a local Ollama at AI_BASE_URL) is set, it
 * uses that OpenAI-compatible model for free-form answers instead. Off by
 * default precisely to keep RAM free.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  private get baseUrl() { return (process.env.AI_BASE_URL || '').replace(/\/$/, ''); }
  private get apiKey() { return process.env.AI_API_KEY || ''; }
  private get model() { return process.env.AI_MODEL || 'llama3.2:1b'; }
  /** LLM is used only when explicitly configured; otherwise local search. */
  private get llmEnabled() { return !!this.baseUrl && (!!this.apiKey || this.baseUrl.includes('11434')); }
  get configured() { return true; } // always usable — local mode needs nothing

  // ── Built-in knowledge base (guidance + exact menu path) ────────────────
  private readonly KB: Array<{ t: string; k: string; a: string }> = [
    // ── Getting started ──
    { t: 'Getting started / setup order', k: 'start setup begin first install order onboarding new fresh configure initial getting started', a: 'Set up in order: 1) Administration → Organization (create ISP, franchises/dealers). 2) Network → NAS (add each router). 3) Network → IP Pools (names must match the router). 4) Plans & Stock → Packages. 5) Areas. 6) Subscribers → Add. Setup Checklist tracks progress.' },
    { t: 'Find your way around', k: 'menu navigate navigation sidebar where find layout screen page lost', a: 'Sidebar groups: Daily Work (Dashboard, Subscribers, Support, Trace Search), Operations (Network, NOC/Uptime, Plans & Stock), Business (Billing, Disputes & Reversals, Insights, KYC & Data Usage), System (Administration, Background Jobs, Setup, Help). The header search finds anything.' },

    // ── Subscribers ──
    { t: 'Add a subscriber', k: 'add create new subscriber customer user account onboard signup register enroll', a: 'Subscribers → Add Subscriber. Enter name, package, username and password (auto-synced to FreeRADIUS), upload photo/CNIC/document, and save — they can connect immediately.' },
    { t: 'Import subscribers', k: 'import bulk upload csv excel many subscribers migrate spreadsheet', a: 'Subscribers → Import. Click the dropzone to upload a CSV, Excel (.xlsx) or JSON file, or paste it. Headers from other panels are matched automatically (full_name→name, connection_password→password, nas_id→NAS, etc.). It checks the required fields (name, username, password) and, if the file uses another panel\'s NAS/package id numbers, shows a small "map to this panel" list where you pick the matching NAS/package here. Fix any red items, then Import.' },
    { t: 'Import fails / column mismatch / nas id mismatch', k: 'import not working nothing happens mismatch nas id package id map foreign panel headers required fields error', a: 'On import the panel: (1) reads the file for you, (2) marks REQUIRED fields red if blank (name, username, password) — fix those in the sheet, (3) if the file\'s nas_id / package_id came from another panel and don\'t exist here, it lists each old number with a dropdown to choose the matching NAS/package in THIS panel. Easiest is to set the correct nas_id/package_id in the Excel before uploading so everything auto-matches.' },
    { t: 'Import packages, IP pools or NAS', k: 'import packages plans ip pools nas routers bulk upload csv excel from another panel', a: 'Each of Plans → Packages, Network → IP Pools and Network → NAS has an ⬆ Import button using the same dialog as subscribers: upload CSV/Excel/JSON, auto-map headers, check required fields, and (where relevant) map any foreign ids to this panel before importing.' },
    { t: 'Real-time link tracing (SNMP + Syslog)', k: 'link tracing snmp syslog signal flap fibre olt ont dbm live feed noc trace connection down', a: 'Enable per NAS in Network → NAS (edit a router → Link tracing): turn on MikroTik API, SNMP (port/traffic/OLT ONT signal) and/or Syslog (real-time events on UDP 514) — each optional. The NOC page shows a Live Network Feed of link up/down, flaps and weak-signal events. A subscriber\'s profile shows the live path PPPoE → NAS → OLT → ONT with a 24h dBm chart.' },
    { t: 'Segments / classify the customer base', k: 'segments classify analytics vlan area package cnic uptime outage franchise dealer reasons pie chart insights', a: 'Insights → Segments slices the base by VLAN, router, area, reseller, package, CNIC/KYC, franchise/dealer tier, uptime and outage — each with a pie chart, live availability bar and health flag. The "Why customers need attention" panel counts every flag (weak signal, flapping, expired, offline-but-active, duplicate CNIC, missing KYC, in-outage, expiring soon). Click any segment to see the customers behind it.' },
    { t: 'Dashboard overview charts', k: 'dashboard home pie goal circle active offline expired inactive franchise dealer subdealer total status', a: 'The Dashboard Home tab shows a subscriber-status pie (Active/Expired/Suspended/Inactive), goal rings (Active, Online, Offline, Expired, Inactive) and tiles for Total, Franchise, Dealer and Sub-dealer counts. Refresh Data reloads them.' },
    { t: 'Update the panel from the GUI', k: 'update button upgrade new version pull git latest gui not working restart', a: 'Only the ISP owner (SUPER_ADMIN) sees the Update button in the sidebar. It checks git for a newer version; clicking it runs the server\'s update-jointbox.sh — pull, database migrate, rebuild backend + frontend, and restart — automatically. Give it 1–2 minutes and refresh. Progress is logged to update.log on the server.' },
    { t: 'Export subscribers', k: 'export download csv excel list report subscribers filter columns', a: 'Subscribers → Export. Combine filters (package, dealer, area, router, status, expiry, online, missing CNIC), watch the live count, pick columns, and download Excel/CSV. Password column is ISP-owner only and logged.' },
    { t: 'Activate or renew', k: 'activate renew renewal extend recharge topup expiry reactivate reconnect enable', a: 'Open the customer → Activation/Renewal. Modes: full period, set days, until a date, use wallet balance, or on credit. A live preview shows price and new expiry before you charge.' },
    { t: 'Renew on credit / pay later', k: 'credit later owe pay friday unpaid activate credit debt', a: "Activation/Renewal → On credit. It activates now and records the debt against whoever approved it. Capped at two unsettled credit extensions per subscriber." },
    { t: 'Change package / pro-rata', k: 'change upgrade downgrade package plan prorata pro-rata switch move plan', a: 'Open the subscriber → Edit → change the package. Mid-cycle changes are pro-rated: unused days credited, remaining days charged at the new price, expiry kept.' },
    { t: 'Move customer between dealers', k: 'move transfer reseller dealer ownership reassign migrate handover', a: 'Open the subscriber → Move/Transfer → pick the destination account. Pricing recalculates for the new owner and settles pro-rata. Bulk: Subscribers → select → bulk-transfer.' },
    { t: 'Suspend / hold a customer', k: 'suspend hold disable pause block stop unpaid dunning grace deactivate', a: 'Auto-suspend runs daily past the grace period. To hold manually: open the subscriber → Hold/Dispute (with a reason). A held customer is skipped by auto-suspend.' },
    { t: 'RADIUS timeout on the router', k: 'radius timeout authentication failed reject router mikrotik not answering no response unknown client secret 1812 firewall', a: 'The router says "radius timeout" when the RADIUS server never replied — the customer\'s details are usually fine. Check in this order: 1) Network → NAS — is this router listed with the SAME IP the router actually sends from (check /ip address print on the device, not what you assume)? An unlisted IP is an unknown client and gets no reply at all. 2) Is the RADIUS secret here character-for-character identical to the one on the router? 3) Can the router reach port 1812/1813 UDP — press Ping on the NAS row to test. 4) If it works when you run freeradius -X by hand but not as a service, the config files are owned by root: the service runs as user freerad and cannot read them.' },
    { t: 'Deactivate / turn off a subscriber', k: 'deactivate disconnect disable turn off switch off stop cut shut down kill terminate cancel service end subscriber off del row buttons', a: 'Subscribers → find the row → the small buttons on the right are Edit, Move, Off and Del. 1) "Off" disables the account: their internet stops at the next reconnect and they cannot log back in — press it again to switch them back on. 2) To cut someone off THIS SECOND while they are connected, use Network → Live Network → Disconnect (that drops the live session but they can redial). 3) "Del" removes the customer permanently — invoices and payments are kept. Off is the reversible one; use it unless you really mean delete.' },
    { t: 'Row buttons on the subscriber list (Edit, Move, Off, Del)', k: 'edit move off del row button small buttons right side list what does mean column actions', a: 'Every subscriber row ends with four small buttons. Edit = open the record to change details (nothing changes until you Save). Move = hand the customer to another dealer, which really transfers ownership and re-prices them. Off = disable the account so they cannot connect, reversible any time. Del = delete the customer permanently; their invoices and payments are kept but the record does not come back.' },
    { t: 'Subscriber logs / history / what happened to this customer', k: 'log logs history activity audit record session past events happened check see view trail radius login attempt subscriber', a: 'Two places. 1) For ONE customer: open them → the tabs on their profile show Sessions (every login, IP, duration, data), Router Log (live fault from the router), RADIUS (auth attempts) and Notes. 2) For everyone: Insights → Logs, which has Activity, Login, Network, System, Sessions, Failed and RADIUS tabs, each filterable. You only ever see records for your own accounts and those below you.' },
    { t: 'Delete / bulk delete subscribers', k: 'delete remove bulk delete subscriber customer purge', a: 'Open a subscriber → Delete, or Subscribers → select rows → bulk delete. Their financial records (invoices/payments) are preserved and detach rather than being destroyed.' },
    { t: 'Notes on records', k: 'note comment remark annotate transmission history log record', a: 'Subscribers, users, packages, IP pools and NAS all have a Notes panel — add transmission details, follow-ups, or any context; each note keeps who wrote it and when.' },
    { t: 'Search / trace anything', k: 'search find trace lookup phone username cnic ip locate who', a: 'Daily Work → Trace Search (or the header search). Find anyone by name, username, phone, IP or CNIC.' },

    // ── Troubleshooting (customer-facing) ──
    { t: 'Customer is offline', k: 'offline down not working no internet disconnected cant connect not online outage customer complaint', a: 'Open the subscriber — the header shows Online/Offline with the last disconnect reason. Check Router Log (Refresh from router) for the live fault, then the RADIUS tab. If many are down, check Insights → Segments or NOC / Uptime for a network fault.' },
    { t: 'Internet is slow', k: 'slow speed slow lag buffering throttled fup limited bandwidth low speed', a: "Check the subscriber's Data Usage — if past the FUP cap they're throttled (extend the cap from the profile, or upgrade the package). Otherwise check the package speed, the Bandwidth graph on the profile, and the router." },
    { t: 'Reconnect loop / cannot authenticate', k: 'reconnect loop authenticate auth reject fails password radius cannot login', a: "Open the subscriber → Router Log (Refresh) — it states the fault (missing pool, rejected auth). Check the RADIUS tab for conflicting addressing. Then press Force Sync to rewrite their credentials from scratch." },
    { t: 'Force sync to RADIUS', k: 'force sync radius push credentials fix repair not exist missing radcheck', a: "Open the subscriber → RADIUS tab → Force Sync. It rewrites the customer's credentials and profile into FreeRADIUS. Use it when a renewed customer still can't connect. Bulk repair: Background Jobs → reconcile heals missing credentials." },
    { t: 'MAC binding / lock', k: 'mac bind lock address device restrict calling-station tie device', a: "Network → Live Network → MAC on the row, or the subscriber's MAC settings. Bind the current MAC or auto-learn it so only that device can use the account." },

    // ── Money / accounting ──
    { t: 'Take a payment', k: 'payment pay collect cash receive record invoice paid money in', a: 'Payments → record a payment, or open an invoice → Record Payment. A near-duplicate (same amount/method within 90s) is blocked unless you confirm.' },
    { t: 'Refund (full or partial)', k: 'refund partial reverse money back return chargeback give back overpaid', a: 'Payments → Refund on the row. Blank amount = full refund; a smaller figure = partial. Reason required. Refunds post offsetting entries and claw back commission proportionally.' },
    { t: 'Refund / expense approval limit', k: 'approval approve limit threshold sign-off staff refund expense pending queue', a: 'Accounting → Refund/Expense approval limit (ISP owner). Staff refunds/expenses above the limit queue for approval instead of posting. Approve/Reject on the same card.' },
    { t: 'Close the books (period lock)', k: 'close books period lock month end backdate backdating accounting close finalize', a: 'Accounting → "Close the books" (ISP owner). Locking through a date stops anyone backdating a payment/refund/expense into that month. The month-end checklist warns of anything unresolved first.' },
    { t: 'Trial balance / money integrity', k: 'trial balance ledger integrity reconcile overdrawn drift audit debits credits balanced', a: 'Accounting shows the trial-balance banner (debits vs credits) and overdrawn-wallet warnings. Full wallet-vs-ledger reconciliation runs in Background Jobs → Run reconcile.' },
    { t: 'Daily cash collection', k: 'collection cash drawer daily reconcile who collected day end by staff method', a: 'Accounting → Collections tab. Pick a day to see who collected how much, by payment method, net of refunds — for balancing the cash drawer. Export to CSV.' },
    { t: 'Expenses', k: 'expense spend cost bill purchase record expense category', a: 'Accounting → Expenses. Add a category and amount. Large staff-raised expenses can require ISP approval (Expense approval limit) before they hit the ledger.' },
    { t: 'Reversals & audit trail', k: 'reversal reverse charge commission clawback audit trail dispute credit note', a: 'Disputes & Reversals — reverse a charge, view all reversals, the commission statement (earned vs clawed back), and the full financial audit trail. Export to CSV.' },
    { t: 'Wallet top-up & reverse', k: 'wallet balance topup top-up add funds reverse correct mistake fund dealer', a: 'Administration → Organization → a reseller → Wallet to top up (debits their direct parent). A wrong top-up can be reversed from the wallet history (Reverse button).' },
    { t: 'Credit limit / overdraft', k: 'credit limit overdraft allow negative balance let sell past zero', a: "Administration → Organization → a reseller → set a credit limit so they can keep activating slightly past zero balance. Overdrawn accounts are flagged on Accounting." },
    { t: 'Invoices', k: 'invoice bill generate custom invoice pdf due', a: 'Invoices lists all bills; open one to Record Payment, view/download the PDF, or reverse it (Accounting → invoice reverse, blocked if it has active payments).' },
    { t: 'Aged debt / who owes', k: 'debt owe overdue receivable aged unpaid outstanding chase collection debtor', a: 'Insights → Reports → Aged receivables: unpaid invoices bucketed by how overdue they are, with the biggest debtors ranked by amount.' },

    // ── Network ──
    { t: 'Disconnect a live user', k: 'disconnect kick drop cut session live user offline coa boot force off', a: 'Network → Live Network → Disconnect on the row. Uses standard RADIUS CoA, so it works on MikroTik, Cisco, Juniper, pfSense, vBNG and OLTs.' },
    { t: 'Change speed live', k: 'speed bandwidth change rate limit throttle upgrade coa live faster slower boost', a: "Network → Live Network → Speed on the row. Changes the customer's speed live via RADIUS CoA (no reconnect) and persists for the next auth." },
    { t: 'Test CoA on a router/BNG', k: 'test coa router nas bng verify session control reachable check', a: 'Network → NAS → open the device → Overview → Test CoA. Sends a harmless probe to confirm the router accepts session control. Changes nothing.' },
    { t: 'Add a router / NAS / BNG', k: 'nas router mikrotik bng cisco juniper add register radius secret api coa port identifier', a: 'Network → NAS → Add NAS. Set the IP, RADIUS secret, API user/password (MikroTik), CoA port (3799), and NAS Identifier for BNGs. Then Test CoA to confirm control.' },
    { t: 'Fix a ghost online user', k: 'ghost online stuck session stale still online after reboot sync not really online', a: "Network → Live Network → Sync sessions — asks the routers who's really connected and closes stale sessions. It also self-heals automatically every 5 minutes." },
    { t: 'IP pools', k: 'ip pool address range dynamic pool assign framed pool mismatch', a: 'Network → IP Pools. Names must match the pool names on the router EXACTLY (case-sensitive) or auth fails — a mismatch warning shows if they differ.' },
    { t: 'Static / public IP', k: 'static ip public fixed address business dedicated ip sell', a: "Set a Static public IP on the subscriber's Edit form (with a monthly price), or Network → Static IPs. It's written to RADIUS and starts its own monthly billing." },
    { t: 'Live network / who is online', k: 'live network online now sessions active users throughput realtime monitor', a: 'Network → Live Network shows everyone currently online with IP, MAC, duration, live throughput, and Disconnect/Speed/MAC actions. Auto-refreshes.' },
    { t: 'NOC / uptime dashboard', k: 'noc uptime outage sla segment health network down monitor status availability', a: 'Operations → NOC / Uptime: online/total, problem areas, ISP vs customer-experienced uptime %, network downtime, per-area segment health, and an outage timeline.' },
    { t: 'Outages / load-shedding', k: 'outage power load shedding wapda area down scheduled blackout', a: 'Network → Outages (and NOC). The panel detects mass area drops and separates power/load-shedding from network faults so your uptime figure is fair. Classify each outage as power vs network.' },
    { t: 'Bandwidth graph per customer', k: 'bandwidth graph usage chart mrtg live historical throughput per subscriber daily', a: "Open the subscriber → the Bandwidth chart shows live throughput plus a 14-day daily usage graph — good for support and upsell." },

    // ── Fiber ──
    { t: 'Fiber OLT / ONU', k: 'fiber olt onu gpon optical provision splitter port ont', a: 'Network → Fiber: manage OLTs, ports and ONUs, assign an ONU to a subscriber, and get provisioning/diagnostic commands.' },
    { t: 'Trace the transmission path', k: 'topology trace path fault splitter olt fiber where fault circuit-id', a: 'Trace/Topology uses the circuit-id your OLT stamps to locate a fault: one customer = their drop; most of a splitter = feeder/splitter; most of an OLT = OLT/uplink. Needs PPPoE Intermediate Agent on the OLT.' },

    // ── Compliance ──
    { t: 'KYC / CNIC verification', k: 'kyc cnic identity verify document nadra compliance duplicate id card', a: 'KYC & Data Usage: record the CNIC number and both image sides, then Verify. It refuses without a number, both sides and a non-expired CNIC. Shared CNICs are flagged, not blocked.' },
    { t: 'Data cap / FUP', k: 'data cap quota fup fair usage limit gb throttle allowance exceeded block extend', a: 'Set a Data Quota and FUP speed on the package (Plans & Stock → Packages). Past the cap the customer is throttled or blocked. Extend a cap from the subscriber profile; heavy users list in KYC & Data Usage.' },

    // ── Vouchers ──
    { t: 'Vouchers / prepaid cards', k: 'voucher prepaid card pin redeem scratch batch generate recharge card', a: 'Billing → Vouchers to generate/manage prepaid vouchers in batches. Customers redeem them in the portal or you apply them on the subscriber. Redemption is double-spend safe.' },

    // ── Users / access ──
    { t: 'Create reseller / dealer / retailer', k: 'reseller dealer retailer franchise create sub add downline user tier hierarchy', a: "Administration → Users → Add. Each tier can create the one below it (ISP→Franchise→Dealer→Retailer). To create a level lower, use Act as to switch into that account first." },
    { t: 'Create staff', k: 'staff sales employee helper create user office worker installer', a: 'Administration → Users → Add → Staff. Staff work inside YOUR account — they see your customers and spend your wallet, with no wallet or customers of their own.' },
    { t: 'Auditor (read-only) account', k: 'auditor read only accountant access role view books reviewer', a: 'Administration → Users → Add → Auditor (ISP owner only). They can view everything in their subtree but cannot create, edit, refund or move money — enforced server-side.' },
    { t: 'Roles & permissions', k: 'role permission access control allow deny capability restrict rights', a: 'Administration → Security → Roles/Permissions. Grant capabilities per role, or deny a specific capability to an individual downline user.' },
    { t: 'Act as / impersonate', k: 'act as impersonate switch into login as view as become another account', a: 'Use "Act as" in the top bar to switch into a downline account (e.g. to create a dealer under a franchise). A banner shows while you\'re acting as someone.' },
    { t: 'Two-factor authentication (2FA)', k: '2fa two factor authentication otp security enable totp', a: 'Administration → Security → 2FA to enrol and enforce two-factor authentication for stronger login security.' },

    // ── Pricing / packages ──
    { t: 'Set a reseller / package price', k: 'reseller pricing price margin franchise dealer package assign wallet commission cost sell how set change rate charge downline', a: 'Billing → Reseller Pricing. 1) Pick the package. 2) Under "Who are you pricing for?" tick one account for a special rate, or several to give them the same price. 3) Enter the price that account PAYS YOU and Save. You can only price accounts DIRECTLY below you — they set their own downstream prices, which keeps each tier\'s margin theirs. A margin is the child\'s price minus what they pay you.' },
    { t: 'Can set prices — the permission', k: 'can set prices permission allow enable disable child own price toggle price-permission rights', a: 'Whether a downline account may set ITS OWN sell prices is the "can set prices" permission. Turn it on/off at Administration → Organization → the reseller (or Billing → Reseller Pricing shows the badge). ON = they choose what they charge their customers/downline; OFF = they resell at the price you set and can\'t change it.' },
    { t: 'What if "can set prices" is OFF', k: 'what happens not select can set price disabled off cannot change reseller resell fixed', a: 'If a reseller does NOT have "can set prices", they cannot set or change their own sell prices — they simply resell at the price you assigned them, so their margin is fixed by you. Enable it in Administration → Organization → that reseller if you want them to control their own pricing.' },
    { t: 'Why "Not yours to price"', k: 'not yours to price cannot price account grey greyed disabled why locked hierarchy', a: 'You can only price accounts DIRECTLY beneath you. An account shown as "Not yours to price" sits under one of your dealers, not under you — so its dealer prices it, not you. To price a dealer\'s customers, use "Act as" to switch into that dealer first.' },
    { t: 'Create / edit a package', k: 'package plan create add speed price duration bandwidth profile tariff', a: 'Plans & Stock → Packages → Add. Set speed, price, duration, and optionally a data quota + FUP speed. Only the ISP owns the package catalogue; resellers resell it at their own price.' },
    { t: 'Tax / extra fee', k: 'tax vat fee extra charge gst surcharge', a: 'Plans & Stock → Packages → Taxes to define taxes/extra fees applied on billing.' },

    // ── System / ops ──
    { t: 'Background jobs / reconcile', k: 'background job queue reconcile integrity progress run task bulk async', a: 'System → Background Jobs (ISP owner). Run the integrity reconcile (trial balance + wallet + RADIUS + session heal) and watch live progress. Long/bulk work runs here off the request path.' },
    { t: 'Backups', k: 'backup restore database dump off-site offsite disaster recovery save copy', a: 'A database backup runs nightly. Set BACKUP_UPLOAD_CMD in the server .env to push each backup off-site (scp/rclone/aws). Status shows on Insights → Logs.' },
    { t: 'IPv6 dual-stack', k: 'ipv6 dual stack prefix delegated framed v6 address', a: 'IPv6 is dual-stack and auto-allocated per subscriber (a stable /64 and delegated prefix), shown on the subscriber profile. Turn on the pool with the IPV6_* env vars.' },
    { t: 'Online payment gateways', k: 'gateway stripe bkash sslcommerz jazzcash easypaisa paypal razorpay online payment card', a: 'Configure gateway keys in the server .env; enabled ones appear on the customer portal. Supported: Stripe, bKash, SSLCommerz, JazzCash, Easypaisa, PayPal, Razorpay.' },
    { t: 'Notifications / SMS / email', k: 'notification sms email whatsapp message template reminder receipt alert send', a: 'Support → Communication. Templates fire automatically on welcome, payment, invoice, renewal, expiry and suspension (defaults are seeded). Set an SMS/email gateway in Settings to actually send.' },
    { t: 'Reports & analytics', k: 'report revenue profit analytics dashboard growth statistics reseller performance', a: 'Insights → Reports & Analytics: revenue trends, subscriber growth, package mix, aged receivables, reseller performance (MRR/cost/profit/wallet). Export to CSV/PDF.' },
    { t: 'Reading analytics / segments', k: 'segment analytics vlan area router package health online active gap fault at-risk read understand', a: 'Insights → Analytics leads with a plain sentence — all normal, or which segments need attention. Segments cuts your base by VLAN, area, dealer, router and package, each showing ONLINE vs ACTIVE. The gap between them is where faults hide (e.g. a VLAN with 40 active but 3 online is broken). Healthy segments are hidden so problems show first.' },
    { t: 'Who sees what (visibility / security)', k: 'security visibility subtree see data isolation permission scope hide access others privacy who can see', a: 'Every account only ever sees its OWN subtree — enforced on the server, not just hidden in the UI, so it can\'t be bypassed via the API. A dealer sees only their own customers, IPs, outages and topology. A child cannot see its own wallet rules, commission or permissions (those belong to the parent). Bulk password export is ISP-owner only and always logged.' },
    { t: 'Where do I get help', k: 'help guide how to learn assistant support documentation manual where find teach', a: 'Ask me — the ✦ assistant (bottom-right, on every screen). I cover how to use every feature, where it lives, and what happens before you act. For jumping to a screen, press Ctrl/⌘+K to search all features.' },
    { t: 'Tickets / support', k: 'ticket support complaint issue helpdesk request problem raise', a: 'Support → Complaints/Tickets. Create, categorise, prioritise, assign to staff, and track status. Customers can raise tickets from the portal.' },
    { t: 'Field jobs / technician dispatch', k: 'field job technician dispatch installation visit task assign engineer', a: 'Support → Field Jobs. Create a job (or from a ticket), assign a technician, and track start/complete. Technician performance shows in the report.' },
    { t: 'Inventory / stock', k: 'inventory stock item asset router ont device supplier storage', a: 'Plans & Stock → Inventory: track devices/items, assign to a reseller, install on a subscriber, or return — with full history.' },
    { t: 'Customer self-service portal', k: 'portal customer self service login pay usage invoice self care app', a: 'Customers log in at /portal to see usage and data cap, pay invoices online, recharge with a voucher, view/download invoices, raise tickets, change password, and self-activate.' },
    { t: 'Server console', k: 'server console terminal command logs system root exec', a: 'System → Server Console (ISP owner only) — view server logs and run allow-listed maintenance from the panel.' },
    { t: 'Settings / currency', k: 'settings configure currency symbol company logo general software preferences', a: 'Administration → Settings: general/software settings, currency and symbol, SMS/email gateways, subscriber and captive-portal settings, invoice and tax config.' },

    // ── Cause & effect / "what if" — understand BEFORE you act ──
    { t: 'Before you activate a subscriber', k: 'before prerequisite need require first what before activate connect prepare requirement', a: 'Before a customer can come online you need: a Package, an IP Pool whose name matches the router, a NAS/router added, and enough wallet balance (or a credit limit) on the activating account. Missing any of these and activation is refused or the customer can\'t authenticate.' },
    { t: 'What if I delete a subscriber', k: 'what happens delete remove subscriber consequence undo permanent lose data', a: 'Deleting removes them from RADIUS (they go offline) but PRESERVES their invoices/payments (those detach, they\'re not destroyed). It is not easily undone — prefer Suspend/Hold if it may be temporary.' },
    { t: 'Suspend vs delete', k: 'suspend versus delete difference reversible temporary permanent which', a: 'Suspend/Hold is reversible — the account stays and you can reactivate anytime. Delete is permanent for the customer record. Use suspend for non-payment or a pause; delete only when they\'re truly gone.' },
    { t: 'What if the RADIUS secret is wrong', k: 'what happens wrong missing radius secret nas authentication fails coa not working', a: 'If a NAS\'s shared secret doesn\'t match the router, authentication silently fails and CoA (disconnect/speed) gets no reply. Set the exact secret in Network → NAS, then Test CoA to confirm.' },
    { t: 'What if IP pool name does not match', k: 'what happens pool name mismatch wrong router no address cannot determine remote', a: 'If the pool name in the panel differs from the router (case-sensitive), the customer authenticates but gets no IP — the router log says "could not determine remote address". Fix the pool name to match exactly.' },
    { t: 'What if wallet balance is empty', k: 'what happens wallet empty zero balance cannot activate insufficient no funds', a: 'With no wallet balance (and no credit limit) the activating account can\'t activate/renew — the attempt is refused. Top up the wallet (Organization → Wallet) or set a credit limit to allow a small overdraft.' },
    { t: 'What happens when I refund', k: 'what happens refund result effect consequence money back commission invoice', a: 'A refund returns the money (cash or to wallet), reverts the invoice to PARTIAL/UNPAID, and claws back the reseller commission proportionally — all as offsetting entries (originals untouched). It\'s refused if the payment\'s month is closed, and large staff refunds may need ISP approval.' },
    { t: 'What happens when I close the books', k: 'what happens close books period lock effect backdate stop cannot post month', a: 'After locking a period, no one can record or backdate a payment/refund/expense into it. To post a late correction you must Reopen it, make the entry, then close again. Resolve pending approvals and out-of-balance warnings first (the checklist shows them).' },
    { t: 'What happens when I disconnect', k: 'what happens disconnect result reconnect back online drop kick effect', a: 'Disconnect drops the current session immediately (via CoA). If the account is still ACTIVE the customer can simply reconnect — to keep them off, suspend the account instead.' },
    { t: 'What happens when I change speed', k: 'what happens change speed effect live reconnect persist take effect', a: 'Changing speed applies LIVE via CoA (no reconnect) and is also saved so it holds on the next authentication. If the live CoA isn\'t acknowledged, it still applies on their next reconnect.' },
    { t: 'What if I move a customer to another dealer', k: 'what happens move transfer dealer consequence pricing commission wallet effect', a: 'Transferring recalculates what the new owner pays and charges for that package, re-bills at the new owner\'s retail price, and future activations settle against the new owner\'s wallet. The old owner stops earning on them.' },
    { t: 'What if a NAS has no API credentials', k: 'what happens no api username password mikrotik nas cant read router log', a: 'Without the router API user/password the panel can\'t read live router logs, verify pools, or force-disconnect via the API — but standard RADIUS CoA disconnect/speed still works if the CoA port and secret are set.' },
    { t: 'What if a payment looks like a duplicate', k: 'what happens duplicate payment blocked twice same amount confirm override', a: 'If you record a payment matching a recent one (same subscriber/amount/method within 90s) it\'s blocked to prevent double-posting. If it\'s genuinely a second payment, confirm to record it anyway.' },
    { t: 'What if I approve or reject a refund/expense', k: 'what happens approve reject refund expense pending decision post close', a: 'Approve runs the actual refund/expense and posts it to the ledger (refunds also claw back commission). Reject closes the request with nothing posted. Both are ISP-owner actions on Accounting.' },
    { t: 'What if I reverse a wallet top-up', k: 'what happens reverse wallet topup undo mistake spent both sides', a: 'Reversing a top-up pulls the amount back off the receiver and refunds the funder (both sides, offsetting entries). It\'s refused if the receiver already spent part of it — that would need a manual correction.' },
    { t: 'What if an Auditor tries to change something', k: 'what happens auditor edit read only refuse cannot write blocked', a: 'An Auditor account can view everything in its subtree but every write (create/edit/refund/move money) is refused on the server. Use it for accountants or reviewers who should look but not touch.' },
    { t: 'What if I don\'t verify KYC / upload CNIC', k: 'what happens no cnic kyc verify skip compliance pta document missing', a: 'Verification is refused without the CNIC number, both image sides, and a non-expired CNIC — so an unverified customer stays flagged. Recording identity is a PTA licence requirement and your defence against resale fraud.' },
    { t: 'What if I don\'t set a data cap / FUP', k: 'what happens no fup quota unlimited cap not set data', a: 'Leave the FUP speed blank and the data quota is never enforced — the plan behaves as unlimited. Set a Data Quota + FUP speed on the package only when you want throttling/blocking past the cap.' },
    { t: 'Is an action reversible / can I undo it', k: 'undo reversible revert mistake cancel take back safe permanent', a: 'Money actions are reversible via offsetting entries (refund, invoice reversal, wallet top-up reversal) and never edit the originals, so there\'s always an audit trail. Deleting a subscriber and closing/deleting are the actions to be careful with — prefer suspend/reopen where possible.' },

    // ══════════════════════════════════════════════════════════════
    //  Daily-work hubs (My Work: My Business · Quick Connect · Renewals)
    // ══════════════════════════════════════════════════════════════
    { t: 'My Work hub', k: 'my work hub daily loop business quick connect renewals franchise dealer where start', a: 'Daily Work → My Work holds the three screens a franchise/dealer uses all day, as tabs: My Business (money + customer health), Quick Connect (add & activate), Renewals (who is due). Use it as your home screen instead of hunting the sidebar.' },
    { t: 'My Business dashboard', k: 'my business wallet balance snapshot revenue commission receivables health low balance dealer franchise earnings month', a: 'My Work → My Business. One live snapshot: wallet balance and spendable (incl. credit limit, amber when low), customers active/expiring-in-7-days/expired/suspended, this month\'s new connections, collected revenue and commission, plus receivables (unpaid invoices). Every tile clicks through to the screen that fixes it. Refreshes each minute.' },
    { t: 'Quick Connect — add and activate in one screen', k: 'quick connect new connection add activate fast one screen wizard collect cash first payment', a: 'Daily Work → Quick Connect. One form: name, phone, username/password (Suggest generates them), package, area, NAS. It tells you exactly what activation will charge, and the checkbox records the customer\'s first cash payment automatically. ⚡ Activate & connect runs the whole flow — package → invoice → wallet charge → RADIUS — so the customer is online immediately. A double-click cannot double-charge (idempotency key).' },
    { t: 'Renewals worklist', k: 'renewals due this week expired renew collect one tap worklist month end win back', a: 'Daily Work → Renewals. Groups your customers into Expired (win back), Due this week, and Coming up (30 days), with package, price and days left. "Renew + cash" does invoice + payment + back-online in one tap; "Wallet" renews from the customer\'s own balance. Scoped to your own customers only.' },
    { t: 'Collections & earnings report', k: 'collections earnings report daily trend by package method csv export how much did i collect commission', a: 'Business → Billing & Accounting → Collections (or /earnings). Pick 7/30/90 days: total collected, commission earned, average per day, a daily bar chart (hover any bar for the exact amount and payment count), and breakdowns by package and payment method. ⬇ Export downloads it as CSV.' },

    // ══════════════════════════════════════════════════════════════
    //  NAS monitoring (traffic, VLAN, signal, uptime, ports)
    // ══════════════════════════════════════════════════════════════
    { t: 'NAS traffic graphs (MRTG style)', k: 'mrtg traffic graph bandwidth chart 1h 6h 7 days 30 days nas router usage peak throughput', a: 'Open Network → NAS → click a router. The Traffic panel plots download/upload over 1h / 6h / 7 days / 30 days with peak ↓/↑, current online and uptime %. Hover anywhere for a crosshair and the exact values at that moment. Data comes from RADIUS accounting sampled every 5 minutes, so a new install needs ~15 minutes before the first curve appears.' },
    { t: 'VLAN breakdown per NAS', k: 'vlan breakdown per vlan port online traffic split nas which vlan', a: 'In a NAS\'s detail, under the traffic graph, the VLAN breakdown lists each VLAN (from nasportid) with how many subscribers are online on it and its up/down bytes — useful for spotting one VLAN carrying everything or a VLAN that has gone quiet.' },
    { t: 'Link up/down and optical signal (dBm)', k: 'signal dbm optical onu ont link up down fiber weak degrading los rx power', a: 'A NAS\'s detail shows "Links up/down & optical signal": every ONU with a green/red status dot, its Rx power in dBm, and a colour band for quality (green ≥ −25, amber ≥ −28, red below). Down/critical links sort first. Requires SNMP-enabled OLT/ONU.' },
    { t: 'Monitor only chosen ports / discover interfaces', k: 'monitored ports interfaces discover snmp which port register only monitor specific', a: 'In a NAS\'s detail, "Monitored ports": click Discover to SNMP-walk the router and list its real interface names (with up/down), then keep only the ones you care about (e.g. ether1-wan, vlan100) and Save. Only those interfaces are then polled. Leave it blank to monitor every interface.' },
    { t: 'NAS uptime %', k: 'uptime percent availability downtime nas router sla history reliability', a: 'The NAS traffic panel shows Uptime % and minutes down for the selected range (green ≥99, amber ≥95, red below). It is derived from gaps in the 5-minute samples: a gap over 12 minutes counts as the router not reporting.' },
    { t: 'Operations screen (what needs attention)', k: 'operations screen noc alerts nas down attention isp owner overview problems now', a: 'Operations (inside Network) is the ISP owner\'s "what needs my attention now" screen: online now, NAS reporting X/Y, active outages, problem areas, open alerts, a live alert feed, routers not reporting, and the busiest routers. Refreshes every 30 seconds.' },

    // ══════════════════════════════════════════════════════════════
    //  Alerts (Discord / WhatsApp)
    // ══════════════════════════════════════════════════════════════
    { t: 'Discord / WhatsApp alerts', k: 'discord whatsapp alert notify webhook uptime kuma nas down outage mass disconnect telegram', a: 'Communication → Alerts. Paste a Discord webhook (Server Settings → Integrations → Webhooks → New Webhook → Copy URL) and Save, then Send test alert. You are then alerted when a NAS mass-disconnects, goes down, recovers, or an outage is detected. WhatsApp works too via CallMeBot (free) or Meta Cloud API. Values are encrypted at rest and only ever shown masked.' },
    { t: 'My own alert channel (per account)', k: 'my alert channel own discord franchise dealer separate alerts not isp only mine', a: 'Communication → Alerts → "My alert channel". Every account — franchise, dealer, staff — can point alerts about THEIR OWN routers and customers at their own Discord/WhatsApp, independent of the ISP owner\'s. You can only ever set your own channel.' },

    // ══════════════════════════════════════════════════════════════
    //  Grouping, bulk actions, temporary boost, demo
    // ══════════════════════════════════════════════════════════════
    { t: 'Group subscribers (classification)', k: 'group grouping classify by nas area dealer package status same router together clean', a: 'On Subscribers click "Group subscribers" and choose NAS/Router, Area, Dealer/Parent, Package or Status. You get a card per group with total + active counts and an active-ratio bar; clicking a card filters the list to it. NAS and Users have the same panel (Group NAS by owner/type/site, Group accounts by role/parent/KYC).' },
    { t: 'Bulk and group actions', k: 'bulk multiple select many at once activate deactivate message grace whole nas area group blast', a: 'On Subscribers, select rows and use the toolbar: Activate, Grace, Message, Remove, Disable, Move. To act on a WHOLE group without selecting, hover a group card and use ✓ activate, ⊘ deactivate, ✉ message or ⏳ grace. You can also right-click a NAS → "Message subscribers…" to notify everyone on that router (maintenance notice).' },
    { t: 'Temporary speed boost', k: 'boost temporary speed upgrade 30mb one day extra speed revert automatically', a: 'Open a subscriber → ⚡ Temporary Boost. Set the speed and a duration (1h / 6h / 1 day / 3 days, or Permanent). It applies live via RADIUS CoA; a timed boost reverts to the plan speed automatically when it expires, so nobody has to remember.' },
    { t: 'Grace period', k: 'grace period extra days keep online past expiry goodwill awaiting payment temporary', a: 'Open a subscriber → Grace Period, enter days (1–90). If they were expired/inactive they are reactivated immediately and put back into RADIUS; the daily expiry sweep will not cut them until the grace ends. No charge and no invoice — it is goodwill, and it is audit-logged.' },
    { t: 'Demo accounts', k: 'demo sandbox trial try test account 7 days auto delete franchise', a: 'The login page has "Try a demo account": it creates a sandbox FRANCHISE account with full franchise powers and a test wallet. Console, RADIUS admin and logs are blocked in demo for security, and the whole account plus everything it created is deleted automatically after 7 days. Creation is rate-limited (one per IP per hour).' },

    // ══════════════════════════════════════════════════════════════
    //  Interface, themes, tables
    // ══════════════════════════════════════════════════════════════
    { t: 'Themes / change the look', k: 'theme colour color dark light winbox aurora appearance look change ui', a: 'Click the 🎨 icon in the header. Three themes: Aurora (the gradient default), WinBox (beta) — flat and compact like MikroTik WinBox — and Light (white). Your choice is remembered per browser.' },
    { t: 'Resize table columns / expand a table', k: 'column width resize drag table expand full screen bigger view wide', a: 'Drag the edge of any column header on Subscribers, NAS or Packages to resize it; double-click the edge to reset. Widths are remembered. Each list also has ⛶ Expand for a full-screen view (Esc to close), and Find/Ctrl+F to search.' },
    { t: 'Keyboard shortcuts', k: 'keyboard shortcut ctrl k command palette search quickly hotkey', a: 'Ctrl+K (or ⌘K, or /) opens the command palette — type to jump to any screen or action. Ctrl+F focuses the Find box on a list. Esc closes dialogs and the expanded view.' },
  ];

  /**
   * Direct answer for "what does this button do / what happens if I press X",
   * asked while standing on the screen that has X.
   *
   * This runs BEFORE the keyword search because the search answers with an
   * article, and someone hovering over a red button wants one sentence about
   * that button — not a paragraph about the feature it belongs to.
   * Returns '' when the question is not about a button, so the normal search
   * takes over.
   */
  private answerAboutButton(question: string, clean: string, top: string, tabRoute?: string): string {
    const q = (question || '').toLowerCase();
    const buttons = this.buttonsFor(clean, top, tabRoute);
    if (!buttons.length) return '';

    // "what is this screen for" — the vaguest question there is, and the one a
    // nervous first-day user actually asks. Keyword search scores it near zero
    // (almost every word is a stop word), so it used to fall through to "I
    // didn't understand that". We already know exactly which screen they are
    // on, so answer from that instead of searching.
    if (/^(what|whats|what's)\b[^?]*\b(this|here|screen|page|tab)\b/.test(q)
        && !/\b(button|buttons|option|options|click|press|tap)\b/.test(q)
        && !buttons.some((b) => b.label.length > 2 && q.includes(b.label.toLowerCase()))) {
      const help = this.pageHelp(tabRoute || clean);
      const risky = buttons.filter((b) => b.risk === 'high').map((b) => b.label);
      return [
        help.title || 'This screen',
        '',
        help.intro || 'This is one of the panel screens.',
        '',
        `There are ${buttons.length} things you can click here. Ask me "what does each button do here" and I'll go through every one.`,
        risky.length ? `\n⚠ Take care with: ${risky.join(', ')} — those change money, service or someone's internet.` : '',
      ].filter(Boolean).join('\n');
    }

    // "what are the buttons here" / "what can I click on this screen"
    if (/\b(button|buttons|option|options|click|press|tap)\b/.test(q)
        && /\b(this|here|screen|page|each|all|what|which)\b/.test(q)
        && !buttons.some((b) => q.includes(b.label.toLowerCase()))) {
      const lines = buttons.map((b) => {
        const mark = b.risk === 'high' ? '🔴' : b.risk === 'medium' ? '🟡' : '🟢';
        return b.does ? `${mark} ${b.label} — ${b.does}` : `${mark} ${b.label}`;
      });
      return [
        'Here is every button on this screen and what it does.',
        '',
        ...lines,
        '',
        '🔴 = changes money, service or data — read the warning before pressing.',
        '🟡 = makes a real change, but shows you a preview first.',
        '🟢 = safe, changes nothing on its own.',
        '',
        'Ask me about any one of them by name and I will tell you exactly what happens.',
      ].join('\n');
    }

    // "what happens if I press <label>" — pick the longest label mentioned so
    // "mass delete" beats "delete".
    const named = buttons
      .filter((b) => b.label.length > 2 && q.includes(b.label.toLowerCase()))
      .sort((a, b) => b.label.length - a.label.length)[0];

    /**
     * Only answer ABOUT the button when they are really asking about it.
     *
     * A loose guard here was worse than no guard: "how do I add a customer"
     * mentions the word "add", matched the Add button, and got back "Opens a
     * form to create a new record" instead of the actual step-by-step. So a
     * "how do I…" task question always goes to the knowledge base, and only
     * an explicit what-happens/is-it-safe/what-does-this-button phrasing gets
     * the button card.
     */
    const asksAboutButton =
      /\bbutton\b/.test(q)
      || /\bwhat (does|do|happens|will happen|is)\b/.test(q)
      || /\b(safe|undo|reversible|dangerous|careful)\b/.test(q)
      || /\bif i (press|click|tap|hit)\b/.test(q);
    const isHowTo = /\b(how (do|can|to)|where (do|is|can))\b/.test(q);

    if (named && asksAboutButton && !isHowTo) {
      if (!named.does) return '';
      return [
        `The "${named.label}" button`,
        '',
        `What it does: ${named.does}`,
        `Before you press it: ${named.careful}`,
        named.risk === 'high'
          ? '\n⚠ This one changes money, service or data. Read the line above twice — it is not easily undone.'
          : named.risk === 'medium'
            ? '\nℹ This makes a real change, but you get a preview or confirmation first.'
            : '\n✓ This one is safe. Nothing changes because you pressed it.',
      ].join('\n');
    }
    return '';
  }

  private static readonly STOP = new Set([
    'the','a','an','how','do','i','to','my','in','on','of','is','for','what','where','it','and','me',
    'with','you','we','our','this','that','get','see','use','need','want','does','are','when','why',
    'should','if','can','or','be','am','was','will','would','there','here','from','out','any','some',
    'please','tell','show','help','know','make','let','one','also','have','has','had','been','they',
  ]);

  /**
   * Crude stemmer — plural and simple verb endings only.
   *
   * "logs of subscribers" scored ZERO on "logs" and "subscribers" because the
   * knowledge base says "log" and "subscriber". No stemming meant the two words
   * that carried the entire question were thrown away. Deliberately shallow:
   * an aggressive stemmer starts merging words that mean different things.
   */
  private stem(w: string): string {
    if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
    if (w.length > 4 && (w.endsWith('ses') || w.endsWith('xes') || w.endsWith('ches'))) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
    return w;
  }

  private tokens(text: string): string[] {
    return (text.toLowerCase().match(/[a-z0-9]+/g) || [])
      .filter((w) => w.length > 1 && !AiService.STOP.has(w))
      .map((w) => this.stem(w));
  }

  /**
   * How rare each word is across the whole knowledge base (classic IDF).
   *
   * THE BUG THIS FIXES: every term scored the same, so "renew subscriber"
   * gave one point for "renew" and one for "subscriber" — but "subscriber"
   * appears in half the entries and tells us nothing, while "renew" is the
   * entire question. Four entries tied on 2 points and the winner was simply
   * whichever sat earliest in the array: "Add a subscriber". Weighting each
   * term by its rarity makes the meaningful word decide the answer.
   */
  private readonly IDF: Map<string, number> = (() => {
    const df = new Map<string, number>();
    const all = [...this.KB, ...this.GEN.entries];
    for (const e of all) {
      for (const w of new Set(this.tokens(`${e.t} ${e.k}`))) df.set(w, (df.get(w) || 0) + 1);
    }
    const idf = new Map<string, number>();
    for (const [w, n] of df) idf.set(w, Math.log(all.length / (1 + n)) + 0.2);
    return idf;
  })();

  /** Levenshtein distance — used only to forgive typos. */
  private dist(a: string, b: string): number {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /**
   * Closest known word to a misspelling, or the word unchanged.
   *
   * Must pick the CLOSEST candidate, not the first acceptable one: "desconnect"
   * is 1 edit from "disconnect" and 3 from "reconnect", but a first-match scan
   * returned whichever happened to be earlier in the vocabulary — and answered
   * a question about disconnecting someone with the reconnect-loop article.
   */
  private correct(word: string): string {
    if (this.IDF.has(word) || word.length < 5) return word;
    const limit = word.length > 7 ? 2 : 1;
    let best = word, bestD = limit + 1;
    for (const v of this.IDF.keys()) {
      if (Math.abs(v.length - word.length) > limit) continue;
      const d = this.dist(word, v);
      if (d < bestD) { bestD = d; best = v; if (d === 1) break; }
    }
    return bestD <= limit ? best : word;
  }

  private localAnswer(question: string, pageKeys?: string[]) {
    const terms = this.tokens(question);
    // Unknown words are usually typos ("desconnect"), and a typo used to delete
    // the most important word in the question. Map each one to the closest
    // word the knowledge base actually knows.
    const resolved = terms.map((t) => this.correct(t));
    const maxIdf = Math.max(1, ...resolved.map((t) => this.IDF.get(t) || 0));

    const scored = this.ALL.map((e) => {
      const title = e.t.toLowerCase();
      const titleWords = new Set(this.tokens(e.t));
      const words = new Set(this.tokens(`${e.t} ${e.k}`));
      let score = 0;
      for (const term of resolved) {
        const weight = this.IDF.get(term) || maxIdf;   // unknown word = treat as rare
        if (titleWords.has(term)) score += weight * 2.5;  // the title IS the topic
        else if (words.has(term)) score += weight;
        else if (title.includes(term)) score += weight * 0.4;
      }
      // Hand-written entries are more precise than generated ones; this only
      // matters when scores are otherwise equal.
      if (this.KB.includes(e as any)) score += 0.15;

      /**
       * Page context is a TIE-BREAKER, never the main signal.
       *
       * The first version appended the page's keywords to the question, so a
       * two-word query like "nas add" competed against eleven injected terms —
       * and an entry that merely mentioned lots of page words (NOC/uptime) beat
       * the one actually about adding a router. Here the bonus is capped at +1
       * in total, so it only decides between entries the QUESTION already
       * ranked closely.
       */
      if (pageKeys?.length) {
        const hay = `${e.t} ${e.k}`.toLowerCase();
        if (pageKeys.some((k) => hay.includes(k))) score += maxIdf * 0.35;
      }
      return { score, entry: e };
    }).sort((a, b) => (
      // Exact ties are common ("renew subscriber" tied Activate-or-renew with
      // Renew-on-credit). Break them on title length: the shorter title is the
      // more general topic, which is the safer answer to a general question.
      b.score - a.score || a.entry.t.length - b.entry.t.length
    ));

    // Scores are now weighted, not counted, so the cut-off has to scale with
    // them: "did we match at least one word that actually mattered?"
    const floor = maxIdf * 0.8;
    const best = scored[0];
    if (!best || best.score < floor) {
      const topics = ['Add a subscriber', 'Activate or renew', 'Refund a customer', 'Customer is offline', 'Disconnect a live user', 'Reseller pricing', 'Reports', 'Vouchers'].map((t) => `• ${t}`).join('\n');
      return [
        "I didn't understand that one — but I probably know the answer, so try again in plain words.",
        '',
        'You can ask me things like:',
        '• "how do I add a customer"',
        '• "what does this button do"',
        '• "what happens if I press delete"',
        '• "why is my customer offline"',
        '',
        'Common topics:',
        topics,
      ].join('\n');
    }
    // Broad question → offer the closest related topics too.
    const related = scored.slice(1, 4).filter((s) => s.score >= best.score * 0.6).map((s) => s.entry.t);
    const relatedLine = related.length ? `\n\nRelated: ${related.join(' · ')}` : '';
    return this.explain(best.entry.a) + relatedLine;
  }

  /**
   * Re-present a knowledge answer so a first-day user cannot misread it.
   *
   * Almost every entry is written as "Where → To → Go. Then do this." — the
   * location and the instructions run together in one block, which is exactly
   * the shape people skim past and then click the wrong thing. Splitting the
   * menu path onto its own labelled line, and numbered steps onto their own
   * lines, changes nothing about the content and a great deal about whether it
   * gets followed correctly.
   */
  private explain(answer: string): string {
    const text = (answer || '').trim();
    // A leading "A → B → C." (optionally "A → B → C → Button.") is the path.
    const m = /^([^.]{3,80}?→[^.]{1,80}?)\.\s+([\s\S]+)$/.exec(text);
    if (!m) return text;
    const [, where, rest] = m;

    // "1) do this. 2) do that." → one numbered step per line, so nobody merges
    // two steps into one click.
    const body = rest.replace(/\s(?=\d\)\s)/g, '\n');
    return `📍 Go to: ${where.trim()}\n\n${body.trim()}`;
  }

  /**
   * Knowledge generated from the codebase by tools/build_ai_knowledge.py —
   * every screen (with its menu path) and every backend capability.
   *
   * Loaded from disk rather than imported so a missing/!built file can never
   * stop the backend booting: no file simply means the assistant falls back to
   * the hand-written entries above.
   */
  private readonly GEN: {
    entries: Array<{ t: string; k: string; a: string }>;
    tabs: Record<string, Array<{ id: string; label: string; hint: string; route?: string }>>;
    buttons: Record<string, Array<{ label: string; does: string; careful: string; risk: string }>>;
  } = (() => {
    const candidates = [
      path.join(__dirname, 'knowledge.generated.json'),               // dist
      path.join(process.cwd(), 'src/ai/knowledge.generated.json'),    // src
      path.join(__dirname, '../../src/ai/knowledge.generated.json'),  // dist -> src
    ];
    for (const p of candidates) {
      try {
        if (!fs.existsSync(p)) continue;
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(data?.entries)) {
          return { entries: data.entries, tabs: data.tabs || {}, buttons: data.buttons || {} };
        }
      } catch { /* try the next path */ }
    }
    return { entries: [], tabs: {}, buttons: {} };
  })();

  private get GENERATED() { return this.GEN.entries; }

  /** Hand-written entries first (they are more precise), then generated ones. */
  private get ALL() {
    return [...this.KB, ...this.GENERATED];
  }

  /**
   * Split a route into the screen and the tab inside it.
   *
   * Hub screens (Network, Billing, Administration, My Work…) put eight or more
   * different tools behind ONE route and switch with `?tab=`. Before this, the
   * assistant saw only `/network-center` — so standing on the Outages tab it
   * would happily explain IP pools. The tab is the more specific answer, so it
   * wins whenever we know it.
   */
  private splitRoute(route?: string) {
    const raw = route || '';
    const [pathPart, queryPart] = raw.split('?');
    const clean = pathPart.replace(/^\/+/, '').replace(/\/+$/, '');
    const top = clean.split('/')[0] || 'dashboard';
    const tabId = /(?:^|&)tab=([^&]+)/.exec(queryPart || '')?.[1] || '';
    const tab = (this.GEN.tabs[clean] || this.GEN.tabs[top] || [])
      .find((t) => t.id === decodeURIComponent(tabId));
    return { clean, top, tab };
  }

  /**
   * "What does this button do?" — answered from the REAL labels on the screen.
   *
   * The scan reads labels straight out of the JSX, so the assistant can never
   * describe a button that is not there; the consequence text is hand-written
   * per action, because no scan can know that Suspend cuts someone's internet.
   */
  private buttonsFor(clean: string, top: string, tabRoute?: string) {
    // A hub tab renders another screen's component, so its buttons belong to
    // THAT screen. Looking only at the hub route listed almost nothing.
    if (tabRoute && this.GEN.buttons[tabRoute]) return this.GEN.buttons[tabRoute];
    return this.GEN.buttons[clean] || this.GEN.buttons[top] || [];
  }

  /**
   * PAGE-AWARE HELP.
   *
   * Someone standing on the NAS screen almost never wants generic guidance —
   * they want "what is this screen for, and what do I do here". So each route
   * declares what it is and which words identify its topics; we then pull the
   * matching entries out of the knowledge base rather than writing the help
   * twice. Unknown routes fall back to global help instead of an empty panel.
   */
  private readonly PAGES: Record<string, { title: string; intro: string; keys: string[]; ask: string[] }> = {
    nas: {
      title: 'NAS / Routers',
      intro: 'Every router that authenticates your customers. Add each one here with the RADIUS secret that matches the device, then monitor its traffic, VLANs and link health.',
      keys: ['nas', 'router', 'mikrotik', 'radius', 'secret', 'traffic', 'vlan', 'signal', 'port', 'coa', 'monitor'],
      ask: ['How do I add a router?', 'Why does my NAS say RADIUS timeout?', 'How do I see traffic graphs?', 'How do I monitor only some ports?'],
    },
    subscribers: {
      title: 'Subscribers',
      intro: 'Your customer list. Add, activate, renew, suspend and group customers — and open any one of them for their full profile, sessions and billing.',
      keys: ['subscriber', 'customer', 'activate', 'renew', 'suspend', 'import', 'export', 'group', 'boost', 'grace'],
      ask: ['How do I add a subscriber?', 'How do I activate someone?', 'How do I give a temporary speed boost?', 'How do I group customers by NAS?'],
    },
    'admin-center': {
      title: 'Administration',
      intro: 'Accounts and configuration: your organisation, the reseller/dealer tree, staff users, roles and permissions, and system settings.',
      keys: ['user', 'role', 'permission', 'organization', 'hierarchy', 'reseller', 'dealer', 'franchise', 'staff', 'security', 'settings'],
      ask: ['How do I create a dealer?', 'How do permissions work?', 'How do I add staff?', 'What can each role do?'],
    },
    'billing-center': {
      title: 'Billing & Accounting',
      intro: 'Everything about money: the ledger, invoices, payments received, collections, vouchers, reseller pricing and reversals.',
      keys: ['invoice', 'payment', 'billing', 'accounting', 'ledger', 'wallet', 'collection', 'voucher', 'pricing', 'refund', 'reversal', 'commission'],
      ask: ['How do I record a payment?', 'How do I refund a customer?', 'Where do I see what I collected?', 'How does reseller pricing work?'],
    },
    'network-center': {
      title: 'Network',
      intro: 'The whole network in one place: live sessions, routers, fiber, IP pools, static IPs, outages and the operations view.',
      keys: ['network', 'nas', 'online', 'session', 'pool', 'static', 'fiber', 'olt', 'outage', 'operations', 'noc', 'uptime'],
      ask: ['Who is online right now?', 'How do I handle an outage?', 'What is an IP pool for?', 'How do I check uptime?'],
    },
    'my-work': {
      title: 'My Work',
      intro: 'Your daily loop as a franchise or dealer: see your business, connect a new customer, and renew the ones falling due.',
      keys: ['my business', 'quick connect', 'renewal', 'wallet', 'commission', 'collect', 'expiring'],
      ask: ['How do I add and activate a customer fast?', 'Who is due for renewal?', 'Where do I see my commission?'],
    },
    compliance: {
      title: 'KYC & Data Usage',
      intro: 'Identity verification for customers and accounts, plus fair-usage/data-cap enforcement.',
      keys: ['kyc', 'cnic', 'verify', 'identity', 'fup', 'quota', 'data', 'compliance'],
      ask: ['How do I verify a CNIC?', 'What happens if I skip KYC?', 'How does the data cap work?'],
    },
    packages: {
      title: 'Packages',
      intro: 'The plans you sell: speed, price, duration, data allowance and the IP pool each one uses.',
      keys: ['package', 'plan', 'speed', 'price', 'duration', 'quota', 'fup', 'pool'],
      ask: ['How do I create a package?', 'How do I set a data cap?', 'How do I change a price?'],
    },
    communication: {
      title: 'Communication',
      intro: 'Messages to customers (SMS templates and sends) and operational alerts to Discord/WhatsApp.',
      keys: ['sms', 'message', 'template', 'notification', 'alert', 'discord', 'whatsapp'],
      ask: ['How do I set up Discord alerts?', 'How do I message all customers on a NAS?', 'How do SMS templates work?'],
    },
    outages: {
      title: 'Outages & Power',
      intro: 'Detected mass disconnections and load-shedding windows, with one-click notification of the affected area.',
      keys: ['outage', 'power', 'load shedding', 'mass', 'disconnect', 'notify', 'area'],
      ask: ['How do I notify an affected area?', 'How are outages detected?'],
    },
  };

  /** Guidance for the screen the user is currently on. */
  pageHelp(route?: string) {
    const { clean, top, tab } = this.splitRoute(route);
    const page = this.PAGES[clean] || this.PAGES[top];
    const buttons = this.buttonsFor(clean, top, tab?.route);

    // Title/intro come from the TAB when we know it, because the tab is what
    // the user is actually looking at.
    const title = tab ? `${page?.title || top} → ${tab.label}` : page?.title;
    const intro = tab?.hint || page?.intro;

    if (!page && !tab) {
      return {
        scoped: buttons.length > 0,
        title: 'This screen',
        intro: buttons.length
          ? 'I don\'t have a written guide for this screen yet, but here is what every button on it does.'
          : 'I don\'t have a dedicated guide for this screen yet — ask me anything and I\'ll search the whole guide.',
        topics: [],
        buttons,
        questions: ['What can I do on this screen?', 'What does each button do here?'],
      };
    }

    // Rank knowledge by this screen's keywords, and by the tab's own words when
    // there is a tab — otherwise every tab of a hub gets the same eight topics.
    const keys = [
      ...(page?.keys || []),
      ...(tab ? (tab.label.toLowerCase().match(/[a-z0-9]+/g) || []) : []),
    ];
    const tabWords = tab ? new Set(tab.label.toLowerCase().match(/[a-z0-9]+/g) || []) : null;
    const scored = this.ALL.map((e) => {
      const hay = `${e.t} ${e.k}`.toLowerCase();
      let score = keys.reduce((n, k) => (hay.includes(k) ? n + 1 : n), 0);
      if (tabWords) for (const w of tabWords) if (hay.includes(w)) score += 3;
      return { e, score };
    }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);

    return {
      scoped: true,
      title,
      intro,
      topics: scored.map((s) => ({ title: s.e.t, answer: s.e.a })),
      // Every control on the screen, in plain words, with the risky ones
      // flagged — so nobody has to press one to find out what it does.
      buttons,
      questions: tab
        ? [`What is the ${tab.label} tab for?`, `What does each button do here?`, ...(page?.ask || []).slice(0, 2)]
        : ['What does each button do here?', ...(page?.ask || [])],
    };
  }

  /**
   * The knowledge base as data, for the in-app Documentation page.
   * Entries are grouped by the section headings used in the KB array, so the
   * docs page and the assistant always describe the same product.
   */
  knowledgeBase() {
    return {
      count: this.ALL.length,
      topics: this.ALL.map((e) => ({ title: e.t, keywords: e.k, answer: e.a })),
    };
  }

  private knowledgePrompt(role?: string) {
    const kb = this.ALL.map((e) => `- ${e.t}: ${e.a}`).join('\n');
    return [
      'You are the built-in help AI for the Jointbox ISP management panel. Answer ONLY about using Jointbox, concisely, and always point the user to the exact menu path. Never invent data values (you have no live DB access) — for "how many/how much" tell them which screen shows it.',
      role ? `The user's role is ${role}.` : '',
      'Use this knowledge base:',
      kb,
    ].filter(Boolean).join('\n');
  }

  async chat(messages: Array<{ role: string; content: string }>, user?: { role?: string }, route?: string) {
    const history = (messages || []).filter((m) => m.role === 'user' || m.role === 'assistant');
    const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content || '';

    // Local, zero-RAM mode (default): knowledge-base search. When the caller
    // tells us which screen they are on, append that page's keywords to the
    // query so "how do I add one?" resolves against THIS screen's topics.
    if (!this.llmEnabled) {
      const { clean, top, tab } = this.splitRoute(route);
      const page = route ? (this.PAGES[clean] || this.PAGES[top]) : null;
      // A question asked while standing on a screen is usually ABOUT something
      // on that screen — check its real buttons before searching the whole KB.
      const direct = route ? this.answerAboutButton(lastUser, clean, top, tab?.route) : '';
      if (direct) return { ok: true, mode: 'local', reply: direct };
      const keys = [
        ...(page?.keys || []),
        ...(tab ? (tab.label.toLowerCase().match(/[a-z0-9]+/g) || []) : []),
      ];
      return { ok: true, mode: 'local', reply: this.localAnswer(lastUser, keys.length ? keys : undefined) };
    }

    // Optional LLM mode (only if configured).
    const payload = {
      model: this.model, temperature: 0.3, max_tokens: 600,
      messages: [{ role: 'system', content: this.knowledgePrompt(user?.role) }, ...history.slice(-10)],
    };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 120_000);
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey || 'ollama'}` },
        body: JSON.stringify(payload), signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
      const data: any = await res.json();
      if (!res.ok) return { ok: true, mode: 'local', reply: this.localAnswer(lastUser) };
      const reply = data?.choices?.[0]?.message?.content?.trim();
      return { ok: true, mode: 'llm', reply: reply || this.localAnswer(lastUser) };
    } catch (e: any) {
      this.logger.warn(`LLM unavailable, using local answer: ${e.message}`);
      return { ok: true, mode: 'local', reply: this.localAnswer(lastUser) };
    }
  }
}
