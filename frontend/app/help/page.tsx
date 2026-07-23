"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Help & Guide.
 *
 * Rewritten to match the current application. The previous version documented
 * a sidebar of twenty-nine separate pages that no longer exists — instructions
 * that send someone looking for a menu item they cannot find are worse than no
 * instructions, so every route and screen name here was checked against the
 * app as it stands.
 *
 * Organised by JOB rather than by menu: people arrive here with a task
 * ("a customer is offline", "export 50 Mb users"), not with a page name.
 */

type Section = {
  id: string;
  title: string;
  tag: string;
  intro: string;
  steps?: string[];
  bullets?: string[];
  tip?: string;
  warn?: string;
  link?: { label: string; href: string };
};

const SECTIONS: Section[] = [
  // ── Orientation ─────────────────────────────────────────────
  {
    id: "start", title: "Getting started", tag: "Basics",
    intro:
      "Jointbox has two sites: this admin panel, and the subscriber portal your customers use at /portal. " +
      "On a fresh install, set things up in this order — each step depends on the one before it.",
    steps: [
      "Administration → Organization: create your ISP, then any franchises or dealers below you.",
      "Network → NAS / Routers: add each MikroTik with its IP, RADIUS secret, and API username and password.",
      "Network → IP Pools: create pools whose names match the pools on the router EXACTLY (case-sensitive).",
      "Plans & Stock → Packages: set speed, price, duration, and optionally a data allowance and FUP speed.",
      "Plans & Stock → Areas: your coverage areas.",
      "Subscribers → Add: create your first customer. They can dial in immediately.",
    ],
    tip: "The API username and password on each router are not optional. Without them the panel cannot read router logs, verify pools, or force a disconnect — three of its most useful abilities.",
  },
  {
    id: "layout", title: "Finding your way around", tag: "Basics",
    intro:
      "The sidebar has ten entries, not thirty. Related screens are grouped into hubs with tabs across the top, " +
      "so everything for one job sits on one page.",
    bullets: [
      "Dashboard — the daily overview.",
      "Subscribers — your customer list, and every customer's full profile.",
      "Support — Complaints, Field Jobs and Communication.",
      "Trace Search — find anything by name, username, phone, IP or CNIC.",
      "Network — Live Network, NAS/Routers, IP Pools, Static IPs, Outages & Power.",
      "Plans & Stock — Packages, Areas, Inventory.",
      "Billing — Accounting, Invoices, Payments, Vouchers, Reseller Pricing.",
      "Insights — Segments, Analytics, Reports, Logs.",
      "KYC & Data Usage — CNIC verification and fair-usage enforcement.",
      "Administration — Organization, Network Tree, Users, Security, Settings.",
    ],
    tip: "Your account menu, sign-out and the theme switch are the round avatar in the top-right, not the sidebar. The search box in the header searches everything.",
  },

  // ── The job people actually arrive with ─────────────────────
  {
    id: "offline", title: "A customer says they are offline", tag: "Daily",
    intro:
      "Work down this list. Each step rules out a whole class of cause, and the panel does most of the diagnosis for you.",
    steps: [
      "Open the subscriber. The header shows Online or Offline with the last disconnect reason in plain language.",
      "Open the Router Log tab and press Refresh from router. The panel reads the MikroTik live and states what is wrong — a reconnect loop, a missing pool, rejected authentication — with the fix.",
      "Check the RADIUS tab. It flags two specific faults: conflicting addressing (both a pool and a fixed IP being sent), and no address source at all.",
      "If several customers are affected, look at Insights → Segments. If one VLAN, area or router is mostly down, it is a network fault, not a customer fault.",
      "Still stuck? Press Force Sync on the RADIUS tab. That rewrites their credentials and profile from scratch.",
    ],
    warn: "If the Router Log says the pool does not exist, the fix is on the MikroTik, not in the panel. Pool names are case-sensitive and must already exist on the router.",
    link: { label: "Open Subscribers", href: "/subscribers" },
  },
  {
    id: "renew", title: "Renewing and reactivating", tag: "Money",
    intro:
      "Subscribers → Activation / Renewal. Five modes, because a month is not always the answer.",
    bullets: [
      "Full period — the normal monthly renewal.",
      "Set days — any number of days, priced pro-rata.",
      "Until a date — an exact expiry, for aligning customers to month end regardless of 28, 30 or 31 days.",
      "Use balance — spends their wallet and grants however many days it buys.",
      "On credit — 'I'll pay Friday'. Activates now and records the debt against whoever approved it.",
    ],
    tip: "A live preview shows the days, the price and the resulting expiry date before you take any money. Renewals extend from the existing expiry when it is still in the future, so paying early never costs the customer days.",
    warn: "Credit extensions are capped at two unsettled per subscriber. One is a favour; a stack is an unmanaged debt.",
  },
  {
    id: "export", title: "Exporting a specific group of customers", tag: "Customers",
    intro:
      "Subscribers → Export. Built to answer a question, not to dump the table. Filters combine, so you can be as precise as you need.",
    steps: [
      "Pick the conditions — package, dealer, area, router, status, expiry window, online now, missing CNIC, date range.",
      "Watch the count at the bottom. It updates live and tells you how many match before you download anything.",
      "Press Choose columns, pick the fields you want, and select Excel or CSV.",
    ],
    tip: "Example: to get all 50 Mb customers under one dealer, tick that package and that dealer. Nothing else needed.",
    warn: "Only the ISP owner can include the Password column. Every export is recorded in the audit log with who ran it and what they took.",
    link: { label: "Open Subscribers", href: "/subscribers" },
  },
  {
    id: "staticip", title: "Selling a static public IP", tag: "Network",
    intro:
      "Two ways in: the Static public IP field on the subscriber's Edit form, or Network → Static IPs.",
    steps: [
      "Type the address and a monthly price on the subscriber's Edit form, then save.",
      "The panel writes it to RADIUS, stops the pool being requested, and reconnects the customer so it applies immediately.",
      "The address appears on the Static IPs page with full assignment history, and starts its own monthly billing cycle.",
    ],
    tip: "Leave Authentication Method on PPPoE. A static address works on any auth method — you do not need to change it.",
    warn: "Clearing the field releases the address and stops the billing. Do not reassign an address until you have confirmed the previous customer is actually off it.",
    link: { label: "Open Network", href: "/network-center?tab=static" },
  },

  // ── Understanding the network ───────────────────────────────
  {
    id: "trace", title: "Tracing the transmission path", tag: "Network",
    intro:
      "The panel learns your ONU → splitter → OLT → BRAS path from the circuit-id your OLT stamps into each session, " +
      "then uses it to tell you WHERE a fault is rather than just that one exists.",
    bullets: [
      "Only one customer down on a splitter — the fault is at their end: drop cable, ONU power, or a fibre bend.",
      "Most of a splitter down — the feeder fibre or the splitter. One truck roll fixes everyone.",
      "Most of an OLT down — the OLT or its uplink. A visit to one customer will find nothing.",
      "Most of a router down — the BRAS. Do not dispatch to customers at all.",
    ],
    tip: "This needs PPPoE Intermediate Agent enabled on the OLT so it sends a circuit-id. Without it the panel says so plainly rather than guessing.",
  },
  {
    id: "segments", title: "Reading the analytics", tag: "Network",
    intro:
      "Insights → Analytics leads with a plain sentence: everything normal, or which segments need attention. " +
      "Below that, the same customer base is cut by VLAN, area, dealer, router and package.",
    bullets: [
      "Every segment shows ONLINE against ACTIVE. The gap between them is where faults hide.",
      "A VLAN with 40 active customers and 3 online is broken — a total on its own can never tell you that.",
      "Healthy segments are hidden by default so problems are what you see first.",
      "Small segments are judged gently: two of three offline means nothing, 33% of sixty is an outage.",
    ],
    link: { label: "Open Analytics", href: "/insights?tab=analytics" },
  },
  {
    id: "fup", title: "Data allowances and FUP", tag: "Customers",
    intro:
      "Set a data allowance and a reduced speed on the package. When a customer passes the allowance the panel throttles them rather than cutting them off — they stay connected and billable.",
    steps: [
      "Plans & Stock → Packages: set Data Quota (GB) plus FUP Download and Upload speeds.",
      "Leave the FUP speeds blank and the quota is never enforced — the right default for unlimited plans.",
      "Usage shows live on each subscriber's header, measured over their own billing period so a renewal resets it.",
      "KYC & Data Usage → Data usage lists everyone at 70% or beyond.",
    ],
    tip: "Anyone sitting at 100% is an upgrade conversation, not a problem.",
  },

  // ── Money and compliance ────────────────────────────────────
  {
    id: "money", title: "Billing and the reseller chain", tag: "Money",
    intro:
      "Billing holds the ledger, invoices, payments, vouchers and reseller pricing. Each account has a wallet; " +
      "activating a subscriber settles down the chain automatically.",
    bullets: [
      "A price row is what THAT account pays. Their margin is what their child pays minus what they pay.",
      "A child never sees what its parent pays — upstream pricing is hidden by design.",
      "Reseller Pricing is where you assign a package downstream with its price.",
      "Wallets are controlled by the parent. Children can be given permission to set their own sell prices.",
    ],
    tip: "Reports → Debt by age ranks unpaid invoices by amount rather than age. The oldest debt is usually small; the largest is what hurts cash flow.",
  },
  {
    id: "kyc", title: "CNIC verification", tag: "Admin",
    intro:
      "KYC & Data Usage tracks the identity behind every connection — a PTA licence requirement, and your defence against resale fraud.",
    bullets: [
      "Record the CNIC number alongside the images. Punctuation is ignored when matching, so 35201-1234567-1 and 3520112345671 are correctly seen as the same person.",
      "Verification refuses to approve without a number, both image sides, and a non-expired CNIC.",
      "Shared CNICs are listed but not blocked — families and businesses legitimately share one.",
      "Export the subscriber register as CSV when a regulator asks.",
    ],
    link: { label: "Open KYC", href: "/compliance" },
  },

  // ── Administration ──────────────────────────────────────────
  {
    id: "security", title: "Security and access", tag: "Admin",
    intro:
      "Every account only ever sees its own subtree. This is enforced on the server, not in the interface, so it cannot be bypassed by calling the API directly.",
    bullets: [
      "A dealer sees their own customers, their own static IPs, their own outages and their own share of the topology.",
      "A child account cannot see or edit its own wallet, its own commission, or its own permissions.",
      "Bulk password export is restricted to the ISP owner, and every export is logged.",
      "Administration → Security holds API keys and webhooks. Keys are shown once and stored hashed.",
    ],
    warn: "If a dealer reports seeing data that is not theirs, treat it as a bug and report it — that should not be possible.",
  },
  {
    id: "backups", title: "Backups and health", tag: "Admin",
    intro:
      "The panel takes a nightly database dump at 02:00 and keeps 14 days. Insights → Logs shows backup status and RADIUS diagnostics.",
    bullets: [
      "A backup older than 48 hours is flagged.",
      "RADIUS diagnostics run eight checks — client registration, accounting columns, orphaned sessions and more.",
      "Router logs are pulled from every MikroTik every two minutes and kept for 14 days.",
    ],
    warn: "Watch disk space on the database server. Backups accumulate, and a full disk will stop PostgreSQL — which takes the whole panel and RADIUS down with it.",
  },
];

const TAGS = ["All", "Basics", "Daily", "Customers", "Network", "Money", "Admin"];

export default function HelpPage() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("All");
  const [open, setOpen] = useState<string | null>("start");

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return SECTIONS.filter((s) => {
      const tagOk = tag === "All" || s.tag === tag;
      const text = (
        s.title + s.intro + (s.steps || []).join(" ") +
        (s.bullets || []).join(" ") + (s.tip || "") + (s.warn || "")
      ).toLowerCase();
      return tagOk && (!query || text.includes(query));
    });
  }, [q, tag]);

  return (
    <div className="hp">
      <style>{CSS}</style>

      <header className="hp-head">
        <h1>Help &amp; Guide</h1>
        <p>Organised by what you are trying to do. Search, or pick a category, then open a card for the steps.</p>
      </header>

      <input className="hp-search" placeholder="Search — e.g. offline, renew, export, static IP, quota…"
        value={q} onChange={(e) => setQ(e.target.value)} />

      <div className="hp-tags">
        {TAGS.map((tg) => (
          <button key={tg} className={tag === tg ? "on" : ""} onClick={() => setTag(tg)}>{tg}</button>
        ))}
      </div>

      {filtered.map((s) => {
        const isOpen = open === s.id;
        return (
          <article key={s.id} className={`hp-card ${isOpen ? "open" : ""}`}>
            <button className="hp-top" onClick={() => setOpen(isOpen ? null : s.id)}>
              <span className="tag">{s.tag}</span>
              <span className="title">{s.title}</span>
              <span className="chev">{isOpen ? "−" : "+"}</span>
            </button>

            {isOpen && (
              <div className="hp-body">
                <p className="intro">{s.intro}</p>

                {s.steps && (
                  <ol>{s.steps.map((t, i) => <li key={i}>{t}</li>)}</ol>
                )}
                {s.bullets && (
                  <ul>{s.bullets.map((t, i) => <li key={i}>{t}</li>)}</ul>
                )}
                {s.tip && <div className="note tip"><b>Tip</b>{s.tip}</div>}
                {s.warn && <div className="note warn"><b>Watch out</b>{s.warn}</div>}
                {s.link && (
                  <button className="go" onClick={() => router.push(s.link!.href)}>
                    {s.link.label} →
                  </button>
                )}
              </div>
            )}
          </article>
        );
      })}

      {!filtered.length && (
        <div className="hp-none">Nothing matches “{q}”. Try a shorter word, or clear the category filter.</div>
      )}

      <footer className="hp-foot">
        Something here does not match what you see on screen? That is a documentation bug — tell us, because
        instructions that send you looking for a button that is not there are worse than none.
      </footer>
    </div>
  );
}

const CSS = `
.hp{padding:4px 2px 32px;color:var(--text);max-width:920px}
.hp-head h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-.02em}
.hp-head p{margin:5px 0 18px;font-size:13px;color:var(--muted);line-height:1.6}

.hp-search{width:100%;background:var(--surface-2);border:1px solid var(--border);border-radius:14px;
  padding:12px 16px;color:var(--text);font-size:13.5px;font-family:inherit;outline:none;
  transition:border-color .18s,box-shadow .18s}
.hp-search:focus{border-color:rgba(140,90,255,.55);box-shadow:0 0 0 3px rgba(140,90,255,.13)}
.hp-search::placeholder{color:var(--muted)}

.hp-tags{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0 18px}
.hp-tags button{background:var(--surface-2);border:1px solid var(--border);color:var(--muted);
  border-radius:99px;padding:6px 14px;font-size:11.5px;font-weight:600;cursor:pointer;
  font-family:inherit;transition:all .16s cubic-bezier(.34,1.56,.64,1)}
.hp-tags button:hover{color:var(--text)}
.hp-tags button.on{background:linear-gradient(135deg,#6C3CE1,#E9408B);color:#fff;border-color:transparent;
  box-shadow:0 4px 14px rgba(233,64,139,.28)}

.hp-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;
  margin-bottom:10px;overflow:hidden;transition:border-color .22s,box-shadow .22s}
.hp-card:hover{border-color:rgba(140,90,255,.3)}
.hp-card.open{border-color:rgba(140,90,255,.4);box-shadow:0 12px 34px rgba(0,0,0,.26)}
.hp-top{display:flex;align-items:center;gap:12px;width:100%;padding:15px 18px;
  background:transparent;border:none;cursor:pointer;font-family:inherit;text-align:left;color:var(--text)}
.hp-top .tag{font-size:10px;font-weight:700;padding:3px 9px;border-radius:99px;flex-shrink:0;
  background:rgba(140,90,255,.14);color:#A78BFA;text-transform:uppercase;letter-spacing:.05em}
.hp-top .title{flex:1;font-size:14.5px;font-weight:600}
.hp-top .chev{color:var(--muted);font-size:19px;line-height:1}

.hp-body{padding:0 18px 18px}
.hp-body .intro{margin:0 0 12px;font-size:13px;color:var(--muted);line-height:1.7}
.hp-body ol,.hp-body ul{margin:0 0 12px;padding-left:20px}
.hp-body li{font-size:13px;line-height:1.7;margin-bottom:6px}
.hp-body ol li::marker{color:#A78BFA;font-weight:700}
.hp-body ul li::marker{color:#A78BFA}

.note{border-radius:12px;padding:11px 14px;margin-bottom:10px;font-size:12.5px;line-height:1.65}
.note b{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
.note.tip{background:rgba(0,201,255,.08);border:1px solid rgba(0,201,255,.28)}
.note.tip b{color:#00C9FF}
.note.warn{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3)}
.note.warn b{color:#F59E0B}

.go{background:linear-gradient(135deg,#6C3CE1,#E9408B);color:#fff;border:none;border-radius:12px;
  padding:9px 18px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;
  box-shadow:0 5px 18px rgba(233,64,139,.28);
  transition:transform .18s cubic-bezier(.34,1.56,.64,1),box-shadow .18s}
.go:hover{transform:scale(1.04);box-shadow:0 9px 26px rgba(233,64,139,.42)}

.hp-none{padding:34px;text-align:center;color:var(--muted);font-size:13px;
  background:var(--surface);border:1px dashed var(--border);border-radius:16px}
.hp-foot{margin-top:20px;padding:14px 18px;border-radius:14px;background:var(--surface-2);
  border:1px solid var(--border);font-size:11.5px;color:var(--muted);line-height:1.7}

@media (prefers-reduced-motion: reduce){.hp-card,.hp-tags button,.go{transition:none}}
`;
