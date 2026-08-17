"use client";

import React from "react";
import API from "../components/api";
import { money } from "../components/currency";

/**
 * Profit report — what the business EARNED, kept strictly separate from wallet
 * balance.
 *
 * A margin is not money sitting in an account: the parent was already paid when
 * it sold the prepaid credit the child spent, so crediting the wallet again
 * would double-count. Profit is therefore recorded in its own ledger and shown
 * here — by day/week/month/year or a custom range, broken down by the downline
 * account that generated it, with the line items behind every figure.
 */
type Bucket = { profit: number; sales: number; activations: number };
type Seller = { id: number | null; name: string; role: string | null; profit: number; sales: number; activations: number };
type Entry = {
  id: number; at: string; seller: string; subscriber: string; subscriberId: number | null;
  packageName: string; sale: number; cost: number; profit: number; note?: string | null;
};
type Data = {
  periods: { today: Bucket; week: Bucket; month: Bucket; year: Bucket; total: Bucket; custom: Bucket | null };
  bySeller: Seller[];
  entries: Entry[];
};

export default function ProfitReport() {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const H = { Authorization: `Bearer ${token}` };
  const [data, setData] = React.useState<Data | null>(null);
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [err, setErr] = React.useState("");

  const load = React.useCallback(async () => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    try {
      const r = await fetch(`${API}/organization/profit/report?${qs}`, { headers: H });
      if (!r.ok) { setErr("Could not load the profit report."); return; }
      setData(await r.json()); setErr("");
    } catch { setErr("Could not load the profit report."); }
  }, [from, to]);
  React.useEffect(() => { load(); }, [load]);

  const exportCsv = () => {
    if (!data) return;
    const head = ["Date", "Seller", "Subscriber", "Package", "Sale", "Cost", "Profit"];
    const body = data.entries.map((e) => [
      new Date(e.at).toLocaleString(), e.seller, e.subscriber, e.packageName, e.sale, e.cost, e.profit,
    ]);
    const csv = [head, ...body].map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `profit-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); a.remove();
  };

  if (err) return <div className="pr-empty">{err}</div>;
  if (!data) return <div className="pr-empty">Loading…</div>;
  const p = data.periods;

  return (
    <div className="pr">
      <style>{CSS}</style>

      <div className="pr-note">
        <b>Profit is reporting only — it is never added to a wallet.</b> Wallet balances change
        only through real transactions (loading balance, transfers, adjustments, and the
        activating account's own deduction). The figures below are what you earned on your
        downline's activations.
      </div>

      {/* Period totals */}
      <div className="pr-cards">
        <Card label="Today" b={p.today} />
        <Card label="This week" b={p.week} />
        <Card label="This month" b={p.month} big />
        <Card label="This year" b={p.year} />
        <Card label="All time" b={p.total} />
      </div>

      {/* Custom range */}
      <div className="pr-range">
        <span>Custom range</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="dim">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        {(from || to) && <button className="clear" onClick={() => { setFrom(""); setTo(""); }}>Clear</button>}
        {p.custom && (
          <span className="pr-range-out">
            <b>{money(p.custom.profit)}</b> profit · {p.custom.activations} activations · {money(p.custom.sales)} sales
          </span>
        )}
        <button className="csv" onClick={exportCsv}>Export CSV</button>
      </div>

      {/* Who generated it */}
      <div className="pr-sec">Profit by account {from || to ? "(selected range)" : "(all time)"}</div>
      {data.bySeller.length === 0 ? (
        <div className="pr-empty">No profit recorded yet. It appears when a downline account activates a customer.</div>
      ) : (
        <div className="pr-table">
          <div className="pr-h"><span>Account</span><span>Activations</span><span>Sales</span><span>Profit</span></div>
          {data.bySeller.map((s) => (
            <div className="pr-r" key={`${s.id}-${s.name}`}>
              <span className="nm">{s.name}<em>{s.role || ""}</em></span>
              <span>{s.activations}</span>
              <span>{money(s.sales)}</span>
              <span className="pos">{money(s.profit)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Line items */}
      <div className="pr-sec">Profit ledger</div>
      {data.entries.length === 0 ? (
        <div className="pr-empty">No entries in this range.</div>
      ) : (
        <div className="pr-table wide">
          <div className="pr-h l"><span>Date</span><span>Account</span><span>Customer</span><span>Package</span><span>Sale</span><span>Cost</span><span>Profit</span></div>
          {data.entries.map((e) => (
            <div className={`pr-r l ${e.profit < 0 ? "neg-row" : ""}`} key={e.id}>
              <span className="dim">{new Date(e.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</span>
              <span>{e.seller}</span>
              <span>{e.subscriber}</span>
              <span>{e.packageName}</span>
              <span>{money(e.sale)}</span>
              <span>{money(e.cost)}</span>
              <span className={e.profit < 0 ? "neg" : "pos"}>{money(e.profit)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Card({ label, b, big }: { label: string; b: Bucket; big?: boolean }) {
  return (
    <div className={`pr-card ${big ? "big" : ""}`}>
      <span>{label}</span>
      <b>{money(b.profit)}</b>
      <i>{b.activations} activation{b.activations === 1 ? "" : "s"} · {money(b.sales)} sales</i>
    </div>
  );
}

const CSS = `
.pr{max-width:1050px}
.pr-empty{padding:26px;text-align:center;color:#94A3B8;font-size:13px}
.pr-note{background:rgba(60,80,224,.07);border:1px solid rgba(60,80,224,.3);border-radius:10px;padding:11px 14px;font-size:12px;line-height:1.75;color:#334155;margin-bottom:14px}
.pr-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:12px}
.pr-card{background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:3px}
.pr-card span{font-size:11.5px;color:#64748B;font-weight:600}
.pr-card b{font-size:20px;color:#157F43}
.pr-card i{font-style:normal;font-size:10.5px;color:#94A3B8}
.pr-card.big{border-color:#C6E9D3;background:#F2FBF5}
.pr-card.big b{font-size:25px}
.pr-range{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#F7F9FC;border:1px solid #E2E8F0;border-radius:10px;padding:9px 13px;margin-bottom:8px;font-size:12px;color:#64748B}
.pr-range input{height:32px;border:1px solid #E2E8F0;border-radius:7px;padding:0 9px;font-size:12px;font-family:inherit}
.pr-range .dim{color:#94A3B8}
.pr-range .clear,.pr-range .csv{background:#fff;border:1px solid #E2E8F0;border-radius:7px;padding:5px 12px;font-size:11.5px;font-weight:600;color:#3C50E0;cursor:pointer;font-family:inherit}
.pr-range .csv{margin-left:auto}
.pr-range-out{color:#1C2434}
.pr-sec{font-size:12.5px;font-weight:700;color:#1C2434;margin:16px 0 8px}
.pr-table{border:1px solid #E2E8F0;border-radius:12px;overflow:hidden;background:#fff}
.pr-h,.pr-r{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;padding:10px 14px;align-items:center}
.pr-h.l,.pr-r.l{grid-template-columns:1.3fr 1.1fr 1.4fr 1fr .9fr .9fr .9fr}
.pr-h{background:#F7F9FC;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748B}
.pr-r{border-top:1px solid #EEF2F7;font-size:12.5px;color:#1C2434}
.pr-r .nm{display:flex;flex-direction:column;font-weight:600}
.pr-r .nm em{font-style:normal;font-size:10.5px;color:#94A3B8;font-weight:500}
.pr-r .pos{color:#157F43;font-weight:700}
.pr-r .neg{color:#B02A37;font-weight:700}
.pr-r .dim{color:#94A3B8}
.pr-r.neg-row{background:rgba(176,42,55,.04)}
@media (max-width:820px){
  .pr-h{display:none}
  .pr-r,.pr-r.l{grid-template-columns:1fr 1fr;gap:4px 10px}
  .pr-r .nm{grid-column:1 / -1}
}
`;
