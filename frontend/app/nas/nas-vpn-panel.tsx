"use client";

import React from "react";
import API from "../components/api";
import { TunnelPanel } from "./tunnel-panel";

type RadiusInfo = {
  provider: string;
  server: string;
  authPort: number;
  acctPort: number;
  nasIdentifier: string | null;
  sharedSecretConfigured: boolean;
  subscriberStore: string;
};

type VpnConfig = {
  state: string;
  revision: number;
  publicHost?: string;
  routerManagementIp?: string;
  l2tpEnabled: boolean;
  ipsecEnabled: boolean;
  pppProfile?: string;
  clientPool?: string;
  dnsServers: string[];
  mtu?: number;
  mru?: number;
  maxSessions?: number;
  idleTimeout?: number;
  sessionTimeout?: number;
  radiusSourceIp?: string;
  masked?: Record<string, unknown>;
  lastError?: string | null;
};

type Activity = { id: string; action: string; actor: string; createdAt: string };
type Neighbor = {
  address?: string | null;
  macAddress?: string | null;
  interface?: string | null;
  identity?: string | null;
  platform?: string | null;
  version?: string | null;
  source: string[];
  kind: "olt" | "onu" | "switch" | "unknown";
};
type Validation = {
  valid: boolean;
  warnings: string[];
  errors: string[];
  preview?: string;
  simulated: boolean;
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "8px 10px",
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 13,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 5, minWidth: 0, color: "var(--muted)", fontSize: 12, fontWeight: 650 }}>
      {label}
      {children}
    </label>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  primary = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        minHeight: 36,
        border: `1px solid ${primary ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 8,
        padding: "7px 12px",
        background: primary ? "var(--accent)" : "var(--surface)",
        color: primary ? "#fff" : "var(--text)",
        font: "inherit",
        fontSize: 12,
        fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

function numericField(name: string, value: string): Record<string, number> {
  if (!value.trim()) return {};
  const parsed = Number(value);
  return Number.isFinite(parsed) ? { [name]: parsed } : {};
}

export function NasVpnPanel({ nasId, nasName }: { nasId: number; nasName?: string }) {
  const [config, setConfig] = React.useState<VpnConfig | null>(null);
  const [radius, setRadius] = React.useState<RadiusInfo | null>(null);
  const [activity, setActivity] = React.useState<Activity[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [validation, setValidation] = React.useState<Validation | null>(null);
  const [applyResult, setApplyResult] = React.useState("");
  const [neighbors, setNeighbors] = React.useState<Neighbor[] | null>(null);

  const [publicHost, setPublicHost] = React.useState("");
  const [routerManagementIp, setRouterManagementIp] = React.useState("");
  const [ipsecPsk, setIpsecPsk] = React.useState("");
  const [l2tpEnabled, setL2tpEnabled] = React.useState(true);
  const [ipsecEnabled, setIpsecEnabled] = React.useState(true);
  const [pppProfile, setPppProfile] = React.useState("uplinko-vpn");
  const [clientPool, setClientPool] = React.useState("uplinko-vpn");
  const [dnsServers, setDnsServers] = React.useState("");
  const [radiusSourceIp, setRadiusSourceIp] = React.useState("");
  const [mtu, setMtu] = React.useState("");
  const [mru, setMru] = React.useState("");
  const [maxSessions, setMaxSessions] = React.useState("");
  const [idleTimeout, setIdleTimeout] = React.useState("");
  const [sessionTimeout, setSessionTimeout] = React.useState("");

  const headers = React.useCallback(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
    return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  }, []);

  const readJson = async (response: Response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.message || `Request failed (HTTP ${response.status}).`);
    }
    return data;
  };

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const requestHeaders = headers();
      const [configResponse, radiusResponse, activityResponse] = await Promise.all([
        fetch(`${API}/nas/${nasId}/l2tp-config`, { headers: requestHeaders }),
        fetch(`${API}/nas/${nasId}/vpn/radius`, { headers: requestHeaders }),
        fetch(`${API}/nas/${nasId}/vpn/activity`, { headers: requestHeaders }),
      ]);
      const [record, radiusData, activityData] = await Promise.all([
        readJson(configResponse),
        readJson(radiusResponse),
        readJson(activityResponse),
      ]);
      setConfig(record);
      setRadius(radiusData);
      setActivity(Array.isArray(activityData) ? activityData : []);
      if (record) {
        setPublicHost(record.publicHost || "");
        setRouterManagementIp(record.routerManagementIp || "");
        setL2tpEnabled(record.l2tpEnabled !== false);
        setIpsecEnabled(record.ipsecEnabled !== false);
        setPppProfile(record.pppProfile || "uplinko-vpn");
        setClientPool(record.clientPool || "uplinko-vpn");
        setDnsServers(Array.isArray(record.dnsServers) ? record.dnsServers.join(", ") : "");
        setRadiusSourceIp(record.radiusSourceIp || "");
        setMtu(record.mtu == null ? "" : String(record.mtu));
        setMru(record.mru == null ? "" : String(record.mru));
        setMaxSessions(record.maxSessions == null ? "" : String(record.maxSessions));
        setIdleTimeout(record.idleTimeout == null ? "" : String(record.idleTimeout));
        setSessionTimeout(record.sessionTimeout == null ? "" : String(record.sessionTimeout));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this NAS VPN configuration.");
    } finally {
      setLoading(false);
    }
  }, [headers, nasId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const payload = React.useCallback(() => ({
    configurationName: `nas-${nasId}-l2tp`,
    publicHost: publicHost.trim(),
    routerManagementIp: routerManagementIp.trim(),
    l2tpEnabled,
    ipsecEnabled,
    ...(ipsecPsk ? { ipsecPsk } : {}),
    pppProfile: pppProfile.trim(),
    clientPool: clientPool.trim(),
    dnsServers: dnsServers.split(",").map((value) => value.trim()).filter(Boolean),
    radiusSourceIp: radiusSourceIp.trim(),
    ...numericField("mtu", mtu),
    ...numericField("mru", mru),
    ...numericField("maxSessions", maxSessions),
    ...numericField("idleTimeout", idleTimeout),
    ...numericField("sessionTimeout", sessionTimeout),
  }), [clientPool, dnsServers, idleTimeout, ipsecEnabled, ipsecPsk, l2tpEnabled, maxSessions, mtu, mru, nasId, pppProfile, publicHost, radiusSourceIp, routerManagementIp, sessionTimeout]);

  const request = async (path: string, method: string, body?: unknown) => {
    const response = await fetch(`${API}/nas/${nasId}${path}`, {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return readJson(response);
  };

  const run = async (path: string, method: string, body?: unknown) => {
    setBusy(true);
    setError("");
    setMessage("");
    setApplyResult("");
    try {
      const result = await request(path, method, body);
      setIpsecPsk("");
      if (path.endsWith("/validate")) {
        setValidation(result);
        setMessage(result.valid ? "Configuration validation completed." : "Configuration needs attention.");
      } else if (path.endsWith("/apply")) {
        setApplyResult(result.message || "No live device operation was performed.");
        setMessage("Apply remains simulation-only; the NAS configuration was not changed on the device.");
      } else if (path.endsWith("/rollback")) {
        setApplyResult(result.message || "No live rollback was performed.");
        setMessage("Rollback remains simulation-only; the NAS configuration was not changed on the device.");
      } else {
        setMessage(result.approved ? "Configuration approved." : "Draft saved.");
      }
      if (!path.endsWith("/apply") && !path.endsWith("/rollback")) await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The VPN operation failed.");
    } finally {
      setBusy(false);
    }
  };

  const discover = async () => {
    setBusy(true);
    setError("");
    setNeighbors(null);
    try {
      const result = await request("/vpn/discover-neighbors", "POST");
      setNeighbors(Array.isArray(result.neighbors) ? result.neighbors : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Neighbor discovery failed.");
    } finally {
      setBusy(false);
    }
  };

  const savedPsk = Boolean(config?.masked?.ipsecPsk);

  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <style>{`
        .nas-vpn-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
        .nas-vpn-check{display:flex;align-items:center;gap:8px;min-height:36px;color:var(--text);font-size:13px}
        .nas-vpn-table{width:100%;border-collapse:collapse;font-size:12px}
        .nas-vpn-table th,.nas-vpn-table td{padding:8px 7px;border-bottom:1px solid var(--border);text-align:left;overflow-wrap:anywhere}
        .nas-vpn-table th{color:var(--muted);font-weight:700}
        @media(max-width:700px){.nas-vpn-grid{grid-template-columns:minmax(0,1fr)}}
      `}</style>

      <section style={panelStyle}>
        <h3 style={headingStyle}>Subscriber VPN · L2TP/IPsec</h3>
        <p style={helperStyle}>
          Per-NAS subscriber access uses central FreeRADIUS. Subscriber credentials remain in the existing RADIUS system; no VPN subscriber database is created.
        </p>
        {radius && (
          <div style={infoStyle}>
            {radius.provider} · {radius.server}:{radius.authPort} · accounting {radius.acctPort}
            {radius.nasIdentifier ? ` · NAS ID ${radius.nasIdentifier}` : ""}
            {" · "}
            {radius.sharedSecretConfigured ? "NAS RADIUS secret configured" : "NAS RADIUS secret missing"}
          </div>
        )}

        {error && <div style={errorStyle}>{error}</div>}
        {message && <div style={infoStyle} role="status">{message}</div>}
        {loading ? <p style={helperStyle}>Loading NAS VPN settings…</p> : (
          <>
            <div style={statusStyle}>
              Configuration: <b>{config?.state || "not configured"}</b>
              {config?.revision ? ` · revision ${config.revision}` : ""}
              {config?.lastError ? ` · ${config.lastError}` : ""}
              {savedPsk ? " · IPsec secret saved (masked)" : ""}
            </div>
            <div className="nas-vpn-grid">
              <Field label="Public VPN hostname or IP">
                <input style={fieldStyle} value={publicHost} onChange={(event) => setPublicHost(event.target.value)} placeholder="vpn.example.com" />
              </Field>
              <Field label="NAS/router management IPv4">
                <input style={fieldStyle} value={routerManagementIp} onChange={(event) => setRouterManagementIp(event.target.value)} placeholder="192.0.2.10" />
              </Field>
              <Field label={savedPsk ? "Replace IPsec pre-shared key (optional)" : "IPsec pre-shared key"}>
                <input style={fieldStyle} type="password" autoComplete="new-password" value={ipsecPsk} onChange={(event) => setIpsecPsk(event.target.value)} placeholder={savedPsk ? "Saved secret is masked; leave blank to keep it" : "Enter secret"} />
              </Field>
              <Field label="PPP profile">
                <input style={fieldStyle} value={pppProfile} onChange={(event) => setPppProfile(event.target.value)} />
              </Field>
              <Field label="Client address pool">
                <input style={fieldStyle} value={clientPool} onChange={(event) => setClientPool(event.target.value)} />
              </Field>
              <Field label="DNS servers (comma-separated)">
                <input style={fieldStyle} value={dnsServers} onChange={(event) => setDnsServers(event.target.value)} placeholder="1.1.1.1, 8.8.8.8" />
              </Field>
              <Field label="RADIUS source IP (optional)">
                <input style={fieldStyle} value={radiusSourceIp} onChange={(event) => setRadiusSourceIp(event.target.value)} placeholder="NAS source address" />
              </Field>
              <Field label="MTU">
                <input style={fieldStyle} type="number" min="1" value={mtu} onChange={(event) => setMtu(event.target.value)} />
              </Field>
              <Field label="MRU">
                <input style={fieldStyle} type="number" min="1" value={mru} onChange={(event) => setMru(event.target.value)} />
              </Field>
              <Field label="Maximum sessions">
                <input style={fieldStyle} type="number" min="1" value={maxSessions} onChange={(event) => setMaxSessions(event.target.value)} />
              </Field>
              <Field label="Idle timeout (seconds)">
                <input style={fieldStyle} type="number" min="0" value={idleTimeout} onChange={(event) => setIdleTimeout(event.target.value)} />
              </Field>
              <Field label="Session timeout (seconds)">
                <input style={fieldStyle} type="number" min="0" value={sessionTimeout} onChange={(event) => setSessionTimeout(event.target.value)} />
              </Field>
              <div>
                <label className="nas-vpn-check"><input type="checkbox" checked={l2tpEnabled} onChange={(event) => setL2tpEnabled(event.target.checked)} /> L2TP enabled</label>
                <label className="nas-vpn-check"><input type="checkbox" checked={ipsecEnabled} onChange={(event) => setIpsecEnabled(event.target.checked)} /> IPsec enabled</label>
              </div>
            </div>
            <div style={actionsStyle}>
              <ActionButton disabled={busy} onClick={() => void run("/l2tp-config", "PUT", payload())}>Save draft</ActionButton>
              <ActionButton primary disabled={busy} onClick={() => void run("/l2tp-config/validate", "POST", payload())}>Validate</ActionButton>
              <ActionButton disabled={busy || config?.state !== "validated"} onClick={() => void run("/l2tp-config/approve", "POST")}>Approve</ActionButton>
              <ActionButton disabled={busy || config?.state !== "approved"} onClick={() => void run("/l2tp-config/apply", "POST")}>Preview apply</ActionButton>
              <ActionButton disabled={busy || !config} onClick={() => void run("/l2tp-config/rollback", "POST")}>Preview rollback</ActionButton>
            </div>
            {validation && (
              <div style={{ marginTop: 10 }}>
                <b style={{ color: validation.valid ? "var(--success, #219653)" : "var(--danger, #D34053)", fontSize: 12 }}>
                  {validation.valid ? "Validation passed" : "Validation failed"} · preview only
                </b>
                {[...validation.errors, ...validation.warnings].map((item, index) => (
                  <p key={`${index}-${item}`} style={{ ...helperStyle, margin: "5px 0" }}>{item}</p>
                ))}
                {validation.preview && <pre style={previewStyle}>{validation.preview}</pre>}
              </div>
            )}
            {applyResult && <div style={warningStyle} role="status">{applyResult}</div>}
          </>
        )}
      </section>

      <section style={panelStyle}>
        <h3 style={headingStyle}>Discover neighbors</h3>
        <p style={helperStyle}>
          Reads this NAS’s RouterOS neighbor and ARP tables only. No subnet scan or active probing is performed; device types are reported candidates.
        </p>
        <ActionButton disabled={busy} onClick={() => void discover()}>{busy ? "Working…" : "Discover neighbors"}</ActionButton>
        {neighbors && (
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            {neighbors.length === 0 ? <p style={helperStyle}>No neighbors were reported by this NAS.</p> : (
              <table className="nas-vpn-table">
                <thead><tr><th>Candidate</th><th>Address</th><th>Platform</th><th>Source</th></tr></thead>
                <tbody>{neighbors.map((neighbor, index) => (
                  <tr key={`${neighbor.macAddress || neighbor.address || "neighbor"}-${index}`}>
                    <td>{neighbor.identity || neighbor.kind.toUpperCase()}</td>
                    <td>{neighbor.address || neighbor.macAddress || "—"}</td>
                    <td>{[neighbor.platform, neighbor.version].filter(Boolean).join(" · ") || "—"}</td>
                    <td>{neighbor.source.join(", ")}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        )}
      </section>

      <section style={panelStyle}>
        <h3 style={headingStyle}>VPN activity</h3>
        {activity.length === 0 ? <p style={helperStyle}>No recorded VPN changes or discovery activity for this NAS.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table className="nas-vpn-table">
              <thead><tr><th>Time</th><th>Action</th><th>Operator</th></tr></thead>
              <tbody>{activity.map((item) => (
                <tr key={item.id}>
                  <td>{new Date(item.createdAt).toLocaleString()}</td>
                  <td>{item.action}</td>
                  <td>{item.actor}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section style={panelStyle}>
        <h3 style={headingStyle}>ISP management access</h3>
        <p style={helperStyle}>
          Separate WireGuard access for panel-to-NAS management; it does not authenticate subscriber VPN connections.
        </p>
        <TunnelPanel nasId={nasId} nasName={nasName} />
      </section>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  minWidth: 0,
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--surface)",
  padding: 14,
};
const headingStyle: React.CSSProperties = { margin: "0 0 6px", color: "var(--text)", fontSize: 14, fontWeight: 800 };
const helperStyle: React.CSSProperties = { margin: "0 0 10px", color: "var(--muted)", fontSize: 12, lineHeight: 1.5 };
const infoStyle: React.CSSProperties = { margin: "8px 0", borderRadius: 8, padding: "8px 10px", background: "var(--bg-subtle, rgba(108,60,225,.08))", color: "var(--text)", fontSize: 12, overflowWrap: "anywhere" };
const errorStyle: React.CSSProperties = { margin: "8px 0", border: "1px solid rgba(211,64,83,.4)", borderRadius: 8, padding: "8px 10px", color: "var(--danger, #D34053)", fontSize: 12 };
const statusStyle: React.CSSProperties = { margin: "8px 0 12px", color: "var(--muted)", fontSize: 12 };
const actionsStyle: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 7, marginTop: 12 };
const warningStyle: React.CSSProperties = { marginTop: 10, border: "1px solid rgba(180,83,9,.35)", borderRadius: 8, padding: "9px 10px", color: "var(--text)", fontSize: 12 };
const previewStyle: React.CSSProperties = { maxWidth: "100%", overflowX: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 10, color: "var(--text)", fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
