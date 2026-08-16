"use client";

import React from "react";
import API from "../components/api";
import { money } from "../components/currency";

/**
 * Accountability — the "am I earning or not" view.
 *
 * Period P&L (today / this week / this month / all-time), the balance flow
 * (what your parent loaded to you, what you loaded to your children, your wallet
 * now), and a per-child breakdown ("from this child you earned X, you loaded
 * them Y"). Every figure comes from recorded transactions.
 */
type Period = { revenue: number; collectedFromCustomers: number; marginFromDownline: number; activationCost: number; expenses: number; profit: number };
type Child = { id: number; name: string; role: string; balance: number; earnedFromThisChild: number; earnedThisMonth: number; balanceYouLoaded: number; subscribersInTree: number };
type Data = {
  account?: string;
  periods: { today: Period; week: Period; month: Period; all: Period };
  balance: { wallet: number; loadedFromParent: number; loadedToChildren: number };
  children: Child[];
};

const TABS: { id: keyof Data["periods"]; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "all", label: "All time" },
];

export default function Accountability() {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const H = { Authorization: `Bearer ${token}` };
  const [data, setData] = React.useState<Data | null>(null);
  const [period, setPeriod] = React.useState<keyof Data["periods"]>("month");
  const [err, setErr] = React.useState("");

  React.useEffect(() => {
    fetch(`${API}/organization/accountability`, { headers: H })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setData)
      .catch(() => setErr("Could not load accountability data."));
  }, []);

  if (err) return <div className="ac-empty">{err}</div>;
  if (!data) return <div className="ac-empty">Loading…</div>;

  const p = data.periods[period];
  const profitPositive = p.profit >= 0;

  return (
    <div className="ac">
      <style>{CSS}</style>

      {/* Period switch */}
      <div className="ac-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={period === t.id ? "on" : ""} onClick={() => setPeriod(t.id)}>{t.label}</button>
        ))}
      </div>

      {/* Headline P&L for the chosen period */}
      <div className="ac-cards">
        <div className={`ac-card big ${profitPositive ? "good" : "bad"}`}>
          <span>{profitPositive ? "Profit" : "Loss"}</span>
          <b>{money(p.profit)}</b>
          <i>{TABS.find((t) => t.id === period)?.label.toLowerCase()}</i>
        </div>
        <div className="ac-card"><span>Revenue</span><b>{money(p.revenue)}</b><i>collected {money(p.collectedFromCustomers)} + margin {money(p.marginFromDownline)}</i></div>
        <div className="ac-card"><span>Activation cost</span><b className="neg">{money(p.activationCost)}</b><i>paid to your parent</i></div>
        <div className="ac-card"><span>Expenses</span><b className="neg">{money(p.expenses)}</b><i>approved this period</i></div>
      </div>

      {/* Balance flow */}
      <div className="ac-sec">Wallet &amp; balance flow</div>
      <div className="ac-cards">
        <div className="ac-card"><span>Your wallet now</span><b>{money(data.balance.wallet)}</b><i>current balance</i></div>
        <div className="ac-card"><span>Loaded to you</span><b style={{ color: "#157F43" }}>{money(data.balance.loadedFromParent)}</b><i>top-ups from your parent (all-time)</i></div>
        <div className="ac-card"><span>You loaded to children</span><b style={{ color: "#8A6209" }}>{money(data.balance.loadedToChildren)}</b><i>top-ups you funded (all-time)</i></div>
      </div>

      {/* Per-child breakdown */}
      <div className="ac-sec">Per child — what each earns you</div>
      {data.children.length === 0 ? (
        <div className="ac-empty">You have no child accounts yet. When you do, each one's earnings and balance appear here.</div>
      ) : (
        <div className="ac-table">
          <div className="ac-h">
            <span>Account</span><span>Earned (all)</span><span>Earned (month)</span><span>You loaded</span><span>Their wallet</span><span>Subs</span>
          </div>
          {data.children.map((c) => (
            <div key={c.id} className="ac-r">
              <span className="nm">{c.name}<em>{c.role}</em></span>
              <span className="pos">{money(c.earnedFromThisChild)}</span>
              <span>{money(c.earnedThisMonth)}</span>
              <span>{money(c.balanceYouLoaded)}</span>
              <span>{money(c.balance)}</span>
              <span>{c.subscribersInTree}</span>
            </div>
          ))}
        </div>
      )}
      <p className="ac-note">Profit = money collected from your customers + margin earned from your downline − what you paid your parent to activate − approved expenses. Unpaid invoices are not counted as profit.</p>
    </div>
  );
}

const CSS = `
.ac{max-width:1000px}
.ac-empty{padding:26px;text-align:center;color:#94A3B8;font-size:13px}
.ac-tabs{display:inline-flex;background:#F1F5F9;border-radius:9px;padding:3px;margin-bottom:14px;flex-wrap:wrap}
.ac-tabs button{border:none;background:transparent;padding:7px 15px;border-radius:7px;font-size:13px;font-weight:600;color:#64748B;cursor:pointer;font-family:inherit}
.ac-tabs button.on{background:#3C50E0;color:#fff}
.ac-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:8px}
.ac-card{background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:13px 15px;display:flex;flex-direction:column;gap:3px}
.ac-card span{font-size:11.5px;color:#64748B;font-weight:600}
.ac-card b{font-size:20px;color:#1C2434}
.ac-card b.neg{color:#B02A37}
.ac-card i{font-style:normal;font-size:10.5px;color:#94A3B8}
.ac-card.big b{font-size:26px}
.ac-card.big.good{border-color:#C6E9D3;background:#F2FBF5}.ac-card.big.good b{color:#157F43}
.ac-card.big.bad{border-color:#F5C2C7;background:#FEF5F5}.ac-card.big.bad b{color:#B02A37}
.ac-sec{font-size:12.5px;font-weight:700;color:#1C2434;margin:16px 0 8px}
.ac-table{border:1px solid #E2E8F0;border-radius:12px;overflow:hidden}
.ac-h,.ac-r{display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr 1fr .6fr;gap:8px;padding:10px 14px;align-items:center}
.ac-h{background:#F7F9FC;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748B}
.ac-r{border-top:1px solid #EEF2F7;font-size:13px;color:#1C2434}
.ac-r .nm{display:flex;flex-direction:column;font-weight:600}
.ac-r .nm em{font-style:normal;font-size:10.5px;color:#94A3B8;font-weight:500}
.ac-r .pos{color:#157F43;font-weight:600}
.ac-note{font-size:11px;color:#94A3B8;line-height:1.6;margin-top:12px}
@media (max-width:768px){
  .ac-h{display:none}
  .ac-r{grid-template-columns:1fr 1fr;gap:4px 10px}
  .ac-r .nm{grid-column:1 / -1;margin-bottom:2px}
  .ac-r span:not(.nm)::before{font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase}
  .ac-r span:nth-child(2)::before{content:"Earned all: "}
  .ac-r span:nth-child(3)::before{content:"Month: "}
  .ac-r span:nth-child(4)::before{content:"Loaded: "}
  .ac-r span:nth-child(5)::before{content:"Wallet: "}
  .ac-r span:nth-child(6)::before{content:"Subs: "}
}
`;
