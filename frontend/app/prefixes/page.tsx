"use client";

/**
 * Routed Prefix Register — corporate / P2P client address space.
 *
 * WHY THIS SCREEN EXISTS
 *
 * The backend register has been correct since it was written, and completely
 * unused, because provisioning a client meant hand-writing a curl command. A
 * register nobody opens does not prevent a prefix being issued twice — the
 * spreadsheet it replaced at least got looked at.
 *
 * So the page is built around the two questions an operator actually has:
 *   1. "What is free?"        → the pool cards and the Next free lookup
 *   2. "Give this client one" → the provision form, which allocates the block
 *                               AND the transit /30 and returns the exact
 *                               router configuration to paste
 *
 * Everything is generated from one stored record. The ACL, the static route and
 * the interface address all repeat the same prefix, and a single wrong digit in
 * the ACL is a silent security hole — the link comes up, traffic flows, and
 * nothing looks wrong until the wrong source range is permitted.
 *
 * ISP-level only. Resellers get a 403 from every endpoint here, and the page
 * says so plainly rather than rendering an empty register.
 */

import React from "react";
import API_BASE from "../components/api";

// ─── API ─────────────────────────────────────────────────────────────────────
const token = () => (typeof window !== "undefined" ? localStorage.getItem("token") : "");
const H = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token()}` });

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, { ...opts, headers: { ...H(), ...(opts.headers || {}) } });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    const err: any = new Error(d?.message || d?.error || `Request failed (${r.status})`);
    err.status = r.status;
    throw err;
  }
  return r.json() as Promise<T>;
}

interface Pool {
  id: number; name: string; cidr: string; kind: "PUBLIC" | "TRANSIT";
  defaultSize: number; description: string | null;
  blocksTotal: number; blocksUsed: number; blocksFree: number; utilisationPercent: number;
}

interface Allocation {
  id: number; clientName: string; status: "ACTIVE" | "RELEASED";
  vlanId: number | null; vlanName: string | null; linkType: string;
  allocatedCidr: string; transitCidr: string | null;
  ourIp: string | null; clientIp: string | null;
  urpfEnabled: boolean; ingressAcl: string | null; mtu: number;
  description: string | null; deviceName: string | null; notes: string | null;
  provisionedAt: string; releasedAt: string | null; releaseReason: string | null;
  pool?: { id: number; name: string; cidr: string };
}

interface NextFree {
  cidr: string; network: string; firstUsable: string; lastUsable: string;
  broadcast: string; usableHosts: number;
  pool: { id: number; name: string; cidr: string; kind: string };
}

const api = {
  pools: () => req<Pool[]>("/prefixes/pools"),
  nextFree: (poolId: number, size?: number) =>
    req<NextFree>(`/prefixes/pools/${poolId}/next-free${size ? `?size=${size}` : ""}`),
  list: (q: { q?: string; status?: string }) => {
    const p = new URLSearchParams();
    if (q.q) p.set("q", q.q);
    if (q.status) p.set("status", q.status);
    return req<Allocation[]>(`/prefixes?${p}`);
  },
  getOne: (id: number) => req<{ allocation: Allocation; config: string; summary: string }>(`/prefixes/${id}`),
  provision: (b: any) =>
    req<{ allocation: Allocation; config: string; summary: string }>("/prefixes/provision", {
      method: "POST", body: JSON.stringify(b),
    }),
  release: (id: number, reason: string) =>
    req<any>(`/prefixes/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) }),
};

// ─── Styles ──────────────────────────────────────────────────────────────────
const CSS = `
.px { --gap: 14px; }
.px h1 { font-size: 20px; font-weight: 700; margin: 0; }
.px .sub { color: var(--muted); font-size: 12.5px; margin: 2px 0 0; }
.px-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 6px 0 18px; flex-wrap: wrap; }
.px-pools { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--gap); margin-bottom: 18px; }
.px-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; box-shadow: var(--card-shadow); }
.px-card h3 { margin: 0 0 2px; font-size: 13.5px; }
.px-card code { font-size: 12px; color: var(--muted); }
.px-bar { height: 6px; border-radius: 999px; background: var(--border); overflow: hidden; margin: 10px 0 6px; }
.px-bar > i { display: block; height: 100%; }
.px-btn { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: var(--radius); padding: 6px 12px; font-size: 12.5px; cursor: pointer; }
.px-btn:hover { border-color: var(--accent); color: var(--accent); }
.px-btn.pri { background: var(--accent); color: #fff; border-color: var(--accent); }
.px-btn.danger { color: var(--danger); border-color: var(--danger); }
.px-btn:disabled { opacity: .5; cursor: not-allowed; }
.px-in { border: 1px solid var(--border); border-radius: var(--radius); padding: 7px 10px; font-size: 12.5px; background: var(--surface); color: var(--text); }
.px-in:focus { outline: none; border-color: var(--accent); }
.px-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.px-tbl th { text-align: left; color: var(--muted); font-weight: 600; font-size: 11px; padding: 7px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.px-tbl td { padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.px-tbl tr:hover td { background: rgba(60,80,224,.03); }
.px-pill { display: inline-block; font-size: 10.5px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
.px-empty { text-align: center; color: var(--muted); padding: 40px 10px; font-size: 13px; }
.px-err { color: var(--danger); font-size: 12.5px; margin: 8px 0; }
.px-pre { background: var(--bg, #0f172a08); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; font-size: 11.5px; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Menlo, Consolas, monospace; max-height: 340px; overflow: auto; }
.px-back { position: fixed; inset: 0; background: rgba(15,23,42,.5); z-index: 60; display: flex; align-items: center; justify-content: center; padding: 16px; }
.px-modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 20px 60px rgba(0,0,0,.25); width: min(760px, 100%); max-height: 90vh; overflow: auto; padding: 18px; }
.px-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.px-lbl { display: block; font-size: 11.5px; font-weight: 600; margin-bottom: 4px; }
.px-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.px-hint { font-size: 11.5px; color: var(--muted); }
`;

const copy = (t: string) => { void navigator.clipboard?.writeText(t); };

export default function PrefixRegisterPage() {
  const [pools, setPools] = React.useState<Pool[] | null>(null);
  const [rows, setRows] = React.useState<Allocation[] | null>(null);
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState("ACTIVE");
  const [err, setErr] = React.useState("");
  const [denied, setDenied] = React.useState(false);
  const [wizard, setWizard] = React.useState(false);
  const [detail, setDetail] = React.useState<{ allocation: Allocation; config: string; summary: string } | null>(null);

  const load = React.useCallback(async () => {
    try {
      const [p, r] = await Promise.all([api.pools(), api.list({ q, status })]);
      setPools(p); setRows(r); setErr("");
    } catch (e: any) {
      if (e?.status === 403) { setDenied(true); return; }
      setErr(e?.message || "Could not load the prefix register.");
    }
  }, [q, status]);

  React.useEffect(() => { void load(); }, [load]);

  if (denied) {
    return (
      <div className="px">
        <style>{CSS}</style>
        <div className="px-head"><div><h1>Routed Prefix Register</h1></div></div>
        <div className="px-card px-empty">
          Routed public address space is managed at ISP level.
          <div className="px-hint" style={{ marginTop: 8 }}>
            The register lists every corporate client, their prefixes and their VLANs across the whole network, so it is
            not scoped per reseller the way IP pools are. Ask an ISP-level administrator if you need a block.
          </div>
        </div>
      </div>
    );
  }

  const publicPools = (pools || []).filter((p) => p.kind === "PUBLIC");
  const transitPools = (pools || []).filter((p) => p.kind === "TRANSIT");

  return (
    <div className="px">
      <style>{CSS}</style>

      <div className="px-head">
        <div>
          <h1>Routed Prefix Register</h1>
          <p className="sub">
            Delegated blocks, transit links and VLANs for corporate / point-to-point clients — with the router
            configuration generated from the record, not typed twice.
          </p>
        </div>
        <div className="px-row">
          <button className="px-btn" onClick={() => void load()}>Refresh</button>
          <button className="px-btn pri" onClick={() => setWizard(true)} disabled={!publicPools.length}>
            Provision client
          </button>
        </div>
      </div>

      {err && <div className="px-err">{err}</div>}

      {/* ── Pools ───────────────────────────────────────────────── */}
      {pools === null && <div className="px-empty">Loading address space…</div>}
      {pools?.length === 0 && (
        <div className="px-card px-empty">
          No address pools defined yet. A pool is the block you actually hold — e.g. your public /24 and a private
          range for point-to-point links. Until one exists there is nothing to allocate from.
        </div>
      )}
      {!!pools?.length && (
        <div className="px-pools">
          {pools.map((p) => <PoolCard key={p.id} pool={p} />)}
        </div>
      )}

      {/* ── Register ────────────────────────────────────────────── */}
      <div className="px-card">
        <div className="px-row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <b style={{ fontSize: 13 }}>Allocations</b>
          <div className="px-row">
            <input
              className="px-in" placeholder="Search client, prefix, VLAN, ACL…"
              value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }}
            />
            <select className="px-in" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="ACTIVE">Active</option>
              <option value="RELEASED">Released</option>
              <option value="ALL">All</option>
            </select>
          </div>
        </div>

        {rows === null && <div className="px-empty">Loading…</div>}
        {rows?.length === 0 && (
          <div className="px-empty">
            {q ? "Nothing matches that search." : "No allocations yet — provision a client to create the first record."}
          </div>
        )}

        {!!rows?.length && (
          <div style={{ overflowX: "auto" }}>
            <table className="px-tbl">
              <thead>
                <tr>
                  <th>Client</th><th>Delegated prefix</th><th>VLAN</th><th>Transit /30</th>
                  <th>Our IP</th><th>Client IP</th><th>uRPF</th><th>Provisioned</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} style={{ opacity: a.status === "RELEASED" ? 0.5 : 1 }}>
                    <td>
                      <b>{a.clientName}</b>
                      {a.status === "RELEASED" && <span className="px-pill" style={{ marginLeft: 6 }}>released</span>}
                      {a.deviceName && <div className="px-hint">{a.deviceName}</div>}
                    </td>
                    <td><code>{a.allocatedCidr}</code></td>
                    <td>{a.vlanId ?? "—"}{a.vlanName && <div className="px-hint">{a.vlanName}</div>}</td>
                    <td>{a.transitCidr ? <code>{a.transitCidr}</code> : "—"}</td>
                    <td><code>{a.ourIp || "—"}</code></td>
                    <td><code>{a.clientIp || "—"}</code></td>
                    <td>{a.urpfEnabled ? "on" : <span style={{ color: "var(--danger)" }}>off</span>}</td>
                    <td className="px-hint">{new Date(a.provisionedAt).toLocaleDateString()}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        className="px-btn"
                        onClick={async () => {
                          try { setDetail(await api.getOne(a.id)); }
                          catch (e: any) { setErr(e?.message || "Could not open that allocation."); }
                        }}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {wizard && (
        <ProvisionWizard
          publicPools={publicPools}
          transitPools={transitPools}
          onClose={() => setWizard(false)}
          onDone={(res) => { setWizard(false); setDetail(res); void load(); }}
        />
      )}

      {detail && (
        <AllocationDetail
          data={detail}
          onClose={() => setDetail(null)}
          onReleased={() => { setDetail(null); void load(); }}
        />
      )}
    </div>
  );
}

/**
 * One pool, with live utilisation and an on-demand "what is free right now?"
 * lookup. The lookup reserves nothing, so it is safe to press while planning —
 * which is the whole point of having it rather than reading the table by eye.
 */
function PoolCard({ pool }: { pool: Pool }) {
  const [size, setSize] = React.useState<number>(pool.defaultSize);
  const [free, setFree] = React.useState<NextFree | null>(null);
  const [err, setErr] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const look = async () => {
    setBusy(true); setErr(""); setFree(null);
    try { setFree(await api.nextFree(pool.id, size)); }
    catch (e: any) { setErr(e?.message || "Lookup failed."); }
    finally { setBusy(false); }
  };

  const pct = pool.utilisationPercent;
  const colour = pct >= 90 ? "var(--danger)" : pct >= 70 ? "var(--warning)" : "var(--online)";

  return (
    <div className="px-card">
      <h3>{pool.name}</h3>
      <code>{pool.cidr}</code> <span className="px-pill">{pool.kind}</span>

      <div className="px-bar"><i style={{ width: `${Math.min(100, pct)}%`, background: colour }} /></div>
      <div className="px-hint">
        {pool.blocksUsed} of {pool.blocksTotal} /{pool.defaultSize} blocks used · {pool.blocksFree} free ({pct}%)
      </div>

      <div className="px-row" style={{ marginTop: 10 }}>
        <select className="px-in" value={size} onChange={(e) => setSize(Number(e.target.value))} style={{ width: 84 }}>
          {[28, 29, 30, 31, 32].filter((s) => s >= pool.defaultSize - 4).map((s) => (
            <option key={s} value={s}>/{s}</option>
          ))}
        </select>
        <button className="px-btn" onClick={() => void look()} disabled={busy}>
          {busy ? "Checking…" : "Next free"}
        </button>
      </div>

      {err && <div className="px-err">{err}</div>}
      {free && (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <b><code>{free.cidr}</code></b>{" "}
          <button className="px-btn" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => copy(free.cidr)}>
            Copy
          </button>
          <div className="px-hint" style={{ marginTop: 4 }}>
            usable {free.firstUsable} – {free.lastUsable} ({free.usableHosts} hosts) · broadcast {free.broadcast}
          </div>
          <div className="px-hint">Nothing is reserved — this is only a lookup.</div>
        </div>
      )}
    </div>
  );
}

/**
 * Provisioning form.
 *
 * Deliberately one submit: the backend allocates the block, allocates the
 * transit /30 and writes the record in a single call, because doing those as
 * separate steps is how a half-provisioned client ends up holding address space
 * nobody can account for.
 *
 * Names are left blank on purpose — the backend derives vlan651-Zubair,
 * ACL-CLIENT-ZUBAIR-IN and Client-Zubair-P2P-23Aug2026 from the client name and
 * date. Filling them in by hand is how conventions drift.
 */
function ProvisionWizard({
  publicPools, transitPools, onClose, onDone,
}: {
  publicPools: Pool[];
  transitPools: Pool[];
  onClose: () => void;
  onDone: (r: { allocation: Allocation; config: string; summary: string }) => void;
}) {
  const [f, setF] = React.useState<any>({
    clientName: "",
    poolId: publicPools[0]?.id ?? 0,
    transitPoolId: transitPools[0]?.id ?? 0,
    size: publicPools[0]?.defaultSize ?? 29,
    vlanId: "",
    linkType: "P2P",
    mtu: 1500,
    urpfEnabled: true,
    deviceName: "",
    notes: "",
  });
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState("");

  const set = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }));

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const body: any = {
        clientName: f.clientName.trim(),
        poolId: Number(f.poolId),
        size: Number(f.size),
        linkType: f.linkType,
        mtu: Number(f.mtu) || 1500,
        urpfEnabled: !!f.urpfEnabled,
      };
      if (f.transitPoolId) body.transitPoolId = Number(f.transitPoolId);
      if (String(f.vlanId).trim()) body.vlanId = Number(f.vlanId);
      if (f.deviceName.trim()) body.deviceName = f.deviceName.trim();
      if (f.notes.trim()) body.notes = f.notes.trim();
      onDone(await api.provision(body));
    } catch (e: any) {
      setErr(e?.message || "Provisioning failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-back" onClick={onClose}>
      <div className="px-modal" onClick={(e) => e.stopPropagation()}>
        <div className="px-row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Provision a client</h3>
          <button className="px-btn" onClick={onClose}>✕</button>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <label className="px-lbl">Client name</label>
            <input className="px-in" style={{ width: "100%" }} value={f.clientName}
              onChange={(e) => set("clientName", e.target.value)} placeholder="e.g. Zubair" autoFocus />
            <div className="px-hint" style={{ marginTop: 4 }}>
              Drives the generated VLAN name, ACL name and interface description. Use the name you will recognise on
              the router a year from now.
            </div>
          </div>

          <div className="px-grid2">
            <div>
              <label className="px-lbl">Public pool</label>
              <select className="px-in" style={{ width: "100%" }} value={f.poolId}
                onChange={(e) => set("poolId", e.target.value)}>
                {publicPools.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.cidr})</option>)}
              </select>
            </div>
            <div>
              <label className="px-lbl">Block size</label>
              <select className="px-in" style={{ width: "100%" }} value={f.size}
                onChange={(e) => set("size", e.target.value)}>
                {[28, 29, 30, 31].map((s) => (
                  <option key={s} value={s}>/{s} — {Math.max(0, 2 ** (32 - s) - 2)} usable hosts</option>
                ))}
              </select>
            </div>
          </div>

          <div className="px-grid2">
            <div>
              <label className="px-lbl">Transit pool (point-to-point /30)</label>
              <select className="px-in" style={{ width: "100%" }} value={f.transitPoolId}
                onChange={(e) => set("transitPoolId", e.target.value)}>
                <option value={0}>None — no transit link</option>
                {transitPools.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.cidr})</option>)}
              </select>
            </div>
            <div>
              <label className="px-lbl">VLAN id (optional)</label>
              <input className="px-in" style={{ width: "100%" }} value={f.vlanId} inputMode="numeric"
                onChange={(e) => set("vlanId", e.target.value)} placeholder="1–4094" />
            </div>
          </div>

          <div className="px-grid2">
            <div>
              <label className="px-lbl">Link type</label>
              <select className="px-in" style={{ width: "100%" }} value={f.linkType}
                onChange={(e) => set("linkType", e.target.value)}>
                <option value="P2P">P2P</option>
                <option value="TRUNK">Trunk</option>
                <option value="ACCESS">Access</option>
              </select>
            </div>
            <div>
              <label className="px-lbl">MTU</label>
              <input className="px-in" style={{ width: "100%" }} value={f.mtu} inputMode="numeric"
                onChange={(e) => set("mtu", e.target.value)} />
            </div>
          </div>

          <div>
            <label className="px-lbl">Router / device (optional)</label>
            <input className="px-in" style={{ width: "100%" }} value={f.deviceName}
              onChange={(e) => set("deviceName", e.target.value)} placeholder="Which box will this be configured on?" />
          </div>

          <label className="px-row" style={{ gap: 6, fontSize: 12.5 }}>
            <input type="checkbox" checked={f.urpfEnabled} onChange={(e) => set("urpfEnabled", e.target.checked)} />
            Enable uRPF (drop traffic whose source is not the delegated prefix)
          </label>

          <div>
            <label className="px-lbl">Notes (optional)</label>
            <textarea className="px-in" style={{ width: "100%", minHeight: 60 }} value={f.notes}
              onChange={(e) => set("notes", e.target.value)} />
          </div>

          {err && <div className="px-err">{err}</div>}

          <div className="px-hint">
            The block and the transit link are allocated together in one call, and both are checked for overlap against
            every live allocation — including hand-typed ones. You will get the router configuration back immediately.
          </div>

          <div className="px-row" style={{ justifyContent: "flex-end" }}>
            <button className="px-btn" onClick={onClose}>Cancel</button>
            <button className="px-btn pri" disabled={busy || !f.clientName.trim() || !f.poolId} onClick={() => void submit()}>
              {busy ? "Allocating…" : "Allocate & generate config"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One allocation: the record, the router configuration to paste, and the
 * handover sheet for the client. Release lives here too, behind a required
 * reason — this returns public address space to the pool, and months later when
 * abuse on a prefix is reported you must still be able to say who held it.
 */
function AllocationDetail({
  data, onClose, onReleased,
}: {
  data: { allocation: Allocation; config: string; summary: string };
  onClose: () => void;
  onReleased: () => void;
}) {
  const a = data.allocation;
  const [tab, setTab] = React.useState<"config" | "summary" | "record">("config");
  const [releasing, setReleasing] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [err, setErr] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const doRelease = async () => {
    setBusy(true); setErr("");
    try { await api.release(a.id, reason); onReleased(); }
    catch (e: any) { setErr(e?.message || "Release failed."); }
    finally { setBusy(false); }
  };

  const text = tab === "config" ? data.config : tab === "summary" ? data.summary : "";

  return (
    <div className="px-back" onClick={onClose}>
      <div className="px-modal" onClick={(e) => e.stopPropagation()}>
        <div className="px-row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>
            {a.clientName} <code style={{ fontSize: 13 }}>{a.allocatedCidr}</code>
          </h3>
          <button className="px-btn" onClick={onClose}>✕</button>
        </div>
        <div className="px-hint" style={{ marginBottom: 12 }}>
          {a.status === "RELEASED"
            ? `Released ${a.releasedAt ? new Date(a.releasedAt).toLocaleDateString() : ""} — ${a.releaseReason || "no reason recorded"}`
            : `Provisioned ${new Date(a.provisionedAt).toLocaleDateString()}${a.vlanId ? ` · VLAN ${a.vlanId}` : ""}`}
        </div>

        <div className="px-row" style={{ marginBottom: 10 }}>
          {(["config", "summary", "record"] as const).map((t) => (
            <button key={t} className={`px-btn${tab === t ? " pri" : ""}`} onClick={() => setTab(t)}>
              {t === "config" ? "Router config" : t === "summary" ? "Client handover" : "Record"}
            </button>
          ))}
          {text && (
            <button className="px-btn" style={{ marginLeft: "auto" }} onClick={() => copy(text)}>Copy</button>
          )}
        </div>

        {tab === "record" ? (
          <table className="px-tbl">
            <tbody>
              <Rec k="Client" v={a.clientName} />
              <Rec k="Status" v={a.status} />
              <Rec k="Pool" v={a.pool ? `${a.pool.name} (${a.pool.cidr})` : "—"} />
              <Rec k="Delegated prefix" v={a.allocatedCidr} />
              <Rec k="VLAN" v={a.vlanId ? `${a.vlanId} (${a.vlanName || "unnamed"})` : "—"} />
              <Rec k="Link type" v={a.linkType} />
              <Rec k="Transit /30" v={a.transitCidr || "—"} />
              <Rec k="Our IP" v={a.ourIp || "—"} />
              <Rec k="Client IP" v={a.clientIp || "—"} />
              <Rec k="uRPF" v={a.urpfEnabled ? "Enabled" : "Disabled"} />
              <Rec k="Ingress ACL" v={a.ingressAcl || "—"} />
              <Rec k="MTU" v={String(a.mtu)} />
              <Rec k="Description" v={a.description || "—"} />
              <Rec k="Device" v={a.deviceName || "—"} />
              <Rec k="Notes" v={a.notes || "—"} />
            </tbody>
          </table>
        ) : (
          <pre className="px-pre">{text}</pre>
        )}

        {tab === "config" && (
          <div className="px-hint" style={{ marginTop: 8 }}>
            The ACL, the static route and the interface address all repeat the same prefix. Paste this rather than
            retyping it — one wrong digit in the ACL permits the wrong source range and nothing looks broken.
          </div>
        )}

        {a.status === "ACTIVE" && (
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 12 }}>
            {!releasing ? (
              <button className="px-btn danger" onClick={() => setReleasing(true)}>Release this allocation</button>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                <div className="px-hint">
                  Returns <code>{a.allocatedCidr}</code>{a.transitCidr ? <> and <code>{a.transitCidr}</code></> : null} to
                  the pool. The historical row is kept — a reason is required so an abuse report months from now still
                  has an answer. Remember to remove the configuration from the router as well.
                </div>
                <input className="px-in" placeholder="Reason — e.g. Client terminated 2026-08-24"
                  value={reason} onChange={(e) => setReason(e.target.value)} />
                {err && <div className="px-err">{err}</div>}
                <div className="px-row">
                  <button className="px-btn danger" disabled={busy || !reason.trim()} onClick={() => void doRelease()}>
                    {busy ? "Releasing…" : "Confirm release"}
                  </button>
                  <button className="px-btn" onClick={() => setReleasing(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Rec({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td style={{ color: "var(--muted)", width: 160 }}>{k}</td>
      <td><code>{v}</code></td>
    </tr>
  );
}
