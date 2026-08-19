"use client";

import React from "react";
import { useParams, useRouter } from "next/navigation";
import { ndm, fmtBits, fmtPps, fmtUptime, fmtTime, isUp, sevColor, type NdmPort, type NdmEvent, type NdmAlert, type SyslogRow } from "../ndm";
import { NDMCSS, NdmModal, PortTile, TrafficChart, UpStrip, SeverityBadge, useNdmRefresh } from "../ndm-ui";
import { useSSE } from "../../../components/use-sse";

const RANGES = ["5m", "1h", "6h", "24h", "7d", "30d"] as const;
type Tab = "Overview" | "Ports" | "Events" | "Syslog" | "Alerts" | "Configuration";

export default function DeviceDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const deviceId = Number(id);
  const [device, setDevice] = React.useState<any>(null);
  const [ports, setPorts] = React.useState<NdmPort[]>([]);
  const [events, setEvents] = React.useState<{ rows: NdmEvent[]; total: number } | null>(null);
  const [syslog, setSyslog] = React.useState<{ rows: SyslogRow[]; total: number } | null>(null);
  const [alerts, setAlerts] = React.useState<{ rows: NdmAlert[]; total: number } | null>(null);
  const [tab, setTab] = React.useState<Tab>("Overview");
  const [stream, setStream] = React.useState<any>(null);
  const [range, setRange] = React.useState<(typeof RANGES)[number]>("24h");
  const [err, setErr] = React.useState("");
  const [portSel, setPortSel] = React.useState<NdmPort | null>(null);
  const [showConfig, setShowConfig] = React.useState(false);

  const loadAll = React.useCallback(async () => {
    if (!Number.isFinite(deviceId)) return;
    try {
      const [d, p] = await Promise.all([ndm.device(deviceId), ndm.ports(deviceId)]);
      setDevice(d); setPorts(p); setErr("");
    } catch (e: any) { setErr(e?.message || "Not found or no permission."); }
  }, [deviceId]);
  const loadStream = React.useCallback(async () => {
    try { setStream(await ndm.deviceStream(deviceId, range)); } catch { /* fine */ }
  }, [deviceId, range]);
  const loadTab = React.useCallback(async () => {
    if (tab === "Events") setEvents(await ndm.events({ deviceId, limit: 120 }).catch(() => null) as any);
    if (tab === "Syslog") setSyslog(await ndm.syslog({ deviceId, limit: 150 }).catch(() => null) as any);
    if (tab === "Alerts") setAlerts(await ndm.alerts({ deviceId, limit: 120 }).catch(() => null) as any);
  }, [tab, deviceId]);

  useNdmRefresh(loadAll, () => {}, [loadAll], 15000);
  useNdmRefresh(loadStream, () => {}, [loadStream], 30000);
  useNdmRefresh(loadTab, () => {}, [loadTab], 20000);
  // Live refresh on push events (port flaps, events, alerts).
  useSSE({ onEvent: (t: string) => {
    if (t === "ndm:event" || t === "ndm:alert" || t === "ndm:port" || t === "ndm:device") { void loadAll(); if (tab !== "Overview") void loadTab(); }
  } });

  React.useEffect(() => { if (tab === "Overview") void loadStream(); }, [tab, loadStream]);

  if (err && !device) {
    return <div className="ndm"><style>{NDMCSS}</style><div className="ndm-empty">{err}<div style={{ marginTop: 10 }}><button className="ndm-btn" onClick={() => router.push("/monitoring/devices")}>← Devices</button></div></div></div>;
  }
  if (!device) return <div className="ndm"><style>{NDMCSS}</style><div className="ndm-empty">Loading…</div></div>;

  const state = !device.enabled ? "off" : device.isReachable === null ? "wait" : device.isReachable ? "up" : "down";
  const color = { off: "#94A3B8", wait: "#8A6209", up: "#219653", down: "#D34053" }[state];
  const label = { off: "Paused", wait: "First check…", up: "Reachable", down: "DOWN" }[state];
  const upPorts = ports.filter((p) => isUp(p)).length;

  return (
    <div className="ndm">
      <style>{NDMCSS}</style>

      <a onClick={() => router.push("/monitoring/devices")} style={{ cursor: "pointer", color: "var(--muted)", fontSize: 12.5 }}>← Devices</a>

      <div className="ndm-page-h">
        <div>
          <h1><span className="ndm-dot" style={{ background: color }} />{device.name}</h1>
          <p>{device.ip} · {device.vendor}{device.deviceType ? ` · ${device.deviceType}` : ""}{device.groupName ? ` · ${device.groupName}` : ""} · polls every {device.pollIntervalSec}s</p>
        </div>
        <div className="ndm-row-actions">
          <span style={{ fontSize: 12.5, fontWeight: 700, color, border: `1px solid ${color}55`, borderRadius: 999, padding: "3px 10px" }}>{label}</span>
          <button className="ndm-btn" onClick={() => { void (async () => { await ndm.check(deviceId); setTimeout(loadAll, 1800); })(); }}>Check now</button>
          <button className="ndm-btn" onClick={() => setShowConfig(true)}>Edit</button>
          <button className="ndm-btn danger" onClick={async () => { if (confirm(`Disable "${device.name}"?`)) { await ndm.remove(deviceId); router.push("/monitoring/devices"); } }}>Disable…</button>
        </div>
      </div>

      {device.lastError && <div className="ndm-err" style={{ marginBottom: 10 }}>⚠ {device.lastError}</div>}

      <div className="ndm-strip">
        <Stat label="Uptime" value={fmtUptime(device.uptimeSec)} />
        <Stat label="Ports up" value={`${upPorts} / ${ports.length}`} color="var(--online)" />
        <Stat label="Ports down" value={device.downPorts} color="var(--danger)" />
        <Stat label="Last poll" value={fmtTime(device.lastSnmpPollAt)} />
        <Stat label="Last syslog" value={fmtTime(device.lastSyslogAt)} />
        <Stat label="Open alerts" value={device.openAlerts ?? alerts?.total ?? 0} color={device.openAlerts ? "var(--danger)" : undefined} />
      </div>

      <div className="ndm-tabs">
        {(["Overview", "Ports", "Events", "Syslog", "Alerts", "Configuration"] as Tab[]).map((t) => (
          <button key={t} className={`ndm-tab ${tab === t ? "on" : ""}`} onClick={() => { setTab(t); }}>
            {t}{t === "Alerts" && device.openAlerts > 0 ? ` (${device.openAlerts})` : ""}
          </button>
        ))}
      </div>

      {tab === "Overview" && (
        <>
          <div className="ndm-card" style={{ marginBottom: 12 }}>
            <div className="ndm-card-h"><b>Device traffic (RX/TX aggregate)</b>
              <div className="ndm-ranges" style={{ margin: 0 }}>
                {RANGES.map((r) => <button key={r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r}</button>)}
              </div>
            </div>
            <TrafficChart points={stream?.points || []} />
            <div className="ndm-card-sub" style={{ marginTop: 6 }}>
              Availability (24h): <b>{stream?.availability?.upPct != null ? `${stream.availability.upPct}%` : "—"}</b>
              {" · "}syslog this device: <b>{syslog?.total ?? "—"}</b> lines · events / 24h: <b>{events?.total ?? "—"}</b>
            </div>
          </div>
          {device.description && <div className="ndm-card" style={{ marginBottom: 12 }}><b style={{ fontSize: 13 }}>Notes</b><div className="ndm-card-sub" style={{ marginTop: 4 }}>{device.description}</div></div>}
        </>
      )}

      {tab === "Ports" && (
        <div className="ndm-ports">
          {ports.map((p) => <PortTile key={p.id} port={p} onClick={() => setPortSel(p)} />)}
          {!ports.length && <div className="ndm-empty">No ports discovered yet — run "Check now" or wait for the first poll.</div>}
        </div>
      )}

      {tab === "Events" && <EventTable events={events?.rows || []} />}
      {tab === "Syslog" && <SyslogTable rows={syslog?.rows || []} />}
      {tab === "Alerts" && <AlertTable alerts={alerts?.rows || []} onChanged={loadTab} />}
      {tab === "Configuration" && (
        <ConfigForm device={device} onSaved={() => { setShowConfig(false); void loadAll(); }} />
      )}

      {portSel && <PortDetail deviceId={deviceId} deviceName={device.name} port={portSel} onClose={() => setPortSel(null)} />}
      {showConfig && <ConfigForm device={device} modal onClose={() => setShowConfig(false)} onSaved={() => { setShowConfig(false); void loadAll(); }} />}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: any; color?: string }) {
  return <div className="ndm-tile"><b style={color ? { color } : undefined}>{value}</b><span>{label}</span></div>;
}

// ── Port detail modal with traffic graph + status history ──────────
function PortDetail({ deviceId, deviceName, port, onClose }: { deviceId: number; deviceName: string; port: NdmPort; onClose: () => void }) {
  const [range, setRange] = React.useState<(typeof RANGES)[number]>("24h");
  const [data, setData] = React.useState<any>(null);
  React.useEffect(() => {
    let alive = true;
    const run = async () => {
      try { const d = await ndm.portHistory(deviceId, port.id, range); if (alive) setData(d); } catch { /* keep */ }
    };
    run();
    const t = setInterval(run, 20000);
    return () => { alive = false; clearInterval(t); };
  }, [deviceId, port.id, range]);

  const state = port.adminStatus === 2 ? "D" : isUp(port) ? "UP" : "DOWN";
  const color = state === "UP" ? "#219653" : state === "DOWN" ? "#D34053" : "#94A3B8";
  const s = data?.stats;

  return (
    <NdmModal title={`${port.name} — ${deviceName}`} onClose={onClose} wide>
      <div className="ndm-page-h" style={{ marginTop: 0 }}>
        <div className="ndm-card-sub">{port.description || "no description"}{port.mac ? ` · ${port.mac}` : ""}</div>
        <span style={{ fontWeight: 700, color, border: `1px solid ${color}55`, borderRadius: 999, padding: "2px 10px", fontSize: 12 }}>{state}</span>
      </div>

      <div className="ndm-ranges">{RANGES.map((r) => <button key={r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r}</button>)}</div>

      <div className="ndm-card" style={{ marginBottom: 12 }}>
        <div className="ndm-card-h"><b>Traffic (last {range})</b></div>
        <TrafficChart points={(data?.points || []).map((p: any) => ({ at: p.at, rxRateBps: p.rxRateBps || 0, txRateBps: p.txRateBps || 0 }))} height={170} />
      </div>

      <div className="ndm-card" style={{ marginBottom: 12 }}>
        <div className="ndm-card-h"><b>Link state history</b></div>
        <UpStrip statuses={data?.statuses || []} height={42} />
      </div>

      <div className="ndm-strip">
        <Stat label="Avg RX" value={s ? fmtBits(s.avgRx) : "—"} />
        <Stat label="Peak RX" value={s ? fmtBits(s.maxRx) : "—"} />
        <Stat label="Avg TX" value={s ? fmtBits(s.avgTx) : "—"} />
        <Stat label="Peak TX" value={s ? fmtBits(s.maxTx) : "—"} />
        <Stat label="Errors / min" value={port.errorRatePerMin > 0 ? Math.round(port.errorRatePerMin) : 0} color={port.errorRatePerMin > 0 ? "var(--danger)" : undefined} />
        <Stat label="Link uptime" value={s?.upPct != null ? `${s.upPct}%` : "—"} color="var(--online)" />
      </div>

      <div className="ndm-card-sub" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 6 }}>
        <span>RX {fmtPps(port.rxPps)} · TX {fmtPps(port.txPps)}</span>
        <span>Speed {port.speedMbps ? `${port.speedMbps} Mbps` : "—"} · {port.duplex || "—"} duplex</span>
        <span>ifIndex {port.ifIndex} · first seen {fmtTime(port.firstSeen)}</span>
      </div>
    </NdmModal>
  );
}

// ── Tab tables ─────────────────────────────────────────────────────
function EventTable({ events }: { events: NdmEvent[] }) {
  if (!events.length) return <div className="ndm-empty">No events recorded yet.</div>;
  return (
    <div className="ndm-card"><table className="ndm-tbl">
      <thead><tr><th>When</th><th>Event</th><th>Port</th><th>Severity</th><th>Occurrences</th><th>Message</th><th>Status</th></tr></thead>
      <tbody>
        {events.map((e) => (
          <tr key={e.id}>
            <td style={{ whiteSpace: "nowrap" }}>{fmtTime(e.createdAt)}</td>
            <td><b>{e.label}</b></td>
            <td>{e.interfaceName || "—"}</td>
            <td><SeverityBadge s={e.severity} /></td>
            <td>{e.count > 1 ? `${e.count}×` : "—"}</td>
            <td className="ndm-card-sub" style={{ maxWidth: 340 }}>{e.message}</td>
            <td>{e.status === "OPEN" ? <b style={{ color: "var(--danger)" }}>OPEN</b> : <span style={{ color: "var(--online)" }}>cleared</span>}</td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

function SyslogTable({ rows }: { rows: SyslogRow[] }) {
  if (!rows.length) return <div className="ndm-empty">No syslog received yet. Point the device's syslog at this panel (UDP 514 by default) and enable the listener under Alerts &amp; Rules.</div>;
  return (
    <div className="ndm-card"><table className="ndm-tbl">
      <thead><tr><th>When</th><th>Severity</th><th>Source</th><th>Tag</th><th>Message</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td style={{ whiteSpace: "nowrap" }}>{fmtTime(r.receivedAt)}</td>
            <td><SeverityBadge s={r.severityName} /></td>
            <td style={{ whiteSpace: "nowrap" }}>{r.sourceIp}{r.hostname && r.hostname !== r.sourceIp ? ` (${r.hostname})` : ""}</td>
            <td>{r.tag || "—"}</td>
            <td className="ndm-card-sub" style={{ maxWidth: 380 }}>{r.message}</td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

function AlertTable({ alerts, onChanged }: { alerts: NdmAlert[]; onChanged: () => void }) {
  const act = async (id: number, kind: "ack" | "resolve") => {
    try { if (kind === "ack") await ndm.ackAlert(id); else await ndm.resolveAlert(id); onChanged(); } catch { /* fine */ }
  };
  if (!alerts.length) return <div className="ndm-empty">No alerts. Alerts are opened by rules — configure some under Alerts &amp; Rules → Rules.</div>;
  return (
    <div className="ndm-card"><table className="ndm-tbl">
      <thead><tr><th>Opened</th><th>Title</th><th>Severity</th><th>Fire count</th><th>Status</th><th></th></tr></thead>
      <tbody>
        {alerts.map((a) => (
          <tr key={a.id}>
            <td style={{ whiteSpace: "nowrap" }}>{fmtTime(a.openedAt)}</td>
            <td><b>{a.title}</b><div className="ndm-card-sub">{a.message.slice(0, 140)}</div></td>
            <td><SeverityBadge s={a.severity} /></td>
            <td>{a.fireCount}{a.fireCount > 1 ? "×" : ""}</td>
            <td>{a.status === "OPEN" ? <b style={{ color: "var(--danger)" }}>OPEN</b> : a.status === "ACKNOWLEDGED" ? <span style={{ color: "#8A6209" }}>ACK</span> : <span style={{ color: "var(--online)" }}>RESOLVED</span>}</td>
            <td>{a.status === "OPEN" && (
              <div className="ndm-row-actions">
                <button className="ndm-btn" onClick={() => act(a.id, "ack")}>Acknowledge</button>
                <button className="ndm-btn" onClick={() => act(a.id, "resolve")}>Resolve</button>
              </div>
            )}</td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

// ── Configuration (inline or modal) ────────────────────────────────
function ConfigForm({ device, onSaved, onClose, modal }: { device: any; onSaved: () => void; onClose?: () => void; modal?: boolean }) {
  const [f, setF] = React.useState({
    name: device.name, ip: device.ip, vendor: device.vendor, deviceType: device.deviceType || "",
    groupName: device.groupName || "", location: device.location || "", description: device.description || "",
    commStatus: device.credentialStatus,
    community: "", v3Username: device.credentialStatus?.v3Username || "", v3AuthProto: "SHA", v3AuthKey: "",
    v3PrivProto: "AES", v3PrivKey: "", snmpVersion: device.snmpVersion, snmpPort: String(device.snmpPort),
    pollIntervalSec: String(device.pollIntervalSec), snmpTimeoutMs: String(device.snmpTimeoutMs), snmpRetries: String(device.snmpRetries),
    syslogEnabled: device.syslogEnabled, syslogProtocol: device.syslogProtocol, syslogPort: String(device.syslogPort),
  });
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState("");

  const body = () => {
    const b: any = {
      name: f.name.trim() || f.ip, ip: f.ip.trim(), vendor: f.vendor,
      deviceType: f.deviceType.trim() || null, groupName: f.groupName.trim() || null,
      location: f.location.trim() || null, description: f.description.trim() || null,
      snmpVersion: f.snmpVersion, snmpPort: Number(f.snmpPort) || 161,
      pollIntervalSec: Number(f.pollIntervalSec) || 30,
      snmpTimeoutMs: Number(f.snmpTimeoutMs) || 5000, snmpRetries: Number(f.snmpRetries) || 1,
      syslogEnabled: f.syslogEnabled, syslogProtocol: f.syslogProtocol, syslogPort: Number(f.syslogPort) || 514,
    };
    if (f.snmpVersion === "V2C") { if (f.community.trim()) b.community = f.community.trim(); }
    else { b.v3Username = f.v3Username.trim() || undefined; b.v3AuthProto = f.v3AuthProto; if (f.v3AuthKey) b.v3AuthKey = f.v3AuthKey; b.v3PrivProto = f.v3PrivProto; if (f.v3PrivKey) b.v3PrivKey = f.v3PrivKey; }
    return b;
  };

  const save = async () => {
    setSaving(true); setErr("");
    try { const d = await ndm.update(device.id, body()); if (!modal) setF((p) => ({ ...p, ...d, community: "" })); onSaved(); }
    catch (e: any) { setErr(e?.message || "Save failed"); }
    finally { setSaving(false); }
  };

  const inner = (
    <div className="ndm-form">
      <div className="ndm-grid2">
        <div className="ndm-field"><label>Name</label><input value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} /></div>
        <div className="ndm-field"><label>IP</label><input value={f.ip} onChange={(e) => setF((p) => ({ ...p, ip: e.target.value }))} /></div>
        <div className="ndm-field"><label>Vendor</label>
          <select value={f.vendor} onChange={(e) => setF((p) => ({ ...p, vendor: e.target.value }))}>
            <option value="OTHER">Other</option><option value="CISCO">Cisco</option><option value="HUAWEI">Huawei</option><option value="MIKROTIK">MikroTik</option><option value="JUNIPER">Juniper</option>
          </select></div>
        <div className="ndm-field"><label>Type</label><input value={f.deviceType} onChange={(e) => setF((p) => ({ ...p, deviceType: e.target.value }))} /></div>
        <div className="ndm-field"><label>Group</label><input value={f.groupName} onChange={(e) => setF((p) => ({ ...p, groupName: e.target.value }))} /></div>
        <div className="ndm-field"><label>Location</label><input value={f.location} onChange={(e) => setF((p) => ({ ...p, location: e.target.value }))} /></div>
      </div>
      <div className="ndm-field"><label>Description</label><input value={f.description} onChange={(e) => setF((p) => ({ ...p, description: e.target.value }))} /></div>

      <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
      <div className="ndm-field"><label>SNMP version</label>
        <select value={f.snmpVersion} onChange={(e) => setF((p) => ({ ...p, snmpVersion: e.target.value }))}>
          <option value="V2C">SNMPv2c</option><option value="V3">SNMPv3</option>
        </select></div>
      {f.snmpVersion === "V2C" ? (
        <div className="ndm-field">
          <label>Community string — {f.commStatus?.community ? "in use (leave blank to keep it)" : "not set"}</label>
          <input type="password" placeholder={f.commStatus?.community ? "••••••••" : "public"} value={f.community} onChange={(e) => setF((p) => ({ ...p, community: e.target.value }))} />
        </div>
      ) : (
        <div className="ndm-grid2">
          <div className="ndm-field"><label>v3 username</label><input value={f.v3Username} onChange={(e) => setF((p) => ({ ...p, v3Username: e.target.value }))} /></div>
          <div className="ndm-field"><label>Auth key — {f.commStatus?.v3Auth ? "in use" : "not set"}</label><input type="password" placeholder={f.commStatus?.v3Auth ? "••••••••" : ""} value={f.v3AuthKey} onChange={(e) => setF((p) => ({ ...p, v3AuthKey: e.target.value }))} /></div>
          <div className="ndm-field"><label>Privacy key — {f.commStatus?.v3Priv ? "in use" : "not set"}</label><input type="password" placeholder={f.commStatus?.v3Priv ? "••••••••" : ""} value={f.v3PrivKey} onChange={(e) => setF((p) => ({ ...p, v3PrivKey: e.target.value }))} /></div>
        </div>
      )}
      <div className="ndm-hint">Credentials are encrypted at rest. Enter a new value only to change it.</div>

      <div className="ndm-grid2">
        <div className="ndm-field"><label>Port</label><input type="number" value={f.snmpPort} onChange={(e) => setF((p) => ({ ...p, snmpPort: e.target.value }))} /></div>
        <div className="ndm-field"><label>Poll interval</label>
          <select value={f.pollIntervalSec} onChange={(e) => setF((p) => ({ ...p, pollIntervalSec: e.target.value }))}>
            <option value="10">10 s</option><option value="30">30 s</option><option value="60">60 s</option><option value="300">5 min</option>
          </select></div>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
        <input type="checkbox" checked={f.syslogEnabled} onChange={(e) => setF((p) => ({ ...p, syslogEnabled: e.target.checked }))} />
        Receives syslog ({f.syslogProtocol} :{f.syslogPort})
      </label>
    </div>
  );

  const foot = (
    <>
      {err && <span className="ndm-err" style={{ marginRight: "auto" }}>{err}</span>}
      {modal ? <button className="ndm-btn" onClick={onClose}>Cancel</button> : null}
      <button className="ndm-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
    </>
  );

  if (!modal) return <div className="ndm-card"><div className="ndm-card-h"><b>Configuration</b></div>{inner}<div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>{foot}</div></div>;
  return <NdmModal title={`Edit — ${device.name}`} onClose={onClose!}>{inner}<div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>{foot}</div></NdmModal>;
}