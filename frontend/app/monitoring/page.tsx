"use client";

import React from "react";
import API from "../components/api";
import { useSSE } from "../components/use-sse";

/**
 * Network Monitoring — each account adds hosts (IP/hostname), grouped, pinged
 * continuously by the backend. Small live latency graphs, and a loud in-app
 * alert (beep + spoken "<host> is down", repeating) the moment one drops.
 * Everything is owner-scoped by the API, so a parent's targets stay private.
 */
type Sample = { t: number; ms: number | null; up: boolean };
type Target = {
  id: number; name: string; host: string; groupName: string | null;
  enabled: boolean; isUp: boolean | null; lastLatencyMs: number | null;
  lossPct: number | null; lastCheckedAt: string | null; downSince: string | null;
  intervalSec: number; history: Sample[];
};

/**
 * Alert preferences. Persisted per browser — an operator on the NOC screen and
 * one working from a laptop want different volumes and repeat rates, and this
 * is a per-person preference rather than shared configuration.
 */
type AlertSettings = {
  enabled: boolean;        // master switch
  downSound: boolean;      // beep when a host goes down
  upSound: boolean;        // beep when a host recovers
  speak: boolean;          // speak "<host> is down"
  repeatSec: number;       // 0 = announce once, no repeat
  volume: number;          // 0..1
  maxSpoken: number;       // cap names read aloud per announcement
};

const ALERT_DEFAULTS: AlertSettings = {
  enabled: true, downSound: true, upSound: true, speak: true,
  repeatSec: 12, volume: 0.6, maxSpoken: 3,
};
const ALERT_KEY = "jb.monitoring.alerts";

function loadAlertSettings(): AlertSettings {
  if (typeof window === "undefined") return ALERT_DEFAULTS;
  try {
    const raw = localStorage.getItem(ALERT_KEY);
    return raw ? { ...ALERT_DEFAULTS, ...JSON.parse(raw) } : ALERT_DEFAULTS;
  } catch { return ALERT_DEFAULTS; }
}

export default function MonitoringPage() {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [targets, setTargets] = React.useState<Target[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [muted, setMuted] = React.useState(false);
  const [form, setForm] = React.useState({ name: "", host: "", groupName: "" });
  const [adding, setAdding] = React.useState(false);
  const [alerts, setAlerts] = React.useState<AlertSettings>(ALERT_DEFAULTS);
  const [showSettings, setShowSettings] = React.useState(false);
  const [showImport, setShowImport] = React.useState(false);

  // Read persisted settings after mount (server render has no localStorage).
  React.useEffect(() => { setAlerts(loadAlertSettings()); }, []);
  const saveAlerts = React.useCallback((next: Partial<AlertSettings>) => {
    setAlerts((prev) => {
      const merged = { ...prev, ...next };
      try { localStorage.setItem(ALERT_KEY, JSON.stringify(merged)); } catch { /* private mode */ }
      return merged;
    });
  }, []);

  const load = React.useCallback(async () => {
    try {
      const r = await fetch(`${API}/monitoring/targets`, { headers: H });
      if (r.status === 403) { setErr("You don't have permission to view monitoring."); setLoaded(true); return; }
      if (r.ok) { setTargets(await r.json()); setErr(""); }
    } catch { /* keep last */ }
    setLoaded(true);
  }, []);

  React.useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  // Instant refresh on a down/up transition pushed from the server.
  useSSE({ onEvent: (type) => { if (type === "monitor") load(); } });

  const down = targets.filter((t) => t.isUp === false && t.enabled);

  // ── Alerting ───────────────────────────────────────────────────────────────
  const audioRef = React.useRef<AudioContext | null>(null);
  /** Two-tone: falling for DOWN (urgent), rising for UP (resolved). */
  const beep = React.useCallback((kind: "down" | "up" = "down") => {
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      const ctx = audioRef.current || (audioRef.current = new AC());
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const notes = kind === "down" ? [880, 620] : [620, 880];
      notes.forEach((freq, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "square"; o.frequency.value = freq;
        const t0 = ctx.currentTime + i * 0.16;
        // Clamped so a slider at 100% cannot produce a painful level.
        g.gain.setValueAtTime(Math.min(Math.max(alerts.volume, 0), 1) * 0.12, t0);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0); o.stop(t0 + 0.15);
      });
    } catch { /* audio blocked until first interaction */ }
  }, [alerts.volume]);

  const speak = React.useCallback((text: string) => {
    try {
      const s = window.speechSynthesis;
      if (!s) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1; u.pitch = 1; u.volume = Math.min(Math.max(alerts.volume, 0), 1);
      s.speak(u);
    } catch { /* ignore */ }
  }, [alerts.volume]);

  const soundOn = alerts.enabled && !muted;

  // RECOVERY CHIME — fires once when a host that was down comes back.
  // Tracked against the previous render's down-set, so it announces the
  // transition rather than the state (which would chime on every poll).
  const prevDownRef = React.useRef<Set<number>>(new Set());
  React.useEffect(() => {
    const nowDown = new Set(down.map((d) => d.id));
    const recovered = [...prevDownRef.current].filter((id) => !nowDown.has(id));
    if (recovered.length && soundOn && alerts.upSound) {
      beep("up");
      if (alerts.speak) {
        const t = targets.find((x) => x.id === recovered[0]);
        if (t) speak(`${t.name || t.host} is back up`);
      }
    }
    prevDownRef.current = nowDown;
  }, [down.map((d) => d.id).join(","), soundOn, alerts.upSound, alerts.speak, beep, speak, targets]);

  // DOWN ALERT — announce immediately, then repeat on the configured interval.
  // repeatSec = 0 means "tell me once", which is what people want overnight.
  React.useEffect(() => {
    if (!soundOn || down.length === 0) return;
    const announce = () => {
      if (alerts.downSound) beep("down");
      if (alerts.speak) {
        down.slice(0, Math.max(1, alerts.maxSpoken)).forEach((t) => speak(`${t.name || t.host} is down`));
      }
    };
    announce();
    if (!alerts.repeatSec) return;                       // announce once only
    const id = setInterval(announce, alerts.repeatSec * 1000);
    return () => clearInterval(id);
  }, [down.map((d) => d.id).join(","), soundOn, alerts.downSound, alerts.speak,
      alerts.repeatSec, alerts.maxSpoken, beep, speak]);

  /** Play both tones so the operator can set the volume without waiting for an outage. */
  const testSound = React.useCallback(() => {
    beep("down");
    if (alerts.speak) speak("Test alert. A host is down.");
    setTimeout(() => beep("up"), 900);
  }, [beep, speak, alerts.speak]);

  // ── Actions ──────────────────────────────────────────────────
  const add = async () => {
    if (!form.host.trim()) return;
    setAdding(true);
    try {
      const r = await fetch(`${API}/monitoring/targets`, { method: "POST", headers: H, body: JSON.stringify(form) });
      if (r.ok) { setForm({ name: "", host: "", groupName: form.groupName }); await load(); }
      else { const d = await r.json().catch(() => ({})); setErr(d?.message || "Could not add host"); }
    } finally { setAdding(false); }
  };
  const del = async (id: number) => {
    if (!confirm("Remove this monitor?")) return;
    await fetch(`${API}/monitoring/targets/${id}`, { method: "DELETE", headers: H }); load();
  };
  const checkNow = async (id: number) => {
    await fetch(`${API}/monitoring/targets/${id}/check`, { method: "POST", headers: H }); setTimeout(load, 500);
  };
  const toggle = async (t: Target) => {
    await fetch(`${API}/monitoring/targets/${t.id}`, { method: "PUT", headers: H, body: JSON.stringify({ enabled: !t.enabled }) }); load();
  };
  const importRows = async (rows: ImportRow[]) => {
    const r = await fetch(`${API}/monitoring/targets/import`, {
      method: "POST", headers: H, body: JSON.stringify({ rows }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.message || "Import failed");
    await load();
    return d as ImportResult;
  };

  // Group targets.
  const groups = React.useMemo(() => {
    const m = new Map<string, Target[]>();
    for (const t of targets) { const k = t.groupName || "Ungrouped"; (m.get(k) || m.set(k, []).get(k)!).push(t); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [targets]);
  const knownGroups = [...new Set(targets.map((t) => t.groupName).filter(Boolean) as string[])];

  return (
    <div className="mon">
      <style>{CSS}</style>

      <div className="mon-head">
        <div>
          <h1>Network Monitoring</h1>
          <p>Ping your routers, towers and upstreams continuously. You'll hear an alert the moment one drops.</p>
        </div>
        <div className="mon-head-stats">
          <span className="ok">{targets.filter((t) => t.isUp).length} up</span>
          <span className={down.length ? "bad" : "muted"}>{down.length} down</span>
          <button className="mon-hbtn" onClick={() => setShowImport(true)} title="Import monitors from Excel or CSV">⬆ Import</button>
          <button className="mon-hbtn" onClick={() => setShowSettings((s) => !s)} title="Alert sound settings">
            {alerts.enabled && !muted ? "🔔" : "🔕"} Alerts
          </button>
        </div>
      </div>

      {showSettings && (
        <AlertSettingsPanel
          s={alerts} onChange={saveAlerts} onTest={testSound}
          muted={muted} onMute={setMuted} onClose={() => setShowSettings(false)}
        />
      )}

      {showImport && <ImportModal onClose={() => setShowImport(false)} onImport={importRows} knownGroups={knownGroups} />}

      {/* DOWN ALERT BANNER */}
      {down.length > 0 && (
        <div className="mon-alert">
          <div>
            <b>⚠ {down.length} host{down.length > 1 ? "s are" : " is"} DOWN:</b>{" "}
            {down.slice(0, 6).map((t) => t.name || t.host).join(", ")}{down.length > 6 ? "…" : ""}
          </div>
          <button onClick={() => setMuted((m) => !m)}>{muted ? "🔔 Unmute" : "🔕 Mute sound"}</button>
        </div>
      )}

      {/* ADD */}
      <div className="mon-add">
        <input placeholder="Host or IP (e.g. 192.168.88.1 or google.com)" value={form.host}
          onChange={(e) => setForm((p) => ({ ...p, host: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && add()} />
        <input placeholder="Label (optional)" value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
        <input placeholder="Group (optional)" value={form.groupName} list="mon-groups"
          onChange={(e) => setForm((p) => ({ ...p, groupName: e.target.value }))} />
        <datalist id="mon-groups">{knownGroups.map((g) => <option key={g} value={g} />)}</datalist>
        <button onClick={add} disabled={adding || !form.host.trim()}>{adding ? "Adding…" : "+ Add monitor"}</button>
      </div>
      {err && <div className="mon-err">{err}</div>}

      {!loaded ? <div className="mon-empty">Loading…</div> :
        targets.length === 0 ? <div className="mon-empty">No monitors yet. Add a host above to start pinging it.</div> :
        groups.map(([g, list]) => (
          <div key={g} className="mon-group">
            <div className="mon-group-h">{g} <span>{list.length}</span></div>
            <div className="mon-grid">
              {list.map((t) => <Card key={t.id} t={t} onDelete={() => del(t.id)} onCheck={() => checkNow(t.id)} onToggle={() => toggle(t)} />)}
            </div>
          </div>
        ))}
    </div>
  );
}

/** Alert sound preferences. Every control takes effect immediately. */
function AlertSettingsPanel({ s, onChange, onTest, muted, onMute, onClose }: {
  s: AlertSettings; onChange: (p: Partial<AlertSettings>) => void; onTest: () => void;
  muted: boolean; onMute: (m: boolean) => void; onClose: () => void;
}) {
  const REPEATS = [
    { v: 0, l: "Once only" }, { v: 12, l: "12 s" }, { v: 30, l: "30 s" },
    { v: 60, l: "1 min" }, { v: 300, l: "5 min" }, { v: 900, l: "15 min" },
  ];
  return (
    <div className="mon-settings">
      <div className="mon-settings-h">
        <b>Alert sounds</b>
        <button onClick={onClose}>✕</button>
      </div>
      <div className="mon-settings-body">
        <label className="ck"><input type="checkbox" checked={s.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })} /> Enable alert sounds</label>
        <label className="ck"><input type="checkbox" checked={s.downSound} disabled={!s.enabled}
          onChange={(e) => onChange({ downSound: e.target.checked })} /> Beep when a host goes <b>down</b></label>
        <label className="ck"><input type="checkbox" checked={s.upSound} disabled={!s.enabled}
          onChange={(e) => onChange({ upSound: e.target.checked })} /> Chime when a host <b>recovers</b></label>
        <label className="ck"><input type="checkbox" checked={s.speak} disabled={!s.enabled}
          onChange={(e) => onChange({ speak: e.target.checked })} /> Speak the host name aloud</label>

        <div className="fld">
          <span>Repeat while down</span>
          <select value={s.repeatSec} disabled={!s.enabled}
            onChange={(e) => onChange({ repeatSec: Number(e.target.value) })}>
            {REPEATS.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
          </select>
        </div>

        <div className="fld">
          <span>Volume</span>
          <input type="range" min={0} max={1} step={0.05} value={s.volume} disabled={!s.enabled}
            onChange={(e) => onChange({ volume: Number(e.target.value) })} />
          <em>{Math.round(s.volume * 100)}%</em>
        </div>

        <div className="fld">
          <span>Names spoken per alert</span>
          <select value={s.maxSpoken} disabled={!s.enabled || !s.speak}
            onChange={(e) => onChange({ maxSpoken: Number(e.target.value) })}>
            {[1, 3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        <div className="mon-settings-actions">
          <button onClick={onTest} disabled={!s.enabled}>▶ Test sound</button>
          <button onClick={() => onMute(!muted)}>{muted ? "🔔 Unmute now" : "🔕 Mute until reload"}</button>
        </div>
        <p className="hint">
          Browsers block audio until you interact with the page — click <b>Test sound</b> once
          per session so alerts can play. Settings are saved in this browser only.
        </p>
      </div>
    </div>
  );
}

type ImportRow = { host: string; name?: string; group?: string };
type ImportResult = {
  total: number; added: number; skipped: number; failed: number;
  results: Array<{ row: number; host: string; status: string; reason?: string }>;
};

/**
 * Import monitors from a spreadsheet.
 *
 * Parsing happens in the browser (SheetJS is already a dependency, and this is
 * the same pattern the subscriber import uses), so .xlsx, .xls and .csv all
 * work without adding a server-side parser.
 *
 * Column names are matched loosely — real operator files say "IP", "ip address",
 * "Host", "Name", "Label", "Group", "Zone" — and a headerless file is accepted
 * positionally as host, label, group.
 */
function ImportModal({ onClose, onImport, knownGroups }: {
  onClose: () => void; onImport: (rows: ImportRow[]) => Promise<ImportResult>; knownGroups: string[];
}) {
  const [rows, setRows] = React.useState<ImportRow[]>([]);
  const [fileName, setFileName] = React.useState("");
  const [parseErr, setParseErr] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [fallbackGroup, setFallbackGroup] = React.useState("");

  const pick = (obj: any, keys: string[]): string => {
    for (const k of Object.keys(obj || {})) {
      const norm = k.toLowerCase().replace(/[^a-z]/g, "");
      if (keys.includes(norm)) {
        const v = obj[k];
        if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
      }
    }
    return "";
  };

  const onFile = async (f: File) => {
    setParseErr(""); setResult(null); setFileName(f.name);
    try {
      const XLSX = await import("xlsx");
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new Error("The file has no readable sheet.");
      const json: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      let parsed: ImportRow[] = json.map((r) => ({
        host: pick(r, ["host", "ip", "ipaddress", "address", "hostname", "target"]),
        name: pick(r, ["label", "name", "title", "description"]),
        group: pick(r, ["group", "groupname", "zone", "area", "category"]),
      })).filter((r) => r.host);

      // Headerless file → treat columns positionally.
      if (parsed.length === 0) {
        const raw: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
        parsed = raw
          .map((c) => ({ host: String(c[0] ?? "").trim(), name: String(c[1] ?? "").trim(), group: String(c[2] ?? "").trim() }))
          .filter((r) => r.host && !/^(host|ip|ip address|address|hostname)$/i.test(r.host));
      }

      if (parsed.length === 0) throw new Error("No usable rows found. The first column should contain a host or IP.");
      setRows(parsed);
    } catch (e: any) {
      setRows([]); setParseErr(e?.message || "Could not read that file.");
    }
  };

  const run = async () => {
    setBusy(true); setParseErr("");
    try {
      const payload = fallbackGroup.trim()
        ? rows.map((r) => ({ ...r, group: r.group || fallbackGroup.trim() }))
        : rows;
      setResult(await onImport(payload));
    } catch (e: any) { setParseErr(e?.message || "Import failed"); }
    finally { setBusy(false); }
  };

  const failures = result?.results.filter((r) => r.status === "failed") || [];

  return (
    <div className="mon-modal-bg" onClick={onClose}>
      <div className="mon-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mon-modal-h"><b>Import monitors</b><button onClick={onClose}>✕</button></div>

        {!result ? (
          <div className="mon-modal-b">
            <p className="hint">
              Excel (.xlsx/.xls) or CSV with three columns — <b>host or IP</b> (required),
              <b> label</b>, <b>group</b>. Column headings are matched automatically
              (<code>ip</code>, <code>host</code>, <code>address</code>, <code>name</code>,
              <code>label</code>, <code>group</code>, <code>zone</code>…). A file with no
              header row is read as host, label, group in that order.
            </p>

            <input type="file" accept=".xlsx,.xls,.csv"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />

            {fileName && !parseErr && (
              <div className="mon-imp-ok">✓ {fileName} — <b>{rows.length}</b> row(s) ready</div>
            )}
            {parseErr && <div className="mon-err">{parseErr}</div>}

            {rows.length > 0 && (
              <>
                <div className="fld">
                  <span>Group for rows with none</span>
                  <input list="mon-imp-groups" value={fallbackGroup} placeholder="(leave blank for Ungrouped)"
                    onChange={(e) => setFallbackGroup(e.target.value)} />
                  <datalist id="mon-imp-groups">{knownGroups.map((g) => <option key={g} value={g} />)}</datalist>
                </div>
                <table className="mon-imp-tbl">
                  <thead><tr><th>#</th><th>Host / IP</th><th>Label</th><th>Group</th></tr></thead>
                  <tbody>
                    {rows.slice(0, 10).map((r, i) => (
                      <tr key={i}><td>{i + 1}</td><td><code>{r.host}</code></td>
                        <td>{r.name || <em className="muted">= host</em>}</td>
                        <td>{r.group || fallbackGroup || <em className="muted">Ungrouped</em>}</td></tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > 10 && <div className="hint">…and {rows.length - 10} more.</div>}
              </>
            )}

            <div className="mon-modal-actions">
              <button onClick={onClose}>Cancel</button>
              <button className="primary" onClick={run} disabled={busy || rows.length === 0}>
                {busy ? "Importing…" : `Import ${rows.length || ""} monitor${rows.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        ) : (
          <div className="mon-modal-b">
            <div className="mon-imp-summary">
              <span className="ok">{result.added} added</span>
              <span className="muted">{result.skipped} already monitored</span>
              <span className={result.failed ? "bad" : "muted"}>{result.failed} failed</span>
            </div>
            {failures.length > 0 && (
              <table className="mon-imp-tbl">
                <thead><tr><th>Row</th><th>Host</th><th>Why it failed</th></tr></thead>
                <tbody>
                  {failures.slice(0, 20).map((f, i) => (
                    <tr key={i}><td>{f.row}</td><td><code>{f.host || "—"}</code></td><td>{f.reason}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mon-modal-actions">
              <button className="primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ t, onDelete, onCheck, onToggle }: { t: Target; onDelete: () => void; onCheck: () => void; onToggle: () => void }) {
  const state = !t.enabled ? "off" : t.isUp === null ? "wait" : t.isUp ? "up" : "down";
  const label = { off: "Paused", wait: "Checking…", up: "Online", down: "DOWN" }[state];
  const color = { off: "#94A3B8", wait: "#8A6209", up: "#157F43", down: "#B02A37" }[state];
  return (
    <div className={`mon-card ${state}`}>
      <div className="mon-card-top">
        <a className="mon-card-name" href={`/monitoring/${t.id}`} title="Open details">
          <b>{t.name || t.host}</b>
          <em>{t.host}</em>
        </a>
        <span className="mon-dot" style={{ background: color }} title={label} />
      </div>
      <LatencyGraph history={t.history} up={t.isUp} />
      <div className="mon-card-metrics">
        <span style={{ color }}>{label}</span>
        <span>{t.isUp && t.lastLatencyMs != null ? `${t.lastLatencyMs} ms` : t.lossPct != null ? `${Math.round(t.lossPct)}% loss` : "—"}</span>
        <span className="muted">{t.lastCheckedAt ? timeAgo(t.lastCheckedAt) : "never"}</span>
      </div>
      {state === "down" && t.downSince && <div className="mon-down-since">down since {timeAgo(t.downSince)}</div>}
      <div className="mon-card-actions">
        {/* Primary way into the per-host history + diagnostics page. */}
        <a className="details" href={`/monitoring/${t.id}`}>📈 Details</a>
        <button onClick={onCheck}>Check now</button>
        <button onClick={onToggle}>{t.enabled ? "Pause" : "Resume"}</button>
        <button className="del" onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

/**
 * Small latency line graph. The Y axis is scaled to the DATA RANGE (min…max),
 * not to zero — a 22 ms line with 1 ms of jitter drawn from zero looks like a
 * dead flat line, which is what made these graphs useless. Range-scaling makes
 * the real variation visible, with the min/max printed so the scale is honest.
 */
function LatencyGraph({ history, up }: { history: Sample[]; up: boolean | null }) {
  const W = 220, HH = 72, padX = 3, padT = 10, padB = 12;
  const pts = (history || []).slice(-40);
  if (pts.length < 2) return <div className="mon-graph empty">gathering data…</div>;

  const okVals = pts.filter((p) => p.up && p.ms != null).map((p) => p.ms!) as number[];
  if (okVals.length < 2) return <div className="mon-graph empty">no latency samples</div>;
  const lo = Math.min(...okVals), hi = Math.max(...okVals);
  const span = Math.max(hi - lo, 1);           // never divide by zero
  const yMin = Math.max(0, lo - span * 0.25);  // headroom so the line isn't glued to the edge
  const yMax = hi + span * 0.25;

  const stepX = (W - padX * 2) / (pts.length - 1);
  const x = (i: number) => padX + i * stepX;
  const y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin)) * (HH - padT - padB);

  // Build the line only across samples we have latency for; a down sample breaks it.
  let d = ""; let started = false;
  pts.forEach((p, i) => {
    if (p.up && p.ms != null) { d += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(p.ms).toFixed(1)} `; started = true; }
    else { started = false; }
  });
  const stroke = up === false ? "#ef4444" : "#22c55e";
  const gid = `mg${Math.round(lo)}_${Math.round(hi)}`;
  const areaD = d ? `${d} L${x(pts.length - 1).toFixed(1)},${HH - padB} L${x(0).toFixed(1)},${HH - padB} Z` : "";

  return (
    <svg className="mon-graph" viewBox={`0 0 ${W} ${HH}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* down periods shaded */}
      {pts.map((p, i) => (!p.up ? <rect key={`d${i}`} x={x(i) - stepX / 2} y={padT} width={stepX} height={HH - padT - padB} fill="rgba(239,68,68,.14)" /> : null))}
      {areaD && <path d={areaD} fill={`url(#${gid})`} />}
      {d && <path d={d} fill="none" stroke={stroke} strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      {/* honest scale labels */}
      <text x={padX} y={7} fontSize="7.5" fill="#94A3B8">{Math.round(hi)}ms</text>
      <text x={padX} y={HH - 3} fontSize="7.5" fill="#94A3B8">{Math.round(lo)}ms</text>
    </svg>
  );
}

function timeAgo(iso: string) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const CSS = `
.mon{max-width:1100px;color:var(--text)}
.mon-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.mon-head h1{font-size:20px;font-weight:800;margin:0}
.mon-head p{font-size:12.5px;color:var(--muted);margin:4px 0 0}
.mon-head-stats{display:flex;gap:8px;font-size:12px;font-weight:700}
.mon-head-stats .ok{color:#157F43;background:rgba(21,127,67,.12);border:1px solid rgba(21,127,67,.3);border-radius:999px;padding:4px 12px}
.mon-head-stats .bad{color:#B02A37;background:rgba(176,42,55,.12);border:1px solid rgba(176,42,55,.35);border-radius:999px;padding:4px 12px}
.mon-head-stats .muted{color:#94A3B8;background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:4px 12px}
.mon-alert{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;background:rgba(239,68,68,.10);border:1px solid rgba(239,68,68,.4);border-radius:10px;padding:11px 14px;margin-bottom:14px;font-size:13px;color:#f87171;animation:monpulse 1.6s ease-in-out infinite}
@keyframes monpulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.0)}50%{box-shadow:0 0 0 4px rgba(239,68,68,.12)}}
.mon-alert button{background:#B02A37;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.mon-add{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.mon-add input{height:38px;border:1px solid var(--border);border-radius:9px;padding:0 12px;font-size:13px;font-family:inherit;background:var(--bg);color:var(--text)}
.mon-add input:nth-child(1){flex:2;min-width:220px}.mon-add input:nth-child(2),.mon-add input:nth-child(3){flex:1;min-width:130px}
.mon-add button{height:38px;border:none;border-radius:9px;background:#3C50E0;color:#fff;padding:0 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
.mon-add button:disabled{opacity:.6}
.mon-err{color:#B02A37;font-size:12px;margin-bottom:8px}
.mon-empty{padding:30px;text-align:center;color:#94A3B8;font-size:13px}
.mon-group{margin-top:16px}
.mon-group-h{font-size:12.5px;font-weight:800;color:var(--text);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px}
.mon-group-h span{color:#94A3B8;font-weight:600}
.mon-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
.mon-card{background:var(--surface,#fff);border:1px solid var(--border,#E2E8F0);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px}
.mon-card.down{border-color:rgba(176,42,55,.5);background:rgba(176,42,55,.05)}
.mon-card.off{opacity:.65}
.mon-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.mon-card-name{display:flex;flex-direction:column;min-width:0;text-decoration:none;color:inherit;cursor:pointer}
.mon-card-name:hover b{color:#3C50E0}
.mon-card-name b{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mon-card-name em{font-style:normal;font-size:10.5px;color:#94A3B8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mon-dot{width:11px;height:11px;border-radius:50%;flex-shrink:0;margin-top:3px}
.mon-graph{width:100%;height:72px;display:block}
.mon-graph.empty{display:flex;align-items:center;justify-content:center;font-size:10.5px;color:#94A3B8;border:1px dashed var(--border);border-radius:8px}
.mon-card-metrics{display:flex;justify-content:space-between;font-size:11.5px;font-weight:600}
.mon-card-metrics .muted{color:#94A3B8;font-weight:500}
.mon-down-since{font-size:10.5px;color:#B02A37;font-weight:600}
.mon-card-actions{display:flex;gap:6px;flex-wrap:wrap}
.mon-card-actions button,.mon-card-actions .details{flex:1;height:30px;border:1px solid var(--border);background:var(--surface-2,#F7F9FC);border-radius:7px;font-size:11px;font-weight:600;color:var(--text);cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;text-decoration:none;white-space:nowrap}
.mon-card-actions .details{flex-basis:100%;background:#EEF1FE;border-color:#C7CEF9;color:#3C50E0}
.mon-card-actions .details:hover{background:#3C50E0;color:#fff}
.mon-card-actions button.del{color:#B02A37;border-color:rgba(176,42,55,.3)}
@media (max-width:640px){ .mon-grid{grid-template-columns:1fr 1fr} .mon-add input,.mon-add button{flex:1 1 100%} }

/* ── Header buttons ── */
.mon-hbtn{border:1px solid var(--border);background:var(--surface-2);color:var(--text);
  border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700;cursor:pointer}
.mon-hbtn:hover{border-color:#3C50E0;color:#3C50E0}

/* ── Alert settings ── */
.mon-settings{border:1px solid var(--border);background:var(--surface);border-radius:12px;
  margin-bottom:14px;overflow:hidden}
.mon-settings-h{display:flex;justify-content:space-between;align-items:center;
  padding:10px 14px;border-bottom:1px solid var(--border);background:var(--surface-2);font-size:13px}
.mon-settings-h button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:15px}
.mon-settings-body{padding:14px;display:flex;flex-direction:column;gap:10px}
.mon-settings-body .ck{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}
.mon-settings-body .ck input{width:15px;height:15px;cursor:pointer}
.mon-settings-body .fld{display:flex;align-items:center;gap:10px;font-size:13px}
.mon-settings-body .fld>span{min-width:180px;color:var(--muted)}
.mon-settings-body .fld select,.mon-settings-body .fld input[type=text],.mon-settings-body .fld input:not([type]){
  border:1px solid var(--border);background:var(--surface-2);color:var(--text);
  border-radius:8px;padding:5px 9px;font-size:13px}
.mon-settings-body .fld input[type=range]{flex:1;max-width:220px}
.mon-settings-body .fld em{font-style:normal;color:var(--muted);font-size:12px;min-width:38px}
.mon-settings-actions{display:flex;gap:8px;margin-top:2px}
.mon-settings-actions button{border:1px solid var(--border);background:var(--surface-2);color:var(--text);
  border-radius:8px;padding:6px 14px;font-size:12.5px;font-weight:600;cursor:pointer}
.mon-settings-actions button:hover:not(:disabled){border-color:#3C50E0;color:#3C50E0}
.mon-settings-actions button:disabled{opacity:.5;cursor:not-allowed}
.hint{font-size:11.5px;color:var(--muted);line-height:1.65;margin:2px 0 0}
.hint code{background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:0 4px;margin:0 2px}

/* ── Import modal ── */
.mon-modal-bg{position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,.45);
  backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:20px}
.mon-modal{background:var(--surface);border:1px solid var(--border);border-radius:14px;
  width:min(640px,96vw);max-height:88vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.45)}
.mon-modal-h{display:flex;justify-content:space-between;align-items:center;
  padding:14px 18px;border-bottom:1px solid var(--border);font-size:14px}
.mon-modal-h button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px}
.mon-modal-b{padding:16px 18px;overflow:auto;display:flex;flex-direction:column;gap:12px}
.mon-modal-b input[type=file]{font-size:13px}
.mon-modal-b .fld{display:flex;align-items:center;gap:10px;font-size:13px}
.mon-modal-b .fld>span{min-width:180px;color:var(--muted)}
.mon-modal-b .fld input{flex:1;border:1px solid var(--border);background:var(--surface-2);
  color:var(--text);border-radius:8px;padding:6px 10px;font-size:13px}
.mon-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
.mon-modal-actions button{border:1px solid var(--border);background:var(--surface-2);color:var(--text);
  border-radius:8px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer}
.mon-modal-actions button.primary{background:#3C50E0;border-color:#3C50E0;color:#fff}
.mon-modal-actions button:disabled{opacity:.5;cursor:not-allowed}
.mon-imp-ok{font-size:12.5px;color:#157F43;font-weight:600}
.mon-imp-tbl{width:100%;border-collapse:collapse;font-size:12px}
.mon-imp-tbl th{text-align:left;color:var(--muted);font-weight:700;padding:6px 8px;
  border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.mon-imp-tbl td{padding:6px 8px;border-bottom:1px solid var(--border)}
.mon-imp-tbl code{font-size:11.5px}
.mon-imp-tbl .muted{color:var(--muted)}
.mon-imp-summary{display:flex;gap:8px;font-size:12.5px;font-weight:700}
.mon-imp-summary .ok{color:#157F43;background:rgba(21,127,67,.12);border-radius:999px;padding:4px 12px}
.mon-imp-summary .bad{color:#B02A37;background:rgba(176,42,55,.12);border-radius:999px;padding:4px 12px}
.mon-imp-summary .muted{color:#94A3B8;background:var(--surface-2);border-radius:999px;padding:4px 12px}
`;
