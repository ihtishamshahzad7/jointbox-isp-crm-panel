"use client";

import React from "react";
import { silent } from "../components/silent";
import API_BASE from "../components/api";

/**
 * Router Console — a WinBox-style workspace, wired to live data.
 *
 * Pick a router at the top; each left-menu item opens a floating window over
 * real data:
 *   Interfaces / IP Addresses / CPU-RAM-uptime  →  GET /nas/:id/sync (router API)
 *   PPP Active                                   →  GET /nas/:id/sessions
 *   PPP Secrets / Simple Queues                  →  GET /subscribers (this NAS)
 *   Log                                          →  GET /logs/router?nasId=
 * Disconnect on an active session is a real action (POST /network/disconnect).
 *
 * The flag column follows WinBox: X disabled, D dynamic, R running.
 */

type Flag = "X" | "D" | "R" | "";
type WinId = "iface" | "ppp-active" | "ppp-secret" | "ip-addr" | "queues" | "log";

const NOVA = "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)";
const API =
  API_BASE;

const TITLE: Record<WinId, string> = {
  iface: "Interface List", "ppp-active": "PPP Active Connections", "ppp-secret": "PPP Secrets",
  "ip-addr": "Address List", queues: "Simple Queues", log: "Log",
};
const MENU: { group: string; items: { id: WinId; label: string }[] }[] = [
  { group: "Interfaces", items: [{ id: "iface", label: "Interface List" }] },
  { group: "PPP", items: [{ id: "ppp-active", label: "Active Connections" }, { id: "ppp-secret", label: "Secrets" }] },
  { group: "IP", items: [{ id: "ip-addr", label: "Addresses" }] },
  { group: "Queues", items: [{ id: "queues", label: "Simple Queues" }] },
  { group: "System", items: [{ id: "log", label: "Log" }] },
];

type Win = { id: WinId; x: number; y: number; z: number };
type Col = { key: string; label: string; mono?: boolean };
type Row = { fl: Flag; [k: string]: any };

const flagStyle = (f: Flag): React.CSSProperties => ({
  color: f === "X" ? "#FCA5A5" : f === "D" ? "#93c5fd" : f === "R" ? "#6EE7B7" : "var(--muted)",
});
const truthy = (v: any) => v === true || v === "true" || v === "yes";
const arr = (x: any): any[] => (Array.isArray(x) ? x : x?.data ?? x?.lines ?? x?.sessions ?? x?.logs ?? []);
const numPct = (v: any) => { const n = parseFloat(String(v ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) ? Math.round(n) : 0; };

export default function RouterConsole() {
  const [token, setToken] = React.useState("");
  const [nasList, setNasList] = React.useState<any[]>([]);
  const [nasId, setNasId] = React.useState<number | null>(null);

  const [details, setDetails] = React.useState<any>(null);
  const [sessions, setSessions] = React.useState<any[]>([]);
  const [subs, setSubs] = React.useState<any[]>([]);
  const [logs, setLogs] = React.useState<any[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState("");

  const [wins, setWins] = React.useState<Win[]>([{ id: "ppp-secret", x: 70, y: 60, z: 2 }, { id: "iface", x: 380, y: 130, z: 1 }]);
  const topZ = React.useRef(3);
  const drag = React.useRef<{ id: WinId; dx: number; dy: number } | null>(null);

  const headers = React.useMemo(() => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }), [token]);

  React.useEffect(() => { setToken(typeof window !== "undefined" ? localStorage.getItem("token") || "" : ""); }, []);

  React.useEffect(() => {
    if (!token) return;
    fetch(`${API}/nas`, { headers })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => { const list = arr(rows); setNasList(list); if (list[0]) setNasId((id) => id ?? list[0].id); })
      .catch(silent("nasListFetch"));
  }, [token]);

  const loadAll = React.useCallback(async (id: number) => {
    setBusy(true); setNote("");
    const get = (u: string) => fetch(`${API}${u}`, { headers }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [d, s, sub, lg] = await Promise.all([
      get(`/nas/${id}/sync`), get(`/nas/${id}/sessions`), get(`/subscribers`), get(`/logs/router?nasId=${id}&limit=120`),
    ]);
    setDetails(d || null);
    setSessions(arr(s));
    setSubs(arr(sub).filter((x: any) => String(x.nasId) === String(id)));
    setLogs(arr(lg));
    if (!d) setNote("Router API did not answer — interfaces/IP/CPU need API access on this NAS.");
    setBusy(false);
  }, [headers]);

  React.useEffect(() => { if (nasId != null && token) loadAll(nasId); }, [nasId, token, loadAll]);

  const disconnect = async (username: string) => {
    if (!username || !confirm(`Disconnect ${username}? Their session drops immediately.`)) return;
    const r = await fetch(`${API}/network/disconnect/${encodeURIComponent(username)}`, { method: "POST", headers });
    setNote(r.ok ? `Sent disconnect for ${username}` : `Disconnect failed for ${username}`);
    if (nasId) loadAll(nasId);
  };

  // ── Live data → window rows ──────────────────────────────────────────────
  const view = (id: WinId): { cols: Col[]; rows: Row[] } => {
    switch (id) {
      case "iface": return {
        cols: [{ key: "name", label: "Name" }, { key: "type", label: "Type" }, { key: "mtu", label: "MTU", mono: true }, { key: "macAddress", label: "MAC", mono: true }],
        rows: (details?.interfaces ?? []).map((i: any) => ({ fl: truthy(i.disabled) ? "X" : truthy(i.running) ? "R" : "", name: i.name, type: i.type, mtu: i.mtu, macAddress: i.macAddress })),
      };
      case "ppp-active": return {
        cols: [{ key: "name", label: "Name" }, { key: "service", label: "Service" }, { key: "address", label: "Address", mono: true }, { key: "uptime", label: "Uptime" }, { key: "caller", label: "Caller ID", mono: true }, { key: "act", label: "" }],
        rows: sessions.map((s: any) => ({
          fl: "", _user: s.username || s.user || s.name || s.name0,
          name: s.username || s.user || s.name || "—", service: s.service || "pppoe",
          address: s.framedIpAddress || s.framedipaddress || s.address || s.ip || "—",
          uptime: s.uptime || s.sessionTime || s.acctsessiontime || "—",
          caller: s.callingStationId || s.callingstationid || s.callerId || s.mac || "—",
          act: "disconnect",
        })),
      };
      case "ppp-secret": return {
        cols: [{ key: "name", label: "Name" }, { key: "profile", label: "Profile" }, { key: "service", label: "Service" }, { key: "pool", label: "Pool" }],
        rows: subs.map((x: any) => ({ fl: String(x.status).toUpperCase() === "ACTIVE" ? "" : "X", name: x.username || x.fullName, profile: x.package?.name || "—", service: x.connectionType || "pppoe", pool: x.package?.pool?.name || "—" })),
      };
      case "ip-addr": return {
        cols: [{ key: "address", label: "Address", mono: true }, { key: "network", label: "Network", mono: true }, { key: "interface", label: "Interface" }],
        rows: (details?.ipAddresses ?? []).map((a: any) => ({ fl: truthy(a.disabled) ? "X" : truthy(a.dynamic) ? "D" : "", address: a.address, network: a.network, interface: a.interface })),
      };
      case "queues": return {
        cols: [{ key: "name", label: "Name" }, { key: "target", label: "Target", mono: true }, { key: "maxLimit", label: "Max limit", mono: true }, { key: "status", label: "Status" }],
        rows: subs.map((x: any) => ({
          fl: String(x.status).toUpperCase() === "ACTIVE" ? "" : "X",
          name: x.username || x.fullName, target: x.framedIp || x.leasedIp || "—",
          maxLimit: x.package ? `${x.package.uploadSpeed}M/${x.package.downloadSpeed}M` : "—",
          status: x.liveStatus === "ONLINE" ? "online" : "offline",
        })),
      };
      case "log": return {
        cols: [{ key: "time", label: "Time", mono: true }, { key: "topic", label: "Topics" }, { key: "message", label: "Message" }],
        rows: logs.map((l: any) => ({ fl: "", time: new Date(l.loggedAt || l.time).toLocaleTimeString(), topic: (l.severity || l.topics || "info").toLowerCase(), message: l.message || l.msg })),
      };
    }
  };

  // ── Window plumbing ──────────────────────────────────────────────────────
  const open = (id: WinId) => setWins((w) => {
    const z = ++topZ.current; const found = w.find((x) => x.id === id);
    return found ? w.map((x) => (x.id === id ? { ...x, z } : x)) : [...w, { id, x: 90 + w.length * 26, y: 80 + w.length * 22, z }];
  });
  const close = (id: WinId) => setWins((w) => w.filter((x) => x.id !== id));
  const focus = (id: WinId) => setWins((w) => w.map((x) => (x.id === id ? { ...x, z: ++topZ.current } : x)));
  const onDown = (e: React.MouseEvent, win: Win) => { focus(win.id); drag.current = { id: win.id, dx: e.clientX - win.x, dy: e.clientY - win.y }; };
  React.useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return; const { id, dx, dy } = drag.current;
      setWins((w) => w.map((x) => (x.id === id ? { ...x, x: Math.max(0, e.clientX - dx), y: Math.max(0, e.clientY - dy) } : x)));
    };
    const up = () => (drag.current = null);
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  const T = { bg: "#0b0e1a", panel: "#151823", panel2: "#1b1f2e", border: "#252a3c", text: "#e9edf5", muted: "#94a3b8" };
  const tbarBtn: React.CSSProperties = { width: 24, height: 22, borderRadius: 6, border: `1px solid ${T.border}`, background: T.panel2, color: T.muted, fontSize: 12, cursor: "pointer", display: "grid", placeItems: "center", fontFamily: "inherit" };

  const nas = nasList.find((n) => n.id === nasId);
  const memPct = details ? Math.round(((numPct(details.totalMemory) - numPct(details.freeMemory)) / (numPct(details.totalMemory) || 1)) * 100) : 0;
  const cpu = numPct(details?.cpuLoad);

  return (
    <div style={{ position: "relative", height: "100%", minHeight: "calc(100vh - 8px)", background: T.bg, color: T.text, fontFamily: "Inter, system-ui, sans-serif", overflow: "hidden" }}>
      {/* Connection / resource bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "8px 16px", borderBottom: `1px solid ${T.border}`, background: T.panel, fontSize: 12, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: details ? "#6EE7B7" : "#64748b", boxShadow: details ? "0 0 7px #6EE7B7" : "none" }} />
          Router
        </span>
        <select value={nasId ?? ""} onChange={(e) => setNasId(Number(e.target.value))}
          style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, borderRadius: 7, padding: "5px 9px", fontSize: 12 }}>
          {nasList.length === 0 && <option value="">No routers</option>}
          {nasList.map((n) => <option key={n.id} value={n.id}>{n.nasname} · {n.nasIp}</option>)}
        </select>
        {details && <><span style={{ color: T.muted }}>{details.identity || nas?.nasname}</span>
          <span style={{ color: T.muted }}>RouterOS {details.version || "—"}</span>
          <span style={{ color: T.muted }}>uptime {details.uptime || "—"}</span></>}
        <button onClick={() => nasId && loadAll(nasId)} style={{ ...tbarBtn, width: "auto", padding: "0 10px", height: 24 }}>{busy ? "…" : "↻ Refresh"}</button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 14, alignItems: "center" }}>
          {[["CPU", cpu], ["RAM", memPct]].map(([l, v]) => (
            <span key={l as string} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: T.muted, fontSize: 11 }}>{l}</span>
              <span style={{ width: 70, height: 6, borderRadius: 99, background: T.panel2, overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${v}%`, borderRadius: 99, background: (v as number) > 80 ? "#EF4444" : (v as number) > 60 ? "#F59E0B" : "#10B981" }} />
              </span>
              <b style={{ fontVariantNumeric: "tabular-nums", width: 30, textAlign: "right" }}>{v as number}%</b>
            </span>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", height: "calc(100% - 64px)" }}>
        {/* Left menu */}
        <div style={{ width: 188, flexShrink: 0, borderRight: `1px solid ${T.border}`, background: T.panel, overflowY: "auto", padding: "8px 0" }}>
          {MENU.map((g) => (
            <div key={g.group} style={{ marginBottom: 4 }}>
              <div style={{ padding: "7px 14px 4px", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.muted }}>{g.group}</div>
              {g.items.map((it) => {
                const isOpen = wins.some((w) => w.id === it.id);
                return (
                  <button key={it.id} onClick={() => open(it.id)}
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 14px", border: "none", background: isOpen ? "rgba(108,60,225,0.16)" : "transparent", color: isOpen ? "#C4B5FD" : T.text, fontSize: 12.5, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: isOpen ? "#C4B5FD" : T.border }} />
                    {it.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Workspace */}
        <div style={{ position: "relative", flex: 1, overflow: "hidden", backgroundImage: `linear-gradient(${T.border}55 1px, transparent 1px), linear-gradient(90deg, ${T.border}55 1px, transparent 1px)`, backgroundSize: "26px 26px" }}>
          {wins.length === 0 && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: T.muted, fontSize: 13 }}>Pick a menu item on the left to open a window.</div>}
          {wins.map((win) => {
            const { cols, rows } = view(win.id);
            return (
              <div key={win.id} onMouseDown={() => focus(win.id)}
                style={{ position: "absolute", left: win.x, top: win.y, zIndex: win.z, width: win.id === "log" ? 580 : 540, background: T.panel, border: `1px solid ${T.border}`, borderRadius: 10, boxShadow: "0 18px 44px rgba(0,0,0,0.5)", overflow: "hidden" }}>
                <div onMouseDown={(e) => onDown(e, win)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: T.panel2, borderBottom: `1px solid ${T.border}`, cursor: "move", userSelect: "none" }}>
                  <span style={{ width: 16, height: 16, borderRadius: 5, background: NOVA, flexShrink: 0 }} />
                  <b style={{ fontSize: 12.5 }}>{TITLE[win.id]}</b>
                  <span style={{ marginLeft: "auto", color: T.muted, fontSize: 11 }}>{rows.length} items</span>
                  <button onClick={() => close(win.id)} aria-label="Close" style={{ width: 20, height: 20, borderRadius: 5, border: `1px solid ${T.border}`, background: "transparent", color: T.muted, cursor: "pointer", fontFamily: "inherit" }}>×</button>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 8px", borderBottom: `1px solid ${T.border}` }}>
                  <button style={tbarBtn} title="Add" aria-label="Add">+</button>
                  <button style={tbarBtn} title="Remove" aria-label="Remove">−</button>
                  <button style={{ ...tbarBtn, color: "#6EE7B7" }} title="Enable" aria-label="Enable">✓</button>
                  <button style={{ ...tbarBtn, color: "#FCA5A5" }} title="Disable" aria-label="Disable">✕</button>
                  <input placeholder="Filter" style={{ marginLeft: "auto", width: 120, height: 22, borderRadius: 6, border: `1px solid ${T.border}`, background: T.bg, color: T.text, fontSize: 11, padding: "0 8px", outline: "none" }} />
                  <button style={tbarBtn} title="Refresh" aria-label="Refresh" onClick={() => nasId && loadAll(nasId)}>↻</button>
                </div>

                <div style={{ maxHeight: 260, overflow: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 26, position: "sticky", top: 0, background: T.panel2, borderBottom: `1px solid ${T.border}`, padding: "6px 4px" }}></th>
                        {cols.map((c) => <th key={c.key} style={{ position: "sticky", top: 0, background: T.panel2, borderBottom: `1px solid ${T.border}`, padding: "6px 10px", textAlign: "left", color: T.muted, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{c.label}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 && <tr><td colSpan={cols.length + 1} style={{ padding: 24, textAlign: "center", color: T.muted, fontSize: 12 }}>{busy ? "Loading…" : "No data."}</td></tr>}
                      {rows.map((r, i) => (
                        <tr key={i} style={{ borderBottom: `1px solid ${T.border}`, background: r.fl === "X" ? "rgba(239,68,68,0.05)" : "transparent" }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(108,60,225,0.08)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = r.fl === "X" ? "rgba(239,68,68,0.05)" : "transparent")}>
                          <td style={{ textAlign: "center", fontWeight: 800, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", ...flagStyle(r.fl) }}>{r.fl}</td>
                          {cols.map((c) => (
                            <td key={c.key} style={{ padding: "6px 10px", whiteSpace: "nowrap", color: r.fl === "X" ? T.muted : T.text, fontFamily: c.mono ? "'JetBrains Mono', monospace" : "inherit", fontSize: c.mono ? 11 : 12 }}>
                              {c.key === "act" && r.act === "disconnect"
                                ? <button onClick={() => disconnect(r._user)} style={{ padding: "2px 8px", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: "#FCA5A5", fontSize: 10.5, cursor: "pointer", fontFamily: "inherit" }}>Disconnect</button>
                                : r[c.key]}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Status bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "6px 16px", borderTop: `1px solid ${T.border}`, background: T.panel, fontSize: 11, color: T.muted }}>
        <span>Flags:</span>
        <span><b style={{ color: "#FCA5A5" }}>X</b> disabled</span>
        <span><b style={{ color: "#93c5fd" }}>D</b> dynamic</span>
        <span><b style={{ color: "#6EE7B7" }}>R</b> running</span>
        {note && <span style={{ color: "#C4B5FD" }}>· {note}</span>}
        <span style={{ marginLeft: "auto" }}>{nas ? `${nas.nasname} · ${nas.nasIp}` : "no router selected"}</span>
      </div>
    </div>
  );
}
