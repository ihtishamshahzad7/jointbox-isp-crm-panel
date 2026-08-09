"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { money } from "../components/currency";
import API_BASE from "../components/api";

const API =
  API_BASE;

const T = {
  card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)",
};

/** Each tier gets its own colour so depth is readable at a glance. */
const ROLE: Record<string, { c: string; grad: string; label: string; icon: string }> = {
  SUPER_ADMIN:  { c: "#0ea5e9", grad: "linear-gradient(135deg,#0ea5e9,#2563eb)", label: "ISP", icon: "🏢" },
  ADMIN:        { c: "#0ea5e9", grad: "linear-gradient(135deg,#0ea5e9,#2563eb)", label: "ISP", icon: "🏢" },
  RESELLER:     { c: "#8b5cf6", grad: "linear-gradient(135deg,#8b5cf6,#6d28d9)", label: "Franchise", icon: "🏬" },
  SUB_RESELLER: { c: "#22c55e", grad: "linear-gradient(135deg,#22c55e,#15803d)", label: "Dealer", icon: "🏪" },
  RETAILER:     { c: "#f59e0b", grad: "linear-gradient(135deg,#f59e0b,#b45309)", label: "Retailer", icon: "🛒" },
  SALES:        { c: "#94a3b8", grad: "linear-gradient(135deg,#64748b,#475569)", label: "Staff", icon: "👤" },
};

export default function HierarchyPage() {
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [days, setDays] = useState(30);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [metric, setMetric] = useState<"revenue" | "subscribers" | "wallet">("revenue");
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  // Dense mode strips the padding so a big network fits far more rows per
  // screen — the tree becomes unusable past ~100 accounts at full size.
  const [dense, setDense] = useState(false);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/analytics/hierarchy?days=${days}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status === 401) { router.push("/login"); return; }
      const d = await r.json();
      setData(d);
      // Open the top two levels by default — deeper than that is noise.
      const seed: Record<number, boolean> = {};
      (d.roots || []).forEach((n: any) => {
        seed[n.id] = true;
        (n.children || []).forEach((c: any) => (seed[c.id] = true));
      });
      setOpen(seed);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [days, token]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    load();
  }, [days, token]);

  const card: React.CSSProperties = {
    background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 16,
  };

  const val = (n: any) =>
    metric === "revenue" ? n.total.revenue
      : metric === "subscribers" ? n.total.subscribers
        : n.walletBalance;

  const fmtVal = (v: number) =>
    metric === "subscribers" ? String(v) : money(v);

  // Largest value in the tree — used to scale the contribution bars.
  const maxVal = (() => {
    let m = 0;
    const walk = (ns: any[]) => ns.forEach((n) => { m = Math.max(m, Math.abs(val(n))); walk(n.children || []); });
    walk(data?.roots || []);
    return m || 1;
  })();

  // Search: keep any branch that matches by name, or that has a matching
  // descendant, so a hit deep in the tree still shows its path. Matches are
  // force-opened regardless of the manual open state.
  const query = q.trim().toLowerCase();
  const filterTree = (ns: any[]): any[] =>
    (ns || [])
      .map((n) => {
        const kids = filterTree(n.children || []);
        const hit = n.name?.toLowerCase().includes(query);
        if (hit || kids.length) return { ...n, children: kids, _hit: hit };
        return null;
      })
      .filter(Boolean);

  const visibleRoots = query ? filterTree(data?.roots || []) : (data?.roots || []);

  // Total node count — shown so the operator knows how big the network is,
  // and used to auto-enable dense mode for large trees.
  const nodeCount = (() => {
    let c = 0;
    const walk = (ns: any[]) => (ns || []).forEach((n) => { c++; walk(n.children || []); });
    walk(data?.roots || []);
    return c;
  })();

  /** One account. Recursive — depth is drawn with an indent rail. */
  const Node = ({ n, depth = 0 }: { n: any; depth?: number }) => {
    const r = ROLE[n.role] || ROLE.SALES;
    const hasKids = (n.children || []).length > 0;
    // A search hit forces the branch open so the match is actually visible.
    const isOpen = query ? true : open[n.id];
    const share = Math.abs(val(n)) / maxVal;
    const pad = dense ? "5px 10px" : "10px 12px";
    const gap = dense ? 8 : 10;

    return (
      <div style={{ marginLeft: depth ? (dense ? 16 : 22) : 0, position: "relative" }}>
        {/* Indent rail so deep branches stay readable */}
        {depth > 0 && (
          <div style={{
            position: "absolute", left: -12, top: 0, bottom: 0,
            width: 1, background: T.border,
          }} />
        )}

        <div
          style={{
            display: "flex", alignItems: "center", gap,
            background: n._hit ? "rgba(14,165,233,.08)" : T.card, border: `1px solid ${T.border}`,
            borderLeft: `3px solid ${r.c}`,
            borderRadius: dense ? 8 : 11, padding: pad, marginBottom: dense ? 4 : 7,
            transition: "transform .12s, box-shadow .12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = "translateX(2px)";
            e.currentTarget.style.boxShadow = `0 4px 14px ${r.c}22`;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "";
            e.currentTarget.style.boxShadow = "";
          }}
        >
          {/* Expander */}
          <button
            onClick={() => setOpen({ ...open, [n.id]: !isOpen })}
            style={{
              width: 22, height: 22, borderRadius: 6, flexShrink: 0,
              background: hasKids ? T.row : "transparent",
              border: `1px solid ${hasKids ? T.border : "transparent"}`,
              color: T.muted, cursor: hasKids ? "pointer" : "default",
              fontSize: 11, lineHeight: 1,
            }}
          >
            {hasKids ? (isOpen ? "−" : "+") : ""}
          </button>

          {/* Identity */}
          <div style={{
            width: 32, height: 32, borderRadius: 9, background: r.grad, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15,
          }}>{r.icon}</div>

          <div style={{ minWidth: 0, flex: "1 1 150px" }}>
            <div
              onClick={() => router.push(`/users/${n.id}`)}
              style={{ fontSize: 13, fontWeight: 700, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {n.name}
              {!n.isActive && <span style={{ color: "#ef4444", fontSize: 10, marginLeft: 6 }}>inactive</span>}
            </div>
            <div style={{ fontSize: 10.5, color: T.muted }}>
              {r.label}
              {n.total.accounts > 0 && ` · ${n.total.accounts} account${n.total.accounts === 1 ? "" : "s"} below`}
            </div>
          </div>

          {/* Contribution bar — shows relative size without a chart library */}
          <div style={{ flex: "1 1 90px", minWidth: 60 }}>
            <div style={{ height: 6, background: T.row, borderRadius: 4, overflow: "hidden" }}>
              <div style={{
                width: `${Math.max(2, share * 100)}%`, height: "100%",
                background: r.grad, borderRadius: 4, transition: "width .3s",
              }} />
            </div>
          </div>

          {/* Numbers */}
          <div style={{ display: "flex", gap: 14, flexShrink: 0, textAlign: "right" }}>
            <div style={{ minWidth: 56 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{n.total.subscribers}</div>
              <div style={{ fontSize: 9.5, color: T.muted }}>
                subs{n.direct.subscribers !== n.total.subscribers ? ` (${n.direct.subscribers} own)` : ""}
              </div>
            </div>
            <div style={{ minWidth: 66 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#22c55e" }}>{money(n.total.revenue)}</div>
              <div style={{ fontSize: 9.5, color: T.muted }}>revenue</div>
            </div>
            <div style={{ minWidth: 62 }}>
              <div style={{
                fontSize: 13, fontWeight: 700,
                color: n.walletBalance < 0 ? "#ef4444" : T.text,
              }}>{money(n.walletBalance)}</div>
              <div style={{ fontSize: 9.5, color: T.muted }}>wallet</div>
            </div>
          </div>
        </div>

        {isOpen && (n.children || []).map((c: any) => <Node key={c.id} n={c} depth={depth + 1} />)}
      </div>
    );
  };

  const s = data?.summary;

  return (
    <div style={{ padding: 20, color: T.text }}>
      {/* Network summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 16 }}>
        {[
          ["Accounts", s?.accounts ?? 0, "#0ea5e9", "#2563eb", `${s?.depth ?? 0} levels deep`],
          ["Subscribers", s?.totalSubscribers ?? 0, "#8b5cf6", "#6d28d9", `${s?.activeSubscribers ?? 0} active`],
          ["Revenue", money(s?.totalRevenue ?? 0), "#22c55e", "#15803d", `last ${days} days`],
          ["Wallets", money(s?.totalWallet ?? 0), "#f59e0b", "#b45309",
            s?.negativeWallets ? `${s.negativeWallets} negative` : "all funded"],
        ].map(([label, value, from, to, sub]: any) => (
          <div key={label} style={{
            borderRadius: 14, padding: "14px 16px", color: "#fff",
            background: `linear-gradient(135deg, ${from}, ${to})`,
            boxShadow: "0 6px 18px rgba(0,0,0,.18)",
          }}>
            <div style={{ fontSize: 10.5, opacity: .85, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, marginTop: 3 }}>{value}</div>
            <div style={{ fontSize: 10.5, opacity: .85 }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Role distribution — a simple stacked bar, no library */}
      {s?.byRole && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 10 }}>Network composition</div>
          <div style={{ display: "flex", height: 26, borderRadius: 8, overflow: "hidden", marginBottom: 10 }}>
            {Object.entries(s.byRole).map(([role, count]: any) => {
              const r = ROLE[role] || ROLE.SALES;
              const width = (count / s.accounts) * 100;
              return (
                <div key={role} title={`${r.label}: ${count}`}
                  style={{ width: `${width}%`, background: r.grad, minWidth: 2 }} />
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11.5 }}>
            {Object.entries(s.byRole).map(([role, count]: any) => {
              const r = ROLE[role] || ROLE.SALES;
              return (
                <span key={role} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: r.c }} />
                  <span style={{ color: T.muted }}>{r.label}</span>
                  <strong>{count}</strong>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Controls */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        <span style={{ fontSize: 11.5, color: T.muted }}>Bar shows:</span>
        {([["revenue", "Revenue"], ["subscribers", "Subscribers"], ["wallet", "Wallet"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setMetric(k as any)} style={{
            background: metric === k ? "#0ea5e9" : "transparent",
            color: metric === k ? "#fff" : T.muted,
            border: `1px solid ${metric === k ? "#0ea5e9" : T.border}`,
            borderRadius: 8, padding: "5px 13px", fontSize: 11.5, fontWeight: 600, cursor: "pointer",
          }}>{l}</button>
        ))}

        <span style={{ fontSize: 11.5, color: T.muted, marginLeft: 12 }}>Period:</span>
        {[7, 30, 90].map((d) => (
          <button key={d} onClick={() => setDays(d)} style={{
            background: days === d ? "#0ea5e9" : "transparent",
            color: days === d ? "#fff" : T.muted,
            border: `1px solid ${days === d ? "#0ea5e9" : T.border}`,
            borderRadius: 8, padding: "5px 13px", fontSize: 11.5, fontWeight: 600, cursor: "pointer",
          }}>{d}d</button>
        ))}

        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Find account… (${nodeCount})`}
            style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "5px 11px", fontSize: 11.5, color: T.text, width: 180 }}
          />
          <button onClick={() => setDense((v) => !v)} title="Compact rows — fits far more of a large network on screen"
            style={{ background: dense ? "#0ea5e9" : "transparent", color: dense ? "#fff" : T.muted, border: `1px solid ${dense ? "#0ea5e9" : T.border}`, borderRadius: 8, padding: "5px 13px", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>
            Dense
          </button>
          <button onClick={() => {
            const all: Record<number, boolean> = {};
            const walk = (ns: any[]) => ns.forEach((n) => { all[n.id] = true; walk(n.children || []); });
            walk(data?.roots || []);
            setOpen(all);
          }} style={{ background: "transparent", color: T.muted, border: `1px solid ${T.border}`, borderRadius: 8, padding: "5px 13px", fontSize: 11.5, cursor: "pointer" }}>
            Expand all
          </button>
          <button onClick={() => setOpen({})} style={{ background: "transparent", color: T.muted, border: `1px solid ${T.border}`, borderRadius: 8, padding: "5px 13px", fontSize: 11.5, cursor: "pointer" }}>
            Collapse
          </button>
        </div>
      </div>

      {/* The tree — capped height with its own scroll so a large network never
          pushes the footer note (and everything above) off the page. */}
      <div style={{ ...card, maxHeight: "62vh", overflow: "auto" }}>
        {loading && <div style={{ padding: 20, color: T.muted, fontSize: 12.5 }}>Loading network…</div>}
        {!loading && !data?.roots?.length && (
          <div style={{ padding: 24, textAlign: "center", color: T.muted, fontSize: 12.5 }}>
            No accounts yet. Create a franchise to start building your network.
          </div>
        )}
        {!loading && data?.roots?.length > 0 && query && visibleRoots.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: T.muted, fontSize: 12.5 }}>
            No account matches “{q}”.
          </div>
        )}
        {visibleRoots.map((n: any) => <Node key={n.id} n={n} />)}
      </div>

      <div style={{ fontSize: 10.5, color: T.muted, marginTop: 10, lineHeight: 1.5 }}>
        Totals roll up through the whole subtree. Where an account owns customers directly,
        its own count is shown in brackets — a franchise with few direct customers but a
        large subtree is a distributor rather than a small reseller.
      </div>
    </div>
  );
}
