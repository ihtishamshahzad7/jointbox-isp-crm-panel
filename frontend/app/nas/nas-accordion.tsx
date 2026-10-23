"use client";

/**
 * Routers & RADIUS — accordion list.
 *
 * Collapsed row: device name, IP and a clear status indicator with a chevron.
 * Expanded: a clean details panel (RADIUS ports, session data, access types)
 * plus the row actions. Drop-in replacement for <NasTable/> — same props.
 * Modern-SaaS surface: rounded cards, subtle type, light + dark via tokens.
 */
import React from "react";

type Row = any;

function bps(v: number) {
  const u = ["bps", "Kbps", "Mbps", "Gbps"];
  let i = 0, x = v || 0;
  while (x >= 1000 && i < 3) { x /= 1000; i++; }
  return `${x.toFixed(x < 10 ? 1 : 0)} ${u[i]}`;
}

export function NasAccordion({
  rows, me, onView, onEdit, onShare, onCheck, onDelete, onVpn, onGroup, checkingIds, reachOf, healthOf,
}: {
  rows: Row[];
  me?: any;
  onView: (r: Row) => void;
  onEdit: (r: Row) => void;
  onShare: (r: Row) => void;
  onCheck: (id: number) => void;
  onDelete: (r: Row) => void;
  onVpn?: (r: Row) => void;
  onGroup?: (r: Row) => void;
  checkingIds?: Set<number>;
  reachOf?: (id: number) => { apiPortOpen?: boolean; activeSessionCount?: number; identity?: string } | undefined;
  healthOf?: (id: number) => { inBps: number; outBps: number } | undefined;
}) {
  const isIsp = !me || me.role === "SUPER_ADMIN" || me.role === "ADMIN";
  const [open, setOpen] = React.useState<Set<number>>(new Set());
  const toggle = (id: number) => setOpen((p) => { const s = new Set(p); s.has(id) ? s.delete(id) : s.add(id); return s; });

  if (!rows.length) {
    return (
      <div className="nacc-empty">
        <div className="nacc-empty-ic">📡</div>
        <b>No routers yet.</b>
        <span>Add one, or ask your parent account to share theirs with you.</span>
        <style>{CSS}</style>
      </div>
    );
  }

  return (
    <div className="nacc">
      <style>{CSS}</style>
      {rows.map((n) => {
        const mine = isIsp || n.ownerId === me?.id;
        const live = reachOf?.(n.id);
        const sessions = live?.activeSessionCount ?? n.activeSessions ?? n._count?.subscribers ?? 0;
        const rowChecking = checkingIds ? checkingIds.has(n.id) : false;
        const reachable = live ? !!live.apiPortOpen : !!n.isActive;
        const status = live
          ? (live.apiPortOpen ? { t: "Reachable", k: "up" } : { t: "Unreachable", k: "down" })
          : (n.isActive ? { t: "Active", k: "up" } : { t: "Disabled", k: "off" });
        const hb = healthOf?.(n.id);
        const isOpen = open.has(n.id);

        return (
          <div key={n.id} className={`nacc-row${isOpen ? " open" : ""}`}>
            {/* ── header (click to expand) ── */}
            <button type="button" className="nacc-head" onClick={() => toggle(n.id)} aria-expanded={isOpen}>
              <span className={`nacc-dot ${status.k}`} title={status.t} />
              <span className="nacc-id">
                <span className="nacc-name">{n.nasname}</span>
                <span className="nacc-ip"><code>{n.nasIp || "no IP"}</code>
                  {!isIsp && (mine ? <em className="nacc-tag ok">yours</em> : <em className="nacc-tag warn">shared</em>)}
                </span>
              </span>
              <span className={`nacc-status ${status.k}`}>{rowChecking ? "checking…" : status.t}</span>
              <span className={`nacc-sess ${sessions > 0 ? "on" : ""}`}>{sessions}<i>online</i></span>
              <span className={`nacc-chev${isOpen ? " up" : ""}`} aria-hidden>⌄</span>
            </button>

            {/* ── details panel ── */}
            {isOpen && (
              <div className="nacc-body">
                <div className="nacc-grid">
                  <Field label="RADIUS">auth 1812 · acct 1813</Field>
                  <Field label="API">{`${n.apiPort || 8728}`}{n.apiUsername ? "" : " (no creds)"}</Field>
                  <Field label="CoA / disconnect">{n.incomingPort || 3799}</Field>
                  <Field label="Sessions online">
                    {sessions}{hb ? <span className="nacc-mut"> · ↓ {bps(hb.inBps)} ↑ {bps(hb.outBps)}</span> : null}
                  </Field>
                  <Field label="Identity / type">{live?.identity || n.type || "default"}</Field>
                  <Field label="Site">{n.shortname || n.description || "—"}</Field>
                  <Field label="Access">
                    {n.apiUsername ? <em className="nacc-tag ok">API ready</em> : <em className="nacc-tag warn">no API access</em>}
                    {typeof n.assignments?.length === "number" && n.assignments.length > 0 && (
                      <span className="nacc-mut"> · shared with {n.assignments.length}</span>
                    )}
                  </Field>
                </div>

                <div className="nacc-actions">
                  <button className="pri" onClick={() => onView(n)}>Open</button>
                  <button onClick={() => onCheck(n.id)} disabled={rowChecking}>{rowChecking ? "Checking…" : "Check"}</button>
                  {mine && onVpn && <button onClick={() => onVpn(n)} title="Configure the VPN tunnel for this router">VPN</button>}
                  {mine && onGroup && <button onClick={() => onGroup(n)}>Group</button>}
                  {mine && <button onClick={() => onShare(n)}>Share</button>}
                  {mine && <button onClick={() => onEdit(n)}>Edit</button>}
                  {mine && <button className="danger" onClick={() => onDelete(n)}>Delete</button>}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="nacc-field">
      <span className="nacc-flabel">{label}</span>
      <span className="nacc-fval">{children}</span>
    </div>
  );
}

const CSS = `
.nacc{display:flex;flex-direction:column;gap:8px}
.nacc-row{background:var(--surface,#fff);border:1px solid var(--border,#E6E9EF);border-radius:14px;overflow:hidden;transition:border-color .15s,box-shadow .15s}
.nacc-row.open{border-color:var(--jb-accent,#16a34a)55;box-shadow:0 6px 24px -14px rgba(16,163,74,.35)}
.nacc-head{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:12px;width:100%;padding:13px 16px;cursor:pointer}
.nacc-head:focus-visible{outline:2px solid var(--jb-accent,#16a34a);outline-offset:-2px}
.nacc-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:#9aa3af}
.nacc-dot.up{background:#16a34a;box-shadow:0 0 0 3px rgba(22,163,74,.15)}
.nacc-dot.down{background:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.15)}
.nacc-dot.off{background:#b9bfc9}
.nacc-id{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.nacc-name{font-size:14px;font-weight:700;color:var(--text,#121826);letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nacc-ip{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted,#6B7280)}
.nacc-ip code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.nacc-tag{font-style:normal;font-size:10px;font-weight:700;padding:1px 7px;border-radius:999px;letter-spacing:.02em}
.nacc-tag.ok{color:#16794a;background:rgba(22,163,74,.12)}
.nacc-tag.warn{color:#9a6a00;background:rgba(245,158,11,.14)}
.nacc-status{font-size:12px;font-weight:700;padding:3px 11px;border-radius:999px;white-space:nowrap}
.nacc-status.up{color:#16794a;background:rgba(22,163,74,.12)}
.nacc-status.down{color:#b02a37;background:rgba(229,72,77,.12)}
.nacc-status.off{color:#6B7280;background:rgba(120,128,140,.12)}
.nacc-sess{display:flex;flex-direction:column;align-items:center;min-width:46px;font-size:16px;font-weight:800;color:var(--muted,#9aa3af);font-variant-numeric:tabular-nums}
.nacc-sess.on{color:var(--text,#121826)}
.nacc-sess i{font-style:normal;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted,#9aa3af)}
.nacc-chev{font-size:20px;line-height:1;color:var(--muted,#9aa3af);transition:transform .18s;flex:0 0 auto;width:18px;text-align:center}
.nacc-chev.up{transform:rotate(180deg);color:var(--jb-accent,#16a34a)}
.nacc-body{padding:4px 16px 16px;border-top:1px solid var(--border,#EEF0F4)}
.nacc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px 18px;padding:14px 0}
.nacc-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.nacc-flabel{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted,#9aa3af)}
.nacc-fval{font-size:13px;color:var(--text,#121826)}
.nacc-mut{color:var(--muted,#6B7280)}
.nacc-actions{display:flex;flex-wrap:wrap;gap:8px;padding-top:4px}
.nacc-actions button{border:1px solid var(--border,#D7DCE3);background:var(--surface,#fff);color:var(--text,#2b3444);border-radius:9px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .12s,border-color .12s}
.nacc-actions button:hover{border-color:var(--jb-accent,#16a34a)}
.nacc-actions button:disabled{opacity:.55;cursor:default}
.nacc-actions button.pri{background:linear-gradient(135deg,#16a34a,#22c55e);border:none;color:#fff}
.nacc-actions button.danger{color:#b02a37;border-color:rgba(229,72,77,.4)}
.nacc-empty{text-align:center;padding:48px 20px;border:1px dashed var(--border,#E6E9EF);border-radius:14px;display:flex;flex-direction:column;align-items:center;gap:6px}
.nacc-empty-ic{font-size:34px}
.nacc-empty b{font-size:15px;color:var(--text,#121826)}
.nacc-empty span{font-size:13px;color:var(--muted,#6B7280)}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]) .nacc-row{background:var(--surface,#161a22);border-color:var(--border,#262b36)}
  :root:not([data-theme="light"]) .nacc-name,:root:not([data-theme="light"]) .nacc-fval,:root:not([data-theme="light"]) .nacc-sess.on,:root:not([data-theme="light"]) .nacc-empty b{color:var(--text,#E6E9EE)}
  :root:not([data-theme="light"]) .nacc-actions button{background:var(--surface,#1b2029);color:var(--text,#cdd3dd);border-color:var(--border,#2b313d)}
  :root:not([data-theme="light"]) .nacc-body{border-color:var(--border,#262b36)}
}
:root[data-theme="dark"] .nacc-row{background:var(--surface,#161a22);border-color:var(--border,#262b36)}
:root[data-theme="dark"] .nacc-name,:root[data-theme="dark"] .nacc-fval,:root[data-theme="dark"] .nacc-sess.on,:root[data-theme="dark"] .nacc-empty b{color:var(--text,#E6E9EE)}
:root[data-theme="dark"] .nacc-actions button{background:var(--surface,#1b2029);color:var(--text,#cdd3dd);border-color:var(--border,#2b313d)}
:root[data-theme="dark"] .nacc-body{border-color:var(--border,#262b36)}
`;

export default NasAccordion;
