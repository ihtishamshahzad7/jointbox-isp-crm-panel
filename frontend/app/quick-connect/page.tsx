"use client";

import React from "react";
import { useRouter } from "next/navigation";
import API from "../components/api";
import { money } from "../components/currency";

/**
 * Quick Connect — one screen to add + activate a new customer: enter details,
 * pick a package, click Activate. Creation runs the full flow (package →
 * invoice → wallet charge → RADIUS), so the customer is online immediately.
 */
export default function QuickConnectPage() {
  const router = useRouter();
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [packages, setPackages] = React.useState<any[]>([]);
  const [areas, setAreas] = React.useState<any[]>([]);
  const [nases, setNases] = React.useState<any[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<any>(null);
  const [err, setErr] = React.useState("");

  const [collect, setCollect] = React.useState(true);
  const [f, setF] = React.useState<any>({ fullName: "", phone: "", username: "", password: "", packageId: "", areaId: "", nasId: "" });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));

  React.useEffect(() => {
    if (!token) { router.push("/login"); return; }
    const g = (p: string) => fetch(`${API}${p}`, { headers }).then((r) => r.ok ? r.json() : []).catch(() => []);
    Promise.all([g("/packages"), g("/areas"), g("/nas")]).then(([p, a, n]) => {
      setPackages(Array.isArray(p) ? p : p?.data ?? []);
      setAreas(Array.isArray(a) ? a : a?.data ?? []);
      setNases(Array.isArray(n) ? n : n?.data ?? []);
    });
  }, [token]);

  const pkg = packages.find((p) => String(p.id) === String(f.packageId));

  const suggestCreds = () => {
    const base = (f.fullName || "user").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8) || "user";
    const u = `${base}${Math.floor(100 + Math.random() * 900)}`;
    set("username", u);
    if (!f.password) set("password", Math.random().toString(36).slice(2, 8));
  };

  const submit = async () => {
    setErr("");
    if (!f.fullName.trim()) return setErr("Enter the customer's name.");
    if (!f.username.trim() || !f.password.trim()) return setErr("Set a username and password (use Suggest).");
    if (!f.packageId) return setErr("Choose a package.");
    setBusy(true);
    try {
      const body = { ...f, idempotencyKey: `qc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
      const r = await fetch(`${API}/subscribers`, { method: "POST", headers, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Could not create the connection");
      // Record the customer's first cash payment against their invoice, if collected.
      if (collect && pkg?.price && d.activated !== false && !d.warning) {
        await fetch(`${API}/payments`, { method: "POST", headers, body: JSON.stringify({ subscriberId: d.id, amount: pkg.price, method: "CASH", notes: "First payment (Quick Connect)" }) }).catch(() => null);
      }
      setResult({ ...d, _collected: collect && pkg?.price });
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };

  if (result) {
    const activated = result.activated !== false && !result.warning;
    return (
      <div className="qc">
        <style>{CSS}</style>
        <div className={`qc-done ${activated ? "ok" : "warn"}`}>
          <div className="qc-icon">{activated ? "✓" : "!"}</div>
          <h2>{activated ? "Customer connected & online" : "Saved — but not activated"}</h2>
          <div className="qc-line">{result.fullName} · <code>{result.username}</code></div>
          {activated
            ? <><div className="qc-line">Package <b>{pkg?.name}</b> · expires {result.serviceSettings?.expiryDate ? new Date(result.serviceSettings.expiryDate).toLocaleDateString() : "—"}</div>
                {result._collected ? <div className="qc-line" style={{ color: "#4ade80" }}>Payment recorded ✓</div> : null}</>
            : <div className="qc-warn">{result.warning}</div>}
          <div className="qc-actions">
            <button className="primary" onClick={() => router.push(`/subscribers/${result.id}`)}>Open profile</button>
            <button onClick={() => { setResult(null); setF({ fullName: "", phone: "", username: "", password: "", packageId: f.packageId, areaId: f.areaId, nasId: f.nasId }); }}>Add another</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="qc">
      <style>{CSS}</style>
      <div className="qc-head"><h1>Quick Connect</h1><span>Add & activate a customer in one screen</span></div>

      <div className="qc-card">
        <div className="qc-row">
          <label>Full name<input value={f.fullName} onChange={(e) => set("fullName", e.target.value)} placeholder="Customer name" /></label>
          <label>Phone<input value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="03xx-xxxxxxx" /></label>
        </div>
        <div className="qc-row">
          <label>Username<input value={f.username} onChange={(e) => set("username", e.target.value)} placeholder="login" /></label>
          <label>Password<input value={f.password} onChange={(e) => set("password", e.target.value)} placeholder="password" /></label>
          <button className="qc-sugg" type="button" onClick={suggestCreds}>Suggest</button>
        </div>
        <div className="qc-row">
          <label>Package
            <select value={f.packageId} onChange={(e) => set("packageId", e.target.value)}>
              <option value="">Choose…</option>
              {packages.map((p) => <option key={p.id} value={p.id}>{p.name} — {money(p.price)}{p.downloadSpeed ? ` · ${p.downloadSpeed}M` : ""}</option>)}
            </select>
          </label>
          <label>Area
            <select value={f.areaId} onChange={(e) => set("areaId", e.target.value)}>
              <option value="">—</option>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label>NAS / Router
            <select value={f.nasId} onChange={(e) => set("nasId", e.target.value)}>
              <option value="">—</option>
              {nases.map((n) => <option key={n.id} value={n.id}>{n.shortname || n.nasname}</option>)}
            </select>
          </label>
        </div>

        {pkg && (
          <div className="qc-price">
            Activating charges your wallet <b>{money(pkg.price)}</b> for <b>{pkg.name}</b> and raises the customer's first invoice.
            <label className="qc-collect">
              <input type="checkbox" checked={collect} onChange={(e) => setCollect(e.target.checked)} />
              Mark {money(pkg.price)} collected from customer (cash)
            </label>
          </div>
        )}
        {err && <div className="qc-err">{err}</div>}

        <button className="qc-go" disabled={busy} onClick={submit}>
          {busy ? "Connecting…" : "⚡ Activate & connect"}
        </button>
      </div>
    </div>
  );
}

const CSS = `
.qc{padding:20px;max-width:760px;margin:0 auto;color:var(--text)}
.qc-head{margin-bottom:16px}
.qc-head h1{font-size:22px;font-weight:800;margin:0}
.qc-head span{font-size:12px;color:var(--muted)}
.qc-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px}
.qc-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;align-items:flex-end}
.qc-row label{flex:1;min-width:150px;display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted)}
.qc-row input,.qc-row select{background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:10px 12px;font-size:13px;font-family:inherit}
.qc-sugg{background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:10px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;height:40px}
.qc-price{background:rgba(124,77,255,.10);border:1px solid rgba(124,77,255,.3);border-radius:10px;padding:11px 14px;font-size:12.5px;color:var(--text);margin-bottom:12px}
.qc-collect{display:flex;align-items:center;gap:8px;margin-top:9px;font-size:12.5px;font-weight:600;cursor:pointer}
.qc-collect input{width:16px;height:16px;accent-color:#7C4DFF;cursor:pointer}
.qc-err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#fca5a5;border-radius:10px;padding:10px 14px;font-size:12.5px;margin-bottom:12px}
.qc-go{width:100%;padding:14px;border:none;border-radius:12px;font-size:15px;font-weight:800;cursor:pointer;
  background:linear-gradient(135deg,#7C4DFF,#E9408B,#F27121);color:#fff}
.qc-go:disabled{opacity:.6;cursor:not-allowed}

.qc-done{text-align:center;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:36px 24px;margin-top:20px}
.qc-done.ok{border-color:rgba(74,222,128,.4)}
.qc-done.warn{border-color:rgba(245,158,11,.5)}
.qc-icon{width:56px;height:56px;border-radius:50%;display:grid;place-items:center;font-size:28px;font-weight:800;margin:0 auto 12px}
.qc-done.ok .qc-icon{background:rgba(74,222,128,.15);color:#4ade80}
.qc-done.warn .qc-icon{background:rgba(245,158,11,.15);color:#fbbf24}
.qc-done h2{font-size:18px;margin:0 0 8px}
.qc-line{font-size:13px;color:var(--muted);margin-top:4px}
.qc-warn{font-size:12.5px;color:#fbbf24;margin-top:8px}
.qc-actions{display:flex;gap:10px;justify-content:center;margin-top:18px}
.qc-actions button{background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:10px;padding:10px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
.qc-actions .primary{background:linear-gradient(135deg,#7C4DFF,#E9408B);color:#fff;border:none}
`;
