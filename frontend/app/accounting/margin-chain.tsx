"use client";

import React from "react";
import API from "../components/api";
import { money } from "../components/currency";

/**
 * Margin chain — one row per sale, showing what every tier took.
 *
 * The Profit Report answers "what did I earn". This answers the question that
 * decides pricing: "on this sale, who took what?" A franchise reselling at
 * near cost, or a package whose ladder leaves the ISP almost nothing, is
 * invisible in a report that only ever shows your own line.
 *
 * Tiers above you are never shown — a parent's margin is your own buy price.
 * When tiers are withheld the row says so rather than presenting a short
 * chain as though it were the whole thing.
 */
type Tier = {
  userId: number;
  name: string;
  role: string | null;
  roleLabel: string;
  sale: number;
  cost: number;
  profit: number;
  note?: string | null;
};
type Row = {
  reference: string;
  at: string | null;
  subscriberId: number | null;
  subscriber: string;
  packageName: string;
  seller: string;
  sellerRole: string | null;
  isReversal: boolean;
  customerPaid: number;
  tiers: Tier[];
  chainProfit: number;
  hiddenTiers: number;
};
type Data = {
  rows: Row[];
  tiers: { role: string; label: string }[];
  totals: { sales: number; profit: number; count: number };
};

export default function MarginChain() {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const H = { Authorization: `Bearer ${token}` };
  const [data, setData] = React.useState<Data | null>(null);
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [err, setErr] = React.useState("");
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    setLoading(true);
    try {
      const r = await fetch(`${API}/organization/profit/margin-chain?${qs}`, { headers: H });
      if (!r.ok) { setErr("Could not load the margin chain."); setLoading(false); return; }
      setData(await r.json());
      setErr("");
    } catch {
      setErr("Could not load the margin chain.");
    }
    setLoading(false);
  }, [from, to]);
  React.useEffect(() => { load(); }, [load]);

  /** Margin this tier took on this sale, or null if it took none. */
  const tierOf = (row: Row, role: string) => row.tiers.find((t) => t.role === role) ?? null;

  const exportCsv = () => {
    if (!data) return;
    const head = [
      "Date", "Reference", "Customer", "Package", "Sold by", "Customer paid",
      ...data.tiers.flatMap((t) => [`${t.label} price`, `${t.label} profit`]),
      "Total margin",
    ];
    const body = data.rows.map((r) => [
      r.at ? new Date(r.at).toLocaleString() : "",
      r.reference, r.subscriber, r.packageName, r.seller, r.customerPaid,
      ...data.tiers.flatMap((t) => {
        const hit = tierOf(r, t.role);
        return [hit ? hit.sale : "", hit ? hit.profit : ""];
      }),
      r.chainProfit,
    ]);
    const csv = [head, ...body]
      .map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `margin-chain-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    a.remove();
  };

  if (err) return <div className="mc-empty">{err}</div>;
  if (!data && loading) return <div className="mc-empty">Loading…</div>;
  if (!data) return <div className="mc-empty">No data.</div>;

  // Grid: date · customer · package · sold by · paid · (price+profit per tier) · total
  const cols = `1.15fr 1.35fr 1.1fr 1.15fr .85fr ${data.tiers.map(() => ".8fr .8fr").join(" ")} .85fr`;
  const anyHidden = data.rows.some((r) => r.hiddenTiers > 0);

  return (
    <div className="mc">
      <style>{CSS}</style>

      <div className="mc-note">
        <b>Every sale, and what each tier took from it.</b> Use this to find margin being
        absorbed — a package where your own share is near zero, or an account reselling at
        barely above its buy price. Figures come from the profit ledger, so a reversal shows
        as a negative row rather than disappearing.
        {anyHidden && (
          <> <span className="mc-priv">Tiers above your account are not shown: their margin is
          your own buy price.</span></>
        )}
      </div>

      <div className="mc-cards">
        <div className="mc-card">
          <span>Sales in view</span>
          <b>{data.totals.count}</b>
        </div>
        <div className="mc-card">
          <span>Customers paid</span>
          <b>{money(data.totals.sales)}</b>
        </div>
        <div className="mc-card big">
          <span>Margin visible to you</span>
          <b>{money(data.totals.profit)}</b>
          <i>
            {data.totals.sales > 0
              ? `${((data.totals.profit / data.totals.sales) * 100).toFixed(1)}% of what customers paid`
              : "—"}
          </i>
        </div>
      </div>

      <div className="mc-range">
        <span>Date range</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="dim">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        {(from || to) && (
          <button className="clear" onClick={() => { setFrom(""); setTo(""); }}>Clear</button>
        )}
        <button className="csv" onClick={exportCsv}>Export CSV</button>
      </div>

      {data.rows.length === 0 ? (
        <div className="mc-empty">
          No sales in this range. Rows appear when an account activates or renews a customer.
        </div>
      ) : (
        <div className="mc-scroll">
          <div className="mc-table" style={{ minWidth: 220 + data.tiers.length * 150 }}>
            <div className="mc-h" style={{ gridTemplateColumns: cols }}>
              <span>Date</span>
              <span>Customer</span>
              <span>Package</span>
              <span>Sold by</span>
              <span className="num">Paid</span>
              {data.tiers.map((t) => (
                <React.Fragment key={t.role}>
                  <span className="num tier-start">{t.label} price</span>
                  <span className="num">{t.label} margin</span>
                </React.Fragment>
              ))}
              <span className="num">Total</span>
            </div>

            {data.rows.map((r) => (
              <div
                className={`mc-r ${r.isReversal ? "rev" : ""}`}
                style={{ gridTemplateColumns: cols }}
                key={r.reference}
              >
                <span className="dim">
                  {r.at ? new Date(r.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—"}
                </span>
                <span className="nm">
                  {r.subscriber}
                  {r.isReversal && <em>reversal</em>}
                  {r.hiddenTiers > 0 && (
                    <em title="A parent's margin is your buy price, so it is not shown.">
                      +{r.hiddenTiers} tier{r.hiddenTiers === 1 ? "" : "s"} above you
                    </em>
                  )}
                </span>
                <span>{r.packageName}</span>
                <span className="nm">
                  {r.seller}
                  {r.sellerRole && <em>{r.sellerRole}</em>}
                </span>
                <span className="num strong">{money(r.customerPaid)}</span>

                {data.tiers.map((t) => {
                  const hit = tierOf(r, t.role);
                  return (
                    <React.Fragment key={t.role}>
                      <span className="num dim tier-start">{hit ? money(hit.sale) : "—"}</span>
                      <span
                        className={`num ${hit ? (hit.profit < 0 ? "neg" : hit.profit === 0 ? "zero" : "pos") : "dim"}`}
                        title={hit ? `${hit.name} — cost ${hit.cost}` : "This tier took no margin on this sale"}
                      >
                        {hit ? money(hit.profit) : "—"}
                      </span>
                    </React.Fragment>
                  );
                })}

                <span className={`num strong ${r.chainProfit < 0 ? "neg" : "pos"}`}>
                  {money(r.chainProfit)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mc-foot">
        A <b>zero margin</b> where you expect one usually means no reseller price is set for
        that account on that package — check Reseller Pricing. <b>Paid</b> is what the
        customer was charged; each tier&rsquo;s <b>price</b> is what the tier below it paid.
      </div>
    </div>
  );
}

const CSS = `
.mc{max-width:1400px}
.mc-empty{padding:26px;text-align:center;color:#94A3B8;font-size:13px}
.mc-note{background:rgba(60,80,224,.07);border:1px solid rgba(60,80,224,.3);border-radius:10px;padding:11px 14px;font-size:12px;line-height:1.75;color:#334155;margin-bottom:14px}
.mc-priv{color:#8A5A12;background:rgba(217,158,48,.13);border-radius:5px;padding:1px 6px}
.mc-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:12px}
.mc-card{background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:3px}
.mc-card span{font-size:11.5px;color:#64748B;font-weight:600}
.mc-card b{font-size:20px;color:#1C2434;font-variant-numeric:tabular-nums}
.mc-card i{font-style:normal;font-size:10.5px;color:#94A3B8}
.mc-card.big{border-color:#C6E9D3;background:#F2FBF5}
.mc-card.big b{font-size:25px;color:#157F43}
.mc-range{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#F7F9FC;border:1px solid #E2E8F0;border-radius:10px;padding:9px 13px;margin-bottom:10px;font-size:12px;color:#64748B}
.mc-range input{height:32px;border:1px solid #E2E8F0;border-radius:7px;padding:0 9px;font-size:12px;font-family:inherit}
.mc-range .dim{color:#94A3B8}
.mc-range .clear,.mc-range .csv{background:#fff;border:1px solid #E2E8F0;border-radius:7px;padding:5px 12px;font-size:11.5px;font-weight:600;color:#3C50E0;cursor:pointer;font-family:inherit}
.mc-range .csv{margin-left:auto}
.mc-scroll{overflow-x:auto;border:1px solid #E2E8F0;border-radius:12px;background:#fff}
.mc-table{min-width:100%}
.mc-h,.mc-r{display:grid;gap:8px;padding:10px 14px;align-items:center}
.mc-h{background:#F7F9FC;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748B;position:sticky;top:0}
.mc-r{border-top:1px solid #EEF2F7;font-size:12.5px;color:#1C2434}
.mc-r:hover{background:#FAFBFE}
.mc-r .nm{display:flex;flex-direction:column;font-weight:600;min-width:0}
.mc-r .nm em{font-style:normal;font-size:10px;color:#94A3B8;font-weight:500}
.mc-h .num,.mc-r .num{text-align:right;font-variant-numeric:tabular-nums}
.mc-h .tier-start,.mc-r .tier-start{border-left:1px solid #EEF2F7;padding-left:8px}
.mc-r .pos{color:#157F43;font-weight:600}
.mc-r .neg{color:#B02A37;font-weight:600}
.mc-r .zero{color:#B4801A;font-weight:600}
.mc-r .dim{color:#94A3B8}
.mc-r .strong{font-weight:700}
.mc-r.rev{background:rgba(176,42,55,.04)}
.mc-foot{font-size:11.5px;color:#94A3B8;line-height:1.7;margin-top:10px}
@media (max-width:820px){
  .mc-cards{grid-template-columns:1fr 1fr}
}
`;
