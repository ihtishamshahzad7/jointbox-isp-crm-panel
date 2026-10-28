"use client";

/**
 * Interfaces / PPPoE / Subscribers tabs.
 *
 * All data from real endpoints:
 *  - Interfaces: RouterOS /interface/print via API sync (live) + SNMP polled
 *    samples with rates (telemetry).
 *  - PPPoE: RouterOS server config + profiles via API sync.
 *  - Subscribers: accounts assigned to this NAS (GET /nas/:id includes them).
 */
import React, { useMemo, useState } from "react";
import { useNasDetail } from "./context";
import { apiGet, fmtBits, fmtDuration, show, Subscriber } from "./lib";
import { Btn, DefList, EmptyState, Panel, StatusChip } from "./ui";

// ── Interfaces ───────────────────────────────────────────────────
export function InterfacesTab() {
  const { nas, details } = useNasDetail();
  const [samples, setSamples] = useState<any[]>([]);
  const [samplesLoaded, setSamplesLoaded] = useState(false);

  React.useEffect(() => {
    let alive = true;
    if (!nas?.id) return;
    apiGet<any[]>(`/telemetry/nas/${nas.id}/interfaces`).then((r) => {
      if (alive) { setSamples(Array.isArray(r) ? r : []); setSamplesLoaded(true); }
    }).catch(() => { if (alive) setSamplesLoaded(true); });
    return () => { alive = false; };
  }, [nas?.id, details?.interfaces?.length]); // recheck when a fresh sync arrives

  const live = details?.interfaces ?? [];
  const sampByName = useMemo(() => new Map(samples.map((s) => [s.name, s])), [samples]);

  return (
    <div className="nd-root">
      <Panel title={`Interfaces${live.length ? ` (${live.length})` : ""}`} sub="Live from RouterOS via API — running/disabled is the router's own state">
        {live.length === 0 ? (
          <EmptyState
            title="No interface data yet"
            hint={nas?.apiUsername && nas?.apiPassword ? 'Click "Refresh" in the header to pull a fresh RouterOS sync — permission-limited API users see an explanation in the API health panel.' : "API credentials are not configured on this device."}
          />
        ) : (
          <div className="nd-table-wrap">
            <table className="nd-table">
              <thead>
                <tr><th>Interface</th><th>Type</th><th>Running</th><th>TX/RX now (SNMP)</th><th>Errors</th><th>MTU</th><th>MAC</th><th>Comment</th></tr>
              </thead>
              <tbody>
                {live.map((f) => {
                  const up = String(f.running ?? "").toLowerCase() === "true" && String(f.disabled ?? "").toLowerCase() !== "true";
                  const s = sampByName.get(f.name);
                  return (
                    <tr key={f.name}>
                      <td style={{ fontWeight: 700 }}>{f.name}</td>
                      <td className="nd-mono">{f.type || "—"}</td>
                      <td>
                        <span className={`nd-if-state ${up ? "up" : "dn"}`}>{up ? "UP" : "DOWN"}</span>
                      </td>
                      <td className="num nd-mono">
                        {s ? `${fmtBits(s.txBps)} / ${fmtBits(s.rxBps)}` : <span className="dim">—</span>}
                      </td>
                      <td className="num">
                        {s && (s.inErrors + s.outErrors) > 0 ? <span className="warn">{(s.inErrors + s.outErrors).toFixed(1)}/s</span> : <span className="dim">0</span>}
                      </td>
                      <td className="nd-mono">{f.mtu || "—"}</td>
                      <td className="nd-mono">{f.macAddress || "—"}</td>
                      <td className="dim">{f.comment || ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!samplesLoaded && nas?.snmpEnabled && (
          <div className="nd-updated" style={{ marginTop: 8 }}>loading SNMP sample rates…</div>
        )}
      </Panel>
    </div>
  );
}

// ── PPPoE ─────────────────────────────────────────────────────────
export function PppoeTab() {
  const { details, sessions } = useNasDetail();
  const pppoe = details?.pppoeServer;
  const profiles = details?.pppoeProfiles ?? [];
  const routerSessions = sessions.filter((s) => s.source === "router");

  return (
    <div className="nd-root">
      {pppoe ? (
        <Panel title="PPPoE server" sub="Configured on this router (from /ppp/profile + api status)">
          <DefList rows={[
            ["Enabled", pppoe.enabled ? "Yes" : "No"],
            ["Interface", show(pppoe.interface)],
            ["Service name", show(pppoe.serviceName)],
            ["Auth methods", show(pppoe.authentication)],
            ["Max MTU / MRU", `${show(pppoe.maxMtu)} / ${show(pppoe.maxMru)}`],
            ["Keepalive timeout", show(pppoe.keepaliveTimeout)],
            ["Default profile", show(pppoe.defaultProfile)],
          ]} />
        </Panel>
      ) : (
        <Panel title="PPPoE server" sub="Router sync required">
          <EmptyState title="Not synced yet" hint="Run a router sync from this page's header, or check the API permission health panel." />
        </Panel>
      )}

      <Panel title={`Profiles${profiles.length ? ` (${profiles.length})` : ""}`} sub="Rate-limit / session-timeout definitions from the router">
        {profiles.length === 0 ? (
          <EmptyState title="No profiles synced" />
        ) : (
          <div className="nd-table-wrap">
            <table className="nd-table">
              <thead><tr><th>Name</th><th>Local address</th><th>Remote address</th><th>Rate limit</th><th>Session timeout</th><th>Comment</th></tr></thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.name}>
                    <td style={{ fontWeight: 700 }}>{p.name}</td>
                    <td className="nd-mono">{show(p.localAddress)}</td>
                    <td className="nd-mono">{show(p.remoteAddress)}</td>
                    <td className="nd-mono">{show(p.rateLimit)}</td>
                    <td className="nd-mono">{show(p.sessionTimeout)}</td>
                    <td className="dim">{p.comment || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={`Active PPPoE sessions (router view)${routerSessions.length ? ` (${routerSessions.length})` : ""}`} sub="Sessions the router reports live via API">
        {routerSessions.length === 0 ? (
          <EmptyState title="No live router sessions" hint="If people are online but none show here, the router API credentials or account state may be limited — see API permission health." />
        ) : (
          <div className="nd-table-wrap">
            <table className="nd-table">
              <thead><tr><th>User</th><th>Address</th><th>Duration</th><th>↓ / ↑</th></tr></thead>
              <tbody>
                {routerSessions.slice(0, 50).map((s) => (
                  <tr key={s.sessionId ?? s.username}>
                    <td className="nd-mono" style={{ fontWeight: 700 }}>{s.username}</td>
                    <td className="nd-mono">{s.framedipaddress ?? s.callingstationid ?? "—"}</td>
                    <td className="num">{fmtDuration(s.duration_seconds)}</td>
                    <td className="num nd-mono">{fmtBits(s.download_bytes ?? 0)} / {fmtBits(s.upload_bytes ?? 0)}</td>
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

// ── Subscribers ───────────────────────────────────────────────────
export function SubscribersTab({ onOpenSession }: { onOpenSession: (s: any) => void }) {
  const { nas, sessions } = useNasDetail();
  const subs = nas?.subscribers ?? [];
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const PER = 25;

  const activeMap = useMemo(() => {
    const m = new Map<string, any>();
    for (const s of sessions) {
      if (s.username && !m.has(s.username)) m.set(s.username, s);
    }
    return m;
  }, [sessions]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? subs.filter((s) =>
      [s.username, s.fullName, s.phone].filter(Boolean).join(" ").toLowerCase().includes(t),
    ) : subs;
  }, [subs, q]);

  const pages = Math.max(1, Math.ceil(filtered.length / PER));
  const pageRows = filtered.slice(page * PER, (page + 1) * PER);

  return (
    <div className="nd-root">
      <Panel
        className="nd-subs-panel"
        title={`Subscribers on this device${nas?._count?.subscribers != null ? ` (${nas._count.subscribers})` : ""}`}
        sub="Accounts assigned to this NAS — click a row to open its live session"
        actions={
          <input
            className="nd-sub-q"
            placeholder="Search name / username / phone…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0); }}
          />
        }
      >
        {filtered.length === 0 ? (
          <EmptyState
            title="No subscribers found"
            hint={subs.length === 0
              ? "Assign accounts to this router from the NAS list or subscriber profile."
              : "Try a different name, username, or phone number."}
          />
        ) : (
          <>
            <div className="nd-table-wrap nd-subs-desktop">
              <table className="nd-table">
                <thead>
                  <tr><th>Username</th><th>Name</th><th>Phone</th><th>Package</th><th>Status</th><th>Online</th><th></th></tr>
                </thead>
                <tbody>
                  {pageRows.map((s: Subscriber) => {
                    const act = activeMap.get(s.username);
                    return (
                      <tr key={s.id} className="nd-row-click" onClick={() => act && onOpenSession(act)}>
                        <td className="nd-mono" style={{ fontWeight: 700 }}>{s.username}</td>
                        <td>{show(s.fullName)}</td>
                        <td className="nd-mono">{show(s.phone)}</td>
                        <td>{s.package?.name ?? "—"}</td>
                        <td>{s.status ?? "—"}</td>
                        <td>
                          {act
                            ? <StatusChip level="ok" text="LIVE" dotPulse={false} />
                            : <span className="dim">offline</span>}
                        </td>
                        <td>{act ? <Btn size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); onOpenSession(act); }}>Session</Btn> : <Btn size="xs" variant="ghost" disabled>—</Btn>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="nd-subs-mobile">
              {pageRows.map((s: Subscriber) => {
                const act = activeMap.get(s.username);
                const ipAddress = act?.framedipaddress || s.serviceSettings?.ipAddress;
                const macAddress = act?.callingstationid || s.serviceSettings?.macAddress;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="nd-subs-card"
                    disabled={!act}
                    onClick={() => act && onOpenSession(act)}
                  >
                    <span className="nd-subs-card-head">
                      <span className="nd-subs-name">{s.fullName || s.username}</span>
                      <StatusChip
                        level={act ? "ok" : "off"}
                        text={act ? "Online" : "Offline"}
                        dotPulse={false}
                      />
                    </span>
                    <span className="nd-subs-details">
                      <span className="nd-subs-field">
                        <span className="nd-subs-label">IP address</span>
                        <span className="nd-subs-value nd-mono">{show(ipAddress)}</span>
                      </span>
                      <span className="nd-subs-field">
                        <span className="nd-subs-label">MAC address</span>
                        <span className="nd-subs-value nd-mono">{show(macAddress)}</span>
                      </span>
                      {s.serviceSettings?.vlanId != null && s.serviceSettings.vlanId !== "" && (
                        <span className="nd-subs-field">
                          <span className="nd-subs-label">VLAN</span>
                          <span className="nd-subs-value">{show(s.serviceSettings.vlanId)}</span>
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            {pages > 1 && (
              <div className="nd-page">
                <Btn size="xs" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</Btn>
                <span>{page + 1} / {pages} · {filtered.length} shown</span>
                <Btn size="xs" variant="ghost" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next →</Btn>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

export const IfacesCss = `
.nd-if-state{display:inline-flex;align-items:center;font-size:9.5px;font-weight:800;letter-spacing:.05em;padding:2px 7px;border-radius:99px}
.nd-if-state.up{color:#219653;background:rgba(33,150,83,.12)}
.nd-if-state.dn{color:#94A3B8;background:rgba(100,116,139,.12)}
.nd-table .dim{color:var(--muted)}
.nd-table .warn{color:#B45309;font-weight:700}
.nd-sub-q{background:var(--surface-2);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:5px 10px;font-size:11.5px;width:220px;outline:none;font-family:inherit}
.nd-sub-q:focus{border-color:var(--accent)}
.nd-page{display:flex;align-items:center;gap:10px;justify-content:center;margin-top:10px;font-size:11px;color:var(--muted)}
.nd-subs-mobile{display:none}
@media (max-width:767px){
  .nd-subs-panel .nd-panel-h{display:block}
  .nd-subs-panel .nd-panel-a{width:100%;margin-top:8px}
  .nd-subs-panel .nd-sub-q{width:100%;box-sizing:border-box}
  .nd-subs-desktop{display:none}
  .nd-subs-mobile{display:grid;gap:7px;overflow-x:visible}
  .nd-subs-card{display:block;width:100%;min-width:0;box-sizing:border-box;padding:10px 11px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);color:var(--text);font:inherit;text-align:left}
  .nd-subs-card:not(:disabled){cursor:pointer}
  .nd-subs-card:disabled{opacity:1}
  .nd-subs-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;margin-bottom:9px}
  .nd-subs-name{min-width:0;font-size:12px;font-weight:800;overflow-wrap:anywhere}
  .nd-subs-details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px}
  .nd-subs-field{display:grid;gap:2px;min-width:0}
  .nd-subs-label{font-size:9px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
  .nd-subs-value{min-width:0;font-size:11px;overflow-wrap:anywhere}
  .nd-subs-value.nd-mono{word-break:break-all}
}
`;