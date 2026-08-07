"use client";

import React from "react";

/**
 * WinBoxToolbar — the flat button strip that sits above a WinBox data table.
 *
 * Reusable across Subscribers, NAS, Packages, IP Pools. Pass only the actions a
 * page supports; omitted handlers hide their buttons. Button groups are divided
 * by thin separators, exactly like WinBox's Add/Remove/Enable/Disable strip.
 *
 * A group with `selectionRequired` disables its buttons until at least one row
 * is selected (WinBox greys out Remove/Enable/Disable with no selection).
 */

export type WBButton = {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  tone?: "default" | "danger" | "warn" | "primary";
  title?: string;
  selectionRequired?: boolean;
};

export function WinBoxToolbar({
  groups,
  find,
  onFind,
  findPlaceholder = "Find…",
  selectedCount = 0,
  right,
}: {
  /** Ordered button groups; each inner array is separated by a divider. */
  groups: WBButton[][];
  find?: string;
  onFind?: (v: string) => void;
  findPlaceholder?: string;
  selectedCount?: number;
  /** Optional extra content pinned to the right (e.g. Export/Print). */
  right?: React.ReactNode;
}) {
  const findRef = React.useRef<HTMLInputElement>(null);

  // Ctrl+F focuses Find, like WinBox.
  React.useEffect(() => {
    if (!onFind) return;
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        findRef.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onFind]);

  return (
    <div className="wbtb">
      <style>{CSS}</style>
      {groups.map((g, gi) => (
        <React.Fragment key={gi}>
          {gi > 0 && <span className="wbsep" />}
          {g.map((b, bi) => {
            const disabled = b.selectionRequired && selectedCount === 0;
            return (
              <button
                key={bi}
                className={`wbbtn ${b.tone ?? "default"}`}
                onClick={b.onClick}
                disabled={disabled}
                title={b.title ?? b.label}
              >
                {b.icon && <span className="wbico">{b.icon}</span>}
                {b.label}
              </button>
            );
          })}
        </React.Fragment>
      ))}

      <span className="wbspacer" />

      {onFind && (
        <span className="wbfind">
          <span className="wbfindico">⌕</span>
          <input
            ref={findRef}
            value={find ?? ""}
            onChange={(e) => onFind(e.target.value)}
            placeholder={findPlaceholder}
          />
          {find && (
            <button className="wbclear" title="Clear" onClick={() => onFind("")}>×</button>
          )}
        </span>
      )}
      {right}
    </div>
  );
}

const CSS = `
.wbtb{display:flex;align-items:center;gap:2px;flex-wrap:wrap;padding:6px 8px;
  background:var(--surface-2);border:1px solid var(--border);border-bottom:none;
  border-radius:8px 8px 0 0}
.wbbtn{display:inline-flex;align-items:center;gap:5px;padding:5px 11px;font-size:12px;
  font-weight:600;cursor:pointer;font-family:inherit;color:var(--text);
  background:var(--surface);border:1px solid var(--border);border-radius:6px;
  transition:all .12s ease;white-space:nowrap}
.wbbtn:hover:not(:disabled){border-color:var(--accent);color:var(--accent);
  background:color-mix(in srgb,var(--accent) 12%,transparent)}
.wbbtn:active:not(:disabled){background:color-mix(in srgb,var(--accent) 22%,transparent)}
.wbbtn:disabled{opacity:.4;cursor:not-allowed}
.wbbtn.primary{color:#fff;background:var(--accent);border-color:var(--accent)}
.wbbtn.primary:hover:not(:disabled){filter:brightness(1.08);color:#fff}
.wbbtn.danger:hover:not(:disabled){border-color:#EF4444;color:#FCA5A5;background:rgba(239,68,68,.12)}
.wbbtn.warn:hover:not(:disabled){border-color:#F59E0B;color:#FCD34D;background:rgba(245,158,11,.12)}
.wbico{font-size:13px;line-height:1;display:inline-flex}
.wbsep{width:1px;align-self:stretch;background:var(--border);margin:2px 6px}
.wbspacer{flex:1 1 auto;min-width:8px}
.wbfind{display:inline-flex;align-items:center;gap:5px;padding:0 8px;height:30px;
  background:var(--surface);border:1px solid var(--border);border-radius:6px}
.wbfind:focus-within{border-color:var(--accent)}
.wbfindico{color:var(--muted);font-size:14px}
.wbfind input{background:transparent;border:none;outline:none;color:var(--text);
  font-family:inherit;font-size:12px;width:150px}
.wbfind input::placeholder{color:var(--muted)}
.wbclear{background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:16px;
  line-height:1;padding:0 2px}
.wbclear:hover{color:var(--text)}
@media (max-width:760px){ .wbfind input{width:110px} .wbspacer{display:none} }
`;
