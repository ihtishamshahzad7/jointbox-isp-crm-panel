'use client';

/**
 * Feature guide — a green "How to use" note shown at the top of every feature
 * screen. One component, one data map, injected once from the app shell, so
 * each page explains itself: what it is, the steps to use it, and where the
 * result is used next (how IP pools feed NAS, how packages tie them together,
 * and so on).
 *
 * It is collapsible and remembers per-screen whether the operator closed it,
 * so it helps a newcomer without nagging a daily user.
 */

import React from 'react';

type Guide = {
  title: string;
  lead: string;
  steps: string[];
  next?: string;
  // For screens with tabs: what each tab is for. Shown as a labelled list so
  // the operator knows where to add or configure each thing, tab by tab.
  tabs?: { name: string; note: string }[];
};

// Keyed by the first path segment, with a few exact two-segment overrides.
// Written in the operator's words, in the order they actually set things up.
const GUIDES: Record<string, Guide> = {
  dashboard: {
    title: 'Dashboard',
    lead: 'Your daily snapshot: subscribers online, revenue, expiring accounts and alerts.',
    steps: [
      'Read the top tiles for today’s numbers at a glance.',
      'Click any tile or chart to open the full screen behind it.',
      'Check the alerts panel for anything that needs action now.',
    ],
    next: 'New here? Set up in this order: IP Pools → Routers (NAS) → Packages → Subscribers.',
  },
  'ip-pools': {
    title: 'IP Pools',
    lead: 'An IP pool is the range of addresses your router hands out to subscribers when they connect.',
    steps: [
      'Click “Add pool” and give it a clear name (e.g. “Main-PPPoE”).',
      'Enter the network range or first–last address your router owns.',
      'Pick the type (PPPoE / Hotspot / Static) to match how customers connect.',
      'Save. The pool is now available to attach elsewhere.',
    ],
    next: 'Next, open Routers (NAS) and point a router at this pool, then choose this pool on a Package so subscribers on that package draw from it.',
  },
  nas: {
    title: 'Routers (NAS)',
    lead: 'A NAS is a router/BRAS that authenticates your subscribers against the panel over RADIUS.',
    steps: [
      'Click “Add router” and enter its name, IP address and RADIUS secret (the same secret set on the router itself).',
      'Choose the IP Pool this router assigns addresses from.',
      'Save, then send a test request from the router to confirm it authenticates.',
    ],
    next: 'Once a router is online, it is selectable on Packages and Subscribers. Live sessions and bandwidth control for this router appear under Monitoring and Network.',
  },
  packages: {
    title: 'Packages (Plans)',
    lead: 'A package is a speed/quota/price plan you sell. It ties together everything else.',
    steps: [
      'Click “Add package”, set name, price, speed and any data quota.',
      'Attach an IP Pool (where the address comes from) and the Policies/Allocations that apply.',
      'Add any Taxes/Fees that should appear on the invoice.',
      'Save. The package is now sellable.',
    ],
    next: 'Assign this package to a customer on the Subscribers screen. Invoices and renewals then use its price automatically.',
  },
  subscribers: {
    title: 'Subscribers',
    lead: 'Your customers — each one is linked to a package, a router and a login.',
    steps: [
      'Click “Add subscriber”, enter their details and PPPoE/Hotspot username.',
      'Choose the Package (this sets speed, price and IP pool).',
      'Save — the account is pushed to RADIUS and can connect immediately.',
      'Use the row actions to recharge, change package, or disable.',
    ],
    next: 'Billing happens under Invoices and Payments. Watch who is online under Monitoring.',
  },
  invoices: {
    title: 'Invoices',
    lead: 'Bills raised for subscribers, from their package price plus any taxes/fees.',
    steps: [
      'Invoices are generated automatically from packages and renewals.',
      'Open any invoice to view, print, or mark it paid.',
      'Use filters to find unpaid or overdue invoices.',
    ],
    next: 'Record money received under Payments; it clears the matching invoice.',
  },
  payments: {
    title: 'Payments',
    lead: 'Money received from subscribers, clearing their invoices.',
    steps: [
      'Click “Record payment”, pick the subscriber and amount.',
      'Choose the method (cash, bank, gateway).',
      'Save — the oldest unpaid invoice is settled first.',
    ],
    next: 'Online methods are configured under Gateways. Totals roll up into Accounting and Reports.',
  },
  vouchers: {
    title: 'Vouchers',
    lead: 'Prepaid top-up codes customers redeem to recharge their account.',
    steps: [
      'Click “Generate”, choose the package/value and how many codes.',
      'Print or export the batch to hand out or sell.',
      'Redeemed codes show who used them and when.',
    ],
    next: 'Vouchers recharge Subscribers; the income appears under Payments and Reports.',
  },
  areas: {
    title: 'Areas / Zones',
    lead: 'Geographic or logical zones you group subscribers and routers into.',
    steps: [
      'Click “Add area” and name it (e.g. a town, tower or building).',
      'Assign routers and subscribers to the area.',
    ],
    next: 'Areas let you filter Monitoring, Reports and Outages by location.',
  },
  'franchise-groups': {
    title: 'Franchises / Dealers',
    lead: 'Sub-accounts that resell your service and manage their own subscribers under you.',
    steps: [
      'Click “Add”, create the franchise/dealer login and set its limits.',
      'Set its wallet or commission terms.',
    ],
    next: 'The dealer signs in to manage their own Subscribers; their numbers roll up to your Earnings and Hierarchy.',
  },
  inventory: {
    title: 'Inventory',
    lead: 'Stock you hold — routers, ONUs, cables and other equipment.',
    steps: [
      'Click “Add item”, set name, quantity and cost.',
      'Record issues/returns as stock moves out to the field.',
    ],
    next: 'Assign equipment to Subscribers or Field Jobs as it is installed.',
  },
  companies: {
    title: 'Companies',
    lead: 'The ISP companies hosted on this installation (super-admin view).',
    steps: [
      'Click “Add company”, enter its name and contact details.',
      'Assign it a Plan (from Plans & Pricing) to set its limits.',
      'The company admin then signs in and manages its own subscribers, routers and packages.',
    ],
    next: 'Set tiers and prices under Plans & Pricing; the licence for each server is managed on your licence site.',
  },
  'platform-plans': {
    title: 'Plans & Pricing',
    lead: 'The tiers you offer companies — price plus subscriber/router/account limits.',
    steps: [
      'Edit a tier’s price and limits, or add a new one.',
      'Open a Company and assign it a plan to apply those limits.',
      'Use “Apply to its companies” after changing a plan’s limits.',
    ],
    next: 'Assigned limits are enforced when a company adds subscribers, routers or sub-accounts.',
  },
  licence: {
    title: 'Licence',
    lead: 'This server’s licence status and activation.',
    steps: [
      'Check the state badge (Active, Renewing, etc.).',
      'To activate or re-bind, paste your licence key and click Activate.',
      'Use “Re-check now” after any change on the licence server.',
    ],
    next: 'Subscribers stay online in every state — RADIUS is never affected. A lapsed licence only makes the panel read-only.',
  },
  communication: {
    title: 'Communication',
    lead: 'Message templates and channels (SMS/WhatsApp/email) for notices to subscribers.',
    steps: [
      'Edit the templates for invoices, reminders and expiry.',
      'Connect a channel/gateway and send a test.',
    ],
    next: 'Templates are used automatically by billing and renewals, and manually from a subscriber’s row.',
    tabs: [
      { name: 'Templates', note: 'Edit the wording of automatic messages (invoice, reminder, expiry).' },
      { name: 'Send', note: 'Message one customer or a group right now.' },
      { name: 'Log', note: 'See what was sent, when, and whether it delivered.' },
      { name: 'Alerts', note: 'Set up the rules that trigger automatic messages.' },
    ],
  },
  pricing: {
    title: 'Pricing & Fees',
    lead: 'Shared fees, discounts and charges that apply across packages.',
    steps: [
      'Add a fee or discount and set how it is applied.',
      'Reference it from a Package.',
    ],
    next: 'These appear on Invoices generated from packages that use them.',
  },
  'service-catalog': {
    title: 'Plans & Stock',
    lead: 'The catalogue tying packages, areas and inventory together.',
    steps: [
      'Review packages, areas and stock in one place.',
      'Jump to any item to edit it.',
    ],
    next: 'Used when onboarding Subscribers and planning Field Jobs.',
  },
  monitoring: {
    title: 'Monitoring',
    lead: 'Who is online now, with live traffic and session detail per router.',
    steps: [
      'Pick a router or area to filter.',
      'Open a session to see live speed, uptime and IP.',
      'Use the disconnect/CoA actions to manage a session.',
    ],
    next: 'Depends on Routers (NAS) being set up and subscribers connected.',
  },
  outages: {
    title: 'Outages',
    lead: 'Track service interruptions and keep affected customers informed.',
    steps: [
      'Click “Add outage”, set the area and time window.',
      'Mark it resolved when service is restored.',
    ],
    next: 'Affected subscribers are drawn from Areas; notices use Communication.',
  },
  complaints: {
    title: 'Complaints / Tickets',
    lead: 'Customer issues tracked from open to resolved.',
    steps: [
      'Create a ticket against a subscriber.',
      'Assign it, add notes, and close when fixed.',
    ],
    next: 'Link a Field Job when a site visit is needed.',
  },
  'field-jobs': {
    title: 'Field Jobs',
    lead: 'Installation and repair visits for your field staff.',
    steps: [
      'Create a job, set the subscriber/address and assign a technician.',
      'The technician updates status from the field.',
    ],
    next: 'Equipment used comes from Inventory; closes back to the Complaint/ticket.',
  },
  reports: {
    title: 'Reports',
    lead: 'Revenue, growth and operational reports.',
    steps: [
      'Pick a report and date range.',
      'Export to CSV/Excel to share.',
    ],
    next: 'Numbers come from Payments, Invoices and Subscribers.',
  },
  accounting: {
    title: 'Accounting',
    lead: 'The ledger: income, expenses and balances.',
    steps: [
      'Review the ledger entries and balances.',
      'Add expenses so profit is accurate.',
    ],
    next: 'Income flows in from Payments; summaries appear in Reports.',
    tabs: [
      { name: 'Ledger', note: 'Every income and expense entry.' },
      { name: 'Cashflow', note: 'Money in vs out over time.' },
      { name: 'Collections', note: 'What is still to be collected.' },
      { name: 'Expenses', note: 'Record and review your costs.' },
      { name: 'Balances', note: 'Current balances and wallets.' },
      { name: 'Automation', note: 'Rules that post entries automatically.' },
    ],
  },
  hotspot: {
    title: 'Hotspot',
    lead: 'Captive-portal WiFi with vouchers or login.',
    steps: [
      'Configure the portal and the hotspot IP Pool.',
      'Issue Vouchers for customers to log in.',
    ],
    next: 'Needs a hotspot-type IP Pool and a Router configured for hotspot.',
  },
  fiber: {
    title: 'Fiber / OLT',
    lead: 'Manage OLTs and ONUs for your fiber network.',
    steps: [
      'Add your OLT and discover ONUs.',
      'Link an ONU to a subscriber.',
    ],
    next: 'Linked subscribers appear under Subscribers and Monitoring.',
  },
  'static-ips': {
    title: 'Static IPs',
    lead: 'Fixed public addresses assigned to specific subscribers.',
    steps: [
      'Define the static range (see also Prefixes).',
      'Assign an address to a subscriber.',
    ],
    next: 'Any static-IP charge is billed through Invoices.',
  },
  prefixes: {
    title: 'IP Prefixes',
    lead: 'The public IP blocks (subnets) your network owns.',
    steps: [
      'Add a prefix (e.g. a /24 you were allocated).',
      'Carve Static IPs and Pools from it.',
    ],
    next: 'Feeds IP Pools and Static IPs.',
  },
  users: {
    title: 'Staff / Users',
    lead: 'Panel logins for your team, with roles and permissions.',
    steps: [
      'Click “Add user”, set name, login and role.',
      'Tune individual permissions if needed.',
    ],
    next: 'Roles decide what each person sees; audited under Logs.',
  },
  security: {
    title: 'Security',
    lead: 'Permissions, sessions and security settings.',
    steps: [
      'Review roles and permission assignments.',
      'Check active sessions and security events.',
    ],
    next: 'Applies to everyone in Staff / Users.',
    tabs: [
      { name: 'Permissions', note: 'What each role can see and do.' },
      { name: 'Child Permissions', note: 'Limits for dealer/sub-accounts beneath you.' },
      { name: 'Two-Factor Auth', note: 'Turn on 2FA for extra login security.' },
      { name: 'Active Sessions', note: 'Who is signed in now; sign a device out.' },
      { name: 'API Keys', note: 'Create keys for external integrations.' },
    ],
  },
  settings: {
    title: 'Settings',
    lead: 'Company-wide configuration for the panel.',
    steps: [
      'Set your company name, branding and defaults.',
      'Save — changes apply across the panel.',
    ],
    next: 'Billing, Communication and Gateways have their own screens.',
  },
  organization: {
    title: 'Organization',
    lead: 'Company profile, currency and multi-company settings.',
    steps: [
      'Set currency and company details.',
      'Review ISPs under this installation.',
    ],
    next: 'Ties into Companies and Plans & Pricing.',
    tabs: [
      { name: 'ISPs', note: 'The ISP companies on this installation; add or open one.' },
      { name: 'Branches', note: 'Branch offices under a company.' },
      { name: 'Resellers', note: 'Reseller accounts and their terms.' },
    ],
  },
  network: {
    title: 'Network',
    lead: 'Live network control — sessions, bandwidth and disconnects.',
    steps: [
      'Find a session by subscriber or IP.',
      'Apply a bandwidth change or disconnect.',
    ],
    next: 'Works with Routers (NAS) and Monitoring.',
  },
  'radius-admin': {
    title: 'RADIUS Admin',
    lead: 'Low-level RADIUS controls for the platform.',
    steps: [
      'Review RADIUS status and tables.',
      'Use the tools only when instructed by support.',
    ],
    next: 'Underlies all Subscriber authentication.',
  },
  renewals: {
    title: 'Renewals',
    lead: 'Accounts due for renewal and auto-renewal status.',
    steps: [
      'Review who is due and when.',
      'Renew manually or let auto-renewal run.',
    ],
    next: 'Creates Invoices; reminders use Communication.',
  },
  gateways: {
    title: 'Payment Gateways',
    lead: 'Online payment providers that let customers pay you directly.',
    steps: [
      'Add a gateway and enter its API keys.',
      'Send a test payment.',
    ],
    next: 'Successful payments post automatically under Payments.',
  },
  logs: {
    title: 'Activity Logs',
    lead: 'An audit trail of who did what in the panel.',
    steps: [
      'Filter by user, action or date.',
      'Open an entry for the full detail.',
    ],
    next: 'Useful for Security reviews.',
  },

  // --- Hubs and the remaining screens, so every area has a note ------------
  'admin-center': {
    title: 'Admin Center',
    lead: 'A hub linking the admin tools — staff, security, settings and system.',
    steps: [
      'Use the cards/tabs to jump to the tool you need.',
      'Each card opens its own full screen.',
    ],
    next: 'Staff logins live in Users; access rules in Security; company options in Settings.',
  },
  'billing-center': {
    title: 'Billing Center',
    lead: 'A hub for everything money — invoices, payments, renewals and reversals.',
    steps: [
      'Use the tabs to switch between invoices, payments and renewals.',
      'Open any item to view or act on it.',
    ],
    next: 'Prices come from Packages; income is summarised in Accounting and Reports.',
  },
  'network-center': {
    title: 'Network Command Center',
    lead: 'A hub for live network control — routers, sessions, bandwidth and outages.',
    steps: [
      'Use the tabs to move between routers, live sessions and traffic.',
      'Act on a session (disconnect / change bandwidth) from here.',
    ],
    next: 'Depends on Routers (NAS) and IP Pools being set up.',
  },
  'support-center': {
    title: 'Support Center',
    lead: 'A hub for customer care — tickets/complaints and field jobs.',
    steps: [
      'Use the tabs to switch between tickets and field jobs.',
      'Open a ticket to assign, note and resolve it.',
    ],
    next: 'Create a Field Job for a site visit; messages use Communication.',
  },
  operations: {
    title: 'Operations',
    lead: 'Day-to-day operational overview and shortcuts.',
    steps: [
      'Scan the panels for what needs attention today.',
      'Click through to the full screen for any item.',
    ],
    next: 'Links into Monitoring, Outages, Field Jobs and Complaints.',
  },
  noc: {
    title: 'Network Operations Center',
    lead: 'A live wall of network health across routers and areas.',
    steps: [
      'Watch the status tiles for anything red.',
      'Click a tile to drill into that router or area.',
    ],
    next: 'Feeds from Routers (NAS), Monitoring and Outages.',
  },
  'quick-connect': {
    title: 'Quick Connect',
    lead: 'Onboard a new subscriber fast, in one short form.',
    steps: [
      'Enter the customer’s name and login.',
      'Pick the Package (this sets speed, price and IP pool).',
      'Save — the account is created and pushed to RADIUS.',
    ],
    next: 'Opens the full Subscriber record for billing and details.',
  },
  hierarchy: {
    title: 'Hierarchy',
    lead: 'The tree of your franchises, dealers and sub-dealers under you.',
    steps: [
      'Expand a branch to see the accounts beneath it.',
      'Click an account to open it.',
    ],
    next: 'Accounts are created in Franchises/Dealers; earnings roll up to Earnings.',
  },
  earnings: {
    title: 'Collections & Earnings',
    lead: 'What you and your dealers have collected and earned.',
    steps: [
      'Pick the period to review.',
      'Drill into a dealer for their detail.',
    ],
    next: 'Figures come from Payments across your Hierarchy.',
  },
  segments: {
    title: 'Customer Segments',
    lead: 'Groups of customers that need attention — expiring, overdue, inactive.',
    steps: [
      'Open a segment to see who is in it.',
      'Act in bulk (message or renew) from the list.',
    ],
    next: 'Messages use Communication; renewals create Invoices.',
  },
  insights: {
    title: 'Insights',
    lead: 'Trends and highlights drawn from your data.',
    steps: [
      'Review the highlighted trends.',
      'Click through for the underlying report.',
    ],
    next: 'Deeper numbers are under Reports and Analytics.',
  },
  analytics: {
    title: 'Analytics',
    lead: 'Charts for growth, revenue and usage over time.',
    steps: [
      'Choose the metric and date range.',
      'Hover a chart for exact values.',
    ],
    next: 'Source data comes from Subscribers, Payments and Monitoring.',
  },
  reversals: {
    title: 'Disputes & Reversals',
    lead: 'Refunds, charge reversals and payment disputes.',
    steps: [
      'Open a dispute to review it.',
      'Approve a reversal or reject it, with a note.',
    ],
    next: 'A reversal adjusts the matching Payment and Invoice.',
  },
  compliance: {
    title: 'Compliance (KYC)',
    lead: 'Customer identity records (CNIC/KYC) for regulatory compliance.',
    steps: [
      'Review which subscribers are missing verified ID.',
      'Open a subscriber to add or confirm their documents.',
    ],
    next: 'Linked to each Subscriber record.',
  },
  status: {
    title: 'Service Status',
    lead: 'A clear up/down view of your services.',
    steps: [
      'Check the status indicators.',
      'Investigate anything not green.',
    ],
    next: 'Record any interruption under Outages.',
  },
  trace: {
    title: 'Global Trace Search',
    lead: 'Find anything fast — a subscriber, IP, invoice or session.',
    steps: [
      'Type a name, username, IP or number.',
      'Open the matching record from the results.',
    ],
    next: 'Jumps you straight to the right screen.',
  },
  console: {
    title: 'Console',
    lead: 'A terminal/diagnostics view for advanced checks.',
    steps: [
      'Use it only for the checks support asks for.',
      'Read the output; it changes nothing on its own.',
    ],
    next: 'For routine work use the normal screens instead.',
  },
  'router-console': {
    title: 'Router Console',
    lead: 'Run read-only commands against one of your routers.',
    steps: [
      'Pick the router.',
      'Run a diagnostic command and read the result.',
    ],
    next: 'Routers are added under Routers (NAS).',
  },
  jobs: {
    title: 'Background Jobs',
    lead: 'Scheduled and queued tasks the panel runs for you.',
    steps: [
      'Check that jobs are running and not failing.',
      'Open a job for its last run and log.',
    ],
    next: 'Covers billing runs, reminders and syncs.',
  },
  'my-work': {
    title: 'My Work',
    lead: 'Your own assigned tasks, tickets and jobs.',
    steps: [
      'Work through the items assigned to you.',
      'Update status as you go.',
    ],
    next: 'Tickets come from Complaints; visits from Field Jobs.',
  },
  'my-business': {
    title: 'My Business',
    lead: 'Your account summary as a dealer/franchise.',
    steps: [
      'Review your wallet, subscribers and earnings.',
      'Top up or act from here.',
    ],
    next: 'Your customers are under Subscribers; income under Earnings.',
  },
  'my-profile': {
    title: 'My Profile',
    lead: 'Your personal account details and preferences.',
    steps: [
      'Update your name and contact details.',
      'Save.',
    ],
    next: 'Change your password under Change Password.',
  },
  'change-password': {
    title: 'Change Password',
    lead: 'Set a new password for your login.',
    steps: [
      'Enter your current password, then the new one twice.',
      'Save — you stay signed in on this device.',
    ],
    next: 'Keep it private; activity is recorded in Logs.',
  },
  assistant: {
    title: 'Assistant',
    lead: 'An in-panel helper for questions and quick actions.',
    steps: [
      'Ask a question in plain words.',
      'Follow the links it gives you.',
    ],
    next: 'It points you to the right feature screen.',
  },
  docs: {
    title: 'Documentation',
    lead: 'Reference guides for the panel.',
    steps: [
      'Browse or search the topics.',
      'Open a topic to read it.',
    ],
    next: 'Each screen also has its own green “How to use” note.',
  },
};

// Shown on any screen without a specific guide, so nothing is ever blank.
const DEFAULT_GUIDE: Guide = {
  title: 'this screen',
  lead: 'This screen is part of your ISP management panel.',
  steps: [
    'Use the buttons at the top to add or create a new item.',
    'Use the tabs and filters to find what you need.',
    'Click any row to open, edit or act on it.',
  ],
  next: 'New here? Set up in this order: IP Pools → Routers (NAS) → Packages → Subscribers.',
};

// Two-segment pages get their own, more specific guide.
const SUB_GUIDES: Record<string, Guide> = {
  'packages/policies': {
    title: 'RADIUS Policies',
    lead: 'Your company’s RADIUS attribute rules — speed limits, session timeouts and the like.',
    steps: [
      'Click “Add policy”, choose the attribute and value.',
      'Give it a clear group name so it is easy to pick later.',
      'Save.',
    ],
    next: 'Attach the policy to a Package; it then applies to every subscriber on that package. Only your company sees and edits its own policies.',
  },
  'packages/allocations': {
    title: 'Allocations (Time Windows)',
    lead: 'Your company’s time windows — e.g. free night hours — that apply a policy on set days and times.',
    steps: [
      'Click “Add allocation”, set the days and start/end time.',
      'Choose the Policy it applies during that window.',
      'Save.',
    ],
    next: 'Attach the allocation to a Package so its subscribers get that time-based rule.',
  },
  'packages/taxes': {
    title: 'Taxes & Fees',
    lead: 'Your company’s tax and fee lines that appear on invoices.',
    steps: [
      'Click “Add”, set name, type (fixed or percent) and value.',
      'Save.',
    ],
    next: 'Attach it to a Package; it is then added to that package’s Invoices.',
  },
};

function guideFor(pathname: string): Guide | null {
  const clean = (pathname || '/').replace(/^\/+|\/+$/g, '');
  if (clean === '' ) return GUIDES.dashboard;
  const parts = clean.split('/');
  const two = parts.slice(0, 2).join('/');
  if (SUB_GUIDES[two]) return SUB_GUIDES[two];
  // Every screen gets a note: a tailored one when we have it, the default
  // otherwise. Login and the public portal are the only screens with no shell,
  // so they never reach this component.
  return GUIDES[parts[0]] ?? DEFAULT_GUIDE;
}

export default function FeatureGuide({ pathname }: { pathname: string }) {
  const guide = guideFor(pathname);
  const storeKey = guide ? `jb-guide-closed:${pathname}` : '';
  const [closed, setClosed] = React.useState(true);

  React.useEffect(() => {
    if (!guide) return;
    let wasClosed = false;
    try {
      wasClosed = localStorage.getItem(storeKey) === '1';
    } catch {
      /* private mode */
    }
    setClosed(wasClosed);
  }, [guide, storeKey]);

  if (!guide) return null;

  const close = () => {
    setClosed(true);
    try {
      localStorage.setItem(storeKey, '1');
    } catch {
      /* ignore */
    }
  };
  const open = () => {
    setClosed(false);
    try {
      localStorage.removeItem(storeKey);
    } catch {
      /* ignore */
    }
  };

  // A fixed, always-visible green "How to use" button sits in the corner of
  // every screen, so the guide can always be opened — even after it has been
  // closed, and no matter where the page has scrolled.
  const floatBtn = (
    <button
      type="button"
      onClick={closed ? open : close}
      className={`jb-guide-fab${closed ? '' : ' jb-guide-fab-open'}`}
      aria-label={closed ? `How to use ${guide.title}` : 'Hide the guide'}
      aria-expanded={!closed}
    >
      <span aria-hidden>❔</span>
      <span className="jb-guide-fab-label">How to use</span>
    </button>
  );

  if (closed) {
    return floatBtn;
  }

  return (
    <>
      <section className="jb-guide" role="note" aria-label={`How to use ${guide.title}`}>
        <div className="jb-guide-head">
          <span className="jb-guide-badge" aria-hidden>❔ How to use</span>
          <strong className="jb-guide-title">{guide.title}</strong>
          <button type="button" onClick={close} className="jb-guide-x" aria-label="Hide this guide">✕</button>
        </div>
        <p className="jb-guide-lead">{guide.lead}</p>
        <ol className="jb-guide-steps">
          {guide.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        {guide.tabs && guide.tabs.length > 0 && (
          <div className="jb-guide-tabs">
            <div className="jb-guide-tabs-head">Tabs on this screen</div>
            <ul>
              {guide.tabs.map((t, i) => (
                <li key={i}>
                  <span className="jb-guide-tab-name">{t.name}</span>
                  <span className="jb-guide-tab-note">{t.note}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {guide.next && (
          <p className="jb-guide-next">
            <span aria-hidden>➜</span> <span><strong>Where next:</strong> {guide.next}</span>
          </p>
        )}
      </section>
      {floatBtn}
    </>
  );
}
