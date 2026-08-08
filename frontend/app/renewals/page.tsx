"use client";

import React from "react";
import { useRouter } from "next/navigation";
import API from "../components/api";
import { money } from "../components/currency";

/**
 * Renewals worklist — due-this-week + expired customers with one-tap renew.
 * Renewing runs activateRenewal, which raises the invoice, records the cash
 * payment and puts the customer back online in a single action.
 */
export default function RenewalsPage() {
  const router = useRouter();
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [rows, setRows] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busyId, setBusyId] = React.useState<number | null>(null);
  const [toast, setToast] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      // No days param → includes already-expired plus the next 30 days.
      const r = await fetch(`${API}/subscribers/expiring`, { headers });
      const d = r.ok ? await r.json() : [];
      setRows(Array.isArray(d) ? d : []);
    } catch { setRows([]); }
    setLoading(false);
  }, [token]);

  React.useEffect(() => { if (!token) { router.push("/login"); return; } load(); }, [token, load]);

  const renew = async (s: any, method: string) => {
    setBusyId(s.id); setToast("");
    try {
      const r = await fetch(`${API}/subscribers/activate-renewal`, {
        method: "POST", headers,
        body: JSON.stringify({ subscriberId: s.id, packageId: s.packageId, mode: "FULL", paymentMethod: method, force: true }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Renew failed");
      setToast(`${s.fullName} renewed — online until ${new Date(d.expiryDate ?? d.quote?.newExpiry).toLocaleDateString()}`);
      setRows((p) => p.filter((x) => x.id !== s.id));
    } catch (e: any) { setToast(`❌ ${e.message}`); }
    setBusyId(null);
  };

  const now = Date.now();
  const withDays = rows.map((s) => {
    const exp = s.serviceSettings?.expiryDate ? new Date(s.serviceSettings.expiryDate).getTime() : null;
    return { ...s, _days: exp != null ? Math.ceil((exp - now) / 86400_000) : null };
  });
  const expired = withDays.filter((s) => s._days != null && s._days < 0);
  const dueSoon = withDays.filter((s) => s._days != null && s._days >= 0 && s._days <= 7);
  const later = withDays.filter((s) => s._days != null && s._days > 7);

  const Section = ({ title, list, tone }: any) => list.length === 0 ? null : (
    <div className="rn-sec">
      <div className={`rn-h ${tone}`}>{title} <span>{list.length}</span></div>
      {list.map((s: any) => (
        <div key={s.id} className="rn-row">
          <div className="rn-who" onClick={() => router.push(`/subscribers/${s.id}`)}>
            <div className="nm">{s.fullName}</div>
            <div className="sub"><code>{s.username}</code>{s.phone ? ` · ${s.phone}` : ""}</div>
          </div>
          <div className="rn-pkg">{s.package?.name ?? "—"}<span>{s.package ? money(s.package.price) : ""}</span></div>
          <div className={`rn-exp ${s._days < 0 ? "bad" : s._days <= 3 ? "warn" : ""}`}>
            {s._days < 0 ? `expired ${-s._days}d ago` : s._days === 0 ? "expires today" : `${s._days}d left`}
          </div>
          <div className="rn-act">
            <button className="primary" disabled={busyId === s.id} onClick={() => renew(s, "CASH")}>
              {busyId === s.id ? "…" : "Renew + cash"}
            </button>
            <button disabled={busyId === s.id} onClick={() => renew(s, "BALANCE")} title="Renew from the customer's wallet balance">Wallet</button>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="rn">
      <style>{CSS}</style>
      <div className="rn-head">
        <div><h1>Renewals</h1><span>Due this week and expired — one tap to renew, collect and reconnect</span></div>
        <button onClick={load}>↻ Refresh</button>
      </div>
      {toast && <div className="rn-toast">{toast}</div>}
      {loading ? <div className="rn-load">Loading…</div> : (
        (expired.length + dueSoon.length + later.length) === 0
          ? <div className="rn-load">Nothing due — every customer is current. 🎉</div>
          : <>
              <Section title="Expired — win back" list={expired} tone="bad" />
              <Section title="Due this week" list={dueSoon} tone="warn" />
              <Section title="Coming up (next 30 days)" list={later} tone="ok" />
            </>
      )}
    </div>
  );
}

const CSS = `
.rn{padding:20px;max-width:960px;margin:0 auto;color:var(--text)}
.rn-head{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.rn-head h1{font-size:22px;font-weight:800;margin:0}
.rn-head span{font-size:12px;color:var(--muted)}
.rn-head button{background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:8px 13px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit}
.rn-toast{background:rgba(74,222,128,.12);border:1px solid rgba(74,222,128,.3);color:#86efac;border-radius:10px;padding:10px 14px;font-size:12.5px;margin-bottom:12px}
.rn-load{padding:50px;text-align:center;color:var(--muted)}
.rn-sec{margin-bottom:18px}
.rn-h{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:8px;display:flex;align-items:center;gap:8px}
.rn-h span{background:var(--surface-2);border-radius:999px;padding:1px 8px;font-size:11px}
.rn-h.bad{color:#fca5a5}.rn-h.warn{color:#fbbf24}.rn-h.ok{color:#86efac}
.rn-row{display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 13px;margin-bottom:7px;flex-wrap:wrap}
.rn-who{flex:1;min-width:160px;cursor:pointer}
.rn-who .nm{font-size:13.5px;font-weight:700}
.rn-who .sub{font-size:11px;color:var(--muted)}
.rn-who code{background:rgba(255,255,255,.06);padding:1px 5px;border-radius:4px;font-size:10.5px}
.rn-pkg{min-width:110px;font-size:12.5px;font-weight:600}
.rn-pkg span{display:block;font-size:11px;color:var(--muted);font-weight:400}
.rn-exp{min-width:110px;font-size:12px;color:var(--muted)}
.rn-exp.warn{color:#fbbf24}.rn-exp.bad{color:#fca5a5;font-weight:700}
.rn-act{display:flex;gap:6px;margin-left:auto}
.rn-act button{background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}
.rn-act .primary{background:linear-gradient(135deg,#7C4DFF,#E9408B);color:#fff;border:none}
.rn-act button:disabled{opacity:.5;cursor:not-allowed}
`;
