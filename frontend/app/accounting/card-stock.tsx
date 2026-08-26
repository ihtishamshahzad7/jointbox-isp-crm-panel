"use client";

import React from "react";
import API from "../components/api";
import { money } from "../components/currency";

/**
 * Prepaid card stock — who is holding your cards, and what they are worth.
 *
 * An unredeemed card is bearer value: whoever holds it can spend it. So the
 * number that matters is each reseller's UNSOLD value — money they are holding
 * on your behalf, and the figure to reconcile against when they settle.
 *
 * Cards could already be generated in batches with a PIN, but not handed to
 * anyone: they existed and belonged to nobody. This is the allocation step
 * that makes them a sales channel.
 */
type Holder = {
  userId: number;
  name: string;
  role: string | null;
  unused: number;
  used: number;
  expired: number;
  unusedValue: number;
  soldValue: number;
};
type Stock = {
  holders: Holder[];
  unassigned: { count: number; value: number } | null;
};
type Account = { id: number; name: string; role?: string | null };

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "ISP",
  SUPER_ADMIN: "ISP",
  RESELLER: "Franchise",
  SUB_RESELLER: "Dealer",
  RETAILER: "Retailer",
  SALES: "Staff",
};

export default function CardStock() {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [stock, setStock] = React.useState<Stock | null>(null);
  const [accounts, setAccounts] = React.useState<Account[]>([]);
  const [err, setErr] = React.useState("");
  const [msg, setMsg] = React.useState("");
  const [batchId, setBatchId] = React.useState("");
  const [target, setTarget] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [s, a] = await Promise.all([
        fetch(`${API}/vouchers/stock`, { headers: H }),
        fetch(`${API}/users`, { headers: H }),
      ]);
      if (!s.ok) { setErr("Could not load card stock."); return; }
      setStock(await s.json());
      if (a.ok) {
        const list = await a.json();
        setAccounts(Array.isArray(list) ? list : list?.data ?? []);
      }
      setErr("");
    } catch {
      setErr("Could not load card stock.");
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  const allocate = async (assignToUserId: number | null) => {
    if (!batchId.trim()) { setMsg("Enter the batch to move."); return; }
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch(`${API}/vouchers/allocate`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ batchId: batchId.trim(), assignToUserId }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg(data?.message || "Could not move those cards.");
      } else if (data.moved === 0) {
        setMsg("No unsold cards matched that batch — already redeemed, or the batch id is wrong.");
      } else {
        setMsg(
          assignToUserId === null
            ? `${data.moved} card${data.moved === 1 ? "" : "s"} taken back into your own stock.`
            : `${data.moved} card${data.moved === 1 ? "" : "s"} handed over.`,
        );
        setBatchId("");
        load();
      }
    } catch {
      setMsg("Could not move those cards.");
    }
    setBusy(false);
  };

  if (err) return <div className="cs-empty">{err}</div>;
  if (!stock) return <div className="cs-empty">Loading…</div>;

  const atRisk = stock.holders.reduce((s, h) => s + h.unusedValue, 0);

  return (
    <div className="cs">
      <style>{CSS}</style>

      <div className="cs-note">
        <b>An unsold card is money someone else is holding.</b> Whoever has the card and its PIN
        can spend it, so a reseller&rsquo;s unsold value is what they owe you once they sell it.
        Reconcile against that column when they settle. Cards you have not handed out yet sit on
        your own shelf.
      </div>

      <div className="cs-cards">
        <div className="cs-card big">
          <span>Held by your resellers</span>
          <b>{money(atRisk)}</b>
          <i>unsold — not yet settled</i>
        </div>
        {stock.unassigned && (
          <div className="cs-card">
            <span>On your own shelf</span>
            <b>{money(stock.unassigned.value)}</b>
            <i>{stock.unassigned.count} card{stock.unassigned.count === 1 ? "" : "s"} unallocated</i>
          </div>
        )}
        <div className="cs-card">
          <span>Holders</span>
          <b>{stock.holders.length}</b>
          <i>accounts carrying stock</i>
        </div>
      </div>

      {/* Allocation */}
      <div className="cs-alloc">
        <div className="cs-alloc-h">Hand a batch over</div>
        <div className="cs-alloc-row">
          <input
            placeholder="Batch id (e.g. BATCH-1724…)"
            value={batchId}
            onChange={(e) => setBatchId(e.target.value)}
          />
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose an account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.role ? ` · ${ROLE_LABEL[a.role] ?? a.role}` : ""}
              </option>
            ))}
          </select>
          <button
            className="primary"
            disabled={busy || !target || !batchId.trim()}
            onClick={() => allocate(Number(target))}
          >
            {busy ? "Moving…" : "Hand over"}
          </button>
          <button
            className="ghost"
            disabled={busy || !batchId.trim()}
            title="Return every unsold card in this batch to your own stock"
            onClick={() => allocate(null)}
          >
            Take back
          </button>
        </div>
        <div className="cs-alloc-hint">
          Only unsold cards move — a redeemed card stays with whoever sold it, because it is the
          record of that sale.
        </div>
        {msg && <div className="cs-msg">{msg}</div>}
      </div>

      {/* Stock per holder */}
      {stock.holders.length === 0 ? (
        <div className="cs-empty">
          No cards allocated yet. Generate a batch on the Vouchers tab, then hand it to a reseller
          above.
        </div>
      ) : (
        <div className="cs-scroll">
          <div className="cs-table">
            <div className="cs-h">
              <span>Account</span>
              <span className="num">Unsold</span>
              <span className="num">Unsold value</span>
              <span className="num">Sold</span>
              <span className="num">Sold value</span>
              <span className="num">Expired</span>
            </div>
            {stock.holders.map((h) => (
              <div className="cs-r" key={h.userId}>
                <span className="nm">
                  {h.name}
                  {h.role && <em>{ROLE_LABEL[h.role] ?? h.role}</em>}
                </span>
                <span className="num">{h.unused}</span>
                <span className="num strong">{money(h.unusedValue)}</span>
                <span className="num">{h.used}</span>
                <span className="num pos">{money(h.soldValue)}</span>
                <span className={`num ${h.expired > 0 ? "warn" : "dim"}`}>{h.expired}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="cs-foot">
        <b>Expired</b> cards were never sold and can no longer be redeemed — that value is lost,
        so a rising count is worth chasing before validity runs out.
      </div>
    </div>
  );
}

const CSS = `
.cs{max-width:1050px}
.cs-empty{padding:26px;text-align:center;color:#94A3B8;font-size:13px}
.cs-note{background:rgba(60,80,224,.07);border:1px solid rgba(60,80,224,.3);border-radius:10px;padding:11px 14px;font-size:12px;line-height:1.75;color:#334155;margin-bottom:14px}
.cs-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:12px}
.cs-card{background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:3px}
.cs-card span{font-size:11.5px;color:#64748B;font-weight:600}
.cs-card b{font-size:20px;color:#1C2434;font-variant-numeric:tabular-nums}
.cs-card i{font-style:normal;font-size:10.5px;color:#94A3B8}
.cs-card.big{border-color:#F3D9A4;background:#FFFBF2}
.cs-card.big b{font-size:25px;color:#8A5A12}
.cs-alloc{background:#F7F9FC;border:1px solid #E2E8F0;border-radius:10px;padding:12px 14px;margin-bottom:14px}
.cs-alloc-h{font-size:12.5px;font-weight:700;color:#1C2434;margin-bottom:9px}
.cs-alloc-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.cs-alloc-row input,.cs-alloc-row select{height:34px;border:1px solid #E2E8F0;border-radius:7px;padding:0 9px;font-size:12px;font-family:inherit;background:#fff;color:#1C2434}
.cs-alloc-row input{min-width:210px}
.cs-alloc-row select{min-width:200px}
.cs-alloc-row button{height:34px;border-radius:7px;padding:0 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid #E2E8F0}
.cs-alloc-row button:disabled{opacity:.5;cursor:not-allowed}
.cs-alloc-row .primary{background:#3C50E0;border-color:#3C50E0;color:#fff}
.cs-alloc-row .ghost{background:#fff;color:#64748B}
.cs-alloc-hint{font-size:11px;color:#94A3B8;margin-top:7px;line-height:1.6}
.cs-msg{margin-top:9px;font-size:12px;color:#1C2434;background:#fff;border:1px solid #E2E8F0;border-radius:7px;padding:7px 10px}
.cs-scroll{overflow-x:auto;border:1px solid #E2E8F0;border-radius:12px;background:#fff}
.cs-table{min-width:640px}
.cs-h,.cs-r{display:grid;grid-template-columns:1.7fr .7fr 1fr .7fr 1fr .7fr;gap:8px;padding:10px 14px;align-items:center}
.cs-h{background:#F7F9FC;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748B}
.cs-r{border-top:1px solid #EEF2F7;font-size:12.5px;color:#1C2434}
.cs-r:hover{background:#FAFBFE}
.cs-r .nm{display:flex;flex-direction:column;font-weight:600;min-width:0}
.cs-r .nm em{font-style:normal;font-size:10px;color:#94A3B8;font-weight:500}
.cs-h .num,.cs-r .num{text-align:right;font-variant-numeric:tabular-nums}
.cs-r .strong{font-weight:700;color:#8A5A12}
.cs-r .pos{color:#157F43;font-weight:600}
.cs-r .warn{color:#B02A37;font-weight:600}
.cs-r .dim{color:#94A3B8}
.cs-foot{font-size:11.5px;color:#94A3B8;line-height:1.7;margin-top:10px}
`;
