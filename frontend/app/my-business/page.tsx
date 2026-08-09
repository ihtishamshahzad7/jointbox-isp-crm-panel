"use client";

import React from "react";
import { useRouter } from "next/navigation";
import API from "../components/api";
import { money } from "../components/currency";
import { SkeletonCards } from "../components/skeleton";

/** My Business — reseller/franchise operations snapshot. */
export default function MyBusinessPage() {
  const router = useRouter();
  const [d, setD] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  const load = React.useCallback(async () => {
    try {
      const r = await fetch(`${API}/users/me/business`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setD(await r.json());
    } catch { /* keep last */ }
    setLoading(false);
  }, [token]);

  React.useEffect(() => {
    if (!token) { router.push("/login"); return; }
    load(); const t = setInterval(load, 60000); return () => clearInterval(t);
  }, [token, load]);

  // Skeleton mirrors the real layout (wallet hero + KPI grid), so nothing
  // shifts when the data lands.
  if (loading) return (
    <div className="mb-wrap">
      <style>{CSS}</style>
      <div className="mb-head"><div><h1>My Business</h1><div className="mb-sub">Loading your snapshot…</div></div></div>
      <SkeletonCards count={2} min={280} />
      <div style={{ height: 16 }} />
      <SkeletonCards count={6} min={180} />
    </div>
  );
  if (!d) return <div className="mb-wrap"><style>{CSS}</style><div className="mb-load">Couldn’t load right now.</div></div>;

  const w = d.wallet, c = d.customers, m = d.month, r = d.receivables;
  const pct = c.total ? Math.round((c.active / c.total) * 100) : 0;

  return (
    <div className="mb-wrap">
      <style>{CSS}</style>

      <div className="mb-head">
        <div>
          <h1>My Business</h1>
          <div className="mb-sub">{d.name} · {d.role} — live snapshot, refreshes every minute</div>
        </div>
        <div className="mb-actions">
          <button className="primary" onClick={() => router.push("/my-work?tab=connect")}>＋ New connection</button>
          <button onClick={() => router.push("/subscribers")}>All subscribers</button>
        </div>
      </div>

      {/* Wallet hero */}
      <div className={`mb-wallet ${w.low ? "low" : ""}`}>
        <div>
          <div className="lbl">Wallet balance</div>
          <div className="amt">{money(w.balance)}</div>
          <div className="hint">
            Spendable {money(w.spendable)}{w.creditLimit ? ` (incl. ${money(w.creditLimit)} credit)` : ""}
            {w.low && <span className="warn"> · Low balance — top up to keep activating</span>}
          </div>
        </div>
        <div className="mb-w-side">
          <div className="k"><b>{money(m.collected)}</b><span>collected this month</span></div>
          <div className="k"><b>{money(m.commission)}</b><span>commission this month</span></div>
        </div>
      </div>

      {/* KPI grid */}
      <div className="mb-grid">
        <Kpi label="Active customers" value={c.active} sub={`${pct}% of ${c.total}`} tone="ok" bar={pct} onClick={() => router.push("/subscribers")} />
        <Kpi label="Expiring in 7 days" value={c.expiringSoon} sub="renew to keep online" tone={c.expiringSoon ? "warn" : "ok"} onClick={() => router.push("/subscribers")} />
        <Kpi label="Expired" value={c.expired} sub="offline — win back" tone={c.expired ? "bad" : "ok"} onClick={() => router.push("/subscribers")} />
        <Kpi label="Suspended" value={c.suspended} sub="on hold" tone={c.suspended ? "warn" : "ok"} onClick={() => router.push("/subscribers")} />
        <Kpi label="New this month" value={m.newConnections} sub="connections added" tone="accent" />
        <Kpi label="Receivables" value={money(r.dueAmount)} sub={`${r.unpaidInvoices} unpaid invoice(s)`} tone={r.dueAmount ? "warn" : "ok"} onClick={() => router.push("/billing-center?tab=invoices")} isMoney />
      </div>

      {/* Action strip */}
      <div className="mb-action-strip">
        <div className="t">Do next</div>
        <button onClick={() => router.push("/my-work?tab=connect")}>Add & activate a customer</button>
        <button onClick={() => router.push("/my-work?tab=renewals")}>Renew expiring customers</button>
        <button onClick={() => router.push("/billing-center?tab=payments")}>Record a payment</button>
        <button onClick={() => router.push("/billing-center?tab=earnings")}>Collections report</button>
        <button onClick={() => router.push("/support-center")}>Handle complaints</button>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone, bar, onClick, isMoney }: any) {
  return (
    <button className={`mb-kpi t-${tone} ${onClick ? "clk" : ""}`} onClick={onClick}>
      <div className="kl">{label}</div>
      <div className="kv">{isMoney ? value : Number(value).toLocaleString()}</div>
      <div className="ks">{sub}</div>
      {bar != null && <div className="kbar"><span style={{ width: `${bar}%` }} /></div>}
    </button>
  );
}

const CSS = `
.mb-wrap{padding:20px;color:var(--text);max-width:1100px;margin:0 auto}
.mb-load{padding:60px;text-align:center;color:var(--muted)}
.mb-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.mb-head h1{font-size:22px;font-weight:800;margin:0}
.mb-sub{font-size:12px;color:var(--muted);margin-top:2px}
.mb-actions{display:flex;gap:8px}
.mb-actions button{background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:10px;padding:9px 15px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
.mb-actions .primary{background:linear-gradient(135deg,#7C4DFF,#E9408B);color:#fff;border:none}

.mb-wallet{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;
  background:linear-gradient(135deg,rgba(124,77,255,.18),rgba(233,64,139,.10));
  border:1px solid var(--border);border-radius:16px;padding:20px 22px;margin-bottom:16px}
.mb-wallet.low{border-color:#f59e0b}
.mb-wallet .lbl{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.mb-wallet .amt{font-size:34px;font-weight:800;margin-top:4px}
.mb-wallet .hint{font-size:12px;color:var(--muted);margin-top:6px}
.mb-wallet .warn{color:#fbbf24;font-weight:700}
.mb-w-side{display:flex;gap:14px;align-items:center}
.mb-w-side .k{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 16px;text-align:center;min-width:120px}
.mb-w-side .k b{display:block;font-size:18px;font-weight:800}
.mb-w-side .k span{font-size:10.5px;color:var(--muted)}

.mb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px}
.mb-kpi{text-align:left;background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--border);
  border-radius:12px;padding:14px 15px;font-family:inherit;transition:all .13s ease}
.mb-kpi.clk{cursor:pointer}
.mb-kpi.clk:hover{transform:translateY(-1px);border-color:var(--accent)}
.mb-kpi .kl{font-size:11.5px;color:var(--muted)}
.mb-kpi .kv{font-size:26px;font-weight:800;margin-top:4px}
.mb-kpi .ks{font-size:11px;color:var(--muted);margin-top:2px}
.mb-kpi .kbar{height:5px;border-radius:3px;background:var(--surface-2);margin-top:8px;overflow:hidden}
.mb-kpi .kbar span{display:block;height:100%;background:#4ade80}
.mb-kpi.t-ok{border-left-color:#4ade80}
.mb-kpi.t-warn{border-left-color:#f59e0b}
.mb-kpi.t-bad{border-left-color:#ef4444}
.mb-kpi.t-accent{border-left-color:#7C4DFF}

.mb-action-strip{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--surface-2);
  border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.mb-action-strip .t{font-size:12px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-right:6px}
.mb-action-strip button{background:var(--surface);border:1px solid var(--border);color:var(--text);
  border-radius:8px;padding:8px 13px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
.mb-action-strip button:hover{border-color:var(--accent);color:var(--accent)}
`;
