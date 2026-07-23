"use client";

import React from "react";

/**
 * Menu — a compact dropdown that collapses a row of buttons into one trigger.
 *
 * The toolbars in this app had grown to a dozen buttons on a single wrapping
 * row, pushing the actual content (the table) a long way down the page. A
 * dropdown keeps every action reachable in one click while giving that whole
 * band of vertical space back to the list underneath.
 *
 * Closes on outside-click and on Escape, because a menu that only closes when
 * you pick something is a menu you cannot back out of.
 */
export function Menu({
  label, icon, items, align = "left", disabled,
}: {
  label: string;
  icon?: React.ReactNode;
  align?: "left" | "right";
  disabled?: boolean;
  items: Array<
    | {
        label: string;
        onClick: () => void;
        icon?: React.ReactNode;
        /** Muted red styling for destructive actions. */
        danger?: boolean;
        disabled?: boolean;
        /** A short note shown dimmed after the label, e.g. a count. */
        note?: string;
      }
    | "divider"
  >;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div className="jmenu" ref={ref}>
      <style>{CSS}</style>
      <button
        className="jmenu-trigger"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {icon}
        <span>{label}</span>
        <i className={`jmenu-caret ${open ? "up" : ""}`}>▾</i>
      </button>

      {open && (
        <div className={`jmenu-pop ${align === "right" ? "right" : ""}`} role="menu">
          {items.map((it, i) =>
            it === "divider" ? (
              <div key={`d${i}`} className="jmenu-div" />
            ) : (
              <button
                key={it.label}
                role="menuitem"
                className={`jmenu-item ${it.danger ? "danger" : ""}`}
                disabled={it.disabled}
                onClick={() => { if (!it.disabled) { it.onClick(); setOpen(false); } }}
              >
                {it.icon && <span className="jmenu-ic">{it.icon}</span>}
                <span className="jmenu-lbl">{it.label}</span>
                {it.note && <em className="jmenu-note">{it.note}</em>}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

const CSS = `
.jmenu{position:relative;display:inline-block}
.jmenu-trigger{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border-radius:8px;
  font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;white-space:nowrap;
  background:var(--surface-2);border:1px solid var(--border);color:var(--text);
  transition:border-color .12s ease,background .12s ease}
.jmenu-trigger:hover:not(:disabled){border-color:#6C3CE1}
.jmenu-trigger:disabled{opacity:.5;cursor:not-allowed}
.jmenu-caret{font-style:normal;font-size:9px;opacity:.7;transition:transform .15s ease}
.jmenu-caret.up{transform:rotate(180deg)}

.jmenu-pop{position:absolute;top:calc(100% + 6px);left:0;z-index:60;min-width:210px;padding:6px;
  background:var(--surface);border:1px solid var(--border);border-radius:11px;
  box-shadow:0 14px 40px rgba(0,0,0,.45);animation:jmenuIn .13s ease}
.jmenu-pop.right{left:auto;right:0}
@keyframes jmenuIn{from{opacity:0;transform:translateY(-4px)}}

.jmenu-item{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:7px;
  border:none;background:transparent;color:var(--text);font-size:12.5px;font-weight:600;
  font-family:inherit;cursor:pointer;text-align:left;transition:background .1s ease}
.jmenu-item:hover:not(:disabled){background:rgba(108,60,225,.14)}
.jmenu-item:disabled{opacity:.4;cursor:not-allowed}
.jmenu-item.danger{color:#FCA5A5}
.jmenu-item.danger:hover:not(:disabled){background:rgba(239,68,68,.14)}
.jmenu-ic{display:inline-flex;width:15px;justify-content:center;flex-shrink:0;opacity:.85}
.jmenu-lbl{flex:1}
.jmenu-note{font-style:normal;font-size:11px;color:var(--muted);font-weight:700}
.jmenu-div{height:1px;background:var(--border);margin:5px 2px}
`;
