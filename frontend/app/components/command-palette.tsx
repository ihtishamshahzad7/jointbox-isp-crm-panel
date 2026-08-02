"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

/**
 * Global quick-launcher (Ctrl/⌘+K). Type to find and jump to ANY feature or
 * common action — so a new user (admin or reseller) can reach everything without
 * hunting the menu. Role-gated: ISP-owner-only items are hidden for others.
 */
type Dest = { label: string; href: string; group: string; keys: string; ispOnly?: boolean };

const DESTS: Dest[] = [
  // Daily
  { label: "Dashboard", href: "/dashboard", group: "Daily", keys: "home overview stats" },
  { label: "Subscribers", href: "/subscribers", group: "Daily", keys: "customers users clients list" },
  { label: "Add subscriber", href: "/subscribers?add=1", group: "Create", keys: "new create customer onboard signup add" },
  { label: "Trace search", href: "/trace", group: "Daily", keys: "find lookup phone username ip cnic" },
  { label: "Support / complaints", href: "/support-center", group: "Daily", keys: "ticket helpdesk issue complaint" },
  { label: "Field jobs", href: "/field-jobs", group: "Daily", keys: "technician dispatch installation visit" },
  { label: "Communication", href: "/communication", group: "Daily", keys: "sms email notification template message" },
  // Network
  { label: "Live Network", href: "/network-center", group: "Network", keys: "online now sessions disconnect speed coa realtime" },
  { label: "NOC / Uptime", href: "/noc", group: "Network", keys: "uptime sla outage health monitor status noc" },
  { label: "NAS / Routers", href: "/nas", group: "Network", keys: "router mikrotik bng nas radius add device" },
  { label: "IP Pools", href: "/ip-pools", group: "Network", keys: "ip pool address range dynamic" },
  { label: "Static IPs", href: "/static-ips", group: "Network", keys: "static public fixed ip business" },
  { label: "Outages", href: "/outages", group: "Network", keys: "outage power load shedding down" },
  { label: "Fiber (OLT/ONU)", href: "/fiber", group: "Network", keys: "fiber olt onu gpon optical splitter" },
  // Plans & stock
  { label: "Packages", href: "/packages", group: "Plans", keys: "package plan tariff speed price create" },
  { label: "Taxes / fees", href: "/packages/taxes", group: "Plans", keys: "tax vat fee charge" },
  { label: "Policies", href: "/packages/policies", group: "Plans", keys: "policy radius attribute" },
  { label: "Allocations", href: "/packages/allocations", group: "Plans", keys: "allocation assign package" },
  { label: "Areas", href: "/areas", group: "Plans", keys: "area zone coverage location" },
  { label: "Inventory", href: "/inventory", group: "Plans", keys: "inventory stock item device asset ont" },
  // Business
  { label: "Billing", href: "/billing-center", group: "Business", keys: "billing money invoice payment" },
  { label: "Accounting", href: "/accounting", group: "Business", keys: "ledger trial balance close books cashflow collections expense refund approval" },
  { label: "Invoices", href: "/invoices", group: "Business", keys: "invoice bill due" },
  { label: "Payments", href: "/payments", group: "Business", keys: "payment pay collect refund cash" },
  { label: "Vouchers", href: "/vouchers", group: "Business", keys: "voucher prepaid card pin redeem" },
  { label: "Reseller pricing", href: "/pricing", group: "Business", keys: "reseller price margin dealer franchise" },
  { label: "Disputes & Reversals", href: "/reversals", group: "Business", keys: "reversal reverse commission audit trail dispute" },
  { label: "Insights", href: "/insights", group: "Business", keys: "analytics reports revenue growth segments logs" },
  { label: "Reports", href: "/insights?tab=reports", group: "Business", keys: "report revenue aged debt reseller performance export" },
  { label: "KYC & Data Usage", href: "/compliance", group: "Business", keys: "kyc cnic identity verify fup quota data usage" },
  // System
  { label: "Administration", href: "/admin-center", group: "System", keys: "admin organization users security settings" },
  { label: "Users", href: "/users", group: "System", keys: "user staff reseller dealer retailer auditor role add" },
  { label: "Organization / hierarchy", href: "/organization", group: "System", keys: "organization reseller wallet topup hierarchy tree" },
  { label: "Security", href: "/security", group: "System", keys: "security roles permissions 2fa api keys" },
  { label: "Settings", href: "/settings", group: "System", keys: "settings currency sms email gateway configure" },
  { label: "Background Jobs", href: "/jobs", group: "System", keys: "job queue reconcile integrity progress", ispOnly: true },
  { label: "Server Console", href: "/console", group: "System", keys: "console terminal logs server root", ispOnly: true },
  { label: "FreeRADIUS & Database", href: "/radius-admin", group: "System", keys: "freeradius radius config modules sql database settings postgres tuning enable disable", ispOnly: true },
  { label: "Setup checklist", href: "/setup", group: "System", keys: "setup checklist start onboarding" },
  { label: "Ask the assistant (help)", href: "#assistant", group: "System", keys: "help guide how to documentation assistant ask ai support" },
];

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMounted(true), []);

  const isOwner = (() => {
    try {
      const t = typeof window !== "undefined" ? localStorage.getItem("token") : "";
      if (!t) return false;
      return ["SUPER_ADMIN", "ADMIN"].includes(JSON.parse(atob(t.split(".")[1] || ""))?.role);
    } catch { return false; }
  })();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === "Escape") setOpen(false);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("open-command-palette", onOpen); };
  }, []);

  useEffect(() => { if (open) { setQ(""); setSel(0); setTimeout(() => inputRef.current?.focus(), 20); } }, [open]);

  const results = useMemo(() => {
    const pool = DESTS.filter((d) => !d.ispOnly || isOwner);
    const s = q.trim().toLowerCase();
    if (!s) return pool;
    const terms = s.split(/\s+/);
    return pool
      .map((d) => {
        const hay = `${d.label} ${d.group} ${d.keys}`.toLowerCase();
        let score = 0;
        for (const t of terms) { if (d.label.toLowerCase().includes(t)) score += 3; else if (hay.includes(t)) score += 1; }
        return { d, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.d);
  }, [q, isOwner]);

  useEffect(() => { setSel(0); }, [q]);

  const go = (d: Dest) => {
    setOpen(false);
    if (d.href === "#assistant") { window.dispatchEvent(new Event("open-assistant")); return; }
    router.push(d.href);
  };

  if (!open || !mounted) return null;

  return createPortal(
    <div onClick={() => setOpen(false)}
      style={{ position: "fixed", inset: 0, zIndex: 3000, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 560, maxWidth: "92vw", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden", boxShadow: "0 30px 70px rgba(0,0,0,.5)" }}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === "Enter" && results[sel]) go(results[sel]);
          }}
          placeholder="Search features and actions…  (e.g. refund, disconnect, add subscriber, reports)"
          style={{ width: "100%", padding: "16px 18px", background: "transparent", border: "none", borderBottom: "1px solid var(--border)", color: "var(--text)", fontSize: 15, outline: "none" }}
        />
        <div style={{ maxHeight: 380, overflowY: "auto" }}>
          {results.length === 0 && <div style={{ padding: 18, color: "var(--muted)", fontSize: 13 }}>No feature matches “{q}”. Try a different word, or ask the ✦ assistant.</div>}
          {results.map((d, i) => (
            <div key={d.href} onMouseEnter={() => setSel(i)} onClick={() => go(d)}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", cursor: "pointer", background: i === sel ? "var(--surface-2)" : "transparent" }}>
              <span style={{ fontSize: 14, color: "var(--text)" }}>{d.label}</span>
              <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>{d.group}</span>
            </div>
          ))}
        </div>
        <div style={{ padding: "8px 16px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--muted)", display: "flex", gap: 14 }}>
          <span>↑↓ navigate</span><span>⏎ open</span><span>esc close</span><span style={{ marginLeft: "auto" }}>Ctrl/⌘ K anytime</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
