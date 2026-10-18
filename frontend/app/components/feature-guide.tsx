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
  return GUIDES[parts[0]] ?? null;
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

  if (closed) {
    return (
      <button type="button" onClick={open} className="jb-guide-pill" aria-label="Show how to use this screen">
        <span aria-hidden>❔</span> How to use {guide.title}
      </button>
    );
  }

  return (
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
      {guide.next && (
        <p className="jb-guide-next">
          <span aria-hidden>➜</span> <span><strong>Where next:</strong> {guide.next}</span>
        </p>
      )}
    </section>
  );
}
