"use client";

import React from "react";
import API from "../components/api";
import { money } from "../components/currency";

/**
 * WalletManager — add / reclaim balance for downline accounts, with the ledger.
 *
 * The money logic already lives in the backend and is correct: a top-up debits
 * the funder's wallet and credits the receiver's, both recorded and reversible.
 * This is the Billing-side home for it — search an account, see its wallet and
 * full history (with WHO moved the money), and top up or withdraw.
 */

type Acct = { id: number; name: string; email?: string; role?: string; balance?: number };
type Tx = { id: number; type: string; amount: number; balanceAfter: number; notes?: string; byName?: string | null; createdAt: string };

export default function WalletManager() {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [accts, setAccts] = React.useState<Acct[]>([]);
  const [q, setQ] = React.useState("");
  const [sel, setSel] = React.useState<Acct | null>(null);
  const [history, setHistory] = React.useState<Tx[]>([]);
  const [amount, setAmount] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [mode, setMode] = React.useState<"TOPUP" | "WITHDRAWAL">("TOPUP");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; t: string } | null>(null);

  const loadAccts = React.useCallback(async () => {
    const r = await fetch(`${API}/users`, { headers: H });
    if (r.ok) setAccts(await r.json());
  }, []);
  React.useEffect(() => { loadAccts(); }, [loadAccts]);

  const pick = async (a: Acct) => {
    setSel(a); setQ(""); setMsg(null);
    const r = await fetch(`${API}/organization/resellers/${a.id}/wallet`, { headers: H });
    setHistory(r.ok ? await r.json() : []);
  };

  const apply = async () => {
    if (!sel) return;
    const val = Number(amount);
    if (Number.isNaN(val) || val <= 0) return setMsg({ ok: false, t: "Enter an amount greater than zero" });
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${API}/organization/resellers/${sel.id}/wallet`, {
        method: "POST", headers: H,
        body: JSON.stringify({ amount: val, type: mode, notes }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || "Failed");
      setMsg({ ok: true, t: `${mode === "TOPUP" ? "Added" : "Withdrew"} ${money(val)} ${mode === "TOPUP" ? "to" : "from"} ${sel.name}` });
      setAmount(""); setNotes("");
      await Promise.all([loadAccts(), pick({ ...sel })]);
    } catch (e: any) {
      setMsg({ ok: false, t: e?.message || "Could not complete the transfer" });
    } finally { setBusy(false); }
  };

  const matches = q.trim()
    ? accts.filter((a) => (a.name || "").toLowerCase().includes(q.toLowerCase()) || (a.email || "").toLowerCase().includes(q.toLowerCase()))
    : accts;

  return (
    <div className="wm">
      <style>{CSS}</style>
      {msg && <div className={`wm-msg ${msg.ok ? "ok" : "bad"}`}>{msg.t}</div>}

      {/* Account picker — searchable for large downlines */}
      {!sel ? (
        <div className="wm-pick">
          <div className="wm-search">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search an account by name or email…" />
          </div>
          <div className="wm-list">
            {matches.slice(0, 100).map((a) => (
              <button key={a.id} className="wm-row" onClick={() => pick(a)}>
                <span className="nm">{a.name}<em>{a.email || ""}</em></span>
                <span className="bal">{money(a.balance || 0)}<i>{a.role}</i></span>
              </button>
            ))}
            {matches.length === 0 && <div className="wm-empty">No account matches “{q}”.</div>}
          </div>
        </div>
      ) : (
        <>
          <div className="wm-selbar">
            <div>
              <b>{sel.name}</b> <span className="muted">· {sel.role}</span>
              <div className="wm-balnow">Wallet now: <b>{money(sel.balance || 0)}</b></div>
            </div>
            <button className="wm-change" onClick={() => { setSel(null); setHistory([]); }}>Change account</button>
          </div>

          {/* Transfer form */}
          <div className="wm-form">
            <div className="wm-modes">
              <button className={mode === "TOPUP" ? "on" : ""} onClick={() => setMode("TOPUP")}>Add balance</button>
              <button className={mode === "WITHDRAWAL" ? "on warn" : ""} onClick={() => setMode("WITHDRAWAL")}>Withdraw</button>
            </div>
            <input className="wm-amt" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" inputMode="numeric" />
            <input className="wm-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Note (optional)" />
            <button className="wm-apply" onClick={apply} disabled={busy}>{busy ? "…" : mode === "TOPUP" ? "Add" : "Withdraw"}</button>
          </div>
          <p className="wm-hint">
            {mode === "TOPUP"
              ? "Adding balance moves money from your wallet into theirs — your balance drops, theirs rises, and both are recorded below."
              : "Withdrawing pulls balance back from them into your wallet — recorded on both sides."}
          </p>

          {/* Ledger — who moved what */}
          <div className="wm-ledger">
            <div className="wm-lhead">
              <span>When</span><span>Type</span><span>Amount</span><span>Balance after</span><span>By</span><span>Note</span>
            </div>
            {history.length === 0 ? (
              <div className="wm-empty">No wallet history yet.</div>
            ) : history.map((t) => (
              <div key={t.id} className="wm-lrow">
                <span>{new Date(t.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</span>
                <span><i className={`wm-tag ${t.amount >= 0 ? "in" : "out"}`}>{t.type}</i></span>
                <span className={t.amount >= 0 ? "pos" : "neg"}>{t.amount >= 0 ? "+" : ""}{money(t.amount)}</span>
                <span>{money(t.balanceAfter)}</span>
                <span>{t.byName || "—"}</span>
                <span className="note">{t.notes || "—"}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const CSS = `
.wm{max-width:960px}
.wm-msg{padding:9px 13px;border-radius:9px;font-size:13px;margin-bottom:12px}
.wm-msg.ok{background:#E7F6EC;color:#157F43;border:1px solid #C6E9D3}
.wm-msg.bad{background:#FDE8EA;color:#B02A37;border:1px solid #F5C2C7}
.wm-search input{width:100%;height:40px;border:1px solid #E2E8F0;border-radius:10px;padding:0 12px;font-size:14px;font-family:inherit;margin-bottom:10px}
.wm-list{border:1px solid #E2E8F0;border-radius:12px;overflow:hidden;max-height:420px;overflow-y:auto}
.wm-row{display:flex;align-items:center;justify-content:space-between;width:100%;text-align:left;background:#fff;border:none;border-bottom:1px solid #EEF2F7;padding:11px 14px;cursor:pointer;font-family:inherit}
.wm-row:hover{background:#F7F9FC}
.wm-row .nm{display:flex;flex-direction:column;color:#1C2434;font-size:14px;font-weight:600}
.wm-row .nm em{font-style:normal;font-size:11.5px;color:#94A3B8;font-weight:400}
.wm-row .bal{display:flex;flex-direction:column;text-align:right;color:#1C2434;font-size:14px;font-weight:600}
.wm-row .bal i{font-style:normal;font-size:11px;color:#64748B;font-weight:600}
.wm-selbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;background:#EEF1FE;border:1px solid #C7CEF9;border-radius:12px;margin-bottom:14px;flex-wrap:wrap}
.wm-selbar b{color:#1C2434}.wm-selbar .muted{color:#64748B}
.wm-balnow{font-size:13px;color:#64748B;margin-top:2px}
.wm-change{background:#fff;border:1px solid #C7CEF9;color:#3C50E0;border-radius:8px;padding:6px 14px;font-size:12.5px;font-weight:600;cursor:pointer}
.wm-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px}
.wm-modes{display:inline-flex;background:#F1F5F9;border-radius:9px;padding:3px}
.wm-modes button{border:none;background:transparent;padding:7px 14px;border-radius:7px;font-size:13px;font-weight:600;color:#64748B;cursor:pointer;font-family:inherit}
.wm-modes button.on{background:#3C50E0;color:#fff}
.wm-modes button.on.warn{background:#B02A37}
.wm-amt{height:40px;width:120px;border:1px solid #CBD5E1;border-radius:9px;padding:0 12px;font-size:14px;font-family:inherit}
.wm-notes{height:40px;flex:1;min-width:150px;border:1px solid #E2E8F0;border-radius:9px;padding:0 12px;font-size:14px;font-family:inherit}
.wm-apply{height:40px;border:none;border-radius:9px;background:#3C50E0;color:#fff;padding:0 22px;font-size:14px;font-weight:600;cursor:pointer}
.wm-apply:disabled{opacity:.6}
.wm-hint{font-size:12px;color:#64748B;margin:0 0 16px;line-height:1.6}
.wm-ledger{border:1px solid #E2E8F0;border-radius:12px;overflow:hidden}
.wm-lhead,.wm-lrow{display:grid;grid-template-columns:1.3fr .9fr 1fr 1.1fr 1.1fr 1.6fr;gap:8px;padding:10px 14px;align-items:center}
.wm-lhead{background:#F7F9FC;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#64748B}
.wm-lrow{border-top:1px solid #EEF2F7;font-size:13px;color:#1C2434}
.wm-lrow .pos{color:#157F43;font-weight:600}
.wm-lrow .neg{color:#B02A37;font-weight:600}
.wm-lrow .note{color:#64748B;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wm-tag{font-style:normal;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px}
.wm-tag.in{background:#E7F6EC;color:#157F43}
.wm-tag.out{background:#FDF3E3;color:#8A6209}
.wm-empty{padding:22px;text-align:center;color:#94A3B8;font-size:13px}
@media (max-width:768px){
  .wm-form{flex-direction:column;align-items:stretch}
  .wm-amt,.wm-modes{width:100%}
  .wm-lhead{display:none}
  .wm-lrow{grid-template-columns:1fr 1fr;gap:4px 10px}
  .wm-lrow .note{grid-column:1 / -1;white-space:normal}
}
`;
