"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

const API =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

type Tab = "status" | "modules" | "files" | "database";

export default function RadiusAdminPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("status");
  const [role, setRole] = useState<string | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [modules, setModules] = useState<any[]>([]);
  const [files, setFiles] = useState<any[]>([]);
  const [db, setDb] = useState<any>(null);
  const [openFile, setOpenFile] = useState<{ path: string; content: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  useEffect(() => {
    try { setRole(JSON.parse(atob((token || "").split(".")[1] || ""))?.role || null); } catch { setRole(null); }
  }, [token]);

  const load = useCallback(async () => {
    if (role !== "SUPER_ADMIN") return;
    const g = (p: string) => fetch(`${API}/radius-admin/${p}`, { headers: H }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (tab === "status") setStatus(await g("status"));
    if (tab === "modules") setModules((await g("modules")) || []);
    if (tab === "files") setFiles((await g("files")) || []);
    if (tab === "database") setDb(await g("database"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, role]);

  useEffect(() => { load(); }, [load]);

  const control = async (action: string) => {
    setBusy(true); setMsg(null);
    const r = await fetch(`${API}/radius-admin/control`, { method: "POST", headers: H, body: JSON.stringify({ action }) }).then((x) => x.json()).catch(() => ({}));
    setMsg({ ok: r.ok !== false, text: (r.out || JSON.stringify(r) || "").slice(0, 4000) });
    setBusy(false); load();
  };

  const toggle = async (name: string, enable: boolean) => {
    setBusy(true); setMsg(null);
    const r = await fetch(`${API}/radius-admin/module/toggle`, { method: "POST", headers: H, body: JSON.stringify({ name, enable }) }).then((x) => x.json()).catch(() => ({}));
    setMsg({ ok: r.configOk !== false, text: r.configOk === false ? `Config check failed after ${enable ? "enabling" : "disabling"} ${name}:\n${r.check}` : `${name} ${enable ? "enabled" : "disabled"} — config OK` });
    setBusy(false); load();
  };

  const view = async (p: string) => {
    const r = await fetch(`${API}/radius-admin/file?path=${encodeURIComponent(p)}`, { headers: H }).then((x) => x.json()).catch(() => null);
    if (r) setOpenFile(r);
  };
  const saveFile = async () => {
    if (!openFile) return;
    setBusy(true); setMsg(null);
    const r = await fetch(`${API}/radius-admin/file`, { method: "POST", headers: H, body: JSON.stringify(openFile) }).then((x) => x.json()).catch(() => ({}));
    setMsg({ ok: r.ok, text: r.ok ? "Saved, config OK, FreeRADIUS restarted." : `Rejected — config invalid, previous version restored:\n${r.check}` });
    setBusy(false);
  };

  const card: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16 };
  const btn: React.CSSProperties = { background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 8, padding: "7px 14px", cursor: "pointer", fontSize: 13 };

  if (role && role !== "SUPER_ADMIN") {
    return <div style={{ padding: 30, color: "var(--muted)" }}>FreeRADIUS &amp; database settings are available to the ISP owner (SUPER_ADMIN) account only.</div>;
  }

  return (
    <div style={{ padding: 20, color: "var(--text)" }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 4px" }}>FreeRADIUS &amp; Database</h1>
      <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 16 }}>ISP owner only. Every config write is validated with <code>freeradius -XC</code> and backed up before FreeRADIUS restarts.</div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {(["status", "modules", "files", "database"] as Tab[]).map((t) => (
          <button key={t} onClick={() => { setTab(t); setOpenFile(null); }}
            style={{ ...btn, background: tab === t ? "var(--accent,#378ADD)" : "var(--surface)", color: tab === t ? "#fff" : "var(--text)", textTransform: "capitalize" }}>{t}</button>
        ))}
      </div>

      {msg && <pre style={{ ...card, whiteSpace: "pre-wrap", fontSize: 12, marginBottom: 14, borderColor: msg.ok ? "rgba(34,197,94,.4)" : "rgba(239,68,68,.4)", color: msg.ok ? "#16a34a" : "#ef4444" }}>{msg.text}</pre>}

      {/* STATUS */}
      {tab === "status" && status && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={card}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Service</div>
            <div style={{ fontSize: 13, lineHeight: 1.9 }}>
              <div>Status: <b style={{ color: status.running ? "#22c55e" : "#ef4444" }}>{status.running ? "RUNNING" : "STOPPED"}</b></div>
              <div>Auth :1812 — {status.listening?.auth1812 ? "✅" : "❌"}　Acct :1813 — {status.listening?.acct1813 ? "✅" : "❌"}</div>
              <div style={{ color: "var(--muted)" }}>{status.version}</div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button disabled={busy} style={btn} onClick={() => control("restart")}>Restart</button>
              <button disabled={busy} style={btn} onClick={() => control("test")}>Test config</button>
              <button disabled={busy} style={btn} onClick={() => control("stop")}>Stop</button>
              <button disabled={busy} style={btn} onClick={() => control("start")}>Start</button>
            </div>
          </div>
          <pre style={{ ...card, whiteSpace: "pre-wrap", fontSize: 12, color: "var(--muted)", maxHeight: 220, overflow: "auto" }}>{status.configCheck}</pre>
        </div>
      )}

      {/* MODULES */}
      {tab === "modules" && (
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Modules ({modules.length}) — toggle enable/disable</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 8 }}>
            {modules.map((m) => (
              <div key={m.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface-2)" }}>
                <span style={{ fontSize: 13 }}>
                  <b>{m.name}</b>{m.required && <span style={{ fontSize: 10, color: "#f59e0b", marginLeft: 6 }}>required</span>}
                </span>
                <button disabled={busy || (m.required && m.enabled)} onClick={() => toggle(m.name, !m.enabled)}
                  title={m.required && m.enabled ? "Required by the panel — cannot disable" : ""}
                  style={{ ...btn, padding: "3px 10px", fontSize: 11, background: m.enabled ? "rgba(34,197,94,.18)" : "var(--surface)", color: m.enabled ? "#22c55e" : "var(--muted)", opacity: m.required && m.enabled ? 0.5 : 1 }}>
                  {m.enabled ? "ON" : "OFF"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* FILES */}
      {tab === "files" && !openFile && (
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Configuration files</div>
          {files.map((f) => (
            <div key={f.path} onClick={() => f.exists && view(f.path)}
              style={{ display: "flex", justifyContent: "space-between", padding: "9px 8px", borderBottom: "1px solid var(--border)", cursor: f.exists ? "pointer" : "default", opacity: f.exists ? 1 : 0.5 }}>
              <span style={{ fontFamily: "monospace", fontSize: 13 }}>{f.path}</span>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>{f.exists ? `${f.size} B — edit` : "missing"}</span>
            </div>
          ))}
        </div>
      )}
      {tab === "files" && openFile && (
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <b style={{ fontFamily: "monospace" }}>{openFile.path}</b>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={btn} onClick={() => setOpenFile(null)}>← Back</button>
              <button disabled={busy} style={{ ...btn, background: "var(--accent,#378ADD)", color: "#fff" }} onClick={saveFile}>Save &amp; restart</button>
            </div>
          </div>
          <textarea value={openFile.content} onChange={(e) => setOpenFile({ ...openFile, content: e.target.value })}
            spellCheck={false} style={{ width: "100%", minHeight: "60vh", background: "var(--bg)", color: "#a7f3d0", border: "1px solid var(--border)", borderRadius: 8, padding: 12, fontFamily: "monospace", fontSize: 12.5 }} />
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>On Save: a timestamped backup is made, the change is validated with <code>freeradius -XC</code>, and if it fails the previous version is restored automatically.</div>
        </div>
      )}

      {/* DATABASE */}
      {tab === "database" && db && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={card}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Connection</div>
            <div style={{ fontSize: 13, lineHeight: 1.9 }}>
              <div>Host: <b>{db.connection?.host}:{db.connection?.port}</b></div>
              <div>Database: <b>{db.connection?.database}</b>　User: <b>{db.connection?.user}</b></div>
              <div>Pool: {Object.entries(db.poolParams || {}).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}</div>
              <div>Redis cache: <b>{db.redis}</b></div>
              <div>Live connections: <b>{db.activity?.connections}</b> ({db.activity?.active} active)</div>
            </div>
            <div style={{ fontWeight: 700, margin: "14px 0 6px" }}>Server settings</div>
            <table style={{ width: "100%", fontSize: 12.5 }}>
              <tbody>
                {(db.settings || []).map((s: any) => (
                  <tr key={s.name}><td style={{ color: "var(--muted)", padding: "3px 0" }}>{s.name}</td><td style={{ textAlign: "right" }}><b>{s.setting}{s.unit ? ` ${s.unit}` : ""}</b></td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={card}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Largest tables</div>
            <table style={{ width: "100%", fontSize: 12.5 }}>
              <thead><tr><th style={{ textAlign: "left", color: "var(--muted)" }}>Table</th><th style={{ textAlign: "right", color: "var(--muted)" }}>Rows</th><th style={{ textAlign: "right", color: "var(--muted)" }}>Size</th></tr></thead>
              <tbody>
                {(db.topTables || []).map((t: any) => (
                  <tr key={t.table}><td style={{ padding: "3px 0" }}>{t.table}</td><td style={{ textAlign: "right" }}>{Number(t.rows).toLocaleString()}</td><td style={{ textAlign: "right" }}>{t.size}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
