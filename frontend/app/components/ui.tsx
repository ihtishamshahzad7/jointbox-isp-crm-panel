"use client";

import React, { useEffect, useRef, useState } from "react";

/**
 * NOVA UI KIT
 *
 * WHY THIS EXISTS
 * Every page in this panel built its own cards, buttons, tables and modals out
 * of inline styles. Thirty pages meant thirty slightly different definitions of
 * "a card", and the only way to restyle them all was a layer of CSS attribute
 * selectors matching rendered style strings — a patch, not a system.
 *
 * These primitives are the system. A page composes them and inherits the Nova
 * language for free: glass surfaces, gradient actions, 8px spacing rhythm,
 * consistent hover and focus behaviour, and sane empty states.
 *
 * DESIGN RULES ENCODED HERE
 *  • Gradients belong to CHROME and ACTIONS, never to data. On monitoring
 *    screens green/amber/red must keep meaning up/degraded/down.
 *  • Every surface is glass in dark mode and flat in light mode — blur over
 *    white reads as fog.
 *  • Spacing is an 8px grid. The `pad` props take multiples, not pixels.
 *  • Nothing renders an empty box: lists and tables always have an empty state.
 */

/* ═══════════════════════════ tokens ═══════════════════════════ */
export const NV = {
  primary: "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)",
  secondary: "linear-gradient(135deg,#00C9FF,#92FE9D)",
  accent: "linear-gradient(135deg,#F7971E,#FFD200)",
  danger: "linear-gradient(135deg,#F43F5E,#E9408B)",
  glowPrimary: "rgba(233,64,139,.30)",
  glowSecondary: "rgba(0,201,255,.26)",
  // Semantic — these are DATA colours and must not be gradients.
  ok: "#10B981",
  warn: "#F59E0B",
  bad: "#EF4444",
  info: "#3B82F6",
  muted: "var(--muted)",
  text: "var(--text)",
  surface: "var(--surface)",
  surface2: "var(--surface-2)",
  border: "var(--border)",
};

const s = (n: number) => n * 8; // 8px grid

/* ═══════════════════════════ page ═══════════════════════════ */

/** Page wrapper. Never use `.db-root` on a page — that is the shell's own
 *  flex container and it lays every section out side by side. */
export function Page({ children }: { children: React.ReactNode }) {
  return <div className="nv-page">{children}</div>;
}

export function PageHead({
  title, subtitle, actions,
}: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="nv-pagehead">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="nv-pagehead-actions">{actions}</div>}
    </div>
  );
}

/* ═══════════════════════════ card ═══════════════════════════ */
export function Card({
  title, subtitle, actions, children, pad = 2.5, className = "", hover = true,
}: {
  title?: string; subtitle?: string; actions?: React.ReactNode;
  children: React.ReactNode; pad?: number; className?: string; hover?: boolean;
}) {
  return (
    <section className={`nv-card ${hover ? "hoverable" : ""} ${className}`}>
      {(title || actions) && (
        <header className="nv-card-h">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="nv-card-actions">{actions}</div>}
        </header>
      )}
      <div style={{ padding: title ? `${s(pad)}px` : `${s(pad)}px` }}>{children}</div>
    </section>
  );
}

/** Cells joined into one bordered strip — reads as a single instrument
 *  rather than four floating tiles. */
export function StatStrip({ children }: { children: React.ReactNode }) {
  return <div className="nv-strip">{children}</div>;
}

export function Stat({
  label, value, sub, icon, gradient = NV.primary, glow = NV.glowPrimary, progress, tone,
}: {
  label: string; value: React.ReactNode; sub?: string; icon?: React.ReactNode;
  gradient?: string; glow?: string; progress?: number;
  tone?: "ok" | "warn" | "bad";
}) {
  const colour = tone === "ok" ? NV.ok : tone === "warn" ? NV.warn : tone === "bad" ? NV.bad : "var(--text)";
  return (
    <div className="nv-stat">
      {icon && (
        <div className="nv-stat-ico" style={{ background: gradient, boxShadow: `0 ${s(1)}px ${s(2.75)}px ${glow}` }}>
          {icon}
        </div>
      )}
      <div>
        <div className="nv-stat-v" style={{ color: colour }}>{value}</div>
        <div className="nv-stat-k">{label}</div>
      </div>
      {sub && <div className="nv-stat-s">{sub}</div>}
      {progress !== undefined && (
        <div className="nv-stat-track">
          <div style={{ width: `${Math.max(2, Math.min(100, progress))}%`, background: gradient }} />
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════ button ═══════════════════════════ */
export function Button({
  children, variant = "ghost", size = "md", onClick, disabled, type = "button", title, full,
}: {
  children: React.ReactNode;
  variant?: "primary" | "success" | "danger" | "ghost" | "quiet";
  size?: "sm" | "md";
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean; type?: "button" | "submit"; title?: string; full?: boolean;
}) {
  return (
    <button
      type={type} title={title} disabled={disabled} onClick={onClick}
      className={`nv-btn ${variant} ${size} ${full ? "full" : ""}`}
    >
      {children}
    </button>
  );
}

/* ═══════════════════════════ badge ═══════════════════════════ */
export function Badge({
  children, tone = "neutral", dot,
}: { children: React.ReactNode; tone?: "ok" | "warn" | "bad" | "info" | "neutral"; dot?: boolean }) {
  const c = tone === "ok" ? NV.ok : tone === "warn" ? NV.warn
    : tone === "bad" ? NV.bad : tone === "info" ? NV.info : "var(--muted)";
  return (
    <span className="nv-badge" style={{ color: c, background: `${c}1a` }}>
      {dot && <i style={{ background: c }} />}
      {children}
    </span>
  );
}

/* ═══════════════════════════ inputs ═══════════════════════════ */
export function Field({
  label, hint, children,
}: { label?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="nv-field">
      {label && <span className="nv-field-l">{label}</span>}
      {children}
      {hint && <span className="nv-field-h">{hint}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`nv-input ${props.className ?? ""}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`nv-input nv-select ${props.className ?? ""}`} />;
}

/** Segmented control — the standard way to switch a view in this panel. */
export function Segmented({
  options, value, onChange,
}: {
  options: Array<{ id: string; label: string; title?: string }>;
  value: string; onChange: (id: string) => void;
}) {
  return (
    <div className="nv-seg" role="tablist">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} title={o.title}
          className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Toggle with a gradient track when on. */
export function Toggle({ on, onChange, label, hint }: {
  on: boolean; onChange: (v: boolean) => void; label?: string; hint?: string;
}) {
  return (
    <div className="nv-toggle-row">
      {label && <div><span>{label}</span>{hint && <small>{hint}</small>}</div>}
      <button className={`nv-toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)}
        role="switch" aria-checked={on} aria-label={label}>
        <i />
      </button>
    </div>
  );
}

/* ═══════════════════════════ table ═══════════════════════════ */
export type Col<T> = {
  key: string;
  header: string;
  align?: "left" | "right";
  width?: number;
  render: (row: T) => React.ReactNode;
};

export function Table<T>({
  cols, rows, onRowClick, empty, emptyHint, loading, minWidth = 640,
}: {
  cols: Col<T>[]; rows: T[]; onRowClick?: (row: T) => void;
  empty?: string; emptyHint?: string; loading?: boolean; minWidth?: number;
}) {
  if (loading) {
    return (
      <div className="nv-skel-wrap">
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className="nv-skel" />)}
      </div>
    );
  }
  if (!rows.length) {
    return <Empty title={empty ?? "Nothing here yet"} hint={emptyHint} />;
  }
  return (
    <div className="nv-tablewrap">
      <table className="nv-table" style={{ minWidth }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} className={c.align === "right" ? "r" : ""}
                style={c.width ? { width: c.width } : undefined}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={onRowClick ? "clickable" : ""}>
              {cols.map((c) => (
                <td key={c.key} className={c.align === "right" ? "r" : ""}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Two-line cell — the panel's most common table pattern. */
export function Cell({ top, bottom }: { top: React.ReactNode; bottom?: React.ReactNode }) {
  return (
    <div className="nv-cell">
      <b>{top}</b>
      {bottom && <em>{bottom}</em>}
    </div>
  );
}

/* ═══════════════════════════ empty / feedback ═══════════════════════════ */
export function Empty({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="nv-empty">
      <div className="nv-empty-ico">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </div>
      <div className="nv-empty-t">{title}</div>
      {hint && <div className="nv-empty-h">{hint}</div>}
      {action && <div style={{ marginTop: s(1.5) }}>{action}</div>}
    </div>
  );
}

/** Callout for a fault or notice. Uses a left rule rather than a filled block —
 *  a solid red panel on a screen you watch all day becomes wallpaper. */
export function Callout({
  tone = "info", title, children, action,
}: {
  tone?: "ok" | "warn" | "bad" | "info";
  title: string; children?: React.ReactNode; action?: React.ReactNode;
}) {
  const c = tone === "ok" ? NV.ok : tone === "warn" ? NV.warn : tone === "bad" ? NV.bad : NV.info;
  return (
    <div className="nv-callout" style={{ borderLeftColor: c }}>
      <div className="nv-callout-h">
        <span className={`nv-dot ${tone === "bad" ? "pulse" : ""}`} style={{ background: c }} />
        <b style={{ color: c }}>{title}</b>
        {action && <div style={{ marginLeft: "auto" }}>{action}</div>}
      </div>
      {children && <div className="nv-callout-b">{children}</div>}
    </div>
  );
}

/* ═══════════════════════════ modal / drawer ═══════════════════════════ */
export function Modal({
  open, onClose, title, subtitle, children, footer, width = 620,
}: {
  open: boolean; onClose: () => void; title: string; subtitle?: string;
  children: React.ReactNode; footer?: React.ReactNode; width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="nv-scrim" onClick={onClose}>
      <div className="nv-modal" style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="nv-modal-b">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Drawer({
  open, onClose, title, eyebrow, subtitle, children, width = 780,
}: {
  open: boolean; onClose: () => void; title: string; eyebrow?: string;
  subtitle?: string; children: React.ReactNode; width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="nv-scrim right" onClick={onClose}>
      <aside className="nv-drawer" style={{ width: `min(${width}px,100%)` }} onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            {eyebrow && <span className="nv-eyebrow">{eyebrow}</span>}
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="nv-drawer-b">{children}</div>
      </aside>
    </div>
  );
}

/* ═══════════════════════════ toast ═══════════════════════════ */
export function useToast() {
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "bad" | "warn" } | null>(null);
  const timer = useRef<any>(null);
  const show = (msg: string, tone: "ok" | "bad" | "warn" = "ok") => {
    setToast({ msg, tone });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 4000);
  };
  const node = toast ? (
    <div className={`nv-toast ${toast.tone}`} role="status">{toast.msg}</div>
  ) : null;
  return { show, node };
}

/* ═══════════════════════════ misc ═══════════════════════════ */

/** Track + fill, used for quotas, availability and progress. */
export function Meter({ value, max = 100, tone, gradient }: {
  value: number; max?: number; tone?: "ok" | "warn" | "bad"; gradient?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const bg = gradient ?? (tone === "bad" ? NV.bad : tone === "warn" ? NV.warn : tone === "ok" ? NV.ok : NV.primary);
  return (
    <div className="nv-meter"><div style={{ width: `${pct}%`, background: bg }} /></div>
  );
}

export function Avatar({ name, size = 34, online }: { name?: string; size?: number; online?: boolean }) {
  const initials = (name || "?").split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  return (
    <span className="nv-avatar" style={{ width: size, height: size }}>
      <span className="face" style={{ fontSize: size * 0.36 }}>{initials}</span>
      {online !== undefined && <i className="dot" style={{ background: online ? NV.ok : "var(--muted)" }} />}
    </span>
  );
}

/** Injected once by the shell. Kept here so the kit ships its own styling. */
export function NovaStyles() {
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />;
}

const CSS = `
.nv-page{padding:4px 2px 32px;color:var(--text);font-variant-numeric:tabular-nums}
.nv-pagehead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;
  flex-wrap:wrap;margin-bottom:24px}
.nv-pagehead h1{font-size:22px;font-weight:700;letter-spacing:-.02em;margin:0}
.nv-pagehead p{font-size:12.5px;color:var(--muted);margin:4px 0 0}
.nv-pagehead-actions{display:flex;gap:8px;flex-wrap:wrap}

/* card */
.nv-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;
  overflow:hidden;margin-bottom:16px}
html:not([data-theme="light"]) .nv-card{background:rgba(255,255,255,.04);backdrop-filter:blur(18px)}
.nv-card.hoverable{transition:border-color .25s,box-shadow .25s,transform .25s cubic-bezier(.2,.8,.2,1)}
.nv-card.hoverable:hover{border-color:rgba(140,90,255,.32);
  box-shadow:0 16px 40px rgba(0,0,0,.32),0 0 28px rgba(140,90,255,.10)}
.nv-card-h{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;
  padding:16px 20px 14px;border-bottom:1px solid var(--border)}
.nv-card-h h3{margin:0;font-size:13.5px;font-weight:600}
.nv-card-h p{margin:4px 0 0;font-size:11.5px;color:var(--muted);line-height:1.55;max-width:620px}
.nv-card-actions{display:flex;gap:8px;flex-shrink:0}

/* stat strip */
.nv-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));
  background:var(--surface);border:1px solid var(--border);border-radius:16px;
  overflow:hidden;margin-bottom:16px}
html:not([data-theme="light"]) .nv-strip{background:rgba(255,255,255,.04);backdrop-filter:blur(18px)}
.nv-stat{padding:16px 20px;position:relative;display:flex;flex-direction:column;gap:12px;
  transition:background .18s}
.nv-stat+.nv-stat{border-left:1px solid var(--border)}
.nv-stat:hover{background:var(--surface-2)}
.nv-stat::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;
  background:linear-gradient(90deg,#6C3CE1,#E9408B);transform:scaleX(0);transform-origin:left;
  transition:transform .25s ease}
.nv-stat:hover::after{transform:scaleX(1)}
.nv-stat-ico{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;color:#fff}
.nv-stat-v{font-size:27px;font-weight:800;letter-spacing:-.03em;line-height:1.1}
.nv-stat-k{font-size:11.5px;color:var(--muted);margin-top:4px}
.nv-stat-s{font-size:11px;color:var(--muted)}
.nv-stat-track{height:4px;border-radius:99px;background:rgba(255,255,255,.07);overflow:hidden}
.nv-stat-track div{height:100%;border-radius:99px;transition:width .6s cubic-bezier(.2,.8,.2,1)}

/* button */
.nv-btn{border:1px solid transparent;border-radius:12px;font-family:inherit;font-weight:600;
  cursor:pointer;position:relative;overflow:hidden;white-space:nowrap;
  transition:transform .18s cubic-bezier(.34,1.56,.64,1),box-shadow .18s,background .18s,border-color .18s,color .18s}
.nv-btn.md{padding:9px 18px;font-size:12.5px}
.nv-btn.sm{padding:6px 13px;font-size:11.5px}
.nv-btn.full{width:100%}
.nv-btn:disabled{opacity:.5;cursor:not-allowed;transform:none!important}
.nv-btn:active:not(:disabled){transform:scale(.97)}
.nv-btn.primary{background:linear-gradient(135deg,#6C3CE1,#E9408B,#F27121);color:#fff;
  box-shadow:0 5px 18px rgba(233,64,139,.28)}
.nv-btn.primary:hover:not(:disabled){transform:scale(1.04);box-shadow:0 9px 26px rgba(233,64,139,.42)}
.nv-btn.success{background:linear-gradient(135deg,#00C9FF,#92FE9D);color:#06281c;
  box-shadow:0 5px 18px rgba(0,201,255,.24)}
.nv-btn.success:hover:not(:disabled){transform:scale(1.04)}
.nv-btn.danger{background:linear-gradient(135deg,#F43F5E,#E9408B);color:#fff;
  box-shadow:0 5px 18px rgba(244,63,94,.28)}
.nv-btn.danger:hover:not(:disabled){transform:scale(1.04)}
.nv-btn.ghost{background:var(--surface);border-color:var(--border);color:var(--text)}
.nv-btn.ghost:hover:not(:disabled){border-color:rgba(140,90,255,.5);background:var(--surface-2)}
.nv-btn.quiet{background:transparent;color:var(--muted)}
.nv-btn.quiet:hover:not(:disabled){color:var(--text);background:var(--surface-2)}

/* badge */
.nv-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:99px;
  font-size:10.5px;font-weight:700;white-space:nowrap}
.nv-badge i{width:6px;height:6px;border-radius:99px;display:inline-block}

/* fields */
.nv-field{display:block;margin-bottom:12px}
.nv-field-l{display:block;font-size:10.5px;font-weight:600;color:var(--muted);
  text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.nv-field-h{display:block;font-size:11px;color:var(--muted);margin-top:5px;line-height:1.5}
.nv-input{width:100%;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;
  padding:9px 12px;color:var(--text);font-size:13px;font-family:inherit;outline:none;
  transition:border-color .18s,box-shadow .18s}
.nv-input:focus{border-color:rgba(140,90,255,.55);box-shadow:0 0 0 3px rgba(140,90,255,.14)}
.nv-input::placeholder{color:var(--muted)}
.nv-select{cursor:pointer}

/* segmented */
.nv-seg{display:inline-flex;gap:2px;padding:3px;border-radius:12px;background:var(--surface-2);
  border:1px solid var(--border)}
.nv-seg button{border:none;background:transparent;color:var(--muted);cursor:pointer;
  padding:7px 15px;border-radius:9px;font-size:12.5px;font-weight:500;font-family:inherit;
  transition:color .15s,background .15s,transform .12s}
.nv-seg button:hover{color:var(--text)}
.nv-seg button:active{transform:scale(.96)}
.nv-seg button.on{background:var(--surface);color:var(--text);font-weight:600;
  box-shadow:0 1px 3px rgba(0,0,0,.28)}

/* toggle */
.nv-toggle-row{display:flex;justify-content:space-between;align-items:center;gap:16px;
  padding:10px 0;font-size:13px}
.nv-toggle-row small{display:block;color:var(--muted);font-size:11px;margin-top:2px}
.nv-toggle{width:44px;height:25px;border-radius:99px;background:rgba(255,255,255,.1);
  border:1px solid var(--border);cursor:pointer;position:relative;flex-shrink:0;padding:0;
  transition:background .3s,border-color .3s}
.nv-toggle i{position:absolute;top:2px;left:2px;width:19px;height:19px;border-radius:99px;
  background:#fff;transition:transform .3s cubic-bezier(.34,1.56,.64,1);box-shadow:0 2px 6px rgba(0,0,0,.35)}
.nv-toggle.on{background:linear-gradient(135deg,#6C3CE1,#E9408B);border-color:transparent}
.nv-toggle.on i{transform:translateX(19px)}

/* table */
.nv-tablewrap{overflow-x:auto}
.nv-table{width:100%;border-collapse:collapse}
.nv-table th{text-align:left;padding:11px 16px;font-size:10px;font-weight:600;color:var(--muted);
  text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid var(--border);
  white-space:nowrap;position:sticky;top:0;background:var(--surface);z-index:1}
.nv-table td{padding:13px 16px;font-size:13px;border-bottom:1px solid var(--border);vertical-align:middle}
.nv-table th.r,.nv-table td.r{text-align:right}
.nv-table tbody tr:last-child td{border-bottom:none}
.nv-table tbody tr.clickable{cursor:pointer;transition:background .13s}
.nv-table tbody tr.clickable:hover{background:var(--surface-2)}
.nv-cell b{font-weight:500;display:block}
.nv-cell em{font-style:normal;display:block;font-size:11px;color:var(--muted);margin-top:1px}

/* skeleton */
.nv-skel-wrap{padding:16px;display:grid;gap:10px}
.nv-skel{height:44px;border-radius:10px;
  background:linear-gradient(90deg,var(--surface-2) 25%,rgba(255,255,255,.06) 37%,var(--surface-2) 63%);
  background-size:400% 100%;animation:nvShim 1.3s ease infinite}
@keyframes nvShim{0%{background-position:100% 50%}100%{background-position:0 50%}}

/* empty */
.nv-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:8px;text-align:center;padding:40px 24px}
.nv-empty-ico{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;
  background:linear-gradient(135deg,rgba(108,60,225,.22),rgba(233,64,139,.22))}
.nv-empty-t{font-size:13.5px;font-weight:600}
.nv-empty-h{font-size:11.5px;color:var(--muted);max-width:340px;line-height:1.6}

/* callout */
.nv-callout{background:var(--surface);border:1px solid var(--border);border-left-width:3px;
  border-radius:14px;padding:14px 18px;margin-bottom:16px}
html:not([data-theme="light"]) .nv-callout{background:rgba(255,255,255,.04);backdrop-filter:blur(18px)}
.nv-callout-h{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:600}
.nv-callout-b{font-size:12.5px;color:var(--muted);line-height:1.65;margin-top:8px}
.nv-dot{width:7px;height:7px;border-radius:99px;flex-shrink:0}
.nv-dot.pulse{animation:nvPulse 1.8s infinite}
@keyframes nvPulse{0%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}
  70%{box-shadow:0 0 0 7px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}

/* modal + drawer */
.nv-scrim{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;
  padding:20px;background:rgba(2,6,23,.62);backdrop-filter:blur(4px);animation:nvFade .18s ease}
.nv-scrim.right{align-items:stretch;justify-content:flex-end;padding:0}
@keyframes nvFade{from{opacity:0}to{opacity:1}}
.nv-modal{width:100%;background:var(--surface);border:1px solid var(--border);border-radius:20px;
  display:flex;flex-direction:column;max-height:90vh;overflow:hidden;
  box-shadow:0 30px 80px rgba(0,0,0,.5);animation:nvPop .24s cubic-bezier(.2,.8,.2,1)}
@keyframes nvPop{from{transform:scale(.96) translateY(10px);opacity:0}to{transform:none;opacity:1}}
.nv-modal>header,.nv-drawer>header{display:flex;justify-content:space-between;align-items:flex-start;
  gap:16px;padding:18px 22px;border-bottom:1px solid var(--border);flex-shrink:0}
.nv-modal h2,.nv-drawer h2{margin:0;font-size:16px;font-weight:600}
.nv-modal p,.nv-drawer p{margin:3px 0 0;font-size:12px;color:var(--muted)}
.nv-modal>header button,.nv-drawer>header button{background:transparent;border:none;color:var(--muted);
  font-size:24px;line-height:1;cursor:pointer;padding:0 4px;border-radius:6px;
  transition:color .15s,background .15s}
.nv-modal>header button:hover,.nv-drawer>header button:hover{color:var(--text);background:var(--surface-2)}
.nv-modal-b{padding:20px 22px;overflow-y:auto}
.nv-modal>footer{display:flex;justify-content:flex-end;gap:8px;padding:14px 22px;
  border-top:1px solid var(--border);flex-shrink:0}
.nv-drawer{background:var(--surface);border-left:1px solid var(--border);display:flex;
  flex-direction:column;box-shadow:-24px 0 70px rgba(0,0,0,.45);
  animation:nvSlide .26s cubic-bezier(.2,.8,.2,1)}
@keyframes nvSlide{from{transform:translateX(34px);opacity:.4}to{transform:none;opacity:1}}
.nv-drawer-b{overflow-y:auto;flex:1}
.nv-eyebrow{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}

/* toast */
.nv-toast{position:fixed;bottom:24px;right:24px;z-index:200;padding:12px 18px;border-radius:14px;
  font-size:12.5px;font-weight:600;max-width:400px;backdrop-filter:blur(18px);
  box-shadow:0 16px 44px rgba(0,0,0,.45);animation:nvToast .3s cubic-bezier(.2,.8,.2,1)}
@keyframes nvToast{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}
.nv-toast.ok{background:rgba(16,185,129,.14);border:1px solid #10B981;color:#6EE7B7}
.nv-toast.bad{background:rgba(239,68,68,.14);border:1px solid #EF4444;color:#FCA5A5}
.nv-toast.warn{background:rgba(245,158,11,.14);border:1px solid #F59E0B;color:#FCD34D}

/* meter + avatar */
.nv-meter{height:6px;border-radius:99px;background:var(--surface-2);overflow:hidden}
.nv-meter div{height:100%;border-radius:99px;transition:width .5s cubic-bezier(.2,.8,.2,1)}
.nv-avatar{position:relative;display:inline-grid;place-items:center;border-radius:50%;padding:2px;
  background:linear-gradient(135deg,#6C3CE1,#E9408B);flex-shrink:0}
.nv-avatar .face{width:100%;height:100%;border-radius:50%;background:var(--surface-2);
  display:grid;place-items:center;font-weight:700;color:var(--text)}
.nv-avatar .dot{position:absolute;bottom:0;right:0;width:9px;height:9px;border-radius:99px;
  border:2px solid var(--surface)}

/* grids */
.nv-grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.nv-grid-3{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.nv-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}

@media (prefers-reduced-motion: reduce){
  .nv-btn,.nv-card.hoverable,.nv-stat,.nv-toggle i,.nv-meter div{transition:none}
  .nv-skel,.nv-dot.pulse,.nv-modal,.nv-drawer,.nv-toast{animation:none}
}
`;
