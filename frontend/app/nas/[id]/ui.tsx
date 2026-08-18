"use client";

/**
 * Small shared UI primitives for the NAS detail page — consistent with the
 * panel's design tokens (--surface/--border/--text/--muted/--accent/…).
 * Compact, information-dense, dark/light compatible.
 */
import React, { useEffect } from "react";
import Portal from "../../components/portal";
import { HealthLevel } from "./lib";

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

export const LEVEL_STYLE: Record<HealthLevel, { color: string; bg: string; dot: string }> = {
  ok:      { color: "#219653", bg: "rgba(33,150,83,.10)", dot: "#219653" },
  warn:    { color: "#B45309", bg: "rgba(180,83,9,.10)",  dot: "#D97706" },
  bad:     { color: "#D34053", bg: "rgba(211,64,83,.10)", dot: "#D34053" },
  off:     { color: "#64748B", bg: "rgba(100,116,139,.10)", dot: "#94A3B8" },
  unknown: { color: "#64748B", bg: "rgba(100,116,139,.08)", dot: "#94A3B8" },
};

/** Status chip with pulsing live dot. */
export function StatusChip({ level, text, detail, dotPulse = true }: {
  level: HealthLevel; text: string; detail?: string; dotPulse?: boolean;
}) {
  const s = LEVEL_STYLE[level];
  return (
    <span className="nd-chip" title={detail} style={{ color: s.color, background: s.bg }}>
      <span className={`nd-dot${dotPulse && (level === "ok" || level === "bad") ? " pulse" : ""}`} style={{ background: s.dot }} />
      {text}
      {detail ? <em>{detail}</em> : null}
    </span>
  );
}

export function Btn({ children, onClick, variant = "default", size = "sm", disabled, title, style }: {
  children: React.ReactNode; onClick?: (e: React.MouseEvent) => void;
  variant?: "default" | "primary" | "ghost" | "danger" | "warn";
  size?: "xs" | "sm"; disabled?: boolean; title?: string; style?: React.CSSProperties;
}) {
  return (
    <button
      className={`nd-btn ${variant} ${size}`}
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
    <section className={`nd-panel${className ? " " + className : ""}`} style={style}>
      {(title || actions) && (
        <header className="nd-panel-h">
          <div>
            {title && <h3>{title}</h3>}
            {sub && <p>{sub}</p>}
          </div>
          {actions && <div className="nd-panel-a">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** KPI-style value block (compact, no giant cards). */
export function Kpi({ label, value, sub, color, icon, title }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; color?: string; icon?: React.ReactNode; title?: string;
}) {
  return (
    <div className="nd-kpi" title={title}>
      <div className="nd-kpi-top">
        {icon}
        <span className="nd-kpi-label">{label}</span>
      </div>
      <div className="nd-kpi-value" style={{ color: color ?? "var(--text)" }}>{value}</div>
      {sub != null && <div className="nd-kpi-sub">{sub}</div>}
    </div>
  );
}

/** Horizontal rule group label. */
export function GroupLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="nd-group-label">
      <span>{children}</span>
      {right}
    </div>
  );
}

export function EmptyState({ icon = "—", title, hint }: { icon?: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="nd-empty">
      <div className="nd-empty-icon">{icon}</div>
      <div className="nd-empty-title">{title}</div>
      {hint && <div className="nd-empty-hint">{hint}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="nd-spinner">
      <span className="nd-spinner-ring" />
      {label && <span>{label}</span>}
    </div>
  );
}

export function Field({ label, hint, children, required }: {
  label: string; hint?: string; children: React.ReactNode; required?: boolean;
}) {
  return (
    <label className="nd-field">
      <span className="nd-field-label">{label}{required && <b>*</b>}</span>
      {children}
      {hint && <span className="nd-field-hint">{hint}</span>}
    </label>
  );
}

export const inputStyle: React.CSSProperties = {
  background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 6,
  color: "var(--text)", padding: "6px 9px", width: "100%", fontSize: 12,
  fontFamily: "inherit", outline: "none",
};

/** Generic modal shell (used by edit dialog, test center, alert rules). */
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
      <div className="nd-modal-back" onClick={onClose}>
        <div className="nd-modal" style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()}>
          <header className="nd-modal-h">
            <div>
              <h3>{title}</h3>
              {sub && <p>{sub}</p>}
            </div>
            <button className="nd-x" onClick={onClose} aria-label="Close">✕</button>
          </header>
          <div className="nd-modal-b">{children}</div>
        </div>
      </div>
    </Portal>
  );
}

/** Right-side drawer (session details, syslog event details). */
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
      <div className="nd-drawer-back" onClick={onClose}>
        <aside className="nd-drawer" style={{ width }} onClick={(e) => e.stopPropagation()}>
          <header className="nd-drawer-h">
            <div>
              <h3>{title}</h3>
              {sub && <p>{sub}</p>}
            </div>
            <button className="nd-x" onClick={onClose} aria-label="Close">✕</button>
          </header>
          <div className="nd-drawer-b">{children}</div>
        </aside>
      </div>
    </Portal>
  );
}

/** Key/value definition rows (drawers, config sections). */
export function DefList({ rows, wide }: { rows: Array<[string, React.ReactNode]>; wide?: boolean }) {
  return (
    <dl className={`nd-def${wide ? " wide" : ""}`}>
      {rows.map(([k, v]) => (
        <div key={k} className="nd-def-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Severity → label/color (for syslog events, device logs). */
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
    <div className="nd-refresh">
      <span className={`nd-live${liveConnected ? " on" : ""}`} title={liveConnected ? "Live stream connected" : "Live stream lost — retrying…"}>
        {liveConnected ? "●" : "○"} Live
      </span>
      <div className="nd-refresh-opts" role="tablist" aria-label="Auto refresh">
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
        <span className="nd-updated" title="Last successful data refresh">
          Updated {lastUpdate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      )}
    </div>
  );
}

/** Detail page root CSS — the page-level stylesheet (single <style> per page). */
export function NasDetailStyles() {
  return <style>{CSS}</style>;
}

const CSS = `
.nd-root{display:flex;flex-direction:column;gap:12px;color:var(--text);font-family:inherit;font-size:13px}
.nd-root *{box-sizing:border-box}
.nd-root code,.nd-mono{font-family:'JetBrains Mono',ui-monospace,monospace}

/* ── Header ── */
.nd-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
.nd-back{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;background:none;border:none;font-family:inherit;padding:4px 0}
.nd-back:hover{color:var(--text)}
.nd-title-block{display:flex;align-items:center;gap:12px;min-width:0}
.nd-title-ic{width:38px;height:38px;border-radius:9px;background:var(--g-primary,linear-gradient(135deg,#6C3CE1,#E9408B,#F27121));display:flex;align-items:center;justify-content:center;color:#fff;flex:none}
.nd-title-ic svg{width:18px;height:18px}
.nd-title h1{font-size:19px;font-weight:800;letter-spacing:-.01em;line-height:1.2;color:var(--text)}
.nd-title .nd-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:4px;font-size:11.5px;color:var(--muted)}
.nd-meta code{font-size:11px;color:#2563EB;background:rgba(37,99,235,.08);padding:1px 6px;border-radius:4px}
.nd-status-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}

/* ── Chips ── */
.nd-chip{display:inline-flex;align-items:center;gap:6px;padding:2.5px 8px;border-radius:99px;font-size:10.5px;font-weight:700;letter-spacing:.02em;white-space:nowrap}
.nd-chip em{font-style:normal;font-weight:500;opacity:.75;margin-left:2px}
.nd-dot{width:6px;height:6px;border-radius:50%;flex:none}
.nd-dot.pulse{animation:nd-pulse 1.8s ease-in-out infinite}
@keyframes nd-pulse{0%,100%{opacity:1}50%{opacity:.35}}

/* ── Buttons ── */
.nd-btn{display:inline-flex;align-items:center;gap:5px;border-radius:6px;border:1px solid var(--border);
  background:var(--surface);color:var(--text);font-family:inherit;font-weight:600;cursor:pointer;white-space:nowrap;
  transition:background .15s,border-color .15s,color .15s,transform .1s}
.nd-btn:hover:not(:disabled){background:var(--surface-2);border-color:var(--muted)}
.nd-btn:active{transform:translateY(1px)}
.nd-btn:disabled{opacity:.45;cursor:not-allowed}
.nd-btn.sm{padding:4.5px 10px;font-size:11.5px}
.nd-btn.xs{padding:2.5px 7px;font-size:10.5px}
.nd-btn.primary{background:var(--accent);border-color:transparent;color:#fff}
.nd-btn.primary:hover{background:color-mix(in srgb,var(--accent) 85%,#000)}
.nd-btn.ghost{background:transparent}
.nd-btn.danger{background:rgba(211,64,83,.12);border-color:rgba(211,64,83,.4);color:#D34053}
.nd-btn.danger:hover{background:rgba(211,64,83,.2)}
.nd-btn.warn{background:rgba(180,83,9,.1);border-color:rgba(180,83,9,.4);color:#B45309}
.nd-btn.warn:hover{background:rgba(180,83,9,.18)}

/* ── Panels / KPI ── */
.nd-panel{background:var(--surface);border:1px solid var(--border);border-radius:9px;overflow:hidden}
.nd-panel-h{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--surface-2)}
.nd-panel-h h3{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.nd-panel-h p{font-size:10.5px;color:var(--muted);margin-top:2px;line-height:1.5}
.nd-panel-a{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.nd-panel>.nd-panel-b{padding:12px}

.nd-kpi{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:9px 11px;min-width:0}
.nd-kpi-top{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.nd-kpi-top svg{width:12px;height:12px;color:var(--muted);flex:none}
.nd-kpi-label{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.nd-kpi-value{font-size:17px;font-weight:800;line-height:1.15;font-variant-numeric:tabular-nums}
.nd-kpi-sub{font-size:10px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.nd-group-label{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;font-weight:800;
  text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:14px 0 6px}
.nd-group-label:first-child{margin-top:0}

/* ── Tables ── */
.nd-table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
.nd-table{width:100%;border-collapse:collapse;font-size:11.5px;min-width:560px}
.nd-table th{background:var(--surface-2);color:var(--muted);font-size:9.5px;font-weight:800;text-transform:uppercase;
  letter-spacing:.05em;text-align:left;padding:6px 9px;border-bottom:1px solid var(--border);white-space:nowrap;position:sticky;top:0}
.nd-table td{padding:6px 9px;border-bottom:1px solid color-mix(in srgb,var(--border) 55%,transparent);vertical-align:middle}
.nd-table tbody tr:last-child td{border-bottom:none}
.nd-table tbody tr:hover{background:var(--surface-2)}
.nd-table .num{font-variant-numeric:tabular-nums;text-align:right}
.nd-table .r{text-align:right}
.nd-table .mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px}
.nd-row-click{cursor:pointer}

/* ── Empty / spinner ── */
.nd-empty{padding:26px 16px;text-align:center;color:var(--muted)}
.nd-empty-icon{font-size:22px;margin-bottom:6px;opacity:.7}
.nd-empty-title{font-size:12.5px;font-weight:700;color:var(--text)}
.nd-empty-hint{font-size:11px;margin-top:4px;line-height:1.6;max-width:420px;margin-left:auto;margin-right:auto}
.nd-spinner{display:flex;align-items:center;gap:8px;justify-content:center;padding:22px;color:var(--muted);font-size:11.5px}
.nd-spinner-ring{width:14px;height:14px;border-radius:50%;border:2px solid var(--border);border-top-color:var(--accent);animation:nd-rot .8s linear infinite}
@keyframes nd-rot{to{transform:rotate(360deg)}}

/* ── Forms ── */
.nd-field{display:block;margin-bottom:10px}
.nd-field-label{display:block;font-size:10.5px;font-weight:700;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em}
.nd-field-label b{color:var(--danger)}
.nd-field-hint{display:block;font-size:10px;color:var(--muted);margin-top:3px;line-height:1.5}
.nd-field input,.nd-field select,.nd-field textarea{background:var(--surface-2);border:1px solid var(--border);border-radius:6px;
  color:var(--text);padding:6px 9px;width:100%;font-size:12px;font-family:inherit;outline:none}
.nd-field input:focus,.nd-field select:focus,.nd-field textarea:focus{border-color:var(--accent)}

/* ── Modal / Drawer ── */
.nd-modal-back{position:fixed;inset:0;background:rgba(10,12,20,.55);z-index:4000;display:flex;align-items:center;justify-content:center;padding:18px;animation:nd-fade .14s ease}
.nd-modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.4);animation:nd-pop .16s cubic-bezier(.22,.61,.36,1)}
.nd-modal-h{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:13px 16px;border-bottom:1px solid var(--border)}
.nd-modal-h h3{font-size:14px;font-weight:800}
.nd-modal-h p{font-size:11px;color:var(--muted);margin-top:3px;line-height:1.5}
.nd-modal-b{padding:14px 16px;overflow-y:auto}
.nd-x{background:var(--surface-2);border:1px solid var(--border);border-radius:6px;width:26px;height:26px;color:var(--muted);cursor:pointer;font-size:11px;flex:none}
.nd-x:hover{color:var(--text)}
.nd-drawer-back{position:fixed;inset:0;background:rgba(10,12,20,.45);z-index:4000;display:flex;justify-content:flex-end;animation:nd-fade .14s ease}
.nd-drawer{background:var(--surface);height:100%;border-left:1px solid var(--border);display:flex;flex-direction:column;box-shadow:-18px 0 50px rgba(0,0,0,.35);animation:nd-slide .18s cubic-bezier(.22,.61,.36,1)}
.nd-drawer-h{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border)}
.nd-drawer-h h3{font-size:14px;font-weight:800}
.nd-drawer-h p{font-size:11px;color:var(--muted);margin-top:3px;line-height:1.5}
.nd-drawer-b{padding:14px 16px;overflow-y:auto;flex:1}
@keyframes nd-fade{from{opacity:0}to{opacity:1}}
@keyframes nd-pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
@keyframes nd-slide{from{transform:translateX(40px);opacity:0}to{transform:none;opacity:1}}

/* ── Def list ── */
.nd-def{display:flex;flex-direction:column}
.nd-def-row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px dashed var(--border);font-size:12px}
.nd-def-row:last-child{border-bottom:none}
.nd-def dt{color:var(--muted);flex:none;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding-top:1px}
.nd-def dd{text-align:right;font-weight:600;font-variant-numeric:tabular-nums;word-break:break-all;min-width:0}
.nd-def.wide dd{text-align:left;font-weight:500}

/* ── Refresh control ── */
.nd-refresh{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:10.5px;color:var(--muted)}
.nd-live{display:inline-flex;align-items:center;gap:4px;font-weight:700;color:#94A3B8;font-family:'JetBrains Mono',monospace}
.nd-live.on{color:#219653}
.nd-refresh-opts{display:inline-flex;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:2px}
.nd-refresh-opts button{border:none;background:transparent;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit}
.nd-refresh-opts button.on{background:var(--accent);color:#fff}
.nd-updated{color:var(--muted);font-family:'JetBrains Mono',monospace;font-size:10px}

/* ── Health summary bar ── */
.nd-healthbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:7px 11px}
.nd-healthbar .sep{width:1px;height:20px;background:var(--border);margin:0 4px;flex:none}

/* ── Alert banner ── */
.nd-alert{display:flex;gap:11px;padding:10px 12px;border-radius:9px;border:1px solid rgba(180,83,9,.4);background:rgba(180,83,9,.07);font-size:12px;line-height:1.55}
.nd-alert .nd-alert-ic{font-size:15px;flex:none;margin-top:1px}
.nd-alert b{color:#92400E}
.nd-alert .nd-alert-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}

/* ── Tabs (sticky) ── */
.nd-tabs{position:sticky;top:0;z-index:300;background:var(--bg);padding:6px 0;display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid var(--border);scrollbar-width:none}
.nd-tabs::-webkit-scrollbar{display:none}
.nd-tab{border:none;background:transparent;padding:6px 11px;border-radius:6px;font-size:11.5px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.nd-tab:hover{color:var(--text);background:var(--surface-2)}
.nd-tab.on{background:var(--accent);color:#fff}

/* ── Test center ── */
.nd-tests{display:flex;flex-direction:column;gap:6px}
.nd-test-row{display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid var(--border);border-radius:7px;background:var(--surface-2)}
.nd-test-row .t-label{font-size:12px;font-weight:700;width:70px;flex:none}
.nd-test-row .t-status{font-size:11px;font-weight:600;flex:none}
.nd-test-row .t-msg{font-size:11px;color:var(--muted);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nd-test-row .t-ms{font-family:'JetBrains Mono',monospace;font-size:10.5px;color:var(--muted);flex:none}

/* ── Micro status grid (overview) ── */
.nd-mini{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:7px}
.nd-mini-cell{background:var(--surface-2);border:1px solid var(--border);border-radius:7px;padding:8px 10px}
.nd-mini-cell .m-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:3px}
.nd-mini-cell .m-value{font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums}
.nd-mini-cell .m-sub{font-size:10px;color:var(--muted);margin-top:2px}

/* ── Action menu (header "…") ── */
.nd-menu-wrap{position:relative}
.nd-menu{position:absolute;right:0;top:calc(100% + 6px);min-width:230px;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 18px 44px rgba(0,0,0,.28);z-index:500;padding:5px;animation:nd-pop .13s ease}
.nd-menu button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:none;padding:7px 10px;border-radius:7px;font-size:12px;color:var(--text);cursor:pointer;font-family:inherit}
.nd-menu button:hover{background:var(--surface-2)}
.nd-menu .danger{color:#D34053}

/* ── Syslog severity dot usage ── */
.nd-sym{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none}

/* Responsive */
@media (max-width:900px){
  .nd-top{flex-direction:column}
}
@media (max-width:640px){
  .nd-title h1{font-size:16px}
  .nd-healthbar .sep{display:none}
}
`;
