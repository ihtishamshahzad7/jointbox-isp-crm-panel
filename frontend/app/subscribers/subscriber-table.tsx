"use client";

import * as React from "react";
import { fileUrl } from "../components/image-upload";
import type { Subscriber } from "./types";
import {
  DataTable,
  type DtColumn,
  type DataTableFetchParams,
  type DataTableFetchResult,
} from "../components/data-table";

/**
 * SubscriberTable — the list, composed rather than tabulated, now rendered by
 * the shared Jointbox DataTable engine.
 *
 * The old table had TWELVE columns: Subscriber, Username, Status, Package,
 * Connection, NAS, Area, Salesperson, Expiry, RADIUS, Install Date, Actions.
 * At 1400px that is roughly 110px each, so every value truncates or wraps and
 * a row reads as a wall of fragments. No amount of CSS fixes that — it is a
 * content problem, not a styling one.
 *
 * Same information, fewer cells on screen, the rest one mouse-click away in
 * the Columns menu. Each cell carries a primary value and its supporting
 * detail underneath, which is how the eye actually reads a list: one anchor,
 * then context.
 *
 * Standalone on purpose. The page keeps its state and handlers; swapping this
 * in or out is one line, and if it is wrong only this file is wrong.
 *
 * The PROPS ARE THE CONTRACT with page.tsx — they are unchanged from the
 * previous implementation. Selection stays controlled by the page; the table
 * only renders state.
 */

/**
 * Subscriber row shape. The backend list endpoint returns FULL subscriber
 * records (no SELECT narrowing) plus live-status enrichments, so the row IS a
 * `Subscriber`. The table layer only adds the derived render fields
 * (daysLeft …) and keeps a couple of legacy enrichments optional.
 */
export interface SubscriberRow extends Subscriber {
  onlineStatus?: string;
  isOnline?: boolean;
  daysLeft?: number | null;
  framedIp?: string | null;
  leasedIp?: string | null;
  acctsessiontime?: number | null;
  balance?: number | null;
  outstandingBalance?: number | null;
  usageDown?: number | null;
  usageUp?: number | null;
  acctinputoctets?: number | null;
  acctoutputoctets?: number | null;
  staticIp?: string | null;
  lastSeen?: string | null;
  lastActivity?: string | null;
}

export type Row = SubscriberRow;

export function SubscriberTable({
  rows, selectedIds, onToggle, onToggleAll, onOpen, onEdit, onMove, onDeactivate, onDelete, onActivate, money,
  onRefresh, fetchPage, filters, refreshToken, totalCount, defaultPageSize = 50, pageSizes = [25, 50, 100, 200],
}: {
  rows: Row[];
  selectedIds: number[];
  onToggle: (id: number) => void;
  onToggleAll: () => void;
  onOpen: (r: Row) => void;
  onEdit: (r: Row) => void;
  onMove: (r: Row) => void;
  onDeactivate: (r: Row) => void;
  onDelete: (r: Row) => void;
  onActivate: (r: Row) => void;
  money: (n: number | string | null | undefined) => string;
  /** Optional: enables the WinBox-style "Live" auto-refresh toggle + manual refresh. */
  onRefresh?: () => void;
  /** SERVER MODE: the DataTable fetches one page at a time through here. */
  fetchPage?: (p: DataTableFetchParams) => Promise<DataTableFetchResult<Row>>;
  /** SERVER MODE: filter state forwarded verbatim into fetchPage. */
  filters?: Record<string, unknown>;
  /** SERVER MODE: bump to force a refetch (post-mutation / Live toggle). */
  refreshToken?: number | string;
  /** SERVER MODE: total rows across all pages (statusbar count). */
  totalCount?: number;
  /** Default page size (server mode). */
  defaultPageSize?: number;
  /** Page-size choices (server mode). */
  pageSizes?: number[];
}) {
  // ── WinBox right-click context menu ──────────────────────────────────
  const [menu, setMenu] = React.useState<{ x: number; y: number; row: Row } | null>(null);
  React.useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);
  const openMenu = (e: React.MouseEvent<HTMLTableRowElement>, row: Row) => {
    e.preventDefault();
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 190), y: Math.min(e.clientY, window.innerHeight - 200), row });
  };

  // ── WinBox "Live" auto-refresh ───────────────────────────────────────
  const [live, setLive] = React.useState(false);
  React.useEffect(() => {
    if (!live || !onRefresh) return;
    const t = setInterval(() => onRefresh(), 5000);
    return () => clearInterval(t);
  }, [live, onRefresh]);

  const onlineOf = (r: Row) =>
    String(r.onlineStatus ?? r.status).toUpperCase() === "ONLINE" || r.isOnline === true;

  const expiryInfo = (r: Row): { date: string; label: string; kind: "ok" | "warn" | "bad" | "none" } => {
    const raw = r.serviceSettings?.expiryDate;
    if (!raw) return { date: "—", label: "", kind: "none" };
    const d = new Date(raw);
    const days = r.daysLeft != null ? r.daysLeft : Math.ceil((d.getTime() - Date.now()) / 86400000);
    if (days <= 0) return { date: d.toLocaleDateString(), label: "expired", kind: "bad" };
    if (days <= 7) return { date: d.toLocaleDateString(), label: `${days} days left`, kind: "warn" };
    return { date: d.toLocaleDateString(), label: `${days} days left`, kind: "ok" };
  };

  const fmtDuration = (sec?: number | null): string | null => {
    if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  };

  const statusOf = (r: Row): { label: string; kind: "ok" | "warn" | "bad" | "neutral" } => {
    const s = String(r.status ?? "").toUpperCase();
    if (s === "ACTIVE") return { label: "Active", kind: "ok" };
    if (s === "SUSPENDED") return { label: "Suspended", kind: "warn" };
    if (s === "EXPIRED") return { label: "Expired", kind: "bad" };
    if (s === "INACTIVE") return { label: "Inactive", kind: "neutral" };
    return { label: s || "—", kind: "neutral" };
  };

  const columns: DtColumn<Row>[] = [
    {
      key: "flags",
      header: "Flags",
      headerTip: "Flags — R: running/online · X: disabled · D: dynamic IP",
      defaultHidden: true,
      sortable: false,
      exportable: false,
      width: 64,
      render: (r) => {
        const online = onlineOf(r);
        const inactive = String(r.status ?? "").toUpperCase() !== "ACTIVE";
        const dynamic = !r.serviceSettings?.staticIp && !r.staticIp;
        return (
          <>
            <span className={`fl ${online ? "r" : ""}`} title="Running (online)">R</span>
            <span className={`fl ${inactive ? "x" : "off"}`} title="Disabled (inactive)">X</span>
            <span className={`fl ${dynamic ? "d" : "off"}`} title="Dynamic IP">D</span>
          </>
        );
      },
    },
    {
      key: "customer",
      header: "Customer",
      sortable: true,
      width: 240,
      sortValue: (r) => (r.fullName || r.username || "").toLowerCase(),
      render: (r) => {
        const online = onlineOf(r);
        const name = r.fullName || r.username || "?";
        const initials = String(name).trim().split(/\s+/).slice(0, 2)
          .map((w: string) => w[0]).join("").toUpperCase() || "?";
        return (
          <div className="who">
            {/* Photo when the subscriber has one, initials otherwise —
                the online ring stays either way. */}
            <span className={`av ${online ? "on" : ""}`} aria-hidden
              style={r.photoUrl ? { backgroundImage: `url(${fileUrl(r.photoUrl)})`, backgroundSize: "cover", backgroundPosition: "center", color: "transparent" } : undefined}>
              {r.photoUrl ? "" : initials}
            </span>
            <span className="whoTxt">
              <span className="nm">{r.fullName || r.username}</span>
              <span className="sub">
                <code>{r.username}</code>
                {r.phone && <span className="ph"> {r.phone}</span>}
              </span>
            </span>
          </div>
        );
      },
    },
    {
      key: "customerId",
      header: "Customer ID",
      headerTip: "Internal subscriber id",
      defaultHidden: true,
      sortable: true,
      sortValue: (r) => (r.id != null ? Number(r.id) : ""),
      render: (r) => (
        <span className="idp">
          <code>#{r.id}</code>
          {r.identity && <span className="sub" title="Identity (CNIC) — only where authorized">{r.identity}</span>}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      sortValue: (r) => String(r.status ?? "").toUpperCase().replace(/[^A-Z]/g, ""),
      render: (r) => {
        const s = statusOf(r);
        return <span className={`pill ${s.kind}`}><span className={`dot ${s.kind}`} />{s.label}</span>;
      },
    },
    {
      key: "connection",
      header: "Connection",
      sortable: true,
      sortValue: (r) => (onlineOf(r) ? 1 : 0),
      render: (r) => {
        const online = onlineOf(r);
        const dur = fmtDuration(r.acctsessiontime);
        return (
          <>
            <span className={`pill ${online ? "up" : "down"}`}>
              <span className={`dot ${online ? "up" : "down"}`} />
              {online ? "Online" : "Offline"}
            </span>
            <div className="sub mt">
              {r.framedIp || r.leasedIp
                ? <code>{r.framedIp || r.leasedIp}</code>
                : (r.connectionType || "—")}
              {dur && <span className="ph"> · {dur}</span>}
            </div>
          </>
        );
      },
    },
    {
      key: "package",
      header: "Package",
      sortable: true,
      sortValue: (r) => (r.package?.name || "").toLowerCase(),
      render: (r) => (
        <>
          <span className="chip">{r.package?.name ?? "—"}</span>
          {r.package && (
            <div className="sub mt">
              {r.package.downloadSpeed}/{r.package.uploadSpeed} Mbps
            </div>
          )}
        </>
      ),
    },
    {
      key: "balance",
      header: "Balance",
      headerTip: "Outstanding balance (PKR)",
      sortable: true,
      align: "right",
      sortValue: (r) => {
        const b = r.balance ?? r.outstandingBalance;
        return b == null ? Number.MAX_SAFE_INTEGER : Number(b);
      },
      render: (r) => {
        const b = r.balance ?? r.outstandingBalance;
        const e = expiryInfo(r);
        if (b == null) return <span className="sub">—</span>;
        const overdue = Number(b) > 0 && e.kind === "bad";
        return (
          <div className={overdue ? "balance bad" : "balance"}>
            <b>{money(b)}</b>
            {overdue && <span className="badge bad">overdue</span>}
          </div>
        );
      },
    },
    {
      key: "expiry",
      header: "Expiry",
      sortable: true,
      sortValue: (r) => (r.serviceSettings?.expiryDate ? new Date(r.serviceSettings.expiryDate).getTime() : Number.MAX_SAFE_INTEGER),
      render: (r) => {
        const e = expiryInfo(r);
        return (
          <>
            <div className={`nm sm ${e.kind === "bad" ? "down" : e.kind === "warn" ? "warn" : ""}`}>{e.date}</div>
            {e.kind !== "none" && (
              <span className={`badge ${e.kind === "bad" ? "bad" : e.kind === "warn" ? "warnb" : "okb"}`}>{e.label}</span>
            )}
          </>
        );
      },
    },
    {
      key: "traffic",
      header: "Traffic",
      headerTip: "Session download / upload",
      defaultHidden: true,
      sortable: true,
      align: "right",
      sortValue: (r) => Number(r.usageDown ?? r.acctinputoctets ?? 0) + Number(r.usageUp ?? r.acctoutputoctets ?? 0),
      render: (r) => {
        const down = r.usageDown ?? r.acctinputoctets;
        const up = r.usageUp ?? r.acctoutputoctets;
        if (down == null && up == null) return <span className="sub">—</span>;
        return (
          <div className="traffic">
            <div className="sub">↓ {down != null ? fmtBytes(down) : "—"}</div>
            <div className="sub">↑ {up != null ? fmtBytes(up) : "—"}</div>
          </div>
        );
      },
    },
    {
      key: "nas",
      header: "NAS",
      defaultHidden: true,
      sortable: true,
      sortValue: (r) => (r.nas?.nasname || "").toLowerCase(),
      render: (r) =>
        r.nas?.nasname ? <code>{r.nas.nasname}</code> : <span className="sub">—</span>,
    },
    {
      key: "owner",
      header: "Owner",
      sortable: true,
      sortValue: (r) => (r.user?.name || r.salesperson?.name || "").toLowerCase(),
      render: (r) => (
        <>
          {/*
            OWNER = whose wallet is charged on activation and in whose subtree
            this customer sits. SOLD BY = attribution only.

            These are different fields and must never be shown as one. An
            absent owner is shown as an explicit warning, never papered over
            with another account's name.
          */}
          {r.user?.name ? (
            <div className="nm sm">{r.user.name}</div>
          ) : (
            <div className="nm sm" style={{ color: "#B02A37" }}
              title="No owner account — nobody's wallet is charged when this subscriber is activated.">
              ⚠ No owner
            </div>
          )}
          {r.salesperson?.name && r.salesperson.name !== r.user?.name && (
            <div className="sub" title="Sold by (attribution only — this account is not charged)">
              sold by {r.salesperson.name}
            </div>
          )}
          <div className="sub">{r.area?.name ?? r.nas?.nasname ?? "—"}</div>
        </>
      ),
    },
    {
      key: "lastSeen",
      header: "Last Seen",
      defaultHidden: true,
      sortable: true,
      sortValue: (r) => {
        const raw = r.lastSeen ?? r.lastActivity;
        return raw ? new Date(raw).getTime() : Number.MAX_SAFE_INTEGER;
      },
      render: (r) => {
        const raw = r.lastSeen || r.lastActivity;
        if (!raw) return <span className="sub">—</span>;
        return <span className="sub" title={new Date(raw).toLocaleString()}>{new Date(raw).toLocaleDateString()}</span>;
      },
    },
    {
      key: "actions",
      header: "",
      sortable: false,
      exportable: false,
      width: 230,
      render: (r) => (
        <span className="act" onClick={(e) => e.stopPropagation()}>
          {String(r.status ?? "").toUpperCase() === "ACTIVE" ? (
            <span className="act-badge" title="Subscriber is active">● Active</span>
          ) : (
            <button className="ok" onClick={() => onActivate(r)} title="Activate this subscriber">Activate</button>
          )}
          <button onClick={() => onEdit(r)} title="Edit">Edit</button>
          <button onClick={() => onMove(r)} title="Move">Move</button>
          <button className="warn" onClick={() => onDeactivate(r)} title="Deactivate">Off</button>
          <button className="bad" onClick={() => onDelete(r)} title="Delete">Del</button>
        </span>
      ),
    },
  ];

  const server = !!fetchPage;

  return (
    <div className="st">
      <style>{CSS}</style>
      <DataTable
        columns={columns}
        rows={server ? undefined : rows}
        fetchPage={fetchPage}
        filters={filters}
        refreshToken={refreshToken}
        rowKey={(r) => r.id}
        selectable
        selectedKeys={selectedIds}
        onToggleKey={(key) => onToggle(Number(key))}
        onTogglePage={() => onToggleAll()}
        storageKey="jb_subcols"
        density="default"
        defaultPageSize={defaultPageSize}
        pageSizes={pageSizes}
        searchable={server}
        searchPlaceholder="Search by name, phone, username, email, identity…"
        selectionBar={false}
        disablePagination={!server}
        exportName="subscribers"
        rowClick={(r) => onOpen(r)}
        onRowContextMenu={(e, r) => openMenu(e, r)}
        onRefresh={onRefresh}
        emptySlot={
          <>
            <b>No subscribers yet.</b>
            <span>Add one with the button above, or adjust the filters if you expected to see some.</span>
          </>
        }
      />

      {/* WinBox status bar: total count + Live auto-refresh toggle. */}
      <div className="statusbar">
        <span className="cnt">
          {(server && totalCount != null ? totalCount : rows.length).toLocaleString()}{" "}
          item{(server && totalCount != null ? totalCount : rows.length) === 1 ? "" : "s"}
          {selectedIds.length > 0 && <> · <b>{selectedIds.length} selected</b></>}
        </span>
        {onRefresh && (
          <span className="live">
            <button className={`livebtn ${live ? "on" : ""}`} onClick={() => setLive((v) => !v)}
              title="Auto-refresh every 5 seconds">
              <span className="ld" /> {live ? "Live" : "Live off"}
            </button>
            <button className="refr" onClick={onRefresh} title="Refresh now">⟳</button>
          </span>
        )}
      </div>

      {/* Right-click context menu (WinBox style). */}
      {menu && (
        <div className="ctxmenu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { onOpen(menu.row); setMenu(null); }}>Open</button>
          <button onClick={() => { onEdit(menu.row); setMenu(null); }}>Edit…</button>
          <button onClick={() => { onMove(menu.row); setMenu(null); }}>Move…</button>
          <div className="sep" />
          <button onClick={() => { onDeactivate(menu.row); setMenu(null); }}>Disable</button>
          <button className="danger" onClick={() => { onDelete(menu.row); setMenu(null); }}>Delete</button>
        </div>
      )}
    </div>
  );
}

function fmtBytes(n: number): string {
  const v = Number(n) || 0;
  if (v <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(v) / Math.log(1024)), units.length - 1);
  return `${(v / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

const CSS = `
.st{background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;
  box-shadow:0 1px 2px rgba(0,0,0,.18)}

/* Cell content primitives — layout (padding/height) lives in the DataTable
   engine so density control stays consistent across every list. */

/* Identity cell. */
.st .who{display:flex;align-items:center;gap:11px}
.st .av{flex:none;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;
  font-size:13px;font-weight:800;color:#fff;letter-spacing:.02em;
  background:linear-gradient(135deg,#7C4DFF,#B14DE8 55%,#F0508A);
  box-shadow:0 2px 8px rgba(124,77,255,.35);position:relative}
.st .av.on::after{content:"";position:absolute;right:-2px;bottom:-2px;width:11px;height:11px;
  border-radius:50%;background:#10B981;border:2px solid var(--surface);box-shadow:0 0 8px rgba(16,185,129,.9)}
.st .whoTxt{display:flex;flex-direction:column;min-width:0}
.st .ph{color:var(--muted)}

.st .idp{display:flex;flex-direction:column;gap:2px}

.st .nm{font-size:13.5px;font-weight:700;color:var(--text);line-height:1.35}
.st .nm.sm{font-size:12.5px;font-weight:600}
.st .sub{font-size:10.5px;color:var(--muted);line-height:1.5}
.st .sub.mt{margin-top:5px}
.st code{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;
  background:rgba(255,255,255,.06);padding:1px 5px;border-radius:4px;letter-spacing:-.02em}

/* Status pill. */
.st .pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;
  font-size:11px;font-weight:700;line-height:1;border:1px solid transparent}
.st .pill.up{color:#6EE7B7;background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.35)}
.st .pill.down{color:#94A3B8;background:rgba(148,163,184,.10);border-color:rgba(148,163,184,.22)}
.st .pill.warn{color:#FCD34D;background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.35)}
.st .pill.bad{color:#FCA5A5;background:rgba(239,68,68,.14);border-color:rgba(239,68,68,.35)}
.st .pill.neutral{color:#94A3B8;background:rgba(148,163,184,.10);border-color:rgba(148,163,184,.22)}
.st .dot{display:inline-block;width:6px;height:6px;border-radius:50%}
.st .dot.up{background:#10B981;box-shadow:0 0 7px rgba(16,185,129,.9)}
.st .dot.down{background:#64748B}
.st .dot.warn{background:#F59E0B}
.st .dot.bad{background:#EF4444}
.st .dot.neutral{background:#64748B}

/* Package chip. */
.st .chip{display:inline-block;padding:3px 10px;border-radius:8px;font-size:12px;font-weight:700;
  color:#C4B5FD;background:rgba(124,77,255,.12);border:1px solid rgba(124,77,255,.28)}

/* Expiry + overdue badges. */
.st .badge{display:inline-block;margin-top:5px;padding:2px 9px;border-radius:999px;
  font-size:10px;font-weight:700}
.st .badge.okb{color:#6EE7B7;background:rgba(16,185,129,.12)}
.st .badge.warnb{color:#FCD34D;background:rgba(245,158,11,.14)}
.st .badge.bad{color:#FCA5A5;background:rgba(239,68,68,.14)}
.st .warn{color:#FCD34D}
.st .down{color:#FCA5A5}

/* Balance. */
.st .balance{display:flex;flex-direction:column;align-items:flex-end;gap:3px}
.st .balance b{font-size:12.5px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums}
.st .balance.bad b{color:#FCA5A5}
.st .balance .badge{margin-top:0}

/* Traffic. */
.st .traffic{display:flex;flex-direction:column;align-items:flex-end;gap:2px}
.st .traffic .sub{font-variant-numeric:tabular-nums}

/* Flags column. */
.st .fl{display:inline-block;width:15px;text-align:center;font-family:ui-monospace,monospace;
  font-size:11px;font-weight:800;margin-right:1px;color:#3a4051}
.st .fl.r{color:#4a9eff}
.st .fl.x{color:#94A3B8}
.st .fl.d{color:#FCD34D}
.st .fl.off{opacity:.28}

/* Action buttons. */
.st .act{display:inline-flex;align-items:center;gap:0;white-space:nowrap}
.st .act button{margin-left:6px;padding:5px 11px;border-radius:8px;font-size:11px;
  font-weight:700;cursor:pointer;font-family:inherit;
  background:var(--surface-2);border:1px solid var(--border);color:var(--text);
  transition:all .13s ease}
.st .act button:hover{border-color:#7C4DFF;color:#C4B5FD;background:rgba(124,77,255,.12);transform:translateY(-1px)}
.st .act button.warn:hover{color:#FCD34D;border-color:#F59E0B;background:rgba(245,158,11,.12)}
.st .act button.bad:hover{color:#FCA5A5;border-color:#EF4444;background:rgba(239,68,68,.12)}
.st .act button.ok{color:#10B981;border-color:rgba(16,185,129,.5)}
.st .act button.ok:hover{color:#34D399;border-color:#10B981;background:rgba(16,185,129,.12)}
.st .act .act-badge{display:inline-block;margin-left:6px;padding:5px 11px;border-radius:8px;font-size:11px;font-weight:700;color:#10B981;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.35)}

/* WinBox status bar. */
.st .statusbar{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:6px 14px;border-top:1px solid var(--border);background:var(--surface-2);
  font-size:11px;color:var(--muted)}
.st .statusbar b{color:var(--text)}
.st .live{display:flex;align-items:center;gap:6px}
.st .livebtn{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;font-size:11px;
  font-weight:700;cursor:pointer;background:var(--surface);border:1px solid var(--border);
  color:var(--muted);border-radius:6px;font-family:inherit}
.st .livebtn .ld{width:7px;height:7px;border-radius:50%;background:#64748B}
.st .livebtn.on{color:#6EE7B7;border-color:rgba(16,185,129,.4)}
.st .livebtn.on .ld{background:#10B981;box-shadow:0 0 7px rgba(16,185,129,.9);animation:stpulse 1.4s ease-in-out infinite}
@keyframes stpulse{50%{opacity:.4}}
.st .refr{padding:3px 9px;font-size:13px;cursor:pointer;background:var(--surface);
  border:1px solid var(--border);color:var(--text);border-radius:6px;line-height:1}
.st .refr:hover{border-color:var(--accent);color:var(--accent)}

/* WinBox right-click context menu. */
.st .ctxmenu{position:fixed;z-index:200;min-width:170px;padding:4px;
  background:var(--surface-2);border:1px solid var(--border);border-radius:8px;
  box-shadow:0 12px 34px rgba(0,0,0,.5);display:flex;flex-direction:column}
.st .ctxmenu button{text-align:left;padding:7px 12px;font-size:12px;font-weight:600;
  cursor:pointer;background:transparent;border:none;color:var(--text);border-radius:5px;
  font-family:inherit}
.st .ctxmenu button:hover{background:rgba(74,158,255,.14)}
.st .ctxmenu button.danger:hover{background:rgba(239,68,68,.16);color:#FCA5A5}
.st .ctxmenu .sep{height:1px;background:var(--border);margin:4px 6px}

/* Mobile: action buttons wrap as a grid inside the card row. */
@media (max-width:760px){
  .st{border:none;background:transparent;box-shadow:none;overflow:visible}
  .st .statusbar{border:1px solid var(--border);border-radius:14px;background:var(--surface);margin-top:4px}
  .st td .act{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;width:100%;padding-top:11px;
    margin-top:5px;border-top:1px solid var(--border)}
  .st .act button{margin:0;width:100%;padding:9px 4px;font-size:12px;min-height:38px}
  .st .act .act-badge{margin:0;width:100%;text-align:center;padding:9px 4px}
}
`;