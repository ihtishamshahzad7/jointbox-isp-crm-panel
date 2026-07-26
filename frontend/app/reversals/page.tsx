"use client";

import React from "react";

/**
 * Disputes / Reversals — one consolidated view of every activation reversal
 * across the caller's dealer tree, plus a reason-coded "reverse a charge" form.
 *
 * A franchise sees its whole tree's reversals; a dealer only its own (scoped on
 * the server). Each row is one credit-note: which subscriber, why, who did it,
 * how much was credited back to the charged tier and clawed back from the
 * commission tiers.
 */

const API =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

const REASON_CODES = [
  { v: "DUPLICATE", label: "Duplicate activation" },
  { v: "DEALER_ERROR", label: "Dealer error" },
  { v: "SYSTEM_BUG", label: "System bug" },
  { v: "CUSTOMER_DISPUTE", label: "Customer dispute" },
  { v: "CANCELLED", label: "Customer cancelled" },
];

const T = {
  bg: "var(--bg,#0b0e1a)", card: "var(--surface,#151823)", border: "var(--border,#252a3c)",
  text: "var(--text,#e9edf5)", muted: "var(--muted,#94a3b8)", green: "#6EE7B7", red: "#FCA5A5", accent: "#6C3CE1",
};

export default function ReversalsPage() {
  const [rows, setRows] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState("");
  const [form, setForm] = React.useState({ subscriberId: "", reasonCode: "DUPLICATE", reason: "", revertService: true });
  const [busy, setBusy] = React.useState(false);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = React.useMemo(() => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }), [token]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/organization/pricing/reversals`, { headers });
      setRows(r.ok ? await r.json() : []);
    } catch { setRows([]); }
    setLoading(false);
  }, [headers]);
  React.useEffect(() => { load(); }, [load]);

  const submit = async () => {
    const id = Number(form.subscriberId);
    if (!id) return setMsg("Enter a subscriber ID.");
    if (!form.reason.trim()) return setMsg("A reason is required.");
    setBusy(true); setMsg("");
    try {
      const r = await fetch(`${API}/organization/pricing/reverse/${id}`, {
        method: "POST", headers,
        body: JSON.stringify({ reason: form.reason, reasonCode: form.reasonCode, revertService: form.revertService }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setMsg(`Reversed ${d.reversalReference} — ${d.reversedRows} ledger row(s)`); setForm((f) => ({ ...f, subscriberId: "", reason: "" })); load(); }
      else setMsg(d.message || "Reversal failed.");
    } catch { setMsg("Request failed."); }
    setBusy(false);
  };

  const input: React.CSSProperties = { background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px", color: T.text, fontSize: 13, fontFamily: "inherit" };
  const codeLabel = (c: string) => REASON_CODES.find((r) => r.v === c)?.label ?? c;

  return (
    <div style={{ padding: 20, color: T.text, background: T.bg, minHeight: "100vh", fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Disputes &amp; Reversals</h1>
      <p style={{ fontSize: 12.5, color: T.muted, marginBottom: 16 }}>
        Every activation reversal across your dealer tree. Reversals credit the charged account and claw back the commission that cascaded up — as a credit-note, never by editing the original.
      </p>

      {/* Reverse a charge */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, marginBottom: 18, maxWidth: 720 }}>
        <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 10 }}>Reverse a charge</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...input, width: 130 }} placeholder="Subscriber ID" value={form.subscriberId}
            onChange={(e) => setForm((f) => ({ ...f, subscriberId: e.target.value.replace(/\D/g, "") }))} />
          <select style={input} value={form.reasonCode} onChange={(e) => setForm((f) => ({ ...f, reasonCode: e.target.value }))}>
            {REASON_CODES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
          </select>
          <input style={{ ...input, flex: 1, minWidth: 220 }} placeholder="Reason (required)" value={form.reason}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: T.muted, cursor: "pointer" }}>
            <input type="checkbox" checked={form.revertService} onChange={(e) => setForm((f) => ({ ...f, revertService: e.target.checked }))} />
            Set service inactive
          </label>
          <button onClick={submit} disabled={busy}
            style={{ border: "none", cursor: "pointer", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, color: "#fff", background: "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)", opacity: busy ? 0.6 : 1 }}>
            {busy ? "…" : "Reverse"}
          </button>
        </div>
        {msg && <div style={{ marginTop: 10, fontSize: 12, color: "#C4B5FD" }}>{msg}</div>}
      </div>

      {/* History */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${T.border}`, fontSize: 12, color: T.muted }}>
          {loading ? "Loading…" : `${rows.length} reversal${rows.length === 1 ? "" : "s"}`}
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 760 }}>
            <thead>
              <tr style={{ background: "var(--surface-2,#1b1f2e)" }}>
                {["When", "Subscriber", "Reason", "Credited back", "Clawed back", "Tiers"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "9px 12px", color: T.muted, fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.reference} style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td style={{ padding: "9px 12px", whiteSpace: "nowrap", color: T.muted }}>{new Date(g.when).toLocaleString()}</td>
                  <td style={{ padding: "9px 12px" }}>
                    <div style={{ fontWeight: 600 }}>{g.subscriber?.fullName || `#${g.subscriberId}`}</div>
                    <div style={{ fontSize: 10.5, color: T.muted }}>{g.subscriber?.username || g.reference}</div>
                  </td>
                  <td style={{ padding: "9px 12px" }}>
                    {g.reasonCode && <span style={{ fontSize: 9.5, fontWeight: 800, padding: "2px 7px", borderRadius: 20, background: "rgba(108,60,225,0.18)", color: "#C4B5FD", marginRight: 6 }}>{codeLabel(g.reasonCode)}</span>}
                    <span style={{ color: T.muted }}>{g.reason}</span>
                  </td>
                  <td style={{ padding: "9px 12px", color: T.green, fontVariantNumeric: "tabular-nums" }}>+{g.restored}</td>
                  <td style={{ padding: "9px 12px", color: T.red, fontVariantNumeric: "tabular-nums" }}>−{g.clawedBack}</td>
                  <td style={{ padding: "9px 12px", color: T.muted }}>{g.tiers?.length ?? 0}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 30, textAlign: "center", color: T.muted }}>No reversals yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
