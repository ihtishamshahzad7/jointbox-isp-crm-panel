"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { money } from "../components/currency";
import API_BASE from "../components/api";
import { PriceGrid } from "./price-grid";

const API = API_BASE;

/**
 * Reseller Pricing.
 *
 * REBUILT — the previous version could not do the one thing it existed for.
 * It sent `{ packageId, price }` with no `userId`, and the API falls back to
 * the CALLER's own id when that is missing. So an ISP pressing Save wrote a
 * price row against themselves; nothing ever reached the franchise, the table
 * kept showing "—", and there was no way to tell which account a price was
 * even for. There was no account selector at all.
 *
 * Now the account is chosen first and is the subject of the whole screen:
 * "what does THIS account pay". That matches the underlying rule —
 *
 *     A price row is what THAT account PAYS.
 *
 * — and makes the margin arithmetic visible instead of something you work out
 * on paper afterwards.
 */

type Acct = {
  id: number; name: string; role: string; parentId: number | null; depth: number;
  /** May this account price its OWN downline? Off by default on older records. */
  canSetPackagePrice?: boolean;
};

export default function PricingPage() {
  const router = useRouter();
  const [packages, setPackages] = useState<any[]>([]);
  const [prices, setPrices] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<Acct[]>([]); // whole downline, for names
  const [direct, setDirect] = useState<Acct[]>([]);     // only who you may price
  // Multi-select: price one child, several, or all at once. Same-price-for-all
  // is the common case, but a particular dealer often negotiates their own
  // rate — so both have to be possible from the same screen.
  const [targets, setTargets] = useState<number[]>([]);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  /**
   * A rejected save has to STAY on screen. The toast clears itself after four
   * seconds, so a refused price looked identical to a saved one to anyone who
   * glanced away — you left the page believing it had been set. Errors now sit
   * in the row until the next attempt.
   */
  const [rowError, setRowError] = useState<Record<number, string>>({});
  /** Retail = what MY OWN subscribers pay. Separate drafts from wholesale. */
  const [retailDraft, setRetailDraft] = useState<Record<number, string>>({});
  const [retailError, setRetailError] = useState<Record<number, string>>({});
  const [earnings, setEarnings] = useState<any[]>([]);
  const [ladderPkg, setLadderPkg] = useState<number | null>(null);
  const [ladder, setLadder] = useState<any>(null);
  /** The signed-in account — needed to find our own buy price and permissions. */
  const [me, setMe] = useState<any>(null);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const get = useCallback(async (path: string) => {
    const r = await fetch(`${API}${path}`, { headers });
    if (r.status === 401) { router.push("/login"); throw new Error("unauthorized"); }
    return r.json();
  }, [token]);

  const load = useCallback(async () => {
    try {
      const [pkgs, priceRows, earn, tree, profile] = await Promise.all([
        get("/packages"),
        get("/organization/pricing"),
        get("/organization/profit/summary"),
        get("/organization/resellers"),
        get("/auth/profile"),
      ]);
      /**
       * /auth/profile answers `{ user: {...} }`, NOT the user itself.
       * Storing the envelope left `me.id` undefined, so myCost() never matched
       * a price row and every account saw "Your cost —" with a margin computed
       * against zero. The franchise paying Rs 800 was told its margin on a
       * Rs 1,000 sale was Rs 1,000.
       */
      setMe((profile as any)?.user ?? profile);
      const list = Array.isArray(pkgs) ? pkgs : pkgs?.data ?? [];
      setPackages(list);
      setPrices(Array.isArray(priceRows) ? priceRows : []);
      setEarnings(Array.isArray(earn) ? earn : []);

      // resellerTree returns a NESTED tree — roots with `children` arrays.
      // Reading it as a flat list silently hides every account below the first
      // level, so a sub-dealer could never be selected. Flatten it, and record
      // the depth so the selector can show the hierarchy.
      const flat: Acct[] = [];
      const walk = (nodes: any[], depth: number) => {
        for (const n of nodes ?? []) {
          flat.push({
            id: n.id, name: n.name, role: n.role, parentId: n.parentId, depth,
            canSetPackagePrice: !!n.canSetPackagePrice,
          });
          if (n.children?.length) walk(n.children, depth + 1);
        }
      };
      walk(Array.isArray(tree) ? tree : tree?.data ?? [], 0);
      setAccounts(flat);

      // Only DIRECT children are selectable. You price the tier immediately
      // below you; they price theirs. Pricing a grandchild directly would set
      // your child's income without them, and their margin would become
      // whatever was left over.
      const accts = flat.filter((a) => a.depth === 0);
      setDirect(accts);
      // If we arrived from a user's "Set pricing" button (/pricing?account=ID),
      // preselect that account so the operator lands straight on pricing them.
      // Falls back to the first account otherwise.
      let wanted: number | null = null;
      if (typeof window !== "undefined") {
        const q = new URLSearchParams(window.location.search).get("account");
        if (q && accts.some((a) => a.id === Number(q))) wanted = Number(q);
      }
      setTargets((t) => (t.length ? t : wanted ? [wanted] : accts[0] ? [accts[0].id] : []));
      if (list.length) setLadderPkg((p) => p ?? list[0].id);
    } catch { /* keep the last good view */ }
  }, [get]);

  useEffect(() => { if (!token) { router.push("/login"); return; } load(); }, []);

  useEffect(() => {
    if (!ladderPkg) return;
    get(`/organization/pricing/ladder/${ladderPkg}`).then(setLadder).catch(() => setLadder(null));
  }, [ladderPkg, prices]);

  const note = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4000);
  };

  /** What a given account currently pays for a package. */
  const priceFor = (userId: number | null, packageId: number) =>
    userId == null ? undefined
      : prices.find((p) => p.userId === userId && p.packageId === packageId)?.price;

  const selected = direct.filter((a) => targets.includes(a.id));
  const one = selected.length === 1 ? selected[0] : null;

  /**
   * What the selected accounts pay for a package.
   * With several selected they may disagree, and saying so plainly is more
   * useful than showing the first one and implying they all match.
   */
  const payState = (packageId: number) => {
    const vals = selected.map((a) => priceFor(a.id, packageId));
    const set = vals.filter((v) => v != null) as number[];
    if (set.length === 0) return { kind: "none" as const };
    if (set.length < vals.length) return { kind: "partial" as const, count: set.length, of: vals.length };
    const uniq = [...new Set(set)];
    return uniq.length === 1
      ? { kind: "same" as const, value: uniq[0] }
      : { kind: "mixed" as const, min: Math.min(...set), max: Math.max(...set) };
  };

  /**
   * What YOU pay for this package — the floor for anything you charge onward.
   *
   * listPrices returns your own subtree, and that INCLUDES your own row, so
   * your cost is the row whose userId is you. The previous version looked for
   * a field called `isMine` that the API never returns, so this always came
   * back 0 and the column showed "—" for every reseller.
   *
   * As ISP you own the package outright, so there is no row and the cost is
   * genuinely zero — the whole price is margin.
   */
  const myCost = (packageId: number) => {
    if (!me?.id) return 0;
    const own = prices.find((p) => p.packageId === packageId && p.userId === me.id);
    if (own?.price != null) return own.price;
    // No explicit row: the ISP owns its packages, so its cost is zero. Any other
    // account inherits its parent's cost — which the /packages API now returns
    // as the package's `price` field for resellers. This is what lets a retailer
    // see their real buying price (and set a retail price above it) even before
    // their dealer assigns them an explicit wholesale rate.
    if (me.parentId == null) return 0;
    const pkg = packages.find((p) => p.id === packageId);
    return pkg?.price ?? 0;
  };

  /** My own retail price for a package, or null if I have not set one. */
  const myRetail = (packageId: number): number | null => {
    if (!me?.id) return null;
    const own = prices.find((p) => p.packageId === packageId && p.userId === me.id);
    return own?.retailPrice ?? null;
  };

  /**
   * Save what MY customers pay. Uses a negative busy key so it cannot collide
   * with the wholesale row for the same package.
   */
  async function saveRetail(packageId: number) {
    const val = Number(retailDraft[packageId]);
    if (retailDraft[packageId] === "" || retailDraft[packageId] == null || Number.isNaN(val) || val < 0) {
      return setRetailError((e) => ({ ...e, [packageId]: "Enter a valid price" }));
    }
    setBusy(-packageId);
    setRetailError((e) => ({ ...e, [packageId]: "" }));
    try {
      const r = await fetch(`${API}/organization/pricing/retail`, {
        method: "PUT", headers,
        body: JSON.stringify({ packageId, retailPrice: val }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Could not save");
      note(`Your subscribers now pay ${money(val)} for this package`);
      setRetailDraft({ ...retailDraft, [packageId]: "" });
      load();
    } catch (e: any) {
      const msg = Array.isArray(e?.message) ? e.message.join(" ") : String(e?.message || "Could not save");
      setRetailError((x) => ({ ...x, [packageId]: msg }));
      note(msg, false);
    } finally { setBusy(null); }
  }

  async function savePrice(packageId: number) {
    if (!targets.length) return note("Select at least one account to price for", false);
    const val = Number(draft[packageId]);
    if (Number.isNaN(val) || val < 0) return note("Enter a valid price", false);

    setBusy(packageId);
    setRowError((e) => ({ ...e, [packageId]: "" }));
    try {
      // One account uses the single endpoint so its error message comes back
      // verbatim; several go through assign-bulk, where each pair is still
      // guarded individually and one rejection does not abort the rest.
      if (targets.length === 1) {
        const r = await fetch(`${API}/organization/pricing`, {
          method: "PUT", headers,
          body: JSON.stringify({ userId: targets[0], packageId, price: val }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d?.message || "Could not save");
        note(`${one?.name} now pays ${money(val)} for this package`);
      } else {
        const r = await fetch(`${API}/organization/pricing/assign-bulk`, {
          method: "POST", headers,
          body: JSON.stringify({ packageIds: [packageId], userIds: targets, price: val }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d?.message || "Could not save");

        const failed = (d?.results ?? []).filter((x: any) => !x.ok);
        if (failed.length) {
          note(
            `${targets.length - failed.length} of ${targets.length} updated. ` +
            `${failed.length} rejected: ${failed[0]?.error ?? "see the ladder"}`,
            false,
          );
        } else {
          note(`${targets.length} accounts now pay ${money(val)} for this package`);
        }
      }
      setDraft({ ...draft, [packageId]: "" });
      load();
    } catch (e: any) {
      const msg = Array.isArray(e?.message) ? e.message.join(' ') : String(e?.message || 'Could not save');
      setRowError((x) => ({ ...x, [packageId]: msg }));
      note(msg, false);
    } finally { setBusy(null); }
  }

  /**
   * Grant or revoke a child's right to price ITS own downline.
   *
   * The endpoint has existed all along with nothing calling it, so the
   * permission could only ever be changed in the database. A franchise would
   * type a price, press Save, get refused, and have no route to fixing it.
   */
  async function grantPricing(a: Acct & { canSetPackagePrice?: boolean }) {
    const allowed = !a.canSetPackagePrice;
    try {
      const r = await fetch(`${API}/organization/resellers/${a.id}/price-permission`, {
        method: "PUT", headers, body: JSON.stringify({ allowed }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Could not change that permission");
      note(allowed
        ? `${a.name} can now set prices for their own downline`
        : `${a.name} can no longer set prices`);
      load();
    } catch (e: any) { note(e?.message || String(e), false); }
  }

  const toggleTarget = (id: number) =>
    setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  const children = useMemo(
    // Only meaningful when exactly one account is selected — with several,
    // "their children" is not a single set worth counting.
    () => (one ? accounts.filter((a) => a.parentId === one.id) : []),
    [accounts, one],
  );

  return (
    <div className="rp">
      <style>{CSS}</style>

      {toast && (
        <div className={`rp-toast ${toast.ok ? "ok" : "bad"}`}>{toast.msg}</div>
      )}

      {/* ── PER-ACCOUNT PRICE GRID — the primary tool ──────────────────────
          Set a different price for each franchise (F1 → 500, F2 → 600),
          searchable so a 1000-account downline is workable. The multi-select
          sections below remain for the "same price to a batch" case. */}
      {direct.length > 0 && packages.length > 0 && (
        <section className="rp-card" style={{ marginBottom: 16 }}>
          <header>
            <h3>Price your accounts <span className="hl">(one price each)</span></h3>
            <p>One package at a time. Type a name to find an account, set that account's price, Save. Every account can have its own — F1 pays 500, F2 pays 600.</p>
          </header>
          <PriceGrid
            packages={packages}
            direct={direct}
            prices={prices}
            myCost={myCost}
            headers={headers}
            api={API}
            money={money}
            onSaved={load}
          />
        </section>
      )}

      <header className="rp-head">
        <div>
          <h1>Reseller Pricing</h1>
          <p>
            You can do <b>both</b> at once: resell to accounts below you, and serve your own
            customers directly. Most dealers do — a few retailers under them, and a book of
            their own subscribers. Set the wholesale price below, your retail price under it,
            and your wallet is charged the same way either way.
          </p>
        </div>
      </header>

      {/* Price-setting is a delegated permission and it defaults OFF on
          accounts created before it existed. Without this banner the only
          feedback was a refusal AFTER typing a price and pressing Save —
          which is how a franchise ends up believing the panel is broken. */}
      {me && me.role !== "ADMIN" && me.role !== "SUPER_ADMIN" && me.canSetPackagePrice === false && (
        <div className="rp-noperm">
          <b>Price-setting is switched off for this account.</b>
          <span>
            {me.name || "This account"} can see prices but cannot save them. The ISP turns it on
            under <b>Administration → Organization → Resellers</b> → edit the account →
            tick <b>“can set price”</b>. Accounts created before this setting existed have it off.
          </span>
        </div>
      )}

      {/* What THIS account pays. Previously invisible, so a reseller had no
          idea what their own floor was and only found out by being refused. */}
      {me && me.parentId != null && packages.length > 0 && (
        <div className="rp-mycost">
          <b>What you pay</b>
          <div className="rows">
            {packages.map((p) => {
              const c = myCost(p.id);
              return (
                <div key={p.id} className="row">
                  <span>{p.name}</span>
                  {c > 0
                    ? <b>{money(c)}</b>
                    : <em>not assigned to you yet — ask your parent account</em>}
                </div>
              );
            })}
          </div>
          <p>Anything you charge below you must be at least this. The difference is your profit.</p>
        </div>
      )}

      {me && me.parentId != null && me.canSetPackagePrice === false && (
        <div className="rp-blocked">
          <b>Price-setting is switched off for this account</b>
          You can see prices but not change them. The ISP can enable it under
          Administration → Organization → Resellers → <b>“can set price”</b>.
        </div>
      )}


      {/* ── 1b · what MY OWN customers pay ───────────────────────
          Shown to every account, with or without a downline. A dealer at the
          bottom of the tree sells to people rather than to accounts, so the
          wholesale table above is empty for them — and this used to be the
          whole screen, leaving them nothing at all and a profit of zero. */}
      {me && packages.length > 0 && (
        <section className="rp-card">
          <header>
            <h3>What <span className="hl">your own subscribers</span> pay</h3>
            <p>
              Your retail price — charged to customers you activate yourself. Every account
              can hold its own subscribers, not just the bottom tier. Your profit on each one
              is this price minus what you pay above{me?.parentId == null ? "" : " you"}.
            </p>
          </header>
          <div className="body">
            <table className="rp-table">
              <thead>
                <tr>
                  <th>Package</th>
                  <th className="r">You pay</th>
                  <th className="r">Your customers pay</th>
                  <th className="r">Profit per subscriber</th>
                  <th>Set retail price</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((p) => {
                  const cost = myCost(p.id);
                  const cur = myRetail(p.id);
                  const typed = Number(retailDraft[p.id]);
                  const shown = !Number.isNaN(typed) && retailDraft[p.id] !== "" ? typed : cur;
                  const profit = shown != null ? shown - cost : null;
                  return (
                    <tr key={p.id}>
                      <td><b>{p.name}</b></td>
                      <td className="r muted">{cost > 0 ? money(cost) : "—"}</td>
                      <td className="r">
                        {cur != null
                          ? <b className="set">{money(cur)}</b>
                          : <span className="unset">not set</span>}
                      </td>
                      <td className="r">
                        {profit == null ? <span className="unset">—</span> : (
                          <b className={profit < 0 ? "bad" : "good"}>
                            {profit < 0 ? "−" : "+"}{money(Math.abs(profit))}
                          </b>
                        )}
                      </td>
                      <td>
                        <div className="rp-set">
                          <input
                            type="number"
                            placeholder={cur != null ? String(cur) : String(cost || "price")}
                            value={retailDraft[p.id] ?? ""}
                            onChange={(e) => setRetailDraft({ ...retailDraft, [p.id]: e.target.value })}
                            onKeyDown={(e) => { if (e.key === "Enter") saveRetail(p.id); }}
                          />
                          <button disabled={busy === -p.id} onClick={() => saveRetail(p.id)}>
                            {busy === -p.id ? "…" : "Save"}
                          </button>
                          {retailError[p.id] && (
                            <div className="rp-rowerr">{retailError[p.id]}</div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}


      {/* ── 3 · the ladder ───────────────────────────────────── */}
      <section className="rp-card">
        <header>
          <h3>The full ladder</h3>
          <p>Every tier for one package, and what each earns per activation.</p>
        </header>
        <div className="body">
          <div className="rp-pills">
            {packages.map((p) => (
              <button key={p.id} className={ladderPkg === p.id ? "on" : ""}
                onClick={() => setLadderPkg(p.id)}>{p.name}</button>
            ))}
          </div>

          {!ladder?.ladder?.length ? (
            <div className="rp-empty">Assign a price to at least one account to see the ladder.</div>
          ) : (
            <div className="rp-ladder">
              {ladder.ladder.map((row: any) => (
                <div key={row.userId} className={`rung ${row.assigned ? "" : "dim"}`}>
                  <div className="who">
                    <b>{row.name}</b>
                    <em>{row.role}</em>
                  </div>
                  <div className="pays">
                    <span>pays</span>
                    <b>{money(row.buyPrice)}</b>
                  </div>
                  <div className="sells">
                    {row.sells.length === 0
                      ? <span className="none">no one below them priced yet</span>
                      : row.sells.map((s: any) => (
                          <span key={s.childId} className="sale">
                            {s.childName} pays <b>{money(s.theyPay)}</b>
                            <i className={s.myMargin < 0 ? "bad" : "ok"}>
                              {s.myMargin >= 0 ? "+" : ""}{money(s.myMargin)}
                            </i>
                          </span>
                        ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── 4 · earnings ─────────────────────────────────────── */}
      <section className="rp-card">
        <header>
          <h3>Earnings by account</h3>
          <p>Balance = wallet now · Earned = margins from sales · Spent = cost of activations.</p>
        </header>
        <div className="rp-tablewrap">
          <table className="rp-table">
            <thead>
              <tr>
                <th>Account</th><th>Role</th>
                <th className="r">Balance</th><th className="r">Earned</th>
                <th className="r">Spent</th><th className="r">Net</th>
              </tr>
            </thead>
            <tbody>
              {earnings.map((e) => (
                <tr key={e.id}>
                  <td><b>{e.name}</b></td>
                  <td className="muted">{e.role}</td>
                  <td className="r">{money(e.balance)}</td>
                  <td className="r ok">{money(e.earned)}</td>
                  <td className="r warn">{money(e.spent)}</td>
                  <td className="r"><b className={e.net >= 0 ? "ok" : "bad"}>{money(e.net)}</b></td>
                </tr>
              ))}
              {earnings.length === 0 && (
                <tr><td colSpan={6} className="rp-empty-cell">
                  No sales yet — activate a subscriber under a reseller to see earnings here.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const CSS = `
.rp{padding:4px 2px 32px;color:var(--text);font-variant-numeric:tabular-nums;
  --ok:#10B981;--warn:#F59E0B;--bad:#EF4444}
.rp-head h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-.02em}
.rp-head p{margin:6px 0 20px;font-size:13px;color:var(--muted);line-height:1.65;max-width:720px}
.rp-head b{color:var(--text)}

.rp-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;
  overflow:hidden;margin-bottom:16px}
.rp-card>header{padding:16px 20px 13px;border-bottom:1px solid var(--border)}
.rp-card h3{margin:0;font-size:13.5px;font-weight:600}
.rp-card header p{margin:4px 0 0;font-size:11.5px;color:var(--muted);line-height:1.6;max-width:700px}
.rp-card .body{padding:18px 20px}
.hl{background:linear-gradient(135deg,#6C3CE1,#E9408B);-webkit-background-clip:text;
  background-clip:text;color:transparent;font-weight:800}

.rp-accts{display:flex;gap:8px;flex-wrap:wrap}
.rp-locked{margin-top:16px;padding:14px 16px;border-radius:12px;background:var(--surface-2);
  border:1px dashed var(--border)}
.rp-locked>b{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.07em;
  color:var(--muted);margin-bottom:9px}
.rp-locked .row{display:flex;justify-content:space-between;gap:14px;padding:5px 0;font-size:12.5px}
.rp-locked .nm{color:var(--text)}
.rp-locked .by{color:var(--muted);font-size:11.5px}
.rp-locked p{margin:10px 0 0;font-size:11.5px;color:var(--muted);line-height:1.6}
.rp-locked p b{color:var(--text)}
.rp-acct{display:flex;align-items:center;gap:10px;
  background:var(--surface-2);border:1px solid var(--border);border-radius:12px;
  padding:10px 15px;cursor:pointer;font-family:inherit;text-align:left;color:var(--text);
  transition:all .18s cubic-bezier(.34,1.56,.64,1)}
.rp-acct:hover{border-color:rgba(140,90,255,.45)}
.rp-acct .tick{width:17px;height:17px;border-radius:5px;flex-shrink:0;
  border:1.5px solid var(--muted);display:grid;place-items:center;
  font-size:11px;font-weight:800;transition:all .18s}
.rp-acct .tick.on{background:#fff;border-color:#fff;color:#6C3CE1}
.rp-acct b{display:block;font-size:13px;font-weight:600}
.rp-acct em{display:block;font-style:normal;font-size:10.5px;color:var(--muted);margin-top:2px}
.rp-acct.on{background:linear-gradient(135deg,#6C3CE1,#E9408B);border-color:transparent;
  box-shadow:0 6px 20px rgba(233,64,139,.3)}
.rp-acct.on b,.rp-acct.on em{color:#fff}
.rp-acct.on em{opacity:.85}

.rp-bulk{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.rp-bulk button{background:var(--surface-2);border:1px solid var(--border);color:var(--muted);
  border-radius:9px;padding:6px 13px;font-size:11.5px;font-weight:600;cursor:pointer;
  font-family:inherit;transition:all .16s}
.rp-bulk button:hover:not(:disabled){color:var(--text);border-color:rgba(140,90,255,.45)}
.rp-bulk button:disabled{opacity:.4;cursor:not-allowed}
.rp-bulk .count{font-size:11.5px;color:var(--muted);margin-left:4px}

.rp-mycost{background:var(--surface);border:1px solid var(--border);border-left:3px solid #00C9FF;
  border-radius:14px;padding:14px 18px;margin-bottom:16px}
.rp-mycost>b{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.07em;
  color:#00C9FF;margin-bottom:9px}
.rp-mycost .rows{display:grid;gap:6px}
.rp-mycost .row{display:flex;justify-content:space-between;gap:14px;font-size:12.5px}
.rp-mycost .row span{color:var(--muted)}
.rp-mycost .row b{font-size:14px;font-weight:700}
.rp-mycost .row em{font-style:normal;font-size:11.5px;color:var(--warn)}
.rp-mycost p{margin:10px 0 0;font-size:11.5px;color:var(--muted);line-height:1.6}

.rp-blocked{background:var(--surface);border:1px solid var(--border);border-left:3px solid #F59E0B;
  border-radius:14px;padding:14px 18px;margin-bottom:16px;font-size:12.5px;color:var(--muted);
  line-height:1.65}
.rp-blocked>b{display:block;font-size:13px;color:#F59E0B;margin-bottom:5px}
.rp-blocked b{color:var(--text)}

.rp-tablewrap{overflow-x:auto}
.rp-table{width:100%;border-collapse:collapse;min-width:720px}
.rp-table th{text-align:left;padding:11px 16px;font-size:10px;font-weight:600;color:var(--muted);
  text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid var(--border);white-space:nowrap}
.rp-table td{padding:13px 16px;font-size:13px;border-bottom:1px solid var(--border)}
.rp-table th.r,.rp-table td.r{text-align:right}
.rp-table tbody tr:last-child td{border-bottom:none}
.rp-table tbody tr:hover{background:var(--surface-2)}
.rp-table .muted{color:var(--muted)}
.rp-table .ok{color:var(--ok)}.rp-table .bad{color:var(--bad)}.rp-table .warn{color:var(--warn)}
.set{color:var(--ok);font-size:14px}
.mixed{color:var(--warn);font-size:13px}
.unset{color:var(--muted);font-size:11.5px;font-style:italic}

.rp-set{display:flex;gap:6px}
.rp-set input{width:92px;background:var(--surface-2);border:1px solid var(--border);
  border-radius:9px;padding:7px 10px;color:var(--text);font-size:12.5px;font-family:inherit;
  outline:none;text-align:right;transition:border-color .18s,box-shadow .18s}
.rp-set input:focus{border-color:rgba(140,90,255,.55);box-shadow:0 0 0 3px rgba(140,90,255,.13)}
.rp-set button{background:linear-gradient(135deg,#6C3CE1,#E9408B);color:#fff;border:none;
  border-radius:9px;padding:7px 15px;font-size:12px;font-weight:700;cursor:pointer;
  font-family:inherit;box-shadow:0 4px 14px rgba(233,64,139,.26);
  transition:transform .16s cubic-bezier(.34,1.56,.64,1)}
.rp-set button:hover:not(:disabled){transform:scale(1.05)}
.rp-set button:disabled{opacity:.5;cursor:not-allowed}

.rp-pills{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
.rp-pills button{background:var(--surface-2);border:1px solid var(--border);color:var(--muted);
  border-radius:99px;padding:6px 14px;font-size:11.5px;font-weight:600;cursor:pointer;
  font-family:inherit;transition:all .16s}
.rp-pills button:hover{color:var(--text)}
.rp-pills button.on{background:linear-gradient(135deg,#6C3CE1,#E9408B);color:#fff;border-color:transparent}

.rp-ladder{display:grid;gap:8px}
.rung{display:grid;grid-template-columns:minmax(130px,1fr) auto minmax(180px,1.4fr);
  gap:18px;align-items:center;padding:14px 16px;border-radius:13px;
  background:var(--surface-2);border:1px solid var(--border)}
.rung.dim{opacity:.5}
@media(max-width:760px){.rung{grid-template-columns:1fr;gap:8px}}
.rung .who b{display:block;font-size:13.5px;font-weight:600}
.rung .who em{display:block;font-style:normal;font-size:10.5px;color:var(--muted);margin-top:2px}
.rung .pays{text-align:center}
.rung .pays span{display:block;font-size:9.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}
.rung .pays b{font-size:17px;font-weight:800;letter-spacing:-.02em}
.rung .sells{display:flex;flex-direction:column;gap:5px;font-size:11.5px;color:var(--muted)}
.rung .sale b{color:var(--text)}
.rung .sale i{font-style:normal;font-weight:700;margin-left:7px}
.rung .sale i.ok{color:var(--ok)}.rung .sale i.bad{color:var(--bad)}
.rung .none{font-style:italic;opacity:.7}

.rp-empty,.rp-empty-cell{color:var(--muted);font-size:12.5px;line-height:1.7}
.rp-empty{padding:24px;text-align:center;border:1px dashed var(--border);border-radius:13px}
.rp-empty-cell{padding:30px !important;text-align:center}
.rp-empty b{color:var(--text)}

.rp-noperm{display:flex;flex-direction:column;gap:5px;padding:14px 18px;margin-bottom:16px;
  border-radius:14px;background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.45)}
.rp-noperm b{color:#FCD34D;font-size:13px}
.rp-noperm span{color:var(--muted);font-size:12.5px;line-height:1.7}
.rp-noperm span b{color:var(--text);font-size:inherit}

.rp-grant{align-self:flex-start;display:inline-block;margin-top:5px;padding:5px 11px;border-radius:8px;font-size:11px;font-weight:700;
  cursor:pointer;border:1px solid var(--border);background:var(--surface-2);color:var(--muted)}
.rp-grant:hover{color:var(--text);border-color:#6C3CE1}
.rp-grant.on{color:#6EE7B7;border-color:rgba(16,185,129,.5);background:rgba(16,185,129,.12)}

.rp-table td .good{color:#6EE7B7}
.rp-table td .bad{color:#FCA5A5}

.rp-rowerr{margin-top:7px;max-width:290px;padding:7px 10px;border-radius:9px;font-size:11.5px;
  line-height:1.6;color:#FCA5A5;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.4)}

.rp-toast{position:fixed;bottom:24px;right:24px;z-index:200;padding:12px 18px;border-radius:14px;
  font-size:12.5px;font-weight:600;max-width:400px;backdrop-filter:blur(18px);
  box-shadow:0 16px 44px rgba(0,0,0,.45)}
.rp-toast.ok{background:rgba(16,185,129,.14);border:1px solid #10B981;color:#6EE7B7}
.rp-toast.bad{background:rgba(239,68,68,.14);border:1px solid #EF4444;color:#FCA5A5}
`;
