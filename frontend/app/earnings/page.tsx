"use client";

import React from "react";
import { useRouter } from "next/navigation";
import API from "../components/api";
import { money } from "../components/currency";
import { SkeletonCards, SkeletonChart } from "../components/skeleton";

/** Collections / earnings report — totals, daily trend, per-package & method. */
export default function EarningsPage() {
  const router = useRouter();
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { Authorization: `Bearer ${token}` };

  const [range, setRange] = React.useState(30);
  const [d, setD] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const [hoverDay, setHoverDay] = React.useState<number | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    const to = new Date(); const from = new Date(Date.now() - (range - 1) * 86400_000);
    try {
      const r = await fetch(`${API}/users/me/earnings?from=${from.toISOString().slice(0,10)}&to=${to.toISOString().slice(0,10)}`, { headers });
      if (r.ok) setD(await r.json());
    } catch { /* keep */ }
    setLoading(false);
  }, [token, range]);

  React.useEffect(() => { if (!token) { router.push("/login"); return; } load(); }, [token, load]);

  const exportCsv = () => {
    if (!d) return;
    const rows = [
      ["Collections report", `${new Date(d.from).toLocaleDateString()} – ${new Date(d.to).toLocaleDateString()}`],
      [], ["Day", "Collected", "Payments"],
      ...d.daily.map((x: any) => [x.day, x.total, x.count]),
      [], ["Package", "Collected", "Payments"],
      ...d.byPackage.map((x: any) => [x.package, x.total, x.count]),
    ];
    const csv = rows.map((r) => r.map((c: any) => `"${String(c ?? "").replace(/"/g,'""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = `collections-${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  const maxDay = d ? Math.max(1, ...d.daily.map((x: any) => x.total)) : 1;

  return (
    <div className="er">
      <style>{CSS}</style>
      <div className="er-head">
        <div><h1>Collections &amp; Earnings</h1><span>What you collected, by day, package and method</span></div>
        <div className="er-ctrl">
          {[7, 30, 90].map((r) => <button key={r} className={range===r?"on":""} onClick={() => setRange(r)}>{r}d</button>)}
          <button onClick={exportCsv} disabled={!d}>⬇ Export</button>
        </div>
      </div>

      {loading || !d ? <><SkeletonCards count={3} min={170} /><div style={{height:16}} /><SkeletonChart height={150} /></> : (
        <>
          <div className="er-kpis">
            <div className="er-k"><span>Total collected</span><b>{money(d.totalCollected)}</b><i>{d.paymentCount} payments</i></div>
            <div className="er-k"><span>Commission earned</span><b style={{color:"#4ade80"}}>{money(d.commission)}</b><i>this range</i></div>
            <div className="er-k"><span>Avg / day</span><b>{money(d.totalCollected / Math.max(1, range))}</b><i>over {range} days</i></div>
          </div>

          <div className="er-panel">
            <div className="er-t">Daily collections</div>
            {d.daily.length === 0 ? <div className="er-empty">No payments in this range.</div> : (
              <div className="er-bars">
                {d.daily.map((x: any, i: number) => (
                  <div key={x.day} className="er-bar"
                    onMouseEnter={() => setHoverDay(i)} onMouseLeave={() => setHoverDay(null)}>
                    <div className="b"><span style={{ height: `${Math.max(3, (x.total/maxDay)*100)}%` }} /></div>
                    <div className="lb">{x.day.slice(5)}</div>
                    {hoverDay === i && (
                      <div className="er-tip">
                        <b>{money(x.total)}</b>
                        <span>{new Date(x.day).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span>
                        <span>{x.count} payment{x.count === 1 ? "" : "s"}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="er-cols">
            <div className="er-panel">
              <div className="er-t">By package</div>
              {d.byPackage.map((x: any) => (
                <div key={x.package} className="er-row"><span>{x.package}</span><b>{money(x.total)}</b><i>{x.count}</i></div>
              ))}
              {d.byPackage.length === 0 && <div className="er-empty">—</div>}
            </div>
            <div className="er-panel">
              <div className="er-t">By method</div>
              {d.byMethod.map((x: any) => (
                <div key={x.method} className="er-row"><span>{x.method}</span><b>{money(x.total)}</b><i>{x.count}</i></div>
              ))}
              {d.byMethod.length === 0 && <div className="er-empty">—</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const CSS = `
.er{padding:20px;max-width:1000px;margin:0 auto;color:var(--text)}
.er-head{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.er-head h1{font-size:22px;font-weight:800;margin:0}
.er-head span{font-size:12px;color:var(--muted)}
.er-ctrl{display:flex;gap:6px}
.er-ctrl button{background:var(--surface);border:1px solid var(--border);color:var(--muted);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}
.er-ctrl button.on{border-color:var(--accent);color:var(--accent)}
.er-load{padding:50px;text-align:center;color:var(--muted)}
.er-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.er-k{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.er-k span{font-size:11.5px;color:var(--muted)}
.er-k b{display:block;font-size:26px;font-weight:800;margin-top:3px}
.er-k i{font-size:11px;color:var(--muted);font-style:normal}
.er-panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:14px}
.er-t{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:12px}
.er-empty{color:var(--muted);font-size:12px}
.er-bars{display:flex;align-items:flex-end;gap:3px;height:150px;overflow-x:auto;padding-bottom:4px}
.er-bar{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:16px;flex:1}
.er-bar .b{width:100%;height:120px;display:flex;align-items:flex-end;background:var(--surface-2);border-radius:4px;overflow:hidden}
.er-bar .b span{display:block;width:100%;background:linear-gradient(180deg,#7C4DFF,#4ade80)}
.er-bar{position:relative}
.er-bar:hover .b span{filter:brightness(1.25)}
.er-bar .lb{font-size:8.5px;color:var(--muted);white-space:nowrap}
.er-tip{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:6px;
  background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:7px 10px;
  display:flex;flex-direction:column;gap:2px;white-space:nowrap;z-index:3;pointer-events:none;
  box-shadow:0 8px 22px rgba(0,0,0,.45)}
.er-tip b{font-size:13px;color:var(--text)}
.er-tip span{font-size:10px;color:var(--muted)}
.er-cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:700px){.er-cols{grid-template-columns:1fr}}
.er-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px}
.er-row span{flex:1}
.er-row b{font-weight:800}
.er-row i{font-style:normal;color:var(--muted);font-size:11px;min-width:34px;text-align:right}
`;
