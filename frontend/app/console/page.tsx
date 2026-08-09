"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { silent } from "../components/silent";
import API_BASE from "../components/api";

/**
 * Server Console — ISP owner only.
 *
 * A terminal into the host plus live tails of the backend, frontend and system
 * logs. Arbitrary command execution is armed server-side (CONSOLE_SHELL_ENABLED)
 * — until then the terminal reads commands but the server refuses to run them,
 * and this page says so.
 */

const API =
  API_BASE;

type Tab = "terminal" | "backend" | "frontend" | "system";

const T = {
  bg: "#0b0e14", panel: "#12151f", panel2: "#1a1e2b", border: "#252a3c",
  text: "#e9edf5", muted: "#8b97ac", green: "#6EE7B7", red: "#FCA5A5", amber: "#FCD34D",
};

export default function ConsolePage() {
  const router = useRouter();
  const [token, setToken] = React.useState("");
  const [role, setRole] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<any>(null);
  const [tab, setTab] = React.useState<Tab>("terminal");

  const [cmd, setCmd] = React.useState("");
  const [history, setHistory] = React.useState<{ cmd: string; out: string; err: string; code: number }[]>([]);
  const [running, setRunning] = React.useState(false);
  const [histIdx, setHistIdx] = React.useState(-1);

  const [logText, setLogText] = React.useState("");
  const [logLoading, setLogLoading] = React.useState(false);
  const [auto, setAuto] = React.useState(false);
  const outRef = React.useRef<HTMLDivElement>(null);
  const logRef = React.useRef<HTMLPreElement>(null);

  const headers = React.useMemo(() => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }), [token]);

  React.useEffect(() => {
    const t = typeof window !== "undefined" ? localStorage.getItem("token") || "" : "";
    setToken(t);
    try { setRole(t ? JSON.parse(atob(t.split(".")[1]))?.role ?? null : null); } catch { setRole(null); }
    if (!t) router.push("/login");
  }, []);

  React.useEffect(() => {
    if (!token || role !== "SUPER_ADMIN") return;
    fetch(`${API}/console/info`, { headers }).then((r) => (r.ok ? r.json() : null)).then(setInfo).catch(silent("consoleInfoFetch"));
  }, [token, role]);

  const loadLog = React.useCallback(async (source: Tab) => {
    if (source === "terminal") return;
    setLogLoading(true);
    try {
      const r = await fetch(`${API}/console/logs?source=${source}&lines=400`, { headers });
      const d = await r.json();
      setLogText((d?.stdout || "") + (d?.stderr ? `\n${d.stderr}` : "") || "(empty)");
    } catch { setLogText("Failed to load log."); }
    setLogLoading(false);
    requestAnimationFrame(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; });
  }, [headers]);

  React.useEffect(() => { if (tab !== "terminal") loadLog(tab); }, [tab, loadLog]);
  React.useEffect(() => {
    if (!auto || tab === "terminal") return;
    const t = setInterval(() => loadLog(tab), 5000);
    return () => clearInterval(t);
  }, [auto, tab, loadLog]);

  const run = async () => {
    const c = cmd.trim();
    if (!c || running) return;
    setRunning(true);
    setCmd("");
    try {
      const r = await fetch(`${API}/console/exec`, { method: "POST", headers, body: JSON.stringify({ command: c }) });
      const d = await r.json();
      setHistory((h) => [...h, { cmd: c, out: d?.stdout || "", err: d?.stderr || (r.ok ? "" : d?.message || "blocked"), code: d?.code ?? (r.ok ? 0 : 1) }]);
    } catch {
      setHistory((h) => [...h, { cmd: c, out: "", err: "Request failed.", code: 1 }]);
    }
    setRunning(false);
    setHistIdx(-1);
    requestAnimationFrame(() => { if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight; });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); run(); }
    else if (e.key === "ArrowUp") {
      const cmds = history.map((h) => h.cmd);
      if (!cmds.length) return;
      const i = histIdx < 0 ? cmds.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(i); setCmd(cmds[i]);
    } else if (e.key === "ArrowDown") {
      const cmds = history.map((h) => h.cmd);
      if (histIdx < 0) return;
      const i = histIdx + 1;
      if (i >= cmds.length) { setHistIdx(-1); setCmd(""); } else { setHistIdx(i); setCmd(cmds[i]); }
    }
  };

  if (role && role !== "SUPER_ADMIN") {
    return <div style={{ padding: 40, color: T.amber, background: T.bg, minHeight: "100vh" }}>The server console is available to the ISP owner account only.</div>;
  }

  const mono = "'JetBrains Mono', ui-monospace, monospace";
  const tabBtn = (id: Tab, label: string): React.CSSProperties => ({
    border: "none", cursor: "pointer", padding: "7px 15px", borderRadius: 8, fontSize: 12.5, fontWeight: 700, fontFamily: "inherit",
    background: tab === id ? "var(--g-primary,#6C3CE1)" : "transparent", color: tab === id ? "#fff" : T.muted,
  });

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "Inter, system-ui, sans-serif", padding: 18 }}>
      {/* Warning */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 14px", borderRadius: 10, background: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.35)", marginBottom: 14, fontSize: 12.5 }}>
        <span style={{ fontSize: 16 }}>⚠️</span>
        <span style={{ color: "#FCA5A5" }}>
          <b>Direct shell access to this server{info?.platform === "win32" ? " (Windows)" : info?.platform ? " (Linux)" : ""}.</b> Every command runs on the host and is audit-logged. Only the ISP owner can reach this page.
          {info && !info.shellArmed && <> Command execution is currently <b>disarmed</b> — set <code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 5px", borderRadius: 4 }}>CONSOLE_SHELL_ENABLED=true</code> on the backend to enable it.</>}
        </span>
      </div>

      {/* Host info */}
      {info && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: "10px 14px", background: T.panel, border: `1px solid ${T.border}`, borderRadius: 10, marginBottom: 14, fontSize: 12, fontFamily: mono }}>
          {[["host", info.hostname], ["os", info.os], ["user", info.whoami], ["uptime", info.uptime], ["disk", info.disk], ["mem", info.mem], ["node", info.node]].map(([k, v]) => v && (
            <span key={k as string}><span style={{ color: T.muted }}>{k}:</span> {v}</span>
          ))}
          <span style={{ marginLeft: "auto", color: info.shellArmed ? T.green : T.amber, fontWeight: 700 }}>
            {info.shellArmed ? "● shell armed" : "○ shell disarmed"}
          </span>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, background: T.panel, border: `1px solid ${T.border}`, borderRadius: 10, padding: 5, width: "fit-content" }}>
        <button style={tabBtn("terminal", "Terminal")} onClick={() => setTab("terminal")}>Terminal</button>
        <button style={tabBtn("backend", "Backend logs")} onClick={() => setTab("backend")}>Backend logs</button>
        <button style={tabBtn("frontend", "Frontend logs")} onClick={() => setTab("frontend")}>Frontend logs</button>
        <button style={tabBtn("system", "System logs")} onClick={() => setTab("system")}>System logs</button>
      </div>

      {tab === "terminal" ? (
        <div style={{ background: "#0a0d13", border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div ref={outRef} style={{ height: "58vh", overflowY: "auto", padding: 14, fontFamily: mono, fontSize: 12.5, lineHeight: 1.6 }}>
            {history.length === 0 && (() => {
              const ex = info?.platform === "win32" ? ["systeminfo", "tasklist", "dir"] : ["uptime", "df -h", "pm2 list"];
              return <div style={{ color: T.muted }}>Type a command and press Enter. ↑/↓ for history. Try: {ex.map((c, i) => <React.Fragment key={c}>{i > 0 && ", "}<span style={{ color: T.green }}>{c}</span></React.Fragment>)}.</div>;
            })()}
            {history.map((h, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <div style={{ color: "#C4B5FD" }}><span style={{ color: T.muted }}>$</span> {h.cmd}</div>
                {h.out && <pre style={{ margin: "3px 0 0", whiteSpace: "pre-wrap", color: T.text }}>{h.out}</pre>}
                {h.err && <pre style={{ margin: "3px 0 0", whiteSpace: "pre-wrap", color: T.red }}>{h.err}</pre>}
                {h.code !== 0 && <div style={{ color: T.amber, fontSize: 11 }}>exit {h.code}</div>}
              </div>
            ))}
            {running && <div style={{ color: T.amber }}>running…</div>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: `1px solid ${T.border}`, padding: "8px 12px", background: T.panel }}>
            <span style={{ color: "#C4B5FD", fontFamily: mono, fontSize: 13 }}>$</span>
            <input
              value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={onKey} autoFocus spellCheck={false}
              placeholder={info?.shellArmed === false ? "shell disarmed — set CONSOLE_SHELL_ENABLED=true" : "command…"}
              style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: T.text, fontFamily: mono, fontSize: 13 }}
            />
            <button onClick={run} disabled={running} style={{ border: "none", cursor: "pointer", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 700, background: "var(--g-primary,#6C3CE1)", color: "#fff", fontFamily: "inherit" }}>Run</button>
          </div>
        </div>
      ) : (
        <div style={{ background: "#0a0d13", border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${T.border}`, padding: "8px 12px", background: T.panel }}>
            <b style={{ fontSize: 12.5, textTransform: "capitalize" }}>{tab} logs</b>
            <label style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: T.muted, cursor: "pointer" }}>
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto 5s
            </label>
            <button onClick={() => loadLog(tab)} style={{ border: `1px solid ${T.border}`, background: "transparent", color: T.muted, borderRadius: 7, padding: "5px 11px", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit" }}>{logLoading ? "…" : "Refresh"}</button>
          </div>
          <pre ref={logRef} style={{ margin: 0, height: "58vh", overflow: "auto", padding: 14, fontFamily: mono, fontSize: 11.5, lineHeight: 1.55, color: T.text, whiteSpace: "pre-wrap" }}>{logText || (logLoading ? "Loading…" : "(empty)")}</pre>
        </div>
      )}
    </div>
  );
}
