"use client";

/**
 * Small shared UI primitives for the Subscriber 360 page — consistent with the
 * panel's design tokens (--surface/--border/--text/--muted/--accent/…).
 * Compact, information-dense, dark/light compatible. `sd-` prefixed classes.
 */
import React, { useEffect } from "react";
import Portal from "../../components/portal";

export const COLORS = {
  ok: "#219653",
  warn: "#B45309",
  bad: "#D34053",
  off: "#94A3B8",
  unknown: "#94A3B8",
  accent: "var(--accent)",
  muted: "var(--muted)",
  text: "var(--text)",
  border: "var(--border)",
  surface: "var(--surface)",
  surface2: "var(--surface-2)",
};

export type Level = "ok" | "warn" | "bad" | "off" | "unknown";

export const LEVEL_STYLE: Record<Level, { color: string; bg: string; dot: string }> = {
  ok:      { color: "#219653", bg: "rgba(33,150,83,.10)", dot: "#219653" },
  warn:    { color: "#B45309", bg: "rgba(180,83,9,.10)",  dot: "#D97706" },
  bad:     { color: "#D34053", bg: "rgba(211,64,83,.10)", dot: "#D34053" },
  off:     { color: "#64748B", bg: "rgba(100,116,139,.10)", dot: "#94A3B8" },
  unknown: { color: "#64748B", bg: "rgba(100,116,139,.08)", dot: "#94A3B8" },
};

/** Status chip with pulsing live dot. */
export function StatusChip({ level, text, detail, dotPulse = true }: {
  level: Level; text: string; detail?: string; dotPulse?: boolean;
}) {
  const s = LEVEL_STYLE[level];
  return (
    <span className="sd-chip" title={detail} style={{ color: s.color, background: s.bg }}>
      <span className={`sd-dot${dotPulse && (level === "ok" || level === "bad") ? " pulse" : ""}`} style={{ background: s.dot }} />
      {text}
      {detail ? <em>{detail}</em> : null}
    </span>
  );
}

export function Btn({ children, onClick, variant = "default", size = "sm", disabled, title, style }: {
  children: React.ReactNode; onClick?: (e: React.MouseEvent) => void;
  variant?: "default" | "primary" | "ghost" | "danger" | "warn" | "success";
  size?: "xs" | "sm"; disabled?: boolean; title?: string; style?: React.CSSProperties;
}) {
  return (
    <button
      className={`sd-btn ${variant} ${size}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={style}
    >
      {children}
    </button>
  );
}

export function Panel({ title, sub, actions, children, style, className }: {
  title?: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode;
  children: React.ReactNode; style?: React.CSSProperties; className?: string;
}) {
  return (
    <section className={`sd-panel${className ? " " + className : ""}`} style={style}>
      {(title || actions) && (
        <header className="sd-panel-h">
          <div>
            {title && <h3>{title}</h3>}
            {sub && <p>{sub}</p>}
          </div>
          {actions && <div className="sd-panel-a">{actions}</div>}
        </header>
      )}
      <div className="sd-panel-b">{children}</div>
    </section>
  );
}

/** KPI-style value block (compact, no giant cards). */
export function Kpi({ label, value, sub, color, icon, title }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; color?: string; icon?: React.ReactNode; title?: string;
}) {
  return (
    <div className="sd-kpi" title={title}>
      <div className="sd-kpi-top">
        {icon}
        <span className="sd-kpi-label">{label}</span>
      </div>
      <div className="sd-kpi-value" style={{ color: color ?? "var(--text)" }}>{value}</div>
      {sub != null && <div className="sd-kpi-sub">{sub}</div>}
    </div>
  );
}

export function GroupLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="sd-group-label">
      <span>{children}</span>
      {right}
    </div>
  );
}

export function EmptyState({ icon = "—", title, hint }: { icon?: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="sd-empty">
      <div className="sd-empty-icon">{icon}</div>
      <div className="sd-empty-title">{title}</div>
      {hint && <div className="sd-empty-hint">{hint}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="sd-spinner">
      <span className="sd-spinner-ring" />
      {label && <span>{label}</span>}
    </div>
  );
}

export function Field({ label, hint, children, required }: {
  label: string; hint?: string; children: React.ReactNode; required?: boolean;
}) {
  return (
    <label className="sd-field">
      <span className="sd-field-label">{label}{required && <b>*</b>}</span>
      {children}
      {hint && <span className="sd-field-hint">{hint}</span>}
    </label>
  );
}

export const inputStyle: React.CSSProperties = {
  background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 6,
  color: "var(--text)", padding: "6px 9px", width: "100%", fontSize: 12,
  fontFamily: "inherit", outline: "none",
};

/** Generic modal shell. */
export function Modal({ title, sub, onClose, children, width = 640 }: {
  title: React.ReactNode; sub?: React.ReactNode; onClose: () => void;
  children: React.ReactNode; width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <Portal>
      <div className="sd-modal-back" onClick={onClose}>
        <div className="sd-modal" style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()}>
          <header className="sd-modal-h">
            <div>
              <h3>{title}</h3>
              {sub && <p>{sub}</p>}
            </div>
            <button className="sd-x" onClick={onClose} aria-label="Close">✕</button>
          </header>
          <div className="sd-modal-b">{children}</div>
        </div>
      </div>
    </Portal>
  );
}

/** Right-side drawer. */
export function Drawer({ title, sub, onClose, children, width = 460 }: {
  title: React.ReactNode; sub?: React.ReactNode; onClose: () => void;
  children: React.ReactNode; width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <Portal>
      <div className="sd-drawer-back" onClick={onClose}>
        <aside className="sd-drawer" style={{ width }} onClick={(e) => e.stopPropagation()}>
          <header className="sd-drawer-h">
            <div>
              <h3>{title}</h3>
              {sub && <p>{sub}</p>}
            </div>
            <button className="sd-x" onClick={onClose} aria-label="Close">✕</button>
          </header>
          <div className="sd-drawer-b">{children}</div>
        </aside>
      </div>
    </Portal>
  );
}

/** Key/value definition rows. */
export function DefList({ rows, wide }: { rows: Array<[string, React.ReactNode]>; wide?: boolean }) {
  return (
    <dl className={`sd-def${wide ? " wide" : ""}`}>
      {rows.map(([k, v]) => (
        <div key={k} className="sd-def-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Severity → label/color. */
export const SEVERITY: Record<string, { label: string; color: string; bg: string }> = {
  critical: { label: "Critical", color: "#D34053", bg: "rgba(211,64,83,.12)" },
  error:    { label: "Error",    color: "#D34053", bg: "rgba(211,64,83,.10)" },
  warning:  { label: "Warning",  color: "#B45309", bg: "rgba(180,83,9,.12)" },
  warn:     { label: "Warning",  color: "#B45309", bg: "rgba(180,83,9,.12)" },
  info:     { label: "Info",     color: "#2563EB", bg: "rgba(37,99,235,.10)" },
  success:  { label: "Success",  color: "#219653", bg: "rgba(33,150,83,.12)" },
};
export function severityOf(v?: string): { label: string; color: string; bg: string } {
  return SEVERITY[String(v || "info").toLowerCase()] ?? { label: String(v || "Info"), color: "var(--muted)", bg: "rgba(100,116,139,.10)" };
}

/** Subscriber status → semantic level (billing/account state, NOT online state). */
export function accountLevel(status?: string): { level: Level; text: string; detail?: string } {
  switch (status) {
    case "ACTIVE":    return { level: "ok", text: "ACTIVE" };
    case "EXPIRED":   return { level: "bad", text: "EXPIRED", detail: "Service should be suspended / renewed" };
    case "SUSPENDED": return { level: "warn", text: "SUSPENDED", detail: "Suspended — blocked from dialling in" };
    case "INACTIVE":  return { level: "off", text: "INACTIVE", detail: "Never used / deprecated" };
    default:          return { level: "unknown", text: status ?? "—" };
  }
}

/** Compact auto-refresh control (Live/30s/1m/5m/Off). */
export function RefreshControl({ mode, setMode, liveConnected, lastUpdate }: {
  mode: string; setMode: (m: any) => void; liveConnected: boolean; lastUpdate: Date | null;
}) {
  const opts = [
    { id: "live", label: "Live" },
    { id: "30s", label: "30 sec" },
    { id: "1m", label: "1 min" },
    { id: "5m", label: "5 min" },
    { id: "off", label: "Off" },
  ];
  return (
    <div className="sd-refresh">
      <span className={`sd-live${liveConnected ? " on" : ""}`} title={liveConnected ? "Live stream connected" : "Live stream lost — retrying…"}>
        {liveConnected ? "●" : "○"} Live
      </span>
      <div className="sd-refresh-opts" role="tablist" aria-label="Auto refresh">
        {opts.map((o) => (
          <button
            key={o.id}
            className={mode === o.id ? "on" : ""}
            onClick={() => setMode(o.id)}
            aria-pressed={mode === o.id}
          >{o.label}</button>
        ))}
      </div>
      {lastUpdate && (
        <span className="sd-updated" title="Last successful data refresh">
          Updated {lastUpdate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      )}
    </div>
  );
}

/** Page stylesheet — a single <style> per page. */
export function SubDetailStyles() {
  return <style>{CSS}</style>;
}

const CSS = `
.sd-root{display:flex;flex-direction:column;gap:12px;color:var(--text);font-family:inherit;font-size:13px;min-height:100vh}
.sd-root *{box-sizing:border-box}
.sd-root code,.sd-mono{font-family:'JetBrains Mono',ui-monospace,monospace}

/* ── Header ── */
.sd-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
.sd-back{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;background:none;border:none;font-family:inherit;padding:4px 0}
.sd-back:hover{color:var(--text)}
.sd-title-block{display:flex;align-items:center;gap:12px;min-width:0}
.sd-avatar{width:38px;height:38px;border-radius:9px;background:linear-gradient(135deg,#0ea5e9,#6366f1);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:15px;flex:none}
.sd-title h1{font-size:19px;font-weight:800;letter-spacing:-.01em;line-height:1.2;color:var(--text);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sd-title .sd-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:4px;font-size:11.5px;color:var(--muted)}
.sd-meta code{font-size:11px;color:#2563EB;background:rgba(37,99,235,.08);padding:1px 6px;border-radius:4px}
.sd-status-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}

/* ── Chips ── */
.sd-chip{display:inline-flex;align-items:center;gap:6px;padding:2.5px 8px;border-radius:99px;font-size:10.5px;font-weight:700;letter-spacing:.02em;white-space:nowrap}
.sd-chip em{font-style:normal;font-weight:500;opacity:.75;margin-left:2px}
.sd-dot{width:6px;height:6px;border-radius:50%;flex:none}
.sd-dot.pulse{animation:sd-pulse 1.8s ease-in-out infinite}
@keyframes sd-pulse{0%,100%{opacity:1}50%{opacity:.35}}

/* ── Badges (account status, static IP health) ── */
.sd-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:99px;font-size:10px;font-weight:800;letter-spacing:.05em;border:1px solid transparent;white-space:nowrap}

/* ── Buttons ── */
.sd-btn{display:inline-flex;align-items:center;gap:5px;border-radius:6px;border:1px solid var(--border);
  background:var(--surface);color:var(--text);font-family:inherit;font-weight:600;cursor:pointer;white-space:nowrap;
  transition:background .15s,border-color .15s,color .15s,transform .1s}
.sd-btn:hover:not(:disabled){background:var(--surface-2);border-color:var(--muted)}
.sd-btn:active{transform:translateY(1px)}
.sd-btn:disabled{opacity:.45;cursor:not-allowed}
.sd-btn.sm{padding:4.5px 10px;font-size:11.5px}
.sd-btn.xs{padding:2.5px 7px;font-size:10.5px}
.sd-btn.primary{background:var(--accent);border-color:transparent;color:#fff}
.sd-btn.primary:hover{background:color-mix(in srgb,var(--accent) 85%,#000)}
.sd-btn.ghost{background:transparent}
.sd-btn.danger{background:rgba(211,64,83,.12);border-color:rgba(211,64,83,.4);color:#D34053}
.sd-btn.danger:hover{background:rgba(211,64,83,.2)}
.sd-btn.warn{background:rgba(180,83,9,.1);border-color:rgba(180,83,9,.4);color:#B45309}
.sd-btn.warn:hover{background:rgba(180,83,9,.18)}
.sd-btn.success{background:rgba(33,150,83,.1);border-color:rgba(33,150,83,.4);color:#219653}
.sd-btn.success:hover{background:rgba(33,150,83,.18)}

.sd-panel a{color:var(--accent);text-decoration:none}
/* ── Panels / KPI ── */
.sd-panel{background:var(--surface);border:1px solid var(--border);border-radius:9px;overflow:hidden}
.sd-panel-h{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:7px 16px;border-bottom:1px solid var(--border);background:var(--surface-2)}
.sd-panel-h h3{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0}
.sd-panel-h p{font-size:10.5px;color:var(--muted);margin:2px 0 0;line-height:1.5}
.sd-panel-a{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.sd-panel>.sd-panel-b{padding:11px 16px}
.sd-panel-b .sd-stack{display:flex;flex-direction:column;gap:10px}

.sd-kpi{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:9px 11px;min-width:0}
.sd-kpi-top{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.sd-kpi-top svg{width:12px;height:12px;color:var(--muted);flex:none}
.sd-kpi-label{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.sd-kpi-value{font-size:17px;font-weight:800;line-height:1.15;font-variant-numeric:tabular-nums}
.sd-kpi-sub{font-size:10px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.sd-group-label{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;font-weight:800;
  text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:14px 0 6px}
.sd-group-label:first-child{margin-top:0}

/* ── Tables ── */
.sd-table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
.sd-table{width:100%;border-collapse:collapse;font-size:11.5px;min-width:560px}
.sd-table th{background:var(--surface-2);color:var(--muted);font-size:9.5px;font-weight:800;text-transform:uppercase;
  letter-spacing:.05em;text-align:left;padding:6px 9px;border-bottom:1px solid var(--border);white-space:nowrap;position:sticky;top:0}
.sd-table td{padding:6px 9px;border-bottom:1px solid color-mix(in srgb,var(--border) 55%,transparent);vertical-align:middle}
.sd-table tbody tr:last-child td{border-bottom:none}
.sd-table tbody tr:hover{background:var(--surface-2)}
.sd-table .num{font-variant-numeric:tabular-nums;text-align:right}
.sd-table .r{text-align:right}
.sd-table .mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px}
.sd-row-click{cursor:pointer}

/* ── Empty / spinner ── */
.sd-empty{padding:26px 16px;text-align:center;color:var(--muted)}
.sd-empty-icon{font-size:22px;margin-bottom:6px;opacity:.7}
.sd-empty-title{font-size:12.5px;font-weight:700;color:var(--text)}
.sd-empty-hint{font-size:11px;margin-top:4px;line-height:1.6;max-width:420px;margin-left:auto;margin-right:auto}
.sd-spinner{display:flex;align-items:center;gap:8px;justify-content:center;padding:22px;color:var(--muted);font-size:11.5px}
.sd-spinner-ring{width:14px;height:14px;border-radius:50%;border:2px solid var(--border);border-top-color:var(--accent);animation:sd-rot .8s linear infinite}
@keyframes sd-rot{to{transform:rotate(360deg)}}

/* ── Forms ── */
.sd-field{display:block;margin-bottom:10px}
.sd-field-label{display:block;font-size:10.5px;font-weight:700;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em}
.sd-field-label b{color:var(--danger)}
.sd-field-hint{display:block;font-size:10px;color:var(--muted);margin-top:3px;line-height:1.5}
.sd-field input,.sd-field select,.sd-field textarea{background:var(--surface-2);border:1px solid var(--border);border-radius:6px;
  color:var(--text);padding:6px 9px;width:100%;font-size:12px;font-family:inherit;outline:none}
.sd-field input:focus,.sd-field select:focus,.sd-field textarea:focus{border-color:var(--accent)}

/* ── Modal / Drawer ── */
.sd-modal-back{position:fixed;inset:0;background:rgba(10,12,20,.55);z-index:4000;display:flex;align-items:center;justify-content:center;padding:18px;animation:sd-fade .14s ease}
.sd-modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.4);animation:sd-pop .16s cubic-bezier(.22,.61,.36,1)}
.sd-modal-h{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:13px 16px;border-bottom:1px solid var(--border)}
.sd-modal-h h3{font-size:14px;font-weight:800}
.sd-modal-h p{font-size:11px;color:var(--muted);margin-top:3px;line-height:1.5}
.sd-modal-b{padding:14px 16px;overflow-y:auto}
.sd-x{background:var(--surface-2);border:1px solid var(--border);border-radius:6px;width:26px;height:26px;color:var(--muted);cursor:pointer;font-size:11px;flex:none}
.sd-x:hover{color:var(--text)}
.sd-drawer-back{position:fixed;inset:0;background:rgba(10,12,20,.45);z-index:4000;display:flex;justify-content:flex-end;animation:sd-fade .14s ease}
.sd-drawer{background:var(--surface);height:100%;border-left:1px solid var(--border);display:flex;flex-direction:column;box-shadow:-18px 0 50px rgba(0,0,0,.35);animation:sd-slide .18s cubic-bezier(.22,.61,.36,1)}
.sd-drawer-h{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border)}
.sd-drawer-h h3{font-size:14px;font-weight:800}
.sd-drawer-h p{font-size:11px;color:var(--muted);margin-top:3px;line-height:1.5}
.sd-drawer-b{padding:14px 16px;overflow-y:auto;flex:1}
@keyframes sd-fade{from{opacity:0}to{opacity:1}}
@keyframes sd-pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
@keyframes sd-slide{from{transform:translateX(40px);opacity:0}to{transform:none;opacity:1}}

/* ── Def list ── */
.sd-def{display:flex;flex-direction:column}
.sd-def-row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px dashed var(--border);font-size:12px}
.sd-def-row:last-child{border-bottom:none}
.sd-def dt{color:var(--muted);flex:none;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding-top:1px}
.sd-def dd{text-align:right;font-weight:600;font-variant-numeric:tabular-nums;word-break:break-all;min-width:0}
.sd-def.wide dd{text-align:left;font-weight:500}

/* ── Refresh control ── */
.sd-refresh{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:10.5px;color:var(--muted)}
.sd-live{display:inline-flex;align-items:center;gap:4px;font-weight:700;color:#94A3B8;font-family:'JetBrains Mono',monospace}
.sd-live.on{color:#219653}
.sd-refresh-opts{display:inline-flex;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:2px}
.sd-refresh-opts button{border:none;background:transparent;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit}
.sd-refresh-opts button.on{background:var(--accent);color:#fff}
.sd-updated{color:var(--muted);font-family:'JetBrains Mono',monospace;font-size:10px}

/* ── Connection banner ── */
.sd-banner{display:flex;gap:11px;padding:10px 12px;border-radius:9px;border:1px solid;font-size:12px;line-height:1.55}
.sd-banner .ic{font-size:15px;flex:none;margin-top:1px}
.sd-banner b{font-weight:800}
.sd-alert-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}

/* ── Tabs (sticky) ── */
.sd-tabs{position:sticky;top:0;z-index:300;background:var(--bg);padding:6px 0;display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid var(--border);scrollbar-width:none}
.sd-tabs::-webkit-scrollbar{display:none}
.sd-tab{border:none;background:transparent;padding:6px 11px;border-radius:6px;font-size:11.5px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.sd-tab:hover{color:var(--text);background:var(--surface-2)}
.sd-tab.on{background:var(--accent);color:#fff}

/* ── Alert banner (static IP mismatch, duplicate login, flapping) ── */
.sd-alert{display:flex;gap:11px;padding:10px 12px;border-radius:9px;border:1px solid rgba(211,64,83,.4);background:rgba(211,64,83,.07);font-size:12px;line-height:1.55}
.sd-alert.warn{border-color:rgba(180,83,9,.4);background:rgba(180,83,9,.07)}
.sd-alert.ok{border-color:rgba(33,150,83,.4);background:rgba(33,150,83,.07)}
.sd-alert b{color:var(--text)}
.sd-alert .sd-alert-ic{font-size:15px;flex:none;margin-top:1px}

/* ── Micro status grid ── */
.sd-mini{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:7px}
.sd-mini-cell{background:var(--surface-2);border:1px solid var(--border);border-radius:7px;padding:8px 10px}
.sd-mini-cell .m-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:3px}
.sd-mini-cell .m-value{font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums}
.sd-mini-cell .m-sub{font-size:10px;color:var(--muted);margin-top:2px}

/* ── Action menu ── */
.sd-menu-wrap{position:relative}
.sd-menu{position:absolute;right:0;top:calc(100% + 6px);min-width:230px;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 18px 44px rgba(0,0,0,.28);z-index:500;padding:5px;animation:sd-pop .13s ease}
.sd-menu button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:none;padding:7px 10px;border-radius:7px;font-size:12px;color:var(--text);cursor:pointer;font-family:inherit}
.sd-menu button:hover{background:var(--surface-2)}
.sd-menu .danger{color:#D34053}
.sd-menu-sep{height:1px;background:var(--border);margin:5px 4px}
.sd-menu button:disabled{opacity:.5;cursor:not-allowed}

/* ── Usage bar (data allowance) ── */
.sd-usage-track{height:7px;border-radius:99px;background:color-mix(in srgb,var(--border) 60%,transparent);overflow:hidden}
.sd-usage-fill{height:100%;border-radius:99px;transition:width .5s cubic-bezier(.2,.8,.2,1)}

/* Responsive */
@media (max-width:900px){
  .sd-top{flex-direction:column}
  .sd-two-col{grid-template-columns:1fr !important}
}
@media (max-width:640px){
  .sd-title h1{font-size:16px}
  .sd-panel-b{padding:10px 12px}
  .sd-root{gap:10px}
  .sd-kpi-grid{grid-template-columns:repeat(2,1fr)}
  .sd-modal-back{padding:10px;align-items:flex-end}
  .sd-modal{max-height:94vh;border-radius:14px 14px 0 0}
  .sd-drawer-back{width:100%}
  .sd-drawer{width:100% !important;max-width:100%;border-left:none}
  .sd-def-row{flex-direction:column;align-items:flex-start;gap:2px}
  .sd-def dd{text-align:left;word-break:break-word}
  .sd-panel-a{width:100%}
  .sd-refresh{width:100%;justify-content:space-between}
  .sd-tabs{padding:6px 0 8px}
}
@media (max-width:400px){
  .sd-kpi-grid{grid-template-columns:1fr}
  .sd-avatar{display:none}
}
`;