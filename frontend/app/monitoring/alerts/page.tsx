"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { ndm, fmtTime, sevColor, type NdmAlert, type NdmRule } from "../ndm";
import { NDMCSS, NdmModal, SeverityBadge, useNdmRefresh } from "../ndm-ui";
import { useSSE } from "../../components/use-sse";

export default function AlertsRulesPage() {
  const router = useRouter();
  const [alerts, setAlerts] = React.useState<{ rows: NdmAlert[]; total: number } | null>(null);
  const [rules, setRules] = React.useState<NdmRule[]>([]);
  const [settings, setSettings] = React.useState<any>(null);
  const [tab, setTab] = React.useState<"alerts" | "rules" | "settings">("alerts");
  const [filter, setFilter] = React.useState<"OPEN" | "RESOLVED" | "">("OPEN");
  const [editing, setEditing] = React.useState<NdmRule | null | "new">(null);

  const load = React.useCallback(async () => {
    try {
      const [a, r] = await Promise.all([
        ndm.alerts({ status: filter || undefined, limit: 300 }).catch(() => null),
        ndm.rules().catch(() => []),
      ]);
      if (a) setAlerts(a as any);
      setRules(r);
    } catch { /* keep */ }
  }, [filter]);
  const loadSettings = React.useCallback(async () => {
    try { setSettings(await ndm.settings()); } catch { /* probably not an admin */ }
  }, []);

  useNdmRefresh(load, () => {}, [load], 15000);
  useNdmRefresh(loadSettings, () => {}, [loadSettings], 30000);
  useSSE({ onEvent: (t: string) => { if (t === "ndm:alert" || t === "ndm:event") void load(); } });

  const act = async (id: number, kind: "ack" | "resolve") => {
    try { if (kind === "ack") await ndm.ackAlert(id); else await ndm.resolveAlert(id); void load(); } catch { /* fine */ }
  };

  const open = alerts?.rows.filter((a) => a.status === "OPEN").length ?? 0;

  return (
    <div className="ndm">
      <style>{NDMCSS}</style>

      <div className="ndm-page-h">
        <div>
          <h1>Alerts &amp; Rules</h1>
          <p>Incidents opened by rules, and the rules themselves. Rules trigger on events from SNMP polling and syslog.</p>
        </div>
        <div className="ndm-row-actions">
          <button className="ndm-btn" onClick={() => router.push("/monitoring/devices")}>Devices</button>
          <button className="ndm-btn" onClick={() => router.push("/monitoring/ports")}>Ports</button>
        </div>
      </div>

      <div className="ndm-tabs">
        <button className={`ndm-tab ${tab === "alerts" ? "on" : ""}`} onClick={() => setTab("alerts")}>Alerts {open ? `(${open})` : ""}</button>
        <button className={`ndm-tab ${tab === "rules" ? "on" : ""}`} onClick={() => setTab("rules")}>Rules ({rules.length})</button>
        <button className={`ndm-tab ${tab === "settings" ? "on" : ""}`} onClick={() => setTab("settings")}>Syslog server {settings ? (settings.listeners.filter((l: any) => l.enabled).length ? "" : "(off)") : ""}</button>
      </div>

      {tab === "alerts" && (
        <>
          <div className="ndm-ranges">
            <button className={filter === "OPEN" ? "on" : ""} onClick={() => setFilter("OPEN")}>Open</button>
            <button className={filter === "RESOLVED" ? "on" : ""} onClick={() => setFilter("RESOLVED")}>Resolved</button>
            <button className={filter === "" ? "on" : ""} onClick={() => setFilter("")}>All</button>
          </div>
          <div className="ndm-card">
            {!alerts?.rows.length ? (
              <div className="ndm-empty">No {filter.toLowerCase() || ""} alerts. Create a rule below and the engine will open one the moment the matching event fires.</div>
            ) : (
              <table className="ndm-tbl">
                <thead><tr><th>Opened</th><th>Title</th><th>Device</th><th>Severity</th><th>Fires</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {alerts.rows.map((a) => (
                    <tr key={a.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtTime(a.openedAt)}</td>
                      <td><b>{a.title}</b><div className="ndm-card-sub" style={{ maxWidth: 320 }}>{a.message.slice(0, 150)}</div></td>
                      <td>{a.device ? <a style={{ color: "var(--accent)", cursor: "pointer" }} onClick={() => router.push(`/monitoring/devices/${a.deviceId}`)}>{a.device.name}</a> : "—"}</td>
                      <td><SeverityBadge s={a.severity} /></td>
                      <td>{a.fireCount}{a.fireCount > 1 ? "×" : ""}</td>
                      <td>
                        {a.status === "OPEN" ? <b style={{ color: "var(--danger)" }}>OPEN</b> :
                         a.status === "ACKNOWLEDGED" ? <b style={{ color: "#8A6209" }}>ACK</b> :
                         <span style={{ color: "var(--online)" }}>RESOLVED {a.resolvedAt ? fmtTime(a.resolvedAt) : ""}</span>}
                      </td>
                      <td>{a.status !== "RESOLVED" && (
                        <div className="ndm-row-actions">
                          <button className="ndm-btn" onClick={() => act(a.id, "ack")}>Ack</button>
                          <button className="ndm-btn" onClick={() => act(a.id, "resolve")}>Resolve</button>
                        </div>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tab === "rules" && (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
            <button className="ndm-btn pri" onClick={() => setEditing("new")}>+ New rule</button>
          </div>
          <div className="ndm-card">
            {!rules.length ? (
              <div className="ndm-empty">No rules yet. A rule says "when this event happens, notify like this". Without rules, nothing is alerted — only recorded.</div>
            ) : (
              <table className="ndm-tbl">
                <thead><tr><th>Name</th><th>Event</th><th>Condition</th><th>Severity</th><th>Channels</th><th>Alerts</th><th>Enabled</th><th></th></tr></thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id}>
                      <td><b>{r.name}</b><div className="ndm-card-sub">{r.description || ""}</div></td>
                      <td>{dispEvent(r.eventType)}</td>
                      <td className="ndm-card-sub">{condLabel(r.condition)}</td>
                      <td><SeverityBadge s={r.severity} /></td>
                      <td className="ndm-card-sub">{channelsLabel(r.channels) || "sound only"}</td>
                      <td>{r._count?.alerts ?? 0}</td>
                      <td>{r.enabled ? <b style={{ color: "var(--online)" }}>ON</b> : <span className="ndm-card-sub">off</span>}</td>
                      <td><div className="ndm-row-actions"><button className="ndm-btn" onClick={() => setEditing(r)}>Edit</button><button className="ndm-btn danger" onClick={async () => { if (confirm(`Delete rule "${r.name}"?`)) { await ndm.deleteRule(r.id); void load(); } }}>Del</button></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tab === "settings" && (
        <SettingsPanel settings={settings} onSaved={loadSettings} />
      )}

      {editing && <RuleEditor rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

// ── Rule editor ────────────────────────────────────────────────────
function RuleEditor({ rule, onClose, onSaved }: { rule: NdmRule | null; onClose: () => void; onSaved: () => void }) {
  const [help, setHelp] = React.useState<any>(null);
  const [f, setF] = React.useState({
    name: rule?.name || "", eventType: rule?.eventType || "PORT_DOWN",
    condition: rule?.condition || "", severity: rule?.severity || "WARNING", enabled: rule?.enabled ?? true,
    discord: !!(rule?.channels as any)?.discord, whatsapp: !!(rule?.channels as any)?.whatsapp,
    sms: (rule?.channels as any)?.sms || "", email: (rule?.channels as any)?.email || "",
    description: rule?.description || "",
  });
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState("");

  React.useEffect(() => { ndm.ruleHelp().then(setHelp).catch(() => {}); }, []);

  const save = async () => {
    setSaving(true); setErr("");
    const channels: any = { discord: f.discord, whatsapp: f.whatsapp };
    if (f.sms.trim()) channels.sms = f.sms.trim();
    if (f.email.trim()) channels.email = f.email.trim();
    try {
      const body = { name: f.name, eventType: f.eventType, condition: f.condition || null, severity: f.severity, enabled: f.enabled, channels, description: f.description || null };
      if (rule) await ndm.updateRule(rule.id, body); else await ndm.createRule(body);
      onSaved();
    } catch (e: any) { setErr(e?.message || "Save failed"); }
    finally { setSaving(false); }
  };

  return (
    <NdmModal title={rule ? `Edit rule — ${rule.name}` : "New rule"} onClose={onClose}>
      <div className="ndm-form">
        <div className="ndm-field"><label>Name *</label><input value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} placeholder="Core switch ports dead" /></div>
        <div className="ndm-field"><label>Trigger event</label>
          <select value={f.eventType} onChange={(e) => setF((p) => ({ ...p, eventType: e.target.value }))}>
            {(help?.eventTypes || [
              { type: "PORT_DOWN", label: "Port DOWN" }, { type: "LINK_DOWN", label: "Link DOWN (syslog)" },
              { type: "DEVICE_DOWN", label: "Device unreachable" }, { type: "BGP_DOWN", label: "BGP neighbor down" },
              { type: "OSPF_DOWN", label: "OSPF adjacency down" }, { type: "CPU_HIGH", label: "High CPU" },
              { type: "MEMORY_HIGH", label: "High memory" }, { type: "AUTH_FAILURE", label: "Auth failure" },
              { type: "CONFIG_CHANGE", label: "Config change" }, { type: "SYSLOG", label: "Any syslog line" },
              { type: "SYSLOG_STOPPED", label: "Device went syslog-silent" },
            ]).map((e: any) => <option key={e.type} value={e.type}>{e.label}</option>)}
          </select></div>
        <div className="ndm-field"><label>Condition <span className="ndm-hint">(leave empty = every occurrence)</span></label>
          <select value={f.condition} onChange={(e) => setF((p) => ({ ...p, condition: e.target.value }))}>
            <option value="">Every event of this type</option>
            <option value="DURATION:120">Sustained 120s → escalate</option>
            <option value="DURATION:300">Sustained 5min → escalate</option>
            <option value="FLAP:5:600">Flapped 5× in 10 min → CRITICAL</option>
            <option value="THRESHOLD:90:CPU">Device CPU ≥ 90%</option>
            <option value="THRESHOLD:90:MEMORY">Device memory ≥ 90%</option>
            <option value="SYSLOG_SILENCE:300">No syslog 5 min</option>
          </select>
          <div className="ndm-hint" style={{ marginTop: 4 }}>{condLabel(f.condition)}</div></div>
        <div className="ndm-field"><label>Severity</label>
          <select value={f.severity} onChange={(e) => setF((p) => ({ ...p, severity: e.target.value }))}>
            <option value="CRITICAL">CRITICAL</option><option value="WARNING">WARNING</option><option value="INFO">INFO</option>
          </select></div>

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={f.enabled} onChange={(e) => setF((p) => ({ ...p, enabled: e.target.checked }))} /> Rule enabled
          </label>
          <div className="ndm-hint" style={{ marginTop: 4 }}>Channels are sent only when this rule fires: Discord/WhatsApp use the system (and your own) webhooks; SMS/email need a recipient number/address here.</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}><input type="checkbox" checked={f.discord} onChange={(e) => setF((p) => ({ ...p, discord: e.target.checked }))} /> Discord</label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}><input type="checkbox" checked={f.whatsapp} onChange={(e) => setF((p) => ({ ...p, whatsapp: e.target.checked }))} /> WhatsApp</label>
            <div className="ndm-field" style={{ gridColumn: "1 / -1" }}><label>SMS recipient (optional)</label><input value={f.sms} onChange={(e) => setF((p) => ({ ...p, sms: e.target.value }))} placeholder="+34612345678" /></div>
            <div className="ndm-field" style={{ gridColumn: "1 / -1" }}><label>Email recipient (optional)</label><input value={f.email} onChange={(e) => setF((p) => ({ ...p, email: e.target.value }))} placeholder="ops@corp.com" /></div>
          </div>
        </div>

        <div className="ndm-field"><label>Description</label><input value={f.description} onChange={(e) => setF((p) => ({ ...p, description: e.target.value }))} /></div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        {err && <span className="ndm-err" style={{ marginRight: "auto" }}>{err}</span>}
        <button className="ndm-btn" onClick={onClose}>Cancel</button>
        <button className="ndm-btn pri" onClick={save} disabled={saving || !f.name.trim()}>{saving ? "Saving…" : "Save rule"}</button>
      </div>
    </NdmModal>
  );
}

function SettingsPanel({ settings, onSaved }: { settings: any; onSaved: () => void }) {
  const [f, setF] = React.useState<any>(null);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState("");
  React.useEffect(() => { if (settings) setF((prev) => prev ?? { listeners: settings.listeners.map((l: any) => ({ ...l })) }); }, [settings]);

  if (!settings) return <div className="ndm-empty">Only a Super Admin can change server-wide listener settings.</div>;

  const save = async () => {
    setSaving(true); setErr("");
    try { await ndm.updateSettings({ listeners: f.listeners.map((l: any) => ({ protocol: l.protocol, enabled: l.enabled, port: Number(l.port), tlsCertPath: l.tlsCertPath || null, tlsKeyPath: l.tlsKeyPath || null })) }); onSaved(); }
    catch (e: any) { setErr(e?.message || "Save failed"); }
    finally { setSaving(false); }
  };

  return (
    <div className="ndm-card">
      <div className="ndm-card-h"><b>Syslog server listeners</b><span className="ndm-card-sub">running: {settings.running?.join(", ") || "none"}</span></div>
      <p className="ndm-hint" style={{ marginBottom: 10 }}>Point your switches' syslog at this panel. Port 514 is privileged — the backend runs as root (or with cap_net_bind_service), otherwise binding fails and the listener logs the reason. TLS needs a certificate path readable by the backend.</p>
      {f && (
        <table className="ndm-tbl">
          <thead><tr><th>Protocol</th><th>Enabled</th><th>Port</th><th>Certificate / key (TLS)</th></tr></thead>
          <tbody>
            {f.listeners.map((l: any, i: number) => (
              <tr key={l.protocol}>
                <td><b>{l.protocol}</b></td>
                <td><input type="checkbox" checked={l.enabled} onChange={(e) => setF((p) => { const ls = [...p.listeners]; ls[i] = { ...ls[i], enabled: e.target.checked }; return { ...p, listeners: ls }; })} /></td>
                <td><input type="number" style={{ width: 80, border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "4px 6px" }} value={l.port} onChange={(e) => setF((p) => { const ls = [...p.listeners]; ls[i] = { ...ls[i], port: e.target.value }; return { ...p, listeners: ls }; })} /></td>
                <td>{l.protocol === "TLS" ? (
                  <div style={{ display: "flex", gap: 6, flexDirection: "column" }}>
                    <input placeholder="cert path" value={l.tlsCertPath || ""} onChange={(e) => setF((p) => { const ls = [...p.listeners]; ls[i] = { ...ls[i], tlsCertPath: e.target.value }; return { ...p, listeners: ls }; })} />
                    <input placeholder="key path" value={l.tlsKeyPath || ""} onChange={(e) => setF((p) => { const ls = [...p.listeners]; ls[i] = { ...ls[i], tlsKeyPath: e.target.value }; return { ...p, listeners: ls }; })} />
                  </div>) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12, alignItems: "center" }}>
        {err && <span className="ndm-err" style={{ marginRight: "auto" }}>{err}</span>}
        <button className="ndm-btn pri" onClick={save} disabled={saving || !f}>{saving ? "Saving…" : "Apply & restart listeners"}</button>
      </div>
    </div>
  );
}

// ── Display helpers ────────────────────────────────────────────────
function dispEvent(t: string) {
  const map: Record<string, string> = { PORT_DOWN: "Port DOWN", LINK_DOWN: "Link DOWN", DEVICE_DOWN: "Device unreachable", BGP_DOWN: "BGP down", OSPF_DOWN: "OSPF down", CPU_HIGH: "CPU high", MEMORY_HIGH: "Memory high", AUTH_FAILURE: "Auth failure", CONFIG_CHANGE: "Config change", SYSLOG: "Syslog", SYSLOG_STOPPED: "Syslog silent" };
  return map[t] || t;
}
function condLabel(c: string | null) {
  if (!c) return "every occurrence";
  if (c.startsWith("DURATION:")) return `re-alert every ${c.split(":")[1]}s while active`;
  if (c.startsWith("FLAP:")) { const [, n, w] = c.split(":"); return `${n}× within ${w}s → CRITICAL`; }
  if (c.startsWith("THRESHOLD:")) { const [, v, m] = c.split(":"); return `${m} ≥ ${v}%`; }
  if (c.startsWith("SYSLOG_SILENCE:")) return `no syslog for ${Math.round(Number(c.split(":")[1]) / 60)} min`;
  return c;
}
function channelsLabel(ch: any) {
  const out: string[] = [];
  if (ch?.discord) out.push("Discord");
  if (ch?.whatsapp) out.push("WhatsApp");
  if (ch?.sms) out.push("SMS");
  if (ch?.email) out.push("Email");
  return out.join(", ");
}