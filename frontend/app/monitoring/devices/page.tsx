"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { ndm, fmtUptimeFull, fmtTime, catLabel, type NdmDevice } from "../ndm";
import { NDMCSS, NdmModal, Stat, useNdmRefresh } from "../ndm-ui";
import { NdmSoundBell } from "../../components/ndm-sound";
import { useSSE } from "../../components/use-sse";
import Link from "next/link";

/** Network devices (SNMP switches/routers) — list + add wizard. */
export default function DevicesPage() {
  const router = useRouter();
  const [devices, setDevices] = React.useState<NdmDevice[]>([]);
  const [stats, setStats] = React.useState<any>(null);
  const [err, setErr] = React.useState("");
  const [q, setQ] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [wizard, setWizard] = React.useState(false);

  const load = React.useCallback(async () => {
    try { return await ndm.devices(); } catch (e: any) { setErr(e?.message || "Could not load devices"); return []; }
  }, []);
  const loadStats = React.useCallback(async () => {
    try { setStats(await ndm.stats()); } catch { /* fine */ }
  }, []);

  useNdmRefresh(load, setDevices, [load]);
  useNdmRefresh(loadStats, setStats, [loadStats], 30000);
  // Live: re-fetch on any push from the poller/syslog.
  useSSE({ onEvent: (t: string) => {
    if (t === "ndm:event" || t === "ndm:alert" || t === "ndm:device" || t === "ndm:port") { void load(); void loadStats(); }
  } });

  const filtered = devices.filter((d) => {
    if (!q.trim()) return true;
    const hay = `${d.name} ${d.ip} ${d.vendor} ${d.groupName || ""} ${d.location || ""}`.toLowerCase();
    return q.trim().toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  });
  const ds = stats?.devices || { total: 0, reachable: 0, down: 0, ports: 0, upPorts: 0, downPorts: 0 };

  return (
    <div className="ndm">
      <style>{NDMCSS}</style>

      <div className="ndm-page-h">
        <div>
          <h1>Network Devices</h1>
          <p>SNMP switches &amp; routers — live ports, traffic, syslog events and alerts.</p>
        </div>
        <div className="ndm-row-actions">
          <NdmSoundBell />
          <Link className="ndm-btn" href="/monitoring/ports">Ports</Link>
          <Link className="ndm-btn" href="/monitoring/alerts">Alerts &amp; Rules</Link>
          <button className="ndm-btn pri" onClick={() => setWizard(true)}>+ Add device</button>
        </div>
      </div>

      <div className="ndm-strip">
        <Stat label="Devices" value={ds.total} />
        <Stat label="Reachable" value={ds.reachable} color="var(--online)" />
        <Stat label="Down / unreachable" value={ds.down} color="var(--danger)" />
        <Stat label="Ports in use" value={`${ds.upPorts} / ${ds.ports}`} color="var(--warning)" />
        <Stat label="Down ports" value={ds.downPorts} color="var(--danger)" />
        <Stat label="Open alerts" value={stats?.alerts?.open ?? 0} color={(stats?.alerts?.open || 0) > 0 ? "var(--danger)" : undefined} />
        <Stat label="Events / 24h" value={stats?.events?.last24h ?? 0} />
        <Stat label="Syslog / 24h" value={stats?.syslog?.last24h ?? 0} />
      </div>

      <div className="ndm-filter" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <input placeholder="Search name, IP, vendor, group…" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "8px 10px", background: "var(--surface)", color: "var(--text)" }} />
        {err && <span className="ndm-err">{err}</span>}
      </div>

      {!devices.length ? (
        <div className="ndm-empty">
          No network devices yet. Add your first switch or router to start SNMP polling — it takes about two minutes
          because the wizard tests the credentials live before anything is saved.
          <div style={{ marginTop: 12 }}><button className="ndm-btn pri" onClick={() => setWizard(true)}>+ Add device</button></div>
        </div>
      ) : (
        <div className="ndm-grid">
          {filtered.map((d) => <DeviceCard key={d.id} d={d} onOpen={() => router.push(`/monitoring/devices/${d.id}`)} onRefresh={load} />)}
          {!filtered.length && <div className="ndm-empty">Nothing matches the search.</div>}
        </div>
      )}

      {wizard && <AddDeviceWizard onClose={() => setWizard(false)} onDone={() => { setWizard(false); void load(); void loadStats(); }} />}
    </div>
  );
}

function DeviceCard({ d, onOpen, onRefresh }: { d: NdmDevice; onOpen: () => void; onRefresh: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const state = !d.enabled ? "off" : d.isReachable === null ? "wait" : d.isReachable ? "up" : "down";
  const color = { off: "#94A3B8", wait: "#8A6209", up: "#219653", down: "#D34053" }[state];
  const label = { off: "Paused", wait: "First check…", up: "Reachable", down: "DOWN" }[state];
  const check = async (e: React.MouseEvent) => {
    e.stopPropagation(); setBusy(true);
    try { await ndm.check(d.id); await new Promise((r) => setTimeout(r, 1500)); onRefresh(); }
    finally { setBusy(false); }
  };
  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await ndm.update(d.id, { enabled: !d.enabled }); onRefresh();
  };
  const toggleSound = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await ndm.update(d.id, { soundEnabled: d.soundEnabled !== false ? false : true }); onRefresh();
  };
  const remove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Disable "${d.name}"? It keeps its history but stops polling and alerts. You can re-enable it any time.`)) return;
    await ndm.remove(d.id); onRefresh();
  };
  return (
    <div className="ndm-card ndm-device" onClick={onOpen}>
      <div className="ndm-card-h">
        <b className="ndm-name"><span className="ndm-dot" style={{ background: color }} />{d.name}</b>
        <SeverityPill label={label} color={color} />
      </div>
      <div className="ndm-card-sub">{d.ip}{d.vendor !== "OTHER" ? ` · ${d.vendor}` : ""}{d.groupName ? ` · ${d.groupName}` : ""}{d.deviceType ? ` · ${d.deviceType}` : ""}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, margin: "12px 0" }}>
        <MiniStat label="Ports up" value={`${d.upPorts} / ${d.interfaceCount}`} color="var(--online)" />
        <MiniStat label="Open alerts" value={d.openAlerts} color={d.openAlerts ? "var(--danger)" : "var(--muted)"} />
        <MiniStat label="Uptime" value={fmtUptimeFull(d.uptimeSec)} />
        <MiniStat label="Last poll" value={fmtTime(d.lastSnmpPollAt)} />
      </div>
      {d.lastError && <div className="ndm-err" style={{ fontSize: 11 }} title={d.lastError}>{d.lastError.slice(0, 90)}</div>}
      <div className="ndm-row-actions" style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
        <button className="ndm-btn" onClick={check} disabled={busy}>{busy ? "Polling…" : "Check now"}</button>
        <button className="ndm-btn" onClick={toggleSound} title={d.soundEnabled !== false ? "Port alerts sound ON — click to mute this device" : "Sound OFF — click to enable"}>
          {d.soundEnabled !== false ? "🔔" : "🔕"}
        </button>
        <button className="ndm-btn" onClick={toggle}>{d.enabled ? "Pause" : "Enable"}</button>
        <button className="ndm-btn danger" onClick={remove}>Disable…</button>
      </div>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: any; color?: string }) {
  return <div style={{ fontSize: 11 }}><span style={{ color: "var(--muted)" }}>{label}</span> <b style={{ color: color || "var(--text)" }}>{value}</b></div>;
}

function SeverityPill({ label, color }: { label: string; color: string }) {
  return <span style={{ fontSize: 10.5, fontWeight: 700, color, border: `1px solid ${color}55`, borderRadius: 999, padding: "2px 8px" }}>{label}</span>;
}

// ── Add-device wizard: details → test → discover → save ───────────
type WizardState = {
  name: string; ip: string; vendor: string; deviceType: string; groupName: string; location: string; description: string;
  snmpVersion: string; snmpPort: string; pollIntervalSec: string; community: string;
  v3Username: string; v3AuthProto: string; v3AuthKey: string; v3PrivProto: string; v3PrivKey: string;
  syslogEnabled: boolean; syslogProtocol: string; syslogPort: string;
  snmpTimeoutMs: string; snmpRetries: string;
};

function AddDeviceWizard({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = React.useState<WizardState>({
    name: "", ip: "", vendor: "OTHER", deviceType: "", groupName: "", location: "", description: "",
    snmpVersion: "V2C", snmpPort: "161", pollIntervalSec: "30", community: "public",
    v3Username: "", v3AuthProto: "SHA", v3AuthKey: "", v3PrivProto: "AES", v3PrivKey: "",
    syslogEnabled: false, syslogProtocol: "UDP", syslogPort: "514", snmpTimeoutMs: "5000", snmpRetries: "1",
  });
  const [step, setStep] = React.useState<1 | 2 | 3>(1);
  const [testing, setTesting] = React.useState(false);
  const [testRes, setTestRes] = React.useState<any>(null);
  const [discovered, setDiscovered] = React.useState<any[] | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState("");

  const set = (k: keyof WizardState, v: any) => setF((p) => ({ ...p, [k]: v }));
  const testBody = () => ({
    ip: f.ip.trim(), snmpVersion: f.snmpVersion, snmpPort: Number(f.snmpPort) || 161,
    community: f.snmpVersion === "V2C" ? f.community.trim() : undefined,
    v3Username: f.snmpVersion === "V3" ? f.v3Username.trim() || undefined : undefined,
    v3AuthProto: f.snmpVersion === "V3" ? f.v3AuthProto : undefined,
    v3AuthKey: f.snmpVersion === "V3" ? f.v3AuthKey || undefined : undefined,
    v3PrivProto: f.snmpVersion === "V3" ? (f.v3PrivKey ? f.v3PrivProto : undefined) : undefined,
    v3PrivKey: f.snmpVersion === "V3" ? f.v3PrivKey || undefined : undefined,
    snmpTimeoutMs: Number(f.snmpTimeoutMs) || 5000, snmpRetries: Number(f.snmpRetries) || 1,
  });

  const test = async () => {
    if (!f.ip.trim()) { setErr("Enter the device IP first."); return; }
    setTesting(true); setErr(""); setTestRes(null);
    try {
      const r = await ndm.test(testBody());
      setTestRes(r);
      if (r.ok && !f.name.trim()) setF((p) => ({ ...p, name: r.sysName || p.ip }));
    } catch (e: any) { setTestRes({ ok: false, error: e?.message }); }
    finally { setTesting(false); }
  };
  const discover = async () => {
    setTesting(true); setErr("");
    try {
      const r = await ndm.discover(testBody());
      if (!r.ok || !r.interfaces) setErr(r.error || "Discovery failed — no SNMP response.");
      else { setDiscovered(r.interfaces); setStep(3); }
    } catch (e: any) { setErr(e?.message || "Discovery failed"); }
    finally { setTesting(false); }
  };
  const save = async () => {
    setSaving(true); setErr("");
    try {
      await ndm.create({
        ...testBody(), name: f.name.trim() || f.ip.trim(),
        vendor: f.vendor, deviceType: f.deviceType.trim() || null, groupName: f.groupName.trim() || null,
        location: f.location.trim() || null, description: f.description.trim() || null,
        pollIntervalSec: Number(f.pollIntervalSec) || 30,
        syslogEnabled: f.syslogEnabled, syslogProtocol: f.syslogProtocol, syslogPort: Number(f.syslogPort) || 514,
      });
      onDone();
    } catch (e: any) { setErr(e?.message || "Could not save device"); }
    finally { setSaving(false); }
  };

  const ipOk = /^(\d{1,3}\.){3}\d{1,3}$|^[a-zA-Z0-9.-]{1,253}$/.test(f.ip.trim());

  return (
    <NdmModal title="Add network device" onClose={onClose} wide>
      {/* Step indicator */}
      <div className="ndm-ranges">
        {(["Details", "Test & Discover", "Confirm"] as const).map((s, i) => (
          <button key={s} className={step === i + 1 ? "on" : ""}>{i + 1}. {s}</button>
        ))}
      </div>

      {step === 1 && (
        <>
          <div className="ndm-form">
            <div className="ndm-grid2">
              <div className="ndm-field"><label>IP address *</label>
                <input placeholder="192.168.1.10" value={f.ip} onChange={(e) => set("ip", e.target.value)} /></div>
              <div className="ndm-field"><label>Name (optional)</label>
                <input placeholder="Core switch racks 1-2" value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
              <div className="ndm-field"><label>Vendor</label>
                <select value={f.vendor} onChange={(e) => set("vendor", e.target.value)}>
                  <option value="OTHER">Other / generic</option>
                  <option value="CISCO">Cisco</option>
                  <option value="HUAWEI">Huawei</option>
                  <option value="MIKROTIK">MikroTik</option>
                  <option value="JUNIPER">Juniper</option>
                </select></div>
              <div className="ndm-field"><label>Type</label>
                <input placeholder="Cisco Catalyst 2960" value={f.deviceType} onChange={(e) => set("deviceType", e.target.value)} /></div>
              <div className="ndm-field"><label>Group</label>
                <input placeholder="Tower 1" value={f.groupName} onChange={(e) => set("groupName", e.target.value)} /></div>
              <div className="ndm-field"><label>Location</label>
                <input placeholder="Main office, rack 3" value={f.location} onChange={(e) => set("location", e.target.value)} /></div>
            </div>
            <div className="ndm-field"><label>Description</label>
              <input placeholder="Anything worth knowing about this device" value={f.description} onChange={(e) => set("description", e.target.value)} /></div>

            <div style={{ borderTop: "1px solid var(--border)", marginTop: 4 }} />
            <div className="ndm-field"><label>SNMP version</label>
              <select value={f.snmpVersion} onChange={(e) => set("snmpVersion", e.target.value)}>
                <option value="V2C">SNMPv2c (community string)</option>
                <option value="V3">SNMPv3 (user + auth)</option>
              </select></div>

            {f.snmpVersion === "V2C" ? (
              <div className="ndm-grid2">
                <div className="ndm-field"><label>Community</label>
                  <input value={f.community} onChange={(e) => set("community", e.target.value)} /></div>
                <div className="ndm-field"><label>Port</label>
                  <input type="number" value={f.snmpPort} onChange={(e) => set("snmpPort", e.target.value)} /></div>
              </div>
            ) : (
              <>
                <div className="ndm-grid2">
                  <div className="ndm-field"><label>v3 username *</label>
                    <input value={f.v3Username} onChange={(e) => set("v3Username", e.target.value)} /></div>
                  <div className="ndm-field"><label>Port</label>
                    <input type="number" value={f.snmpPort} onChange={(e) => set("snmpPort", e.target.value)} /></div>
                  <div className="ndm-field"><label>Auth protocol</label>
                    <select value={f.v3AuthProto} onChange={(e) => set("v3AuthProto", e.target.value)}><option>SHA</option><option>MD5</option></select></div>
                  <div className="ndm-field"><label>Auth key</label>
                    <input type="password" value={f.v3AuthKey} onChange={(e) => set("v3AuthKey", e.target.value)} /></div>
                  <div className="ndm-field"><label>Privacy protocol</label>
                    <select value={f.v3PrivProto} onChange={(e) => set("v3PrivProto", e.target.value)}><option>AES</option><option>DES</option></select></div>
                  <div className="ndm-field"><label>Privacy key (optional)</label>
                    <input type="password" value={f.v3PrivKey} onChange={(e) => set("v3PrivKey", e.target.value)} /></div>
                </div>
              </>
            )}

            <div className="ndm-grid2">
              <div className="ndm-field"><label>Poll interval</label>
                <select value={f.pollIntervalSec} onChange={(e) => set("pollIntervalSec", e.target.value)}>
                  <option value="10">Every 10 seconds</option><option value="30">Every 30 seconds</option>
                  <option value="60">Every minute</option><option value="300">Every 5 minutes</option>
                </select></div>
              <div className="ndm-field"><label>Timeout / retries</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input type="number" value={f.snmpTimeoutMs} onChange={(e) => set("snmpTimeoutMs", e.target.value)} title="ms" style={{ width: "60%" }} />
                  <input type="number" value={f.snmpRetries} onChange={(e) => set("snmpRetries", e.target.value)} title="retries" style={{ width: "40%" }} />
                </div></div>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={f.syslogEnabled} onChange={(e) => set("syslogEnabled", e.target.checked)} />
                This device sends syslog to this panel (port 514 UDP by default)
              </label>
              {f.syslogEnabled && (
                <div className="ndm-grid2" style={{ marginTop: 8 }}>
                  <div className="ndm-field"><label>Protocol</label>
                    <select value={f.syslogProtocol} onChange={(e) => set("syslogProtocol", e.target.value)}><option>UDP</option><option>TCP</option><option>TLS</option></select></div>
                  <div className="ndm-field"><label>Port</label>
                    <input type="number" value={f.syslogPort} onChange={(e) => set("syslogPort", e.target.value)} /></div>
                </div>
              )}
              <div className="ndm-hint" style={{ marginTop: 6 }}>Keep the syslog listener (UDP/TCP/TLS) enabled under Alerts &amp; Rules → Server settings for the panel to receive it.</div>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
            {err && <span className="ndm-err" style={{ marginRight: "auto" }}>{err}</span>}
            <button className="ndm-btn" onClick={onClose}>Cancel</button>
            <button className="ndm-btn pri" disabled={!ipOk} onClick={() => { setStep(2); void test(); }}>Next — test SNMP →</button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="ndm-card" style={{ marginBottom: 12 }}>
            <div className="ndm-card-h"><b>SNMP test on {f.ip}</b><button className="ndm-btn" onClick={test} disabled={testing}>{testing ? "Testing…" : "Test again"}</button></div>
            {testing ? <div className="ndm-card-sub">Connecting via {f.snmpVersion} on :{f.snmpPort}…</div> :
              !testRes ? <div className="ndm-card-sub">Press "Next" ran the test automatically.</div> :
              testRes.ok ? (
                <div className="ndm-ok">
                  ✓ SNMP works — {testRes.sysName || "unnamed device"} · {testRes.interfaceCount} interface(s) · {testRes.sysDescr || ""}
                </div>
              ) : (
                <div className="ndm-err"><b>SNMP test failed:</b> {testRes.error}<div className="ndm-hint" style={{ marginTop: 4 }}>Check the community/v3 credentials, that SNMP is enabled on the device, and that this server can reach UDP/{f.snmpPort}.</div></div>
              )}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <button className="ndm-btn" onClick={() => setStep(1)}>← Back</button>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="ndm-btn" onClick={() => setStep(3)}>Skip discovery</button>
              <button className="ndm-btn pri" disabled={!testRes?.ok || testing || !f.ip.trim()} onClick={discover}>{testing ? "Discovering…" : "Discover interfaces →"}</button>
            </div>
          </div>
          {err && (
            <div className="ndm-err" style={{ marginTop: 10 }}>
              <b>Interface discovery failed:</b> {err}
              <div className="ndm-hint" style={{ marginTop: 4 }}>You can retry discovery, or skip it — saving the device still works and the first poll will pick up the interfaces automatically.</div>
            </div>
          )}
        </>
      )}

      {step === 3 && (
        <>
          {discovered ? (
            <>
              <div className="ndm-ok" style={{ marginBottom: 8 }}>✓ Found {discovered.length} interface(s) — this is what the poller will track.</div>
              <div style={{ maxHeight: 300, overflow: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
                <table className="ndm-tbl">
                  <thead><tr><th>#</th><th>Name</th><th>Status</th><th>Type</th><th>Monitored</th><th>Speed</th><th>MAC</th></tr></thead>
                  <tbody>
                    {discovered.map((p) => (
                      <tr key={p.ifIndex} style={p.monitoringEnabled === false ? { opacity: .55 } : undefined}>
                        <td>{p.ifIndex}</td><td><b>{p.name}</b></td>
                        <td><span style={{ color: p.operStatus === 1 ? "var(--online)" : "var(--danger)" }}>{p.operStatus === 1 ? "UP" : "down"}</span></td>
                        <td>{catLabel(p.interfaceCategory)}</td>
                        <td>{p.monitoringEnabled === false
                          ? <span className="ndm-pill" title="PPPoE/dynamic/session links are excluded — no alerts, no traffic history">{catLabel(p.interfaceCategory)} — off</span>
                          : <b style={{ color: "var(--online)" }}>yes</b>}</td>
                        <td>{p.speedMbps ? `${p.speedMbps} Mbps` : "—"}</td><td style={{ fontFamily: "monospace", fontSize: 11 }}>{p.mac || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="ndm-hint" style={{ marginTop: 6 }}>PPPoE / dynamic / tunnel session links start excluded automatically — you can enable or disable any port later under Ports.</div>
            </>
          ) : (
            <div className="ndm-empty">No discovery data — the first poll will populate the ports automatically.</div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 14 }}>
            <button className="ndm-btn" onClick={() => setStep(2)}>← Back</button>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {err && <span className="ndm-err">{err}</span>}
              <button className="ndm-btn pri" onClick={save} disabled={saving || !f.ip.trim()}>{saving ? "Saving…" : "Save device"}</button>
            </div>
          </div>
          <div className="ndm-hint" style={{ marginTop: 8 }}>After saving, the first poll runs within a few seconds. Credentials are encrypted at rest and never shown here again.</div>
        </>
      )}
    </NdmModal>
  );
}