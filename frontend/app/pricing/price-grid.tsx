"use client";

import React from "react";

/**
 * PriceGrid — set a DIFFERENT price for each account, at scale.
 *
 * The multi-select flow only ever applies ONE price to everyone selected, which
 * is wrong the moment F1 should pay 500 and F2 should pay 600. This is the
 * opposite: pick a package, then every account below you is a row with its own
 * editable price and its own Save. Search narrows a 1000-account downline to
 * the few you're changing; "apply to all shown" is there for the genuine
 * bulk case, but the default is per-account.
 */

type Acct = { id: number; name: string; role?: string };

export function PriceGrid({
  packages, direct, prices, myCost, headers, api, money, onSaved,
}: {
  packages: any[];
  direct: Acct[];
  prices: any[];
  myCost: (packageId: number) => number | undefined;
  headers: Record<string, string>;
  api: string;
  money: (n: number) => string;
  onSaved: () => void;
}) {
  const [pkgId, setPkgId] = React.useState<number | null>(packages[0]?.id ?? null);
  const [q, setQ] = React.useState("");
  const [draft, setDraft] = React.useState<Record<number, string>>({});
  const [busy, setBusy] = React.useState<number | null>(null);
  const [saved, setSaved] = React.useState<Record<number, boolean>>({});
  const [bulk, setBulk] = React.useState("");
  const [page, setPage] = React.useState(1);
  const PER = 25;

  React.useEffect(() => { setPage(1); }, [q, pkgId]);

  const cost = pkgId != null ? myCost(pkgId) : undefined;
  const current = (accId: number) =>
    pkgId == null ? undefined
      : prices.find((p) => p.userId === accId && p.packageId === pkgId)?.price;

  const filtered = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? direct.filter((a) => a.name.toLowerCase().includes(s)) : direct;
  }, [direct, q]);
  const shown = filtered.slice((page - 1) * PER, page * PER);
  const pages = Math.max(1, Math.ceil(filtered.length / PER));

  async function saveOne(accId: number) {
    if (pkgId == null) return;
    const raw = draft[accId];
    const val = Number(raw);
    if (raw == null || raw === "" || Number.isNaN(val) || val < 0) return;
    setBusy(accId);
    try {
      const r = await fetch(`${api}/organization/pricing`, {
        method: "PUT", headers,
        body: JSON.stringify({ userId: accId, packageId: pkgId, price: val }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || "Save failed");
      setSaved((m) => ({ ...m, [accId]: true }));
      setTimeout(() => setSaved((m) => ({ ...m, [accId]: false })), 1600);
      onSaved();
    } catch (e: any) {
      alert(e?.message || "Could not save this price");
    } finally { setBusy(null); }
  }

  const applyBulk = () => {
    const v = bulk.trim();
    if (!v) return;
    const next: Record<number, string> = { ...draft };
    for (const a of shown) next[a.id] = v;
    setDraft(next);
  };

  const margin = (accPrice?: number) =>
    accPrice != null && cost != null ? accPrice - cost : undefined;

  return (
    <div className="pg">
      <style>{CSS}</style>
      <div className="pg-head">
        <div className="pg-field">
          <label>Package</label>
          <select value={pkgId ?? ""} onChange={(e) => setPkgId(Number(e.target.value))}>
            {packages.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.downloadSpeed ? ` · ${p.downloadSpeed}` : ""}</option>
            ))}
          </select>
        </div>
        <div className="pg-field grow">
          <label>Find account</label>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a franchise name…" />
        </div>
        <div className="pg-cost">
          <span>Your cost</span>
          <b>{cost != null ? money(cost) : "—"}</b>
        </div>
      </div>

      <div className="pg-bulk">
        <span>{filtered.length} account{filtered.length === 1 ? "" : "s"}{q ? " match" : ""}</span>
        <div>
          <input value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder="price" inputMode="numeric" />
          <button onClick={applyBulk} disabled={!bulk.trim()}>Fill all shown</button>
        </div>
      </div>

      <div className="pg-rows">
        {shown.map((a) => {
          const cur = current(a.id);
          const dv = draft[a.id];
          const preview = dv !== undefined && dv !== "" ? Number(dv) : cur;
          const m = margin(preview);
          return (
            <div key={a.id} className="pg-row">
              <div className="pg-acct">
                <span className="nm">{a.name}</span>
                <span className="rl">{a.role || "account"}</span>
              </div>
              <div className="pg-now">
                <span className="k">Pays now</span>
                <span className="v">{cur != null ? money(cur) : <em>not set</em>}</span>
              </div>
              <div className="pg-margin">
                <span className="k">Your margin</span>
                <span className="v" style={{ color: m == null ? "#94A3B8" : m >= 0 ? "#157F43" : "#B02A37" }}>
                  {m == null ? "—" : `${m >= 0 ? "+" : ""}${money(m)}`}
                </span>
              </div>
              <div className="pg-set">
                <input
                  value={dv ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [a.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") saveOne(a.id); }}
                  placeholder={cur != null ? String(cur) : "price"}
                  inputMode="numeric"
                />
                <button onClick={() => saveOne(a.id)} disabled={busy === a.id || dv == null || dv === ""}>
                  {busy === a.id ? "…" : saved[a.id] ? "✓" : "Save"}
                </button>
              </div>
            </div>
          );
        })}
        {shown.length === 0 && <div className="pg-empty">No accounts match “{q}”.</div>}
      </div>

      {pages > 1 && (
        <div className="pg-pager">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>Prev</button>
          <span>Page {page} of {pages}</span>
          <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages}>Next</button>
        </div>
      )}
    </div>
  );
}

const CSS = `
.pg{background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.pg-head{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px}
.pg-field{display:flex;flex-direction:column;gap:4px}
.pg-field.grow{flex:1;min-width:180px}
.pg-field label{font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:.04em}
.pg-field select,.pg-field input{height:38px;border:1px solid #E2E8F0;border-radius:8px;padding:0 10px;font-size:14px;color:#1C2434;background:#fff;font-family:inherit}
.pg-field.grow input{width:100%}
.pg-cost{display:flex;flex-direction:column;gap:2px;padding:4px 12px;background:#F7F9FC;border:1px solid #E2E8F0;border-radius:8px;text-align:right}
.pg-cost span{font-size:10px;font-weight:600;color:#94A3B8;text-transform:uppercase}
.pg-cost b{font-size:15px;color:#1C2434}
.pg-bulk{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 4px;font-size:12px;color:#64748B;flex-wrap:wrap}
.pg-bulk>div{display:flex;gap:6px}
.pg-bulk input{height:34px;width:90px;border:1px solid #E2E8F0;border-radius:8px;padding:0 10px;font-size:13px;font-family:inherit}
.pg-bulk button{height:34px;border:1px solid #E2E8F0;background:#F7F9FC;border-radius:8px;padding:0 12px;font-size:12px;font-weight:600;color:#1C2434;cursor:pointer}
.pg-rows{display:flex;flex-direction:column}
.pg-row{display:grid;grid-template-columns:1.6fr 1fr 1fr 1.4fr;gap:12px;align-items:center;padding:10px 6px;border-top:1px solid #EEF2F7}
.pg-acct{display:flex;flex-direction:column;min-width:0}
.pg-acct .nm{font-size:14px;font-weight:600;color:#1C2434;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pg-acct .rl{font-size:11px;color:#94A3B8}
.pg-now .k,.pg-margin .k{display:block;font-size:10px;color:#94A3B8;text-transform:uppercase;font-weight:600}
.pg-now .v,.pg-margin .v{font-size:14px;color:#1C2434;font-weight:500}
.pg-now .v em{color:#94A3B8;font-style:normal;font-weight:400}
.pg-set{display:flex;gap:6px}
.pg-set input{height:38px;flex:1;min-width:70px;border:1px solid #CBD5E1;border-radius:8px;padding:0 10px;font-size:14px;font-family:inherit}
.pg-set button{height:38px;padding:0 16px;border:none;border-radius:8px;background:#3C50E0;color:#fff;font-size:13px;font-weight:600;cursor:pointer}
.pg-set button:disabled{opacity:.5;cursor:default}
.pg-empty{padding:24px;text-align:center;color:#94A3B8;font-size:13px}
.pg-pager{display:flex;align-items:center;justify-content:center;gap:14px;padding-top:12px;font-size:13px;color:#64748B}
.pg-pager button{border:1px solid #E2E8F0;background:#F7F9FC;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer}
.pg-pager button:disabled{opacity:.5;cursor:default}
@media (max-width:768px){
  .pg-row{grid-template-columns:1fr 1fr;gap:8px}
  .pg-set{grid-column:1 / -1}
  .pg-acct{grid-column:1 / -1}
}
`;
