"use client";

/**
 * IP addresses, VLANs, device logs and audit tabs.
 *
 *  - IPs/VLANs: real RouterOS + telemetry endpoints.
 *  - Logs: network logs filtered to this device (server-filtered by nasId).
 *  - Audit: timeline rows that reference this device (login/activity/system).
 */
import React, { useMemo, useState } from "react";
import { useNasDetail } from "./context";
import { apiGet, fmtDateTime, show } from "./lib";
import { Btn, EmptyState, Panel, severityOf } from "./ui";

// ── IP Addresses ──────────────────────────────────────────────────
export function IpAddrTab() {
  const { details } = useNasDetail();
  const addrs = details?.ipAddresses ?? [];
  return (
    <div className="nd-root">
      <Panel title={`IP addresses on the router${addrs.length ? ` (${addrs.length})` : ""}`} sub="RouterOS /ip/address (via API sync)">
        {addrs.length === 0 ? (
          <EmptyState title="No address rows synced" hint="The address list comes from the router API sync — see the API permission health panel if it stays empty." />
        ) : (
          <div className="nd-table-wrap">
            <table className="nd-table">
              <thead><tr><th>Address</th><th>Network</th><th>Interface</th><th>Disabled</th></tr></thead>
              <tbody>
                {addrs.map((a, i) => (
                  <tr key={i}>
                    <td className="nd-mono" style={{ fontWeight: 700 }}>{show(a.address)}</td>
                    <td className="nd-mono">{show(a.network)}</td>
                    <td>{show(a.interface)}</td>
                    <td>{String(a.disabled ?? "").toLowerCase() === "true" ? "disabled" : "active"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ── VLANs ──────────────────────────────────────────────────────────
export function VlansTab() {
  const { nasId } = useNasDetail();
  const [vlans, setVlans] = useState<any[] | null>(null);
  const [q, setQ] = useState("");

  React.useEffect(() => {
    let alive = true;
    apiGet<{ vlans?: any[] }>(`/telemetry/nas/${nasId}/vlans`).then((d) => {
      if (alive) setVlans(d?.vlans ?? []);
    }).catch(() => { if (alive) setVlans([]); });
    return () => { alive = false; };
  }, [nasId]);

  const rows = useMemo(() => {
    const list = vlans ?? [];
    const t = q.trim().toLowerCase();
    return t ? list.filter((v) => String(v.vlan).toLowerCase().includes(t)) : list;
  }, [vlans, q]);

  return (
    <div className="nd-root">
      <Panel
        title={`VLAN breakdown${vlans ? ` (${vlans.length})` : ""}`}
        sub="Live throughput + online count per VLAN on this device"
        actions={
          <input className="nd-sub-q" placeholder="Filter VLAN…" value={q} onChange={(e) => setQ(e.target.value)} />
        }
      >
        {vlans === null ? (
          <EmptyState title="Loading…" />
        ) : rows.length === 0 ? (
          <EmptyState title="No VLAN traffic" hint="Groups appear here as sessions carry them — 'no VLAN' traffic is shown when the router reports un-tagged sessions." />
        ) : (
          <div className="nd-table-wrap">
            <table className="nd-table">
              <thead><tr><th>VLAN</th><th>Online</th><th>↓ bytes</th><th>↑ bytes</th></tr></thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.vlan}>
                    <td className="nd-mono" style={{ fontWeight: 700 }}>{v.vlan === "-" ? "(no VLAN)" : v.vlan}</td>
                    <td><span className="nd-online">{v.online ?? 0}</span></td>
                    <td className="num nd-mono">{fmtBytes(v.inBytes)}</td>
                    <td className="num nd-mono">{fmtBytes(v.outBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function fmtBytes(n?: number | null) {
  const v = Number(n);
  if (!n || Number.isNaN(v) || v < 0) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(1)} ${u[i]}`;
}

// ── Logs (network) ─────────────────────────────────────────────────
export function LogsTab() {
  const { networkLogs, loadNetworkLogs, nasId } = useNasDetail();
  const [page, setPage] = useState(0);
  const [sev, setSev] = useState<string>("all");
  const PER = 40;

  const filtered = useMemo(() => {
    if (sev === "all") return networkLogs;
    return networkLogs.filter((l) => (l.severity ?? "info").toLowerCase() === sev);
  }, [networkLogs, sev]);

  const pages = Math.max(1, Math.ceil(filtered.length / PER));
  const rows = filtered.slice(page * PER, (page + 1) * PER);

  return (
    <div className="nd-root">
      <Panel
        title={`Network logs — device #${nasId}`}
        sub="Link state + connection events captured on this NAS (server-filtered)"
        actions={
          <>
            <div className="nd-ranges" role="tablist">
              <button className={sev === "all" ? "on" : ""} onClick={() => { setSev("all"); setPage(0); }}>all</button>
              {["critical", "error", "warning", "info", "success"].map((s) => (
                <button key={s} className={sev === s ? "on" : ""} onClick={() => { setSev(s); setPage(0); }}>{s}</button>
              ))}
            </div>
            <Btn size="xs" variant="ghost" onClick={loadNetworkLogs}>Reload</Btn>
          </>
        }
      >
        {rows.length === 0 ? (
          <EmptyState title="No logs for this device yet" hint="Link up/down, PPPoE and disconnect events for this router appear here as they happen." />
        ) : (
          <>
            <div className="nd-table-wrap">
              <table className="nd-table">
                <thead>
                  <tr><th>Time</th><th>Severity</th><th>Event</th><th>User</th><th>IP / MAC</th><th>Detail</th></tr>
                </thead>
                <tbody>
                  {rows.map((l) => {
                    const sv = severityOf(l.severity);
                    return (
                      <tr key={l.id}>
                        <td className="num nd-mono">{fmtDateTime(l.loggedAt)}</td>
                        <td><span className="nd-sev" style={{ color: sv.color, background: sv.bg }}>{sv.label}</span></td>
                        <td className="nd-mono">{l.eventType ?? "—"}</td>
                        <td className="nd-mono">{l.username ?? "—"}</td>
                        <td className="nd-mono">{l.framedIp ?? l.callerId ?? "—"}</td>
                        <td style={{ maxWidth: 320 }} title={`${l.message ?? ""}${l.eventReason ? ` · ${l.eventReason}` : ""}`}>
                          {(l.message ?? l.eventReason) || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="nd-page">
                <Btn size="xs" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</Btn>
                <span>{page + 1} / {pages} · {filtered.length} rows</span>
                <Btn size="xs" variant="ghost" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next →</Btn>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

// ── Audit timeline ─────────────────────────────────────────────────
export function AuditTab() {
  const { timeline, loadTimeline, nasId } = useNasDetail();
  const [page, setPage] = useState(0);
  const PER = 40;
  const pages = Math.max(1, Math.ceil(timeline.length / PER));
  const rows = timeline.slice(page * PER, (page + 1) * PER);

  return (
    <div className="nd-root">
      <Panel
        title={`Audit — device #${nasId}`}
        sub="Login, activity and system log rows referencing this device"
        actions={<Btn size="xs" variant="ghost" onClick={loadTimeline}>Reload</Btn>}
      >
        {rows.length === 0 ? (
          <EmptyState title="No audit rows referencing this device yet" hint="Administrative actions (edit, disconnect, assign) that touch this NAS appear here." />
        ) : (
          <>
            <div className="nd-table-wrap">
              <table className="nd-table">
                <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.id ?? i}`}>
                      <td className="num nd-mono">{fmtDateTime(r.ts ?? r.loggedAt ?? r.at)}</td>
                      <td>{r.actor?.name ?? r.user?.name ?? r.actorName ?? r.actor ?? "system"}</td>
                      <td className="nd-mono">{r.action ?? r.eventType ?? "—"}</td>
                      <td>{r.entity ?? "—"}</td>
                      <td style={{ maxWidth: 380 }} title={r.details ?? r.message}>
                        {r.details ?? r.message ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="nd-page">
                <Btn size="xs" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</Btn>
                <span>{page + 1} / {pages}</span>
                <Btn size="xs" variant="ghost" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next →</Btn>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

export const NetCss = `
.nd-online{color:#219653;font-weight:700;font-variant-numeric:tabular-nums}
.nd-sev{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;padding:2px 7px;border-radius:4px;white-space:nowrap}
.nd-sub-q{background:var(--surface-2);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:5px 10px;font-size:11.5px;width:180px;outline:none;font-family:inherit}
.nd-sub-q:focus{border-color:var(--accent)}
.nd-page{display:flex;align-items:center;gap:10px;justify-content:center;margin-top:10px;font-size:11px;color:var(--muted)}
`;