"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { money, currencySymbol } from "../components/currency";
import { ComparisonBars, DivergingBars, DualBars, StackedBar, Delta } from "../components/charts";

const API =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

/**
 * Reports.
 *
 * The previous version drew a pie of package counts and two empty chart
 * placeholders. None of it could answer "is this better or worse than
 * before", which is the only question a report exists to answer. Every panel
 * here carries a baseline: the preceding period of equal length, a second
 * measure of the same thing, or the age of the debt.
 *
 * Note: no `.db-root` class — in globals.css that is the app shell's own flex
 * wrapper, and applying it to a page breaks the layout.
 */

const GRAINS = [
  { id: "day",   label: "Daily",   points: 30, note: "last 30 days vs the 30 before" },
  { id: "week",  label: "Weekly",  points: 12, note: "last 12 weeks vs the 12 before" },
  { id: "month", label: "Monthly", points: 12, note: "last 12 months vs the 12 before" },
];

export default function ReportsPage() {
  const router = useRouter();
  const [grain, setGrain] = useState("day");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [aged, setAged] = useState<any>(null);
  const [perf, setPerf] = useState<any>(null);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const cur = currencySymbol();

  const load = useCallback(async () => {
    const g = GRAINS.find((x) => x.id === grain)!;
    try {
      const r = await fetch(`${API}/reports/analytics?grain=${g.id}&points=${g.points}`, { headers });
      if (r.ok) setData(await r.json());
    } catch { /* keep the last good view */ }
    try {
      const [a, p] = await Promise.all([
        fetch(`${API}/reports/aged-debt`, { headers }),
        fetch(`${API}/reports/reseller-performance`, { headers }),
      ]);
      if (a.ok) setAged(await a.json());
      if (p.ok) setPerf(await p.json());
    } catch { /* optional sections */ }
    setLoading(false);
  }, [token, grain]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    load();
  }, [token, grain]);

  function exportCsv() {
    const rows = data?.revenue?.points ?? [];
    if (!rows.length) return;
    const csv = [
      "Period,Revenue,Previous,Change,Payments",
      ...rows.map((p: any) => [p.label, p.value, p.previous, p.value - p.previous, p.payments].join(",")),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `revenue-${grain}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const rev = data?.revenue;
  const growth = data?.growth;
  const pkgs = data?.packages;
  const coll = data?.collections;
  const g = GRAINS.find((x) => x.id === grain)!;

  if (loading) {
    return <div style={{ padding: 30, color: "var(--muted)", fontSize: 13 }}>Building reports…</div>;
  }

  return (
    <div className="rp">
      <style>{CSS}</style>

      <div className="rp-bar">
        <div className="rp-seg">
          {GRAINS.map((x) => (
            <button key={x.id} className={grain === x.id ? "on" : ""} onClick={() => setGrain(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <span className="rp-note">Comparing {g.note}</span>
        <div className="rp-actions">
          <button onClick={load}>Refresh</button>
          <button onClick={exportCsv} className="primary">Export CSV</button>
        </div>
      </div>

      {/* Headline figures, each against a baseline */}
      <div className="rp-kpis">
        <div className="rp-kpi">
          <span className="k">Revenue collected</span>
          <Delta value={rev?.summary?.total ?? 0} previous={rev?.summary?.previousTotal ?? 0}
            percent={rev?.summary?.changePercent ?? null} prefix={cur} />
          <span className="s">
            Best period: {rev?.summary?.best?.label ?? "—"}
            {rev?.summary?.best ? ` · ${money(rev.summary.best.value)}` : ""}
          </span>
        </div>

        <div className="rp-kpi">
          <span className="k">Net subscriber change</span>
          <div className="rp-net">
            <b className={(growth?.summary?.net ?? 0) >= 0 ? "up" : "down"}>
              {(growth?.summary?.net ?? 0) >= 0 ? "+" : ""}{growth?.summary?.net ?? 0}
            </b>
            <span className="up">+{growth?.summary?.joined ?? 0} joined</span>
            <span className="down">−{growth?.summary?.left ?? 0} left</span>
          </div>
          <span className="s">Churn {growth?.summary?.churnRate ?? 0}% of the base over 12 months</span>
        </div>

        <div className="rp-kpi">
          <span className="k">Collection rate</span>
          <div className="rp-rate">
            <b style={{ color: rateColor(coll?.totals?.collectionRate ?? 100) }}>
              {coll?.totals?.collectionRate ?? 100}%
            </b>
            <div className="rp-rate-track">
              <div style={{ width: `${coll?.totals?.collectionRate ?? 0}%`,
                background: rateColor(coll?.totals?.collectionRate ?? 100) }} />
            </div>
          </div>
          <span className="s">
            {money(coll?.totals?.collected ?? 0)} of {money(coll?.totals?.billed ?? 0)} billed
          </span>
        </div>

        <div className="rp-kpi">
          <span className="k">Outstanding</span>
          <div className="rp-out">{money(coll?.totals?.outstanding ?? 0)}</div>
          <span className="s">
            {coll?.buckets?.filter((b: any) => b.key !== "current")
              .reduce((s: number, b: any) => s + b.count, 0) ?? 0} overdue invoices
          </span>
        </div>
      </div>

      <section className="rp-card">
        <header>
          <div>
            <h3>Revenue</h3>
            <p>Solid bars are this period. The pale bar behind each is the same point in the previous period — where the solid bar is shorter, takings fell.</p>
          </div>
          <span className="rp-avg">Average {money(rev?.summary?.average ?? 0)} per {grain}</span>
        </header>
        <div className="body"><ComparisonBars data={rev?.points ?? []} prefix={cur} /></div>
      </section>

      <div className="rp-two">
        <section className="rp-card">
          <header>
            <div>
              <h3>Subscriber movement</h3>
              <p>Joiners and leavers shown separately. A single growth line always slopes upward and hides churn.</p>
            </div>
          </header>
          <div className="body"><DivergingBars data={growth?.points ?? []} /></div>
        </section>

        <section className="rp-card">
          <header>
            <div>
              <h3>Debt by age</h3>
              <p>How long the unpaid has been unpaid. Thirty days is a phone call; ninety is usually a write-off.</p>
            </div>
          </header>
          <div className="body">
            <StackedBar segments={coll?.buckets ?? []} total={coll?.totals?.outstanding ?? 0} prefix={cur} />
          </div>
        </section>
      </div>

      <section className="rp-card">
        <header>
          <div>
            <h3>Packages — customers against revenue</h3>
            <p>The same plans measured both ways. Where the two bars disagree, a plan is carrying more or less of the business than its customer count suggests.</p>
          </div>
          <span className="rp-avg">ARPU {money(pkgs?.totals?.arpu ?? 0)}</span>
        </header>
        <div className="body">
          <DualBars
            aLabel="Customers" bLabel="Monthly revenue" bPrefix={cur}
            rows={(pkgs?.rows ?? []).map((r: any) => ({
              name: r.name, a: r.subscribers, b: r.monthlyRevenue,
              aShare: r.subscriberShare, bShare: r.revenueShare,
            }))}
          />
        </div>
      </section>

      {coll?.worst?.length > 0 && (
        <section className="rp-card">
          <header>
            <div>
              <h3>Worth chasing first</h3>
              <p>Ranked by amount rather than age — the oldest debt is often small, the largest is what hurts cash flow.</p>
            </div>
          </header>
          <div className="rp-tablewrap">
            <table className="rp-table">
              <thead>
                <tr><th>Customer</th><th>Invoice</th><th className="r">Amount</th><th className="r">Overdue</th></tr>
              </thead>
              <tbody>
                {coll.worst.map((w: any) => (
                  <tr key={w.invoiceNo} onClick={() => w.subscriberId && router.push(`/subscribers/${w.subscriberId}`)}>
                    <td><b>{w.customer}</b><em>{w.username}{w.phone ? ` · ${w.phone}` : ""}</em></td>
                    <td className="muted">{w.invoiceNo}</td>
                    <td className="r strong">{money(w.amount)}</td>
                    <td className="r" style={{ color: ageColor(w.daysOverdue), fontWeight: 600 }}>
                      {w.daysOverdue === 0 ? "due" : `${w.daysOverdue}d`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {aged && aged.count > 0 && (
        <section className="rp-card">
          <header className="rp-head">
            <div>
              <h3>Aged receivables — {money(aged.total)} outstanding</h3>
              <p>Unpaid invoices bucketed by how overdue they are, across {aged.count} invoice(s).</p>
            </div>
          </header>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "4px 20px 16px" }}>
            {[["Current", aged.buckets.current], ["1–30 days", aged.buckets.d1_30], ["31–60", aged.buckets.d31_60], ["61–90", aged.buckets.d61_90], ["90+ days", aged.buckets.d90plus]].map(([label, val]: any) => (
              <div key={label} style={{ minWidth: 110, padding: 12, borderRadius: 10, border: "1px solid var(--border)" }}>
                <div style={{ fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, marginTop: 3 }}>{money(val)}</div>
              </div>
            ))}
          </div>
          <div className="rp-tablewrap">
            <table className="rp-table">
              <thead><tr><th>Debtor</th><th className="r">Owed</th><th className="r">Invoices</th><th className="r">Oldest</th></tr></thead>
              <tbody>
                {aged.debtors.slice(0, 25).map((d: any) => (
                  <tr key={d.subscriberId} onClick={() => d.subscriberId && router.push(`/subscribers/${d.subscriberId}`)}>
                    <td><b>{d.name}</b><em>{d.username}</em></td>
                    <td className="r strong">{money(d.owed)}</td>
                    <td className="r muted">{d.invoices}</td>
                    <td className="r" style={{ color: ageColor(d.oldestDays), fontWeight: 600 }}>{d.oldestDays}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {perf && perf.accounts.length > 0 && (
        <section className="rp-card">
          <header className="rp-head">
            <div>
              <h3>Reseller performance</h3>
              <p>{perf.totals.active} active subscribers · {money(perf.totals.mrr)} monthly revenue · {money(perf.totals.profit)} profit across {perf.accounts.length} account(s).</p>
            </div>
          </header>
          <div className="rp-tablewrap">
            <table className="rp-table">
              <thead>
                <tr><th>Account</th><th className="r">Active</th><th className="r">MRR</th><th className="r">Cost</th><th className="r">Profit</th><th className="r">Wallet</th></tr>
              </thead>
              <tbody>
                {perf.accounts.map((a: any) => (
                  <tr key={a.userId} onClick={() => router.push(`/users/${a.userId}`)}>
                    <td><b>{a.name}</b><em>{a.role}</em></td>
                    <td className="r">{a.active}/{a.subscribers}</td>
                    <td className="r strong">{money(a.mrr)}</td>
                    <td className="r muted">{money(a.cost)}</td>
                    <td className="r" style={{ color: a.profit >= 0 ? "#22c55e" : "#ef4444", fontWeight: 600 }}>{money(a.profit)}</td>
                    <td className="r" style={{ color: a.balance < 0 ? "#ef4444" : "var(--text)" }}>{money(a.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

const rateColor = (r: number) => (r >= 90 ? "#10b981" : r >= 70 ? "#f59e0b" : "#ef4444");
const ageColor = (d: number) => (d > 90 ? "#991b1b" : d > 60 ? "#ef4444" : d > 30 ? "#f97316" : "#f59e0b");

const CSS = `
.rp { padding: 4px 2px 24px; color: var(--text); font-variant-numeric: tabular-nums; }

.rp-bar { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-bottom:18px; }
.rp-seg { display:inline-flex; gap:2px; padding:3px; border-radius:11px;
  background:var(--surface-2); border:1px solid var(--border); }
.rp-seg button { border:none; background:transparent; color:var(--muted); cursor:pointer;
  padding:7px 15px; border-radius:8px; font-size:12.5px; font-weight:500;
  transition:color .15s, background .15s, transform .12s; }
.rp-seg button:hover { color:var(--text); }
.rp-seg button:active { transform:scale(.96); }
.rp-seg button.on { background:var(--surface); color:var(--text); font-weight:600;
  box-shadow:0 1px 3px rgba(0,0,0,.28); }
.rp-note { font-size:12px; color:var(--muted); }
.rp-actions { margin-left:auto; display:flex; gap:8px; }
.rp-actions button { border:1px solid var(--border); background:var(--surface); color:var(--text);
  border-radius:9px; padding:7px 15px; font-size:12px; font-weight:500; cursor:pointer;
  transition:background .15s, border-color .15s, transform .12s; }
.rp-actions button:hover { background:var(--surface-2); border-color:#3b82f6; }
.rp-actions button:active { transform:scale(.97); }
.rp-actions button.primary { background:#3b82f6; border-color:#3b82f6; color:#fff; }
.rp-actions button.primary:hover { background:#2563eb; }

.rp-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr));
  background:var(--surface); border:1px solid var(--border); border-radius:14px;
  overflow:hidden; margin-bottom:18px; }
.rp-kpi { padding:16px 20px; position:relative; transition:background .18s; }
.rp-kpi + .rp-kpi { border-left:1px solid var(--border); }
.rp-kpi:hover { background:var(--surface-2); }
.rp-kpi::after { content:""; position:absolute; left:0; right:0; bottom:0; height:2px;
  background:linear-gradient(90deg,#3b82f6,#8b5cf6); transform:scaleX(0); transform-origin:left;
  transition:transform .25s ease; }
.rp-kpi:hover::after { transform:scaleX(1); }
.rp-kpi .k { display:block; font-size:10px; font-weight:600; color:var(--muted);
  text-transform:uppercase; letter-spacing:.07em; margin-bottom:7px; }
.rp-kpi .s { display:block; font-size:11px; color:var(--muted); margin-top:6px; }
.rp-net { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.rp-net b { font-size:26px; font-weight:700; letter-spacing:-.02em; }
.rp-net .up, .rp-net b.up { color:#10b981; }
.rp-net .down, .rp-net b.down { color:#ef4444; }
.rp-net span { font-size:12px; font-weight:600; }
.rp-rate { display:flex; align-items:center; gap:12px; }
.rp-rate b { font-size:26px; font-weight:700; letter-spacing:-.02em; }
.rp-rate-track { flex:1; height:6px; background:var(--surface-2); border-radius:99px; overflow:hidden; }
.rp-rate-track div { height:100%; border-radius:99px; transition:width .6s cubic-bezier(.4,0,.2,1); }
.rp-out { font-size:26px; font-weight:700; letter-spacing:-.02em; color:#f59e0b; }

.rp-card { background:var(--surface); border:1px solid var(--border); border-radius:14px;
  overflow:hidden; margin-bottom:16px; }
.rp-card > header { display:flex; justify-content:space-between; align-items:flex-start;
  gap:16px; padding:16px 20px 14px; border-bottom:1px solid var(--border); }
.rp-card h3 { margin:0; font-size:13.5px; font-weight:600; }
.rp-card header p { margin:4px 0 0; font-size:11.5px; color:var(--muted); line-height:1.55; max-width:640px; }
.rp-avg { font-size:11.5px; color:var(--muted); white-space:nowrap; }
.rp-card .body { padding:18px 20px 16px; }

.rp-two { display:grid; grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); gap:16px; }

.rp-tablewrap { overflow-x:auto; }
.rp-table { width:100%; border-collapse:collapse; min-width:480px; }
.rp-table th { text-align:left; padding:11px 20px; font-size:10px; font-weight:600; color:var(--muted);
  text-transform:uppercase; letter-spacing:.07em; border-bottom:1px solid var(--border); }
.rp-table td { padding:12px 20px; font-size:13px; border-bottom:1px solid var(--border); }
.rp-table th.r, .rp-table td.r { text-align:right; }
.rp-table td.muted { color:var(--muted); }
.rp-table td.strong { font-weight:600; }
.rp-table tbody tr { cursor:pointer; transition:background .13s; }
.rp-table tbody tr:hover { background:var(--surface-2); }
.rp-table tbody tr:last-child td { border-bottom:none; }
.rp-table td b { font-weight:500; display:block; }
.rp-table td em { font-style:normal; display:block; font-size:11px; color:var(--muted); margin-top:1px; }
`;
