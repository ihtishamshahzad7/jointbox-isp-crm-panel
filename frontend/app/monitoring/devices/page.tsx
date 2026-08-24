"use client";

import React from "react";
import { useRouter } from "next/navigation";
import {
  ndm, fmtUptimeFull, fmtTime, fmtBits, catLabel, sevColor, portState,
  methodOf, isSnmp,
  type NdmDevice, type NdmPort, type NdmAlert, type NdmEvent, type SyslogRow,
} from "../ndm";
// `Stat` is no longer used here: the old 8-tile strip was replaced by the
// 6-KPI grid below. The card view (DeviceCard) still uses its own MiniStat.
import { NDMCSS, NdmModal, useNdmRefresh } from "../ndm-ui";
import { NdmSoundBell } from "../../components/ndm-sound";
import { useSSE } from "../../components/use-sse";
import Link from "next/link";

/** Nothing in the UI may ever print null/undefined/[object Object]. */
const dash = (v: any): string => {
  if (v === null || v === undefined) return "—";
  const s = typeof v === "object" ? "" : String(v).trim();
  return s && s !== "null" && s !== "undefined" && s !== "[object Object]" ? s : "—";
};

/**
 * "OTHER" is the vendor default, not information. Showing it wastes a column
 * and reads as though something is known when nothing is.
 */
const realVendor = (v: string | null | undefined) => {
  const s = String(v || "").trim();
  return !s || s.toUpperCase() === "OTHER" || s.toUpperCase() === "UNKNOWN" ? "" : s;
};

/** Operational state, in the order an engineer triages. */
type DState = "DOWN" | "WARN" | "UP" | "PAUSED" | "UNKNOWN";
const deviceState = (d: NdmDevice): DState => {
  if (!d.enabled) return "PAUSED";
  if (d.isReachable === false) return "DOWN";
  if (d.isReachable == null) return "UNKNOWN";
  return (d.openAlerts || 0) > 0 || (d.downPorts || 0) > 0 ? "WARN" : "UP";
};

/**
 * WARNING must always be explainable. A vague amber badge tells an engineer
 * nothing and trains them to ignore it, so the reason is computed here and
 * shown next to the badge and in the expanded row.
 */
const warnReason = (d: NdmDevice): string => {
  const parts: string[] = [];
  if ((d.openAlerts || 0) > 0) parts.push(`${d.openAlerts} open alert${d.openAlerts === 1 ? "" : "s"}`);
  if ((d.downPorts || 0) > 0) parts.push(`${d.downPorts} of ${d.portCount} ports down`);
  return parts.join(" · ");
};

/** "6m", "2h 14m" — how long the current outage has lasted. */
const downFor = (since: string | null | undefined): string => {
  if (!since) return "";
  const ms = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};
const STATE_META: Record<DState, { label: string; cls: string }> = {
  DOWN:    { label: "Down",    cls: "st-down" },
  WARN:    { label: "Warning", cls: "st-warn" },
  UP:      { label: "Up",      cls: "st-up" },
  PAUSED:  { label: "Paused",  cls: "st-paused" },
  UNKNOWN: { label: "Pending", cls: "st-unknown" },
};
/** Triage order: Down → alerts → Warning → Up → Paused. */
const TRIAGE: Record<DState, number> = { DOWN: 0, WARN: 1, UNKNOWN: 2, UP: 3, PAUSED: 4 };

const VIEW_KEY = "jb.ndm.devices.view";

/** Network devices (SNMP switches/routers) — list + add wizard. */
export default function DevicesPage() {
  const router = useRouter();
  const [devices, setDevices] = React.useState<NdmDevice[]>([]);
  const [stats, setStats] = React.useState<any>(null);
  const [err, setErr] = React.useState("");
  const [q, setQ] = React.useState("");
  const [dq, setDq] = React.useState("");           // debounced query
  const [wizard, setWizard] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [statusFilter, setStatusFilter] = React.useState<"ALL" | DState | "ALERTS">("ALL");
  const [groupFilter, setGroupFilter] = React.useState("ALL");
  const [methodFilter, setMethodFilter] = React.useState<"ALL" | "SNMP" | "ICMP" | "HTTP">("ALL");
  const [sortKey, setSortKey] = React.useState<"triage" | "name" | "ip" | "alerts" | "uptime" | "poll">("triage");
  const [view, setView] = React.useState<"table" | "cards">("table");
  const [groupBy, setGroupBy] = React.useState<"none" | "status" | "group">("none");
  const [selected, setSelected] = React.useState<number[]>([]);
  const [expanded, setExpanded] = React.useState<number | null>(null);
  const [busyIds, setBusyIds] = React.useState<number[]>([]);
  /** Device shown in the drawer. Held by id so live refreshes flow through. */
  const [drawerId, setDrawerId] = React.useState<number | null>(null);

  React.useEffect(() => {
    try { const v = localStorage.getItem(VIEW_KEY); if (v === "cards" || v === "table") setView(v); } catch {}
  }, []);
  const pickView = (v: "table" | "cards") => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch {} };

  // Debounce search so 500 rows don't re-filter on every keystroke.
  React.useEffect(() => { const t = setTimeout(() => setDq(q), 180); return () => clearTimeout(t); }, [q]);

  const load = React.useCallback(async () => {
    try { const r = await ndm.devices(); setErr(""); setLoaded(true); return r; }
    catch (e: any) { setErr(e?.message || "Could not load devices"); setLoaded(true); return []; }
  }, []);
  /**
   * MUST RETURN the stats, not set them.
   *
   * useNdmRefresh does `setter(await loader())`. This used to call setStats()
   * itself and return undefined, so the very next line wrote `undefined` over
   * the value it had just stored — every KPI fell back to 0 on each refresh.
   * Returning the object lets useNdmRefresh commit it, which is the contract
   * the hook expects (and how `load` already behaved).
   */
  const loadStats = React.useCallback(async () => {
    try { return await ndm.stats(); } catch { return null; }
  }, []);

  useNdmRefresh(load, setDevices, [load]);
  useNdmRefresh(loadStats, setStats, [loadStats], 30000);
  // Live: re-fetch on any push from the poller/syslog.
  useSSE({ onEvent: (t: string) => {
    // Commit both results — a bare `void load()` fetched the rows and threw
    // them away, so a live push only took effect on the next 15s poll.
    if (t === "ndm:event" || t === "ndm:alert" || t === "ndm:device" || t === "ndm:port") {
      void load().then(setDevices); void loadStats().then(setStats);
    }
  } });

  const groups = React.useMemo(
    () => [...new Set(devices.map((d) => d.groupName).filter(Boolean) as string[])].sort(),
    [devices]);

  const filtered = React.useMemo(() => {
    const terms = dq.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = devices.filter((d) => {
      const st = deviceState(d);
      if (statusFilter === "ALERTS") { if (!(d.openAlerts > 0)) return false; }
      else if (statusFilter !== "ALL" && st !== statusFilter) return false;
      if (groupFilter !== "ALL" && (d.groupName || "—") !== groupFilter) return false;
      if (methodFilter !== "ALL" && String(d.monitorMethod || "SNMP").toUpperCase() !== methodFilter) return false;
      if (!terms.length) return true;
      // Method is searchable too ("ping", "snmp") — a quick way to see one class.
      const hay = `${d.name} ${d.ip} ${realVendor(d.vendor)} ${d.deviceType || ""} ${d.groupName || ""} ${d.location || ""} ${methodOf(d).label}`.toLowerCase();
      return terms.every((w) => hay.includes(w));
    });
    const by = {
      triage: (a: NdmDevice, b: NdmDevice) =>
        TRIAGE[deviceState(a)] - TRIAGE[deviceState(b)] ||
        (b.openAlerts || 0) - (a.openAlerts || 0) ||
        a.name.localeCompare(b.name),
      name:   (a: NdmDevice, b: NdmDevice) => a.name.localeCompare(b.name),
      ip:     (a: NdmDevice, b: NdmDevice) => a.ip.localeCompare(b.ip, undefined, { numeric: true }),
      alerts: (a: NdmDevice, b: NdmDevice) => (b.openAlerts || 0) - (a.openAlerts || 0),
      uptime: (a: NdmDevice, b: NdmDevice) => Number(b.uptimeSec || 0) - Number(a.uptimeSec || 0),
      poll:   (a: NdmDevice, b: NdmDevice) =>
        new Date(b.lastSnmpPollAt || 0).getTime() - new Date(a.lastSnmpPollAt || 0).getTime(),
    }[sortKey];
    return [...rows].sort(by);
  }, [devices, dq, statusFilter, groupFilter, methodFilter, sortKey]);

  // Counts come from the device list so the chips always match the rows.
  const counts = React.useMemo(() => {
    const c = { ALL: devices.length, DOWN: 0, WARN: 0, UP: 0, PAUSED: 0, UNKNOWN: 0, ALERTS: 0 } as Record<string, number>;
    for (const d of devices) { c[deviceState(d)]++; if (d.openAlerts > 0) c.ALERTS++; }
    return c;
  }, [devices]);

  const ds = stats?.devices || { total: 0, reachable: 0, down: 0, ports: 0, upPorts: 0, downPorts: 0 };
  const downList = React.useMemo(() => devices.filter((d) => deviceState(d) === "DOWN"), [devices]);

  const setBusy = (id: number, on: boolean) =>
    setBusyIds((p) => (on ? [...p, id] : p.filter((x) => x !== id)));

  const checkNow = async (id: number) => {
    setBusy(id, true);
    try { await ndm.check(id); await new Promise((r) => setTimeout(r, 1200)); await load().then(setDevices); }
    catch (e: any) { setErr(e?.message || "Check failed"); }
    finally { setBusy(id, false); }
  };
  const patch = async (id: number, body: any) => {
    setBusy(id, true);
    try { await ndm.update(id, body); await load().then(setDevices); }
    catch (e: any) { setErr(e?.message || "Update failed"); }
    finally { setBusy(id, false); }
  };
  const removeDevice = async (d: NdmDevice) => {
    if (!confirm(`Delete "${d.name}" (${d.ip})? Its ports, syslog and alert history go with it.`)) return;
    setBusy(d.id, true);
    try { await ndm.remove(d.id); await load().then(setDevices); void loadStats().then(setStats); }
    catch (e: any) { setErr(e?.message || "Delete failed"); }
    finally { setBusy(d.id, false); }
  };

  /** Bulk actions run sequentially so one failure never hides the rest. */
  const bulk = async (fn: (id: number) => Promise<any>, label: string) => {
    const ids = [...selected];
    if (!ids.length) return;
    if (label === "Delete" && !confirm(`Delete ${ids.length} device(s)? This cannot be undone.`)) return;
    for (const id of ids) { try { await fn(id); } catch { /* keep going */ } }
    setSelected([]);
    await load().then(setDevices); void loadStats().then(setStats);
  };

  const allVisibleSelected = filtered.length > 0 && filtered.every((d) => selected.includes(d.id));
  const toggleAll = () =>
    setSelected(allVisibleSelected ? [] : filtered.map((d) => d.id));

  // Grouped rendering (collapsible sections) or one flat list.
  const sections = React.useMemo(() => {
    if (groupBy === "none") return [["", filtered]] as [string, NdmDevice[]][];
    const m = new Map<string, NdmDevice[]>();
    for (const d of filtered) {
      const k = groupBy === "status" ? STATE_META[deviceState(d)].label : (d.groupName || "Ungrouped");
      (m.get(k) || m.set(k, []).get(k)!).push(d);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered, groupBy]);

  const [collapsed, setCollapsed] = React.useState<string[]>([]);
  const toggleSection = (k: string) =>
    setCollapsed((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  return (
    <div className="ndm ndmx">
      <style>{NDMCSS}</style>
      <style>{DEVCSS}</style>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="ndmx-head">
        <div className="ndmx-head-l">
          <nav className="ndmx-crumb" aria-label="Breadcrumb">
            <Link href="/monitoring">Monitoring</Link><span aria-hidden="true">/</span><span>Network Devices</span>
          </nav>
          <h1>Network Devices</h1>
          <p>Monitor SNMP switches, routers, internet targets, ports, traffic, syslog events and alerts.</p>
        </div>
        <div className="ndmx-head-r">
          <NdmSoundBell />
          <Link className="ndm-btn" href="/monitoring/ports">Ports</Link>
          <Link className="ndm-btn" href="/monitoring/alerts">Alerts &amp; Rules</Link>
          <button className="ndm-btn pri" onClick={() => setWizard(true)}>+ Add device</button>
        </div>
      </div>

      {/* ── Tabs ───────────────────────────────────────────────── */}
      <div className="ndmx-tabs" role="tablist">
        <span className="tab active" role="tab" aria-selected="true">Devices</span>
        <Link className="tab" role="tab" aria-selected="false" href="/monitoring/ports">Ports</Link>
        <Link className="tab" role="tab" aria-selected="false" href="/monitoring/alerts">Alerts &amp; Rules</Link>
      </div>

      {/* ── 6 KPIs ─────────────────────────────────────────────── */}
      <div className="ndmx-kpis">
        <Kpi label="Total devices" value={ds.total}
          sub={`${counts.UP + counts.WARN + counts.DOWN + counts.UNKNOWN} active · ${counts.PAUSED} paused`} />
        <Kpi label="Reachable" value={ds.reachable} tone="ok"
          sub={ds.total ? `${Math.round((ds.reachable / ds.total) * 100)}% online` : "—"} />
        <Kpi label="Down" value={ds.down} tone={ds.down > 0 ? "bad" : undefined}
          sub={ds.down > 0 ? "needs attention" : "none"} />
        <Kpi label="Ports" value={`${ds.upPorts} / ${ds.ports}`} sub="up / monitored"
          bar={ds.ports ? (ds.upPorts / ds.ports) * 100 : 0} />
        <Kpi label="Open alerts" value={stats?.alerts?.open ?? 0}
          tone={(stats?.alerts?.open || 0) > 0 ? "bad" : undefined}
          sub={`${stats?.alerts?.critical ?? 0} critical`} />
        <Kpi label="Events &amp; syslog" value={(stats?.events?.last24h ?? 0) + (stats?.syslog?.last24h ?? 0)}
          sub="last 24 hours" />
      </div>

      {/* ── Health banner (data-driven) ────────────────────────── */}
      {loaded && devices.length > 0 && (
        downList.length > 0 ? (
          <div className="ndmx-banner bad" role="status">
            <div>
              <b>{downList.length} device{downList.length === 1 ? " is" : "s are"} currently unreachable</b>
              {/* Method split first: it tells the engineer whether this is an
                  SNMP problem or genuine loss of reachability. */}
              <span>
                {(() => {
                  const snmpDown = downList.filter((x) => isSnmp(x)).length;
                  const pingDown = downList.length - snmpDown;
                  return [
                    snmpDown ? `${snmpDown} SNMP device${snmpDown === 1 ? "" : "s"}` : "",
                    pingDown ? `${pingDown} ICMP target${pingDown === 1 ? "" : "s"}` : "",
                  ].filter(Boolean).join(" · ");
                })()}
                {" — "}
                {downList.slice(0, 3).map((d) => d.name).join(", ")}
                {downList.length > 3 ? ` +${downList.length - 3} more` : ""}
              </span>
            </div>
            <div className="ndmx-banner-actions">
              <button className="ndm-btn" onClick={() => { setStatusFilter("DOWN"); setGroupBy("none"); }}>View down devices</button>
              <button className="ndm-btn" onClick={() => downList.forEach((d) => void checkNow(d.id))}>Check all now</button>
            </div>
          </div>
        ) : (
          <div className="ndmx-banner ok" role="status">
            <div><b>All monitored devices are operating normally</b></div>
          </div>
        )
      )}

      {/* ── Sticky toolbar ─────────────────────────────────────── */}
      <div className="ndmx-toolbar">
        <div className="ndmx-search">
          <input
            aria-label="Search devices"
            placeholder="Search device name, IP address, type, group or location…"
            value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }} />
          {q && <button className="clr" aria-label="Clear search" onClick={() => setQ("")}>✕</button>}
        </div>

        <div className="ndmx-chips" role="group" aria-label="Filter by status">
          {([["ALL", "All"], ["DOWN", "Down"], ["WARN", "Warning"], ["UP", "Up"],
             ["PAUSED", "Paused"], ["ALERTS", "Has alerts"]] as const).map(([k, label]) => (
            <button key={k} aria-pressed={statusFilter === k}
              className={`chip ${statusFilter === k ? "on" : ""} ${String(k).toLowerCase()}`}
              onClick={() => setStatusFilter(k as any)}>
              {label} <em>{counts[k] ?? 0}</em>
            </button>
          ))}
        </div>

        <div className="ndmx-selects">
          <select aria-label="Filter by monitoring method" value={methodFilter}
            onChange={(e) => setMethodFilter(e.target.value as any)}>
            <option value="ALL">All monitoring</option>
            <option value="SNMP">SNMP</option>
            <option value="ICMP">ICMP Ping</option>
            <option value="HTTP">HTTP/HTTPS</option>
          </select>
          {groups.length > 0 && (
            <select aria-label="Filter by group" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
              <option value="ALL">Group: all</option>
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          )}
          <select aria-label="Sort by" value={sortKey} onChange={(e) => setSortKey(e.target.value as any)}>
            <option value="triage">Sort: triage (down first)</option>
            <option value="name">Name</option>
            <option value="ip">IP address</option>
            <option value="alerts">Open alerts</option>
            <option value="uptime">Uptime</option>
            <option value="poll">Last poll</option>
          </select>
          <select aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value as any)}>
            <option value="none">No grouping</option>
            <option value="status">Group by status</option>
            <option value="group">Group by group</option>
          </select>
          <div className="ndmx-view" role="group" aria-label="View">
            <button aria-pressed={view === "table"} className={view === "table" ? "on" : ""} onClick={() => pickView("table")}>Table</button>
            <button aria-pressed={view === "cards"} className={view === "cards" ? "on" : ""} onClick={() => pickView("cards")}>Cards</button>
          </div>
        </div>
      </div>

      {err && <div className="ndm-err ndmx-error" role="alert">
        {err} <button className="ndm-btn" onClick={() => { setErr(""); void load().then(setDevices); }}>Retry</button>
      </div>}

      {/* ── Bulk bar ───────────────────────────────────────────── */}
      {selected.length > 0 && (
        <div className="ndmx-bulk" role="region" aria-label="Bulk actions">
          <b>{selected.length} device{selected.length === 1 ? "" : "s"} selected</b>
          <button className="ndm-btn" onClick={() => bulk((id) => ndm.check(id), "Check")}>Check</button>
          <button className="ndm-btn" onClick={() => bulk((id) => ndm.update(id, { enabled: true }), "Resume")}>Resume</button>
          <button className="ndm-btn" onClick={() => bulk((id) => ndm.update(id, { enabled: false }), "Pause")}>Pause</button>
          <button className="ndm-btn" onClick={() => bulk((id) => ndm.update(id, { soundEnabled: false }), "Mute")}>Mute</button>
          <button className="ndm-btn" onClick={() => bulk((id) => ndm.update(id, { soundEnabled: true }), "Unmute")}>Unmute</button>
          <button className="ndm-btn danger" onClick={() => bulk((id) => ndm.remove(id), "Delete")}>Delete</button>
          <button className="ndm-btn" onClick={() => setSelected([])}>Clear</button>
        </div>
      )}

      {/* ── Body ───────────────────────────────────────────────── */}
      {!loaded ? (
        <div className="ndmx-skel" aria-busy="true" aria-label="Loading devices">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="row" />)}
        </div>
      ) : !devices.length ? (
        <div className="ndm-empty">
          <b>No network devices yet</b>
          <div style={{ marginTop: 6 }}>
            Add your first router, switch, server or internet target to start monitoring. The wizard tests the
            credentials live before anything is saved.
          </div>
          <div style={{ marginTop: 12 }}><button className="ndm-btn pri" onClick={() => setWizard(true)}>+ Add device</button></div>
        </div>
      ) : !filtered.length ? (
        <div className="ndm-empty">
          <b>No devices match your filters</b>
          <div style={{ marginTop: 12 }}>
            <button className="ndm-btn" onClick={() => { setQ(""); setStatusFilter("ALL"); setGroupFilter("ALL"); setMethodFilter("ALL"); }}>Clear filters</button>
          </div>
        </div>
      ) : view === "cards" ? (
        <div className="ndm-grid">
          {filtered.map((d) => (
            <DeviceCard key={d.id} d={d} onOpen={() => router.push(`/monitoring/devices/${d.id}`)}
              /* load() returns the rows; the caller must commit them to state,
                 otherwise a card action only took effect on the next poll. */
              onRefresh={() => { void load().then(setDevices); void loadStats().then(setStats); }} />
          ))}
        </div>
      ) : (
        sections.map(([sectionName, list]) => (
          <div key={sectionName || "all"} className="ndmx-section">
            {sectionName && (
              <button className="ndmx-section-h" onClick={() => toggleSection(sectionName)}
                aria-expanded={!collapsed.includes(sectionName)}>
                <span>{collapsed.includes(sectionName) ? "▸" : "▾"}</span> {sectionName}
                <em>{list.length}</em>
              </button>
            )}
            {!collapsed.includes(sectionName) && (
              <div className="ndmx-tablewrap">
                <table className="ndmx-table">
                  <thead>
                    <tr>
                      <th className="cbx">
                        <input type="checkbox" aria-label="Select all visible devices"
                          checked={allVisibleSelected} onChange={toggleAll} />
                      </th>
                      <th>Status</th><th>Device</th><th>Address</th><th>Monitoring</th>
                      <th>Ports</th><th>Uptime / RTT</th><th>Last check</th><th>Alerts</th>
                      <th className="ta-r">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((d) => (
                      <DeviceRow
                        key={d.id} d={d}
                        busy={busyIds.includes(d.id)}
                        selected={selected.includes(d.id)}
                        expanded={expanded === d.id}
                        onSelect={() => setSelected((p) => p.includes(d.id) ? p.filter((x) => x !== d.id) : [...p, d.id])}
                        onExpand={() => setExpanded((p) => (p === d.id ? null : d.id))}
                        onOpen={() => setDrawerId(d.id)}
                        onCheck={() => checkNow(d.id)}
                        onPatch={(b) => patch(d.id, b)}
                        onDelete={() => removeDevice(d)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))
      )}

      {/* Drawer is keyed off the LIVE row, so the 15s poll and SSE pushes keep
          its header/overview current while it is open. */}
      {drawerId != null && (() => {
        const dev = devices.find((x) => x.id === drawerId);
        if (!dev) return null;
        return (
          <DeviceDrawer
            d={dev}
            busy={busyIds.includes(dev.id)}
            onClose={() => setDrawerId(null)}
            onOpenFull={() => router.push(`/monitoring/devices/${dev.id}`)}
            onCheck={() => checkNow(dev.id)}
            onPatch={(b) => patch(dev.id, b)}
          />
        );
      })()}

      {wizard && <AddDeviceWizard onClose={() => setWizard(false)} onDone={() => { setWizard(false); void load().then(setDevices); void loadStats().then(setStats); }} />}
    </div>
  );
}

/**
 * DEVICE DRAWER — everything about one device, without leaving the list.
 *
 * Built against the typed `ndm` API methods rather than the /devices/[id]
 * page's internals, deliberately: that page keeps working untouched as the
 * deep-link target (and still owns Traffic and History, which need their own
 * time-range machinery). Refactoring it into shared components would have put
 * working tabs at risk for no gain here.
 *
 * Every tab fetches ONLY when first opened, and the result is cached for the
 * life of the drawer — opening a device must not pull ports, syslog, events and
 * alerts for a device the engineer only glanced at.
 */
function DeviceDrawer({ d, onClose, onOpenFull, onCheck, onPatch, busy }: {
  d: NdmDevice; onClose: () => void; onOpenFull: () => void;
  onCheck: () => void; onPatch: (b: any) => void; busy: boolean;
}) {
  type Tab = "overview" | "ports" | "alerts" | "syslog" | "events";
  const [tab, setTab] = React.useState<Tab>("overview");
  const [ports, setPorts] = React.useState<NdmPort[] | null>(null);
  const [alerts, setAlerts] = React.useState<NdmAlert[] | null>(null);
  const [syslog, setSyslog] = React.useState<SyslogRow[] | null>(null);
  const [events, setEvents] = React.useState<NdmEvent[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [tabErr, setTabErr] = React.useState("");
  const [sevFilter, setSevFilter] = React.useState("ALL");
  const [portQ, setPortQ] = React.useState("");

  const st = deviceState(d);
  const meta = STATE_META[st];

  // Close on Escape — expected of any drawer.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lazy-load the active tab once.
  React.useEffect(() => {
    let alive = true;
    const need =
      (tab === "ports" && ports === null) || (tab === "alerts" && alerts === null) ||
      (tab === "syslog" && syslog === null) || (tab === "events" && events === null);
    if (!need) return;
    setLoading(true); setTabErr("");
    (async () => {
      try {
        if (tab === "ports")  { const r = await ndm.ports(d.id); if (alive) setPorts(r); }
        if (tab === "alerts") { const r = await ndm.alerts({ deviceId: d.id, limit: 50 }); if (alive) setAlerts(r.rows || []); }
        if (tab === "syslog") { const r = await ndm.syslog({ deviceId: d.id, limit: 100 }); if (alive) setSyslog(r.rows || []); }
        if (tab === "events") { const r = await ndm.events({ deviceId: d.id, limit: 100 }); if (alive) setEvents(r.rows || []); }
      } catch (e: any) {
        if (alive) setTabErr(e?.message || "Could not load this tab");
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [tab, d.id, ports, alerts, syslog, events]);

  const ack = async (id: number) => {
    try { await ndm.ackAlert(id); setAlerts(await ndm.alerts({ deviceId: d.id, limit: 50 }).then((r) => r.rows || [])); }
    catch (e: any) { setTabErr(e?.message || "Acknowledge failed"); }
  };

  /** Only interfaces the poller actually monitors — PPPoE/dynamic stay out. */
  const visiblePorts = (ports || []).filter((p) => {
    if (!p.monitoringEnabled) return false;
    if (!portQ.trim()) return true;
    const hay = `${p.name} ${p.description || ""}`.toLowerCase();
    return portQ.trim().toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  });
  const excludedCount = (ports || []).length - (ports || []).filter((p) => p.monitoringEnabled).length;

  const visibleSyslog = (syslog || []).filter(
    (r) => sevFilter === "ALL" || String(r.severityName || "").toUpperCase() === sevFilter);

  return (
    <div className="ndmx-drawer-bg" onClick={onClose} role="dialog" aria-modal="true"
      aria-label={`Device ${d.name}`}>
      <div className="ndmx-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="ndmx-drawer-h">
          <div>
            <div className="ndmx-drawer-title">
              <span className={`ndmx-pill ${meta.cls}`}><i aria-hidden="true" /> {meta.label}</span>
              <b>{dash(d.name)}</b>
            </div>
            <div className="ndmx-drawer-sub">
              <span className="mono">{dash(d.ip)}</span>
              <span>·</span><span>{dash(d.deviceType || d.vendor)}</span>
              {d.groupName && <><span>·</span><span>{d.groupName}</span></>}
              {d.location && <><span>·</span><span>{d.location}</span></>}
            </div>
          </div>
          <div className="ndmx-drawer-actions">
            <button className="ndm-btn sm" onClick={onCheck} disabled={busy}>{busy ? "Checking…" : "Check now"}</button>
            <button className="ndm-btn sm" onClick={() => onPatch({ enabled: !d.enabled })}>{d.enabled ? "Pause" : "Resume"}</button>
            <button className="ndm-btn sm" onClick={onOpenFull} title="Traffic and history live on the full page">Full page</button>
            <button className="ndm-btn sm" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        <div className="ndmx-drawer-tabs" role="tablist">
          {/* Only tabs that apply to THIS method. An ICMP target has no
              interface table and receives no syslog, so offering those tabs
              would promise data that cannot exist. */}
          {(isSnmp(d)
            ? ([["overview", "Overview"], ["ports", "Ports"], ["alerts", "Alerts"],
                ["syslog", "Syslog"], ["events", "Events"]] as const)
            : ([["overview", "Overview"], ["alerts", "Alerts"], ["events", "Events"]] as const)
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k}
              className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {label}
              {k === "alerts" && d.openAlerts > 0 && <em>{d.openAlerts}</em>}
            </button>
          ))}
        </div>

        <div className="ndmx-drawer-body">
          {tabErr && <div className="ndm-err" role="alert">{tabErr}</div>}

          {tab === "overview" && (
            <>
              <div className="ndmx-exp-grid">
                <Field label="Monitoring" value={methodOf(d).label} />
                <Field label="Status" value={meta.label} />
                <Field label="Reachable" value={d.isReachable == null ? "Not checked yet" : d.isReachable ? "Yes" : "No"} />
                {isSnmp(d) ? (
                  <>
                    <Field label="SNMP uptime" value={d.uptimeSec ? fmtUptimeFull(d.uptimeSec) : "—"} />
                    <Field label="Ports up / total" value={d.portCount ? `${d.upPorts} / ${d.portCount}` : "—"} />
                    <Field label="Ports down" value={d.downPorts || 0} />
                    <Field label="Last syslog" value={d.lastSyslogAt ? fmtTime(d.lastSyslogAt) : "No syslog received"} />
                  </>
                ) : (
                  <>
                    <Field label="Response time" value={d.lastLatencyMs != null ? `${d.lastLatencyMs} ms` : "—"} />
                    {d.lastLossPct != null && <Field label="Packet loss" value={`${Math.round(d.lastLossPct)}%`} />}
                    <Field label="Last successful check" value={d.lastOkAt ? fmtTime(d.lastOkAt) : "Never"} />
                    {st === "DOWN" && <Field label="Down for" value={downFor(d.downSince) || "—"} />}
                  </>
                )}
                <Field label="Last check" value={d.lastSnmpPollAt ? fmtTime(d.lastSnmpPollAt) : "Never"} />
                <Field label="Open alerts" value={d.openAlerts || 0} />
                {realVendor(d.vendor) && <Field label="Vendor" value={realVendor(d.vendor)} />}
                <Field label="Monitoring" value={d.enabled ? "Enabled" : "Paused"} />
                <Field label="Alert sound" value={d.soundEnabled === false ? "Muted" : "On"} />
                <Field label="Recovery sound" value={d.soundUpEnabled === false ? "Off" : "On"} />
              </div>
              {d.lastError && <div className="ndmx-reason"><b>Last failure:</b> {dash(d.lastError)}</div>}
              {d.description && <div className="ndmx-desc">{dash(d.description)}</div>}
              <p className="ndmx-note">
                {isSnmp(d)
                  ? "Interface traffic graphs and the full event history live on the device page — they need their own time-range controls. "
                  : "This target is checked by ping, so there are no interface or traffic graphs. Event history lives on the device page. "}
                <button className="linkish strong" onClick={onOpenFull}>Open full page</button>
              </p>
            </>
          )}

          {tab === "ports" && (
            loading && ports === null ? <Skel rows={6} /> : (
              <>
                <div className="ndmx-drawer-tools">
                  <input placeholder="Filter interfaces…" value={portQ} onChange={(e) => setPortQ(e.target.value)}
                    aria-label="Filter interfaces" />
                  {excludedCount > 0 && (
                    <span className="muted" title="PPPoE / dynamic session interfaces are never monitored">
                      {excludedCount} excluded
                    </span>
                  )}
                </div>
                {!visiblePorts.length ? <div className="ndm-empty sm">No monitored interfaces.</div> : (
                  <table className="ndmx-table sub">
                    <thead><tr><th>Interface</th><th>Description</th><th>State</th><th>Speed</th><th>RX</th><th>TX</th></tr></thead>
                    <tbody>
                      {visiblePorts.map((p) => {
                        const s = portState(p);
                        return (
                          <tr key={p.id}>
                            <td className="mono">{dash(p.name)}</td>
                            <td className="muted">{dash(p.description)}</td>
                            <td><span className={`ndmx-pill ${s === "up" ? "st-up" : s === "down" ? "st-down" : ""}`}>
                              <i aria-hidden="true" /> {s === "disabled" ? "Disabled" : s === "up" ? "Up" : "Down"}
                            </span></td>
                            <td className="mono">{p.speedMbps ? `${p.speedMbps}M` : "—"}</td>
                            <td className="mono">{p.rxRateBps != null ? fmtBits(p.rxRateBps) : "—"}</td>
                            <td className="mono">{p.txRateBps != null ? fmtBits(p.txRateBps) : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </>
            )
          )}

          {tab === "alerts" && (
            loading && alerts === null ? <Skel rows={4} /> :
            !alerts?.length ? <div className="ndm-empty sm">No alerts for this device.</div> : (
              <div className="ndmx-list">
                {alerts.map((a) => (
                  <div key={a.id} className="ndmx-item">
                    <span className="sev" style={{ background: sevColor(a.severity) }} aria-hidden="true" />
                    <div className="body">
                      <b>{dash(a.title)}</b>
                      <span className="muted">{dash(a.message)}</span>
                      <span className="meta">
                        {dash(a.severity)} · {fmtTime(a.openedAt)} · {dash(a.status)}
                        {a.interfaceName ? ` · ${a.interfaceName}` : ""}
                      </span>
                    </div>
                    {a.status === "OPEN" && !a.acknowledgedAt && (
                      <button className="ndm-btn sm" onClick={() => ack(a.id)}>Acknowledge</button>
                    )}
                  </div>
                ))}
              </div>
            )
          )}

          {tab === "syslog" && (
            loading && syslog === null ? <Skel rows={6} /> : (
              <>
                <div className="ndmx-drawer-tools">
                  <select value={sevFilter} onChange={(e) => setSevFilter(e.target.value)} aria-label="Filter by severity">
                    <option value="ALL">All severities</option>
                    {["EMERGENCY", "ALERT", "CRITICAL", "ERROR", "WARNING", "NOTICE", "INFORMATIONAL", "DEBUG"]
                      .map((s) => <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()}</option>)}
                  </select>
                </div>
                {!visibleSyslog.length ? (
                  <div className="ndm-empty sm">
                    {syslog?.length ? "No messages at that severity." : "No syslog received from this device."}
                  </div>
                ) : (
                  <table className="ndmx-table sub">
                    <thead><tr><th>Time</th><th>Severity</th><th>Tag</th><th>Message</th></tr></thead>
                    <tbody>
                      {visibleSyslog.map((r) => (
                        <tr key={r.id}>
                          <td className="mono nowrap">{fmtTime(r.receivedAt)}</td>
                          <td><span style={{ color: sevColor(r.severityName), fontWeight: 700 }}>{dash(r.severityName)}</span></td>
                          <td className="mono">{dash(r.tag)}</td>
                          <td>{dash(r.message)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )
          )}

          {tab === "events" && (
            loading && events === null ? <Skel rows={5} /> :
            !events?.length ? <div className="ndm-empty sm">No events recorded for this device.</div> : (
              <div className="ndmx-list">
                {events.map((e) => (
                  <div key={e.id} className="ndmx-item">
                    <span className="sev" style={{ background: sevColor(e.severity) }} aria-hidden="true" />
                    <div className="body">
                      <b>{dash(e.label || e.eventType)}</b>
                      <span className="muted">{dash(e.message)}</span>
                      <span className="meta">
                        {fmtTime(e.createdAt)} · {dash(e.status)}
                        {e.interfaceName ? ` · ${e.interfaceName}` : ""}
                        {e.count > 1 ? ` · ×${e.count}` : ""}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function Skel({ rows }: { rows: number }) {
  return (
    <div className="ndmx-skel" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="row" />)}
    </div>
  );
}

function Kpi({ label, value, sub, tone, bar }: {
  label: string; value: any; sub?: string; tone?: "ok" | "bad"; bar?: number;
}) {
  return (
    <div className={`ndmx-kpi ${tone || ""}`}>
      <span className="k">{label}</span>
      <b className="v">{dash(value)}</b>
      {bar !== undefined && (
        <div className="ndmx-bar" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} /></div>
      )}
      {sub && <span className="s">{sub}</span>}
    </div>
  );
}

/**
 * One device row. Dense by default; expands in place for the detail an engineer
 * needs during triage (why it is down, when it last answered) WITHOUT a page
 * load. The full drawer/page stays one click away for everything else.
 */
function DeviceRow({ d, busy, selected, expanded, onSelect, onExpand, onOpen, onCheck, onPatch, onDelete }: {
  d: NdmDevice; busy: boolean; selected: boolean; expanded: boolean;
  onSelect: () => void; onExpand: () => void; onOpen: () => void;
  onCheck: () => void; onPatch: (b: any) => void; onDelete: () => void;
}) {
  const [menu, setMenu] = React.useState(false);
  const st = deviceState(d);
  const meta = STATE_META[st];
  const portPct = d.portCount ? (d.upPorts / d.portCount) * 100 : 0;
  const method = methodOf(d);
  const snmp = isSnmp(d);
  const vendor = realVendor(d.vendor);
  const reason = warnReason(d);

  return (
    <>
      <tr className={`${meta.cls} ${selected ? "sel" : ""}`}>
        <td className="cbx">
          <input type="checkbox" checked={selected} onChange={onSelect}
            aria-label={`Select ${d.name}`} onClick={(e) => e.stopPropagation()} />
        </td>
        <td>
          <span className={`ndmx-pill ${meta.cls}`}>
            <i aria-hidden="true" /> {meta.label}
          </span>
          {st === "WARN" && reason && <span className="ndmx-why" title={reason}>{reason}</span>}
          {st === "DOWN" && d.downSince && <span className="ndmx-why">for {downFor(d.downSince)}</span>}
        </td>
        <td className="nm">
          <button className="linkish" onClick={onExpand} aria-expanded={expanded}
            title={expanded ? "Collapse" : "Show quick details"}>{expanded ? "▾" : "▸"}</button>
          <button className="linkish strong" onClick={onOpen} title="Open device">{dash(d.name)}</button>
          {/* Secondary line only when there is something real to say — no
              trailing "· —" next to every device name. */}
          {(d.deviceType || d.location) && (
            <div className="ndmx-sub">{[d.deviceType, d.location].filter(Boolean).join(" · ")}</div>
          )}
        </td>
        <td className="mono">{dash(d.ip)}</td>
        <td className="muted">
          {/* Method first: it is what tells an engineer whether a failure is an
              SNMP problem or a reachability problem. */}
          {method.label}
          {vendor && <span className="dimmer"> · {vendor}</span>}
          {d.groupName && <span className="dimmer"> · {d.groupName}</span>}
        </td>
        <td>
          {!snmp ? (
            <span className="muted" title="Ports come from SNMP — this target is not SNMP-polled">—</span>
          ) : d.portCount ? (
            <div className="ndmx-ports">
              <span>{d.upPorts}/{d.portCount}</span>
              <div className="ndmx-bar sm" aria-hidden="true"><i className={d.downPorts ? "warn" : ""} style={{ width: `${portPct}%` }} /></div>
            </div>
          ) : <span className="muted">—</span>}
        </td>
        <td className="mono">
          {snmp && d.uptimeSec ? fmtUptimeFull(d.uptimeSec)
            : !snmp && d.lastLatencyMs != null ? `${d.lastLatencyMs} ms`
            : <span className="muted">—</span>}
        </td>
        <td className="muted">{d.lastSnmpPollAt ? fmtTime(d.lastSnmpPollAt) : "—"}</td>
        <td>{d.openAlerts > 0 ? <span className="ndmx-alerts">{d.openAlerts}</span> : <span className="muted">—</span>}</td>
        <td className="ta-r nowrap">
          <button className="ndm-btn sm" onClick={onCheck} disabled={busy}>{busy ? "Checking…" : "Check now"}</button>
          <span className="ndmx-menu">
            <button className="ndm-btn sm" aria-haspopup="true" aria-expanded={menu}
              onClick={() => setMenu((m) => !m)} aria-label={`More actions for ${d.name}`}>⋮</button>
            {menu && (
              <>
                <span className="ndmx-menu-bg" onClick={() => setMenu(false)} />
                <span className="ndmx-menu-pop" role="menu">
                  <button role="menuitem" onClick={() => { setMenu(false); onOpen(); }}>Open details</button>
                  <button role="menuitem" onClick={() => { setMenu(false); onPatch({ enabled: !d.enabled }); }}>
                    {d.enabled ? "Pause polling" : "Resume polling"}
                  </button>
                  <button role="menuitem" onClick={() => { setMenu(false); onPatch({ soundEnabled: d.soundEnabled === false }); }}>
                    {d.soundEnabled === false ? "Unmute alerts" : "Mute alerts"}
                  </button>
                  <button role="menuitem" onClick={() => { setMenu(false); onPatch({ soundUpEnabled: d.soundUpEnabled === false }); }}>
                    {d.soundUpEnabled === false ? "Enable recovery sound" : "Silence recovery sound"}
                  </button>
                  <button role="menuitem" className="danger" onClick={() => { setMenu(false); onDelete(); }}>Delete device</button>
                </span>
              </>
            )}
          </span>
        </td>
      </tr>

      {expanded && (
        <tr className="ndmx-exp">
          <td colSpan={10}>
            {/* Only the fields that MEAN something for this method. A ping
                target has no ports, no SNMP uptime and no syslog — printing
                them as "—" is noise that hides the fields that do matter. */}
            <div className="ndmx-exp-grid">
              <Field label="Monitoring" value={method.label} />
              <Field label="State" value={meta.label} />
              {st === "WARN" && reason && <Field label="Warning reason" value={reason} />}
              {vendor && <Field label="Vendor" value={vendor} />}
              {d.groupName && <Field label="Group" value={d.groupName} />}
              {d.location && <Field label="Location" value={d.location} />}

              {snmp ? (
                <>
                  <Field label="Ports up / total" value={d.portCount ? `${d.upPorts} / ${d.portCount}` : "—"} />
                  <Field label="Ports down" value={d.downPorts || 0} />
                  <Field label="SNMP uptime" value={d.uptimeSec ? fmtUptimeFull(d.uptimeSec) : "—"} />
                  <Field label="Last syslog" value={d.lastSyslogAt ? fmtTime(d.lastSyslogAt) : "No syslog received"} />
                </>
              ) : (
                <>
                  <Field label="Response time" value={d.lastLatencyMs != null ? `${d.lastLatencyMs} ms` : "—"} />
                  {d.lastLossPct != null && <Field label="Packet loss" value={`${Math.round(d.lastLossPct)}%`} />}
                  <Field label="Last successful check" value={d.lastOkAt ? fmtTime(d.lastOkAt) : "Never"} />
                  {st === "DOWN" && <Field label="Down for" value={downFor(d.downSince) || "—"} />}
                </>
              )}

              <Field label="Last check" value={d.lastSnmpPollAt ? fmtTime(d.lastSnmpPollAt) : "Never"} />
              <Field label="Open alerts" value={d.openAlerts || 0} />
              <Field label="Monitoring" value={d.enabled ? "Enabled" : "Paused"} />
              <Field label="Alert sound" value={d.soundEnabled === false ? "Muted" : "On"} />
            </div>
            {d.lastError && (
              <div className="ndmx-reason">
                <b>Last failure:</b> {dash(d.lastError)}
              </div>
            )}
            {d.description && <div className="ndmx-desc">{dash(d.description)}</div>}
            <div className="ndmx-exp-actions">
              <button className="ndm-btn pri sm" onClick={onOpen}>Open device</button>
              <button className="ndm-btn sm" onClick={onCheck} disabled={busy}>{busy ? "Checking…" : "Check now"}</button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Field({ label, value }: { label: string; value: any }) {
  return (
    <div className="ndmx-field">
      <span>{label}</span>
      <b>{dash(value)}</b>
    </div>
  );
}

/** Scoped styles for the redesigned list. Uses the existing NDM CSS variables. */
const DEVCSS = `
.ndmx{--r:8px}
.ndmx-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:14px}
.ndmx-crumb{font-size:11.5px;color:var(--muted);display:flex;gap:6px;align-items:center;margin-bottom:4px}
.ndmx-crumb a{color:var(--muted);text-decoration:none}
.ndmx-crumb a:hover{color:var(--accent,#3C50E0)}
.ndmx-head-l h1{margin:0;font-size:20px;font-weight:800;letter-spacing:-.01em}
.ndmx-head-l p{margin:4px 0 0;font-size:12.5px;color:var(--muted);max-width:70ch}
.ndmx-head-r{display:flex;gap:8px;align-items:center;flex-wrap:wrap}

.ndmx-tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:14px}
.ndmx-tabs .tab{padding:8px 14px;font-size:13px;font-weight:600;color:var(--muted);text-decoration:none;
  border-bottom:2px solid transparent;margin-bottom:-1px}
.ndmx-tabs .tab:hover{color:var(--text)}
.ndmx-tabs .tab.active{color:var(--accent,#3C50E0);border-bottom-color:var(--accent,#3C50E0)}

.ndmx-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.ndmx-kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;
  display:flex;flex-direction:column;gap:3px}
.ndmx-kpi .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700}
.ndmx-kpi .v{font-size:20px;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums}
.ndmx-kpi .s{font-size:11px;color:var(--muted)}
.ndmx-kpi.ok .v{color:var(--online,#157F43)}
.ndmx-kpi.bad{border-color:var(--danger,#B02A37)}
.ndmx-kpi.bad .v{color:var(--danger,#B02A37)}
.ndmx-bar{height:4px;background:var(--border);border-radius:99px;overflow:hidden;margin:3px 0 1px}
.ndmx-bar i{display:block;height:100%;background:var(--online,#157F43)}
.ndmx-bar i.warn{background:var(--warning,#B45309)}
.ndmx-bar.sm{width:56px;margin:0}

.ndmx-banner{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;
  border:1px solid var(--border);border-radius:var(--r);padding:10px 14px;margin-bottom:12px;font-size:13px}
.ndmx-banner b{display:block}
.ndmx-banner span{font-size:11.5px;color:var(--muted)}
.ndmx-banner.bad{border-color:var(--danger,#B02A37);background:rgba(176,42,55,.06)}
.ndmx-banner.bad b{color:var(--danger,#B02A37)}
.ndmx-banner.ok{border-color:rgba(21,127,67,.35);background:rgba(21,127,67,.05)}
.ndmx-banner.ok b{color:var(--online,#157F43)}
.ndmx-banner-actions{display:flex;gap:6px;flex-wrap:wrap}

.ndmx-toolbar{position:sticky;top:0;z-index:20;background:var(--bg,var(--surface));padding:8px 0;
  display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--border);margin-bottom:10px}
.ndmx-search{position:relative;flex:1;min-width:240px;display:flex;align-items:center}
.ndmx-search input{width:100%;border:1px solid var(--border);border-radius:var(--r);padding:8px 30px 8px 10px;
  background:var(--surface);color:var(--text);font-size:13px}
.ndmx-search input:focus{outline:none;border-color:var(--accent,#3C50E0);box-shadow:0 0 0 3px rgba(60,80,224,.12)}
.ndmx-search .clr{position:absolute;right:6px;border:none;background:none;color:var(--muted);cursor:pointer}
.ndmx-chips{display:flex;gap:5px;flex-wrap:wrap}
.ndmx-chips .chip{border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:99px;
  padding:5px 11px;font-size:11.5px;font-weight:700;cursor:pointer;display:inline-flex;gap:5px;align-items:center}
.ndmx-chips .chip em{font-style:normal;opacity:.65;font-variant-numeric:tabular-nums}
.ndmx-chips .chip:hover{border-color:var(--accent,#3C50E0);color:var(--accent,#3C50E0)}
.ndmx-chips .chip.on{background:var(--accent,#3C50E0);border-color:var(--accent,#3C50E0);color:#fff}
.ndmx-chips .chip.on em{opacity:.85}
.ndmx-chips .chip.down.on{background:var(--danger,#B02A37);border-color:var(--danger,#B02A37)}
.ndmx-chips .chip.up.on{background:var(--online,#157F43);border-color:var(--online,#157F43)}
.ndmx-selects{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ndmx-selects select{border:1px solid var(--border);border-radius:var(--r);padding:6px 8px;background:var(--surface);
  color:var(--text);font-size:12px;cursor:pointer}
.ndmx-view{display:inline-flex;border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
.ndmx-view button{border:none;background:var(--surface);color:var(--muted);font-size:12px;font-weight:600;
  padding:6px 11px;cursor:pointer}
.ndmx-view button.on{background:var(--accent,#3C50E0);color:#fff}

.ndmx-bulk{display:flex;gap:6px;align-items:center;flex-wrap:wrap;background:var(--surface);
  border:1px solid var(--accent,#3C50E0);border-radius:var(--r);padding:8px 12px;margin-bottom:10px;font-size:12.5px}
.ndmx-error{display:flex;gap:10px;align-items:center;margin-bottom:10px}

.ndmx-section{margin-bottom:12px}
.ndmx-section-h{display:flex;gap:8px;align-items:center;width:100%;text-align:left;background:none;border:none;
  color:var(--text);font-size:13px;font-weight:700;padding:6px 2px;cursor:pointer}
.ndmx-section-h em{font-style:normal;font-weight:600;color:var(--muted);font-size:11.5px}

.ndmx-tablewrap{border:1px solid var(--border);border-radius:var(--r);overflow-x:auto;background:var(--surface)}
.ndmx-table{width:100%;border-collapse:collapse;font-size:12.5px}
.ndmx-table th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);
  font-weight:700;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap;
  position:sticky;top:0;background:var(--surface);z-index:1}
.ndmx-table td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
.ndmx-table tbody tr:hover{background:rgba(127,127,127,.05)}
.ndmx-table tr.sel{background:rgba(60,80,224,.06)}
.ndmx-table tr.st-down td{box-shadow:inset 3px 0 0 var(--danger,#B02A37)}
.ndmx-table tr.st-warn td{box-shadow:inset 3px 0 0 var(--warning,#B45309)}
.ndmx-table .cbx{width:30px}
.ndmx-table .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.ndmx-table .muted{color:var(--muted)}
.ndmx-table .ta-r{text-align:right}
.ndmx-table .nowrap{white-space:nowrap}
.ndmx-table .nm{min-width:180px}
.linkish{background:none;border:none;color:var(--text);cursor:pointer;font-size:12.5px;padding:0 2px}
.linkish.strong{font-weight:700}
.linkish:hover{color:var(--accent,#3C50E0);text-decoration:underline}

.ndmx-pill{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:800;text-transform:uppercase;
  letter-spacing:.04em;border-radius:99px;padding:2px 9px;border:1px solid var(--border);color:var(--muted)}
.ndmx-pill i{width:7px;height:7px;border-radius:99px;background:currentColor;display:inline-block}
.ndmx-pill.st-down{color:var(--danger,#B02A37);border-color:rgba(176,42,55,.4);background:rgba(176,42,55,.08)}
.ndmx-pill.st-warn{color:var(--warning,#B45309);border-color:rgba(180,83,9,.4);background:rgba(180,83,9,.08)}
.ndmx-pill.st-up{color:var(--online,#157F43);border-color:rgba(21,127,67,.35);background:rgba(21,127,67,.07)}
.ndmx-ports{display:flex;align-items:center;gap:7px;font-variant-numeric:tabular-nums}
/* Secondary line under a device name — only rendered when there is real
   content, so no row ever ends in a stray "· —". */
.ndmx-sub{font-size:10.5px;color:var(--muted);margin-left:20px;margin-top:1px}
/* Why a row is amber/red, next to the badge. A status without a reason is
   noise an engineer learns to ignore. */
.ndmx-why{display:block;font-size:10px;color:var(--muted);margin-top:2px;max-width:190px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dimmer{opacity:.7}
.ndmx-alerts{display:inline-block;min-width:20px;text-align:center;background:rgba(176,42,55,.12);
  color:var(--danger,#B02A37);border:1px solid rgba(176,42,55,.35);border-radius:99px;padding:1px 7px;font-weight:800}

.ndmx-menu{position:relative;display:inline-block;margin-left:4px}
.ndmx-menu-bg{position:fixed;inset:0;z-index:30}
.ndmx-menu-pop{position:absolute;right:0;top:calc(100% + 4px);z-index:31;background:var(--surface);
  border:1px solid var(--border);border-radius:var(--r);box-shadow:0 10px 30px rgba(0,0,0,.25);
  display:flex;flex-direction:column;min-width:190px;padding:4px;text-align:left}
.ndmx-menu-pop button{background:none;border:none;text-align:left;padding:7px 10px;font-size:12.5px;
  color:var(--text);cursor:pointer;border-radius:6px;white-space:nowrap}
.ndmx-menu-pop button:hover{background:rgba(127,127,127,.1)}
.ndmx-menu-pop button.danger{color:var(--danger,#B02A37)}

.ndmx-exp td{background:rgba(127,127,127,.04)}
.ndmx-exp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 16px;padding:4px 0 8px}
.ndmx-field{display:flex;flex-direction:column;gap:1px}
.ndmx-field span{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700}
.ndmx-field b{font-size:12.5px;font-weight:600}
.ndmx-reason{font-size:12px;color:var(--danger,#B02A37);background:rgba(176,42,55,.07);
  border:1px solid rgba(176,42,55,.3);border-radius:6px;padding:6px 10px;margin-bottom:8px}
.ndmx-desc{font-size:12px;color:var(--muted);margin-bottom:8px}
.ndmx-exp-actions{display:flex;gap:6px;flex-wrap:wrap}
.ndm-btn.sm{padding:4px 10px;font-size:11.5px}
.ndm-btn.danger{color:var(--danger,#B02A37);border-color:rgba(176,42,55,.4)}

.ndmx-skel .row{height:38px;border:1px solid var(--border);border-radius:var(--r);margin-bottom:6px;
  background:linear-gradient(90deg,rgba(127,127,127,.06),rgba(127,127,127,.14),rgba(127,127,127,.06));
  background-size:200% 100%;animation:ndmxsk 1.2s ease-in-out infinite}
@keyframes ndmxsk{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* ── Device drawer ── */
.ndmx-drawer-bg{position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.42);backdrop-filter:blur(2px);
  display:flex;justify-content:flex-end}
.ndmx-drawer{width:min(760px,96vw);height:100%;background:var(--surface);border-left:1px solid var(--border);
  display:flex;flex-direction:column;box-shadow:-16px 0 44px rgba(0,0,0,.35)}
.ndmx-drawer-h{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;
  padding:14px 18px;border-bottom:1px solid var(--border)}
.ndmx-drawer-title{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.ndmx-drawer-title b{font-size:16px;font-weight:800}
.ndmx-drawer-sub{display:flex;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin-top:4px}
.ndmx-drawer-actions{display:flex;gap:6px;flex-wrap:wrap}
.ndmx-drawer-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--border);overflow-x:auto}
.ndmx-drawer-tabs button{background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-1px;
  padding:9px 12px;font-size:12.5px;font-weight:600;color:var(--muted);cursor:pointer;white-space:nowrap;
  display:inline-flex;align-items:center;gap:6px}
.ndmx-drawer-tabs button:hover{color:var(--text)}
.ndmx-drawer-tabs button.on{color:var(--accent,#3C50E0);border-bottom-color:var(--accent,#3C50E0)}
.ndmx-drawer-tabs button em{font-style:normal;font-size:10px;font-weight:800;background:rgba(176,42,55,.14);
  color:var(--danger,#B02A37);border-radius:99px;padding:1px 6px}
.ndmx-drawer-body{flex:1;overflow:auto;padding:14px 18px}
.ndmx-drawer-tools{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.ndmx-drawer-tools input,.ndmx-drawer-tools select{border:1px solid var(--border);border-radius:var(--r);
  padding:6px 9px;background:var(--surface);color:var(--text);font-size:12.5px}
.ndmx-drawer-tools input{flex:1;min-width:160px}
.ndmx-note{font-size:11.5px;color:var(--muted);margin-top:12px;line-height:1.6}
.ndmx-table.sub{font-size:12px}
.ndmx-table.sub th{position:static}
.ndm-empty.sm{padding:18px;font-size:12.5px}
.ndmx-list{display:flex;flex-direction:column;gap:6px}
.ndmx-item{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border);border-radius:var(--r);
  padding:9px 11px}
.ndmx-item .sev{width:3px;align-self:stretch;border-radius:99px;flex:none}
.ndmx-item .body{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}
.ndmx-item .body b{font-size:12.5px}
.ndmx-item .body .muted{font-size:12px;color:var(--muted);word-break:break-word}
.ndmx-item .body .meta{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}

@media (max-width:900px){
  .ndmx-table th:nth-child(5),.ndmx-table td:nth-child(5),
  .ndmx-table th:nth-child(7),.ndmx-table td:nth-child(7){display:none}
}
@media (max-width:640px){
  .ndmx-table th:nth-child(6),.ndmx-table td:nth-child(6),
  .ndmx-table th:nth-child(8),.ndmx-table td:nth-child(8){display:none}
  .ndmx-search{min-width:100%}
  .ndmx-toolbar{position:static}
}
`;

function DeviceCard({ d, onOpen, onRefresh }: { d: NdmDevice; onOpen: () => void; onRefresh: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const state = !d.enabled ? "off" : d.isReachable === null ? "wait" : d.isReachable ? "up" : "down";
  const color = { off: "#94A3B8", wait: "#8A6209", up: "#219653", down: "#D34053" }[state];
  const label = { off: "Paused", wait: "First check…", up: "Reachable", down: "DOWN" }[state];
  const check = async (e: React.MouseEvent) => {
    e.stopPropagation(); setBusy(true);
    try { await ndm.check(d.id); await new Promise((r) => setTimeout(r, 1500)); onRefresh(); }
    finally { setBusy(false); }
  };
  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await ndm.update(d.id, { enabled: !d.enabled }); onRefresh();
  };
  const toggleSound = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await ndm.update(d.id, { soundEnabled: d.soundEnabled !== false ? false : true }); onRefresh();
  };
  const toggleUpSound = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await ndm.update(d.id, { soundUpEnabled: d.soundUpEnabled !== false ? false : true }); onRefresh();
  };
  const remove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Disable "${d.name}"? It keeps its history but stops polling and alerts. You can re-enable it any time.`)) return;
    await ndm.remove(d.id); onRefresh();
  };
  return (
    <div className="ndm-card ndm-device" onClick={onOpen}>
      <div className="ndm-card-h">
        <b className="ndm-name"><span className="ndm-dot" style={{ background: color }} />{d.name}</b>
        <SeverityPill label={label} color={color} />
      </div>
      <div className="ndm-card-sub">{d.ip}{d.vendor !== "OTHER" ? ` · ${d.vendor}` : ""}{d.groupName ? ` · ${d.groupName}` : ""}{d.deviceType ? ` · ${d.deviceType}` : ""}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, margin: "12px 0" }}>
        <MiniStat label="Ports up" value={`${d.upPorts} / ${d.interfaceCount}`} color="var(--online)" />
        <MiniStat label="Open alerts" value={d.openAlerts} color={d.openAlerts ? "var(--danger)" : "var(--muted)"} />
        <MiniStat label="Uptime" value={fmtUptimeFull(d.uptimeSec)} />
        <MiniStat label="Last poll" value={fmtTime(d.lastSnmpPollAt)} />
      </div>
      {d.lastError && <div className="ndm-err" style={{ fontSize: 11 }} title={d.lastError}>{d.lastError.slice(0, 90)}</div>}
      <div className="ndm-row-actions" style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
        <button className="ndm-btn" onClick={check} disabled={busy}>{busy ? "Polling…" : "Check now"}</button>
        <button className="ndm-btn" onClick={toggleSound} title={d.soundEnabled !== false ? "Port alert sound ON — click to mute this device" : "Sound OFF — click to enable"}>
          {d.soundEnabled !== false ? "🔔" : "🔕"}
        </button>
        <button className="ndm-btn" onClick={toggleUpSound} title={d.soundUpEnabled !== false ? "Recovery (PORT UP) chime ON — click to mute" : "Recovery chime OFF — click to enable"}>
          {d.soundUpEnabled !== false ? "▲🔔" : "▲🔕"}
        </button>
        <button className="ndm-btn" onClick={toggle}>{d.enabled ? "Pause" : "Enable"}</button>
        <button className="ndm-btn danger" onClick={remove}>Disable…</button>
      </div>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: any; color?: string }) {
  return <div style={{ fontSize: 11 }}><span style={{ color: "var(--muted)" }}>{label}</span> <b style={{ color: color || "var(--text)" }}>{value}</b></div>;
}

function SeverityPill({ label, color }: { label: string; color: string }) {
  return <span style={{ fontSize: 10.5, fontWeight: 700, color, border: `1px solid ${color}55`, borderRadius: 999, padding: "2px 8px" }}>{label}</span>;
}

// ── Add-device wizard: details → test → discover → save ───────────
type WizardState = {
  name: string; ip: string; vendor: string; deviceType: string; groupName: string; location: string; description: string;
  /** SNMP | ICMP | HTTP — decides what is polled and which fields apply. */
  monitorMethod: string;
  snmpVersion: string; snmpPort: string; pollIntervalSec: string; community: string;
  v3Username: string; v3AuthProto: string; v3AuthKey: string; v3PrivProto: string; v3PrivKey: string;
  syslogEnabled: boolean; syslogProtocol: string; syslogPort: string;
  snmpTimeoutMs: string; snmpRetries: string;
};

function AddDeviceWizard({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = React.useState<WizardState>({
    name: "", ip: "", vendor: "OTHER", deviceType: "", groupName: "", location: "", description: "",
    monitorMethod: "SNMP",
    snmpVersion: "V2C", snmpPort: "161", pollIntervalSec: "30", community: "public",
    v3Username: "", v3AuthProto: "SHA", v3AuthKey: "", v3PrivProto: "AES", v3PrivKey: "",
    syslogEnabled: false, syslogProtocol: "UDP", syslogPort: "514", snmpTimeoutMs: "5000", snmpRetries: "1",
  });
  const [step, setStep] = React.useState<1 | 2 | 3>(1);
  const [testing, setTesting] = React.useState(false);
  const [testRes, setTestRes] = React.useState<any>(null);
  const [discovered, setDiscovered] = React.useState<any[] | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState("");

  const set = (k: keyof WizardState, v: any) => setF((p) => ({ ...p, [k]: v }));
  const testBody = () => ({
    ip: f.ip.trim(), snmpVersion: f.snmpVersion, snmpPort: Number(f.snmpPort) || 161,
    community: f.snmpVersion === "V2C" ? f.community.trim() : undefined,
    v3Username: f.snmpVersion === "V3" ? f.v3Username.trim() || undefined : undefined,
    v3AuthProto: f.snmpVersion === "V3" ? f.v3AuthProto : undefined,
    v3AuthKey: f.snmpVersion === "V3" ? f.v3AuthKey || undefined : undefined,
    v3PrivProto: f.snmpVersion === "V3" ? (f.v3PrivKey ? f.v3PrivProto : undefined) : undefined,
    v3PrivKey: f.snmpVersion === "V3" ? f.v3PrivKey || undefined : undefined,
    snmpTimeoutMs: Number(f.snmpTimeoutMs) || 5000, snmpRetries: Number(f.snmpRetries) || 1,
  });

  const test = async () => {
    if (!f.ip.trim()) { setErr("Enter the device IP first."); return; }
    setTesting(true); setErr(""); setTestRes(null);
    try {
      const r = await ndm.test(testBody());
      setTestRes(r);
      if (r.ok && !f.name.trim()) setF((p) => ({ ...p, name: r.sysName || p.ip }));
    } catch (e: any) { setTestRes({ ok: false, error: e?.message }); }
    finally { setTesting(false); }
  };
  const discover = async () => {
    setTesting(true); setErr("");
    try {
      const r = await ndm.discover(testBody());
      if (!r.ok || !r.interfaces) setErr(r.error || "Discovery failed — no SNMP response.");
      else { setDiscovered(r.interfaces); setStep(3); }
    } catch (e: any) { setErr(e?.message || "Discovery failed"); }
    finally { setTesting(false); }
  };
  const save = async () => {
    setSaving(true); setErr("");
    try {
      await ndm.create({
        ...testBody(), name: f.name.trim() || f.ip.trim(),
        monitorMethod: f.monitorMethod,
        vendor: f.vendor, deviceType: f.deviceType.trim() || null, groupName: f.groupName.trim() || null,
        location: f.location.trim() || null, description: f.description.trim() || null,
        pollIntervalSec: Number(f.pollIntervalSec) || 30,
        syslogEnabled: f.syslogEnabled, syslogProtocol: f.syslogProtocol, syslogPort: Number(f.syslogPort) || 514,
      });
      onDone();
    } catch (e: any) { setErr(e?.message || "Could not save device"); }
    finally { setSaving(false); }
  };

  const ipOk = /^(\d{1,3}\.){3}\d{1,3}$|^[a-zA-Z0-9.-]{1,253}$/.test(f.ip.trim());

  return (
    <NdmModal title="Add network device" onClose={onClose} wide>
      {/* Step indicator */}
      <div className="ndm-ranges">
        {(["Details", "Test & Discover", "Confirm"] as const).map((s, i) => (
          <button key={s} className={step === i + 1 ? "on" : ""}>{i + 1}. {s}</button>
        ))}
      </div>

      {step === 1 && (
        <>
          <div className="ndm-form">
            <div className="ndm-grid2">
              <div className="ndm-field"><label>IP address *</label>
                <input placeholder="192.168.1.10" value={f.ip} onChange={(e) => set("ip", e.target.value)} /></div>
              <div className="ndm-field"><label>Name (optional)</label>
                <input placeholder="Core switch racks 1-2" value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
              <div className="ndm-field"><label>Vendor</label>
                <select value={f.vendor} onChange={(e) => set("vendor", e.target.value)}>
                  <option value="OTHER">Other / generic</option>
                  <option value="CISCO">Cisco</option>
                  <option value="HUAWEI">Huawei</option>
                  <option value="MIKROTIK">MikroTik</option>
                  <option value="JUNIPER">Juniper</option>
                </select></div>
              <div className="ndm-field"><label>Type</label>
                <input placeholder="Cisco Catalyst 2960" value={f.deviceType} onChange={(e) => set("deviceType", e.target.value)} /></div>
              <div className="ndm-field"><label>Group</label>
                <input placeholder="Tower 1" value={f.groupName} onChange={(e) => set("groupName", e.target.value)} /></div>
              <div className="ndm-field"><label>Location</label>
                <input placeholder="Main office, rack 3" value={f.location} onChange={(e) => set("location", e.target.value)} /></div>
            </div>
            <div className="ndm-field"><label>Description</label>
              <input placeholder="Anything worth knowing about this device" value={f.description} onChange={(e) => set("description", e.target.value)} /></div>

            <div style={{ borderTop: "1px solid var(--border)", marginTop: 4 }} />

            {/*
              HOW this target is checked. Everything used to be SNMP-polled, so
              adding an internet target (8.8.8.8, google.com) produced a device
              that reported "SNMP timeout" forever while answering ping fine.
              Choosing the method here is what stops that.
            */}
            <div className="ndm-field"><label>Monitoring method</label>
              <select value={f.monitorMethod} onChange={(e) => set("monitorMethod", e.target.value)}>
                <option value="SNMP">SNMP — switch, router, NAS (ports, traffic, uptime)</option>
                <option value="ICMP">ICMP Ping — internet target or host without SNMP</option>
                <option value="HTTP">HTTP/HTTPS endpoint</option>
              </select>
              <div className="ndm-hint" style={{ marginTop: 4 }}>
                {f.monitorMethod === "SNMP"
                  ? "Discovers interfaces and collects ports, traffic and device uptime."
                  : f.monitorMethod === "ICMP"
                    ? "Reachability and response time only — no ports, traffic or SNMP uptime. Nothing below is used."
                    : "Checked for reachability; endpoint checking is polled as ICMP until HTTP probing ships."}
              </div>
            </div>

            {/* SNMP credentials are meaningless for a ping target — hiding them
                prevents an operator filling in a community string that will
                never be used and then wondering why nothing polls. */}
            {f.monitorMethod !== "SNMP" ? null : (
            <>
            <div className="ndm-field"><label>SNMP version</label>
              <select value={f.snmpVersion} onChange={(e) => set("snmpVersion", e.target.value)}>
                <option value="V2C">SNMPv2c (community string)</option>
                <option value="V3">SNMPv3 (user + auth)</option>
              </select></div>

            {f.snmpVersion === "V2C" ? (
              <div className="ndm-grid2">
                <div className="ndm-field"><label>Community</label>
                  <input value={f.community} onChange={(e) => set("community", e.target.value)} /></div>
                <div className="ndm-field"><label>Port</label>
                  <input type="number" value={f.snmpPort} onChange={(e) => set("snmpPort", e.target.value)} /></div>
              </div>
            ) : (
              <>
                <div className="ndm-grid2">
                  <div className="ndm-field"><label>v3 username *</label>
                    <input value={f.v3Username} onChange={(e) => set("v3Username", e.target.value)} /></div>
                  <div className="ndm-field"><label>Port</label>
                    <input type="number" value={f.snmpPort} onChange={(e) => set("snmpPort", e.target.value)} /></div>
                  <div className="ndm-field"><label>Auth protocol</label>
                    <select value={f.v3AuthProto} onChange={(e) => set("v3AuthProto", e.target.value)}><option>SHA</option><option>MD5</option></select></div>
                  <div className="ndm-field"><label>Auth key</label>
                    <input type="password" value={f.v3AuthKey} onChange={(e) => set("v3AuthKey", e.target.value)} /></div>
                  <div className="ndm-field"><label>Privacy protocol</label>
                    <select value={f.v3PrivProto} onChange={(e) => set("v3PrivProto", e.target.value)}><option>AES</option><option>DES</option></select></div>
                  <div className="ndm-field"><label>Privacy key (optional)</label>
                    <input type="password" value={f.v3PrivKey} onChange={(e) => set("v3PrivKey", e.target.value)} /></div>
                </div>
              </>
            )}
            </>
            )}

            {/* Poll interval applies to EVERY method — a ping target is checked
                on a schedule too. Timeout/retries are SNMP-specific. */}
            <div className="ndm-grid2">
              <div className="ndm-field"><label>Check interval</label>
                <select value={f.pollIntervalSec} onChange={(e) => set("pollIntervalSec", e.target.value)}>
                  <option value="10">Every 10 seconds</option><option value="30">Every 30 seconds</option>
                  <option value="60">Every minute</option><option value="300">Every 5 minutes</option>
                </select></div>
              {f.monitorMethod === "SNMP" && (
                <div className="ndm-field"><label>Timeout / retries</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input type="number" value={f.snmpTimeoutMs} onChange={(e) => set("snmpTimeoutMs", e.target.value)} title="ms" style={{ width: "60%" }} />
                    <input type="number" value={f.snmpRetries} onChange={(e) => set("snmpRetries", e.target.value)} title="retries" style={{ width: "40%" }} />
                  </div></div>
              )}
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={f.syslogEnabled} onChange={(e) => set("syslogEnabled", e.target.checked)} />
                This device sends syslog to this panel (port 514 UDP by default)
              </label>
              {f.syslogEnabled && (
                <div className="ndm-grid2" style={{ marginTop: 8 }}>
                  <div className="ndm-field"><label>Protocol</label>
                    <select value={f.syslogProtocol} onChange={(e) => set("syslogProtocol", e.target.value)}><option>UDP</option><option>TCP</option><option>TLS</option></select></div>
                  <div className="ndm-field"><label>Port</label>
                    <input type="number" value={f.syslogPort} onChange={(e) => set("syslogPort", e.target.value)} /></div>
                </div>
              )}
              <div className="ndm-hint" style={{ marginTop: 6 }}>Keep the syslog listener (UDP/TCP/TLS) enabled under Alerts &amp; Rules → Server settings for the panel to receive it.</div>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
            {err && <span className="ndm-err" style={{ marginRight: "auto" }}>{err}</span>}
            <button className="ndm-btn" onClick={onClose}>Cancel</button>
            {/* Testing SNMP against a ping target is guaranteed to fail and
                would block the wizard on a device that is perfectly fine. */}
            {f.monitorMethod === "SNMP" ? (
              <button className="ndm-btn pri" disabled={!ipOk} onClick={() => { setStep(2); void test(); }}>Next — test SNMP →</button>
            ) : (
              <button className="ndm-btn pri" disabled={!ipOk} onClick={() => setStep(3)}>Next →</button>
            )}
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="ndm-card" style={{ marginBottom: 12 }}>
            <div className="ndm-card-h"><b>SNMP test on {f.ip}</b><button className="ndm-btn" onClick={test} disabled={testing}>{testing ? "Testing…" : "Test again"}</button></div>
            {testing ? <div className="ndm-card-sub">Connecting via {f.snmpVersion} on :{f.snmpPort}…</div> :
              !testRes ? <div className="ndm-card-sub">Press "Next" ran the test automatically.</div> :
              testRes.ok ? (
                <div className="ndm-ok">
                  ✓ SNMP works — {testRes.sysName || "unnamed device"} · {testRes.interfaceCount} interface(s) · {testRes.sysDescr || ""}
                </div>
              ) : (
                <div className="ndm-err"><b>SNMP test failed:</b> {testRes.error}<div className="ndm-hint" style={{ marginTop: 4 }}>Check the community/v3 credentials, that SNMP is enabled on the device, and that this server can reach UDP/{f.snmpPort}.</div></div>
              )}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <button className="ndm-btn" onClick={() => setStep(1)}>← Back</button>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="ndm-btn" onClick={() => setStep(3)}>Skip discovery</button>
              <button className="ndm-btn pri" disabled={!testRes?.ok || testing || !f.ip.trim()} onClick={discover}>{testing ? "Discovering…" : "Discover interfaces →"}</button>
            </div>
          </div>
          {err && (
            <div className="ndm-err" style={{ marginTop: 10 }}>
              <b>Interface discovery failed:</b> {err}
              <div className="ndm-hint" style={{ marginTop: 4 }}>You can retry discovery, or skip it — saving the device still works and the first poll will pick up the interfaces automatically.</div>
            </div>
          )}
        </>
      )}

      {step === 3 && (
        <>
          {discovered ? (
            <>
              <div className="ndm-ok" style={{ marginBottom: 8 }}>✓ Found {discovered.length} interface(s) — this is what the poller will track.</div>
              <div style={{ maxHeight: 300, overflow: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
                <table className="ndm-tbl">
                  <thead><tr><th>#</th><th>Name</th><th>Status</th><th>Type</th><th>Monitored</th><th>Speed</th><th>MAC</th></tr></thead>
                  <tbody>
                    {discovered.map((p) => (
                      <tr key={p.ifIndex} style={p.monitoringEnabled === false ? { opacity: .55 } : undefined}>
                        <td>{p.ifIndex}</td><td><b>{p.name}</b></td>
                        <td><span style={{ color: p.operStatus === 1 ? "var(--online)" : "var(--danger)" }}>{p.operStatus === 1 ? "UP" : "down"}</span></td>
                        <td>{catLabel(p.interfaceCategory)}</td>
                        <td>{p.monitoringEnabled === false
                          ? <span className="ndm-pill" title="PPPoE/dynamic/session links are excluded — no alerts, no traffic history">{catLabel(p.interfaceCategory)} — off</span>
                          : <b style={{ color: "var(--online)" }}>yes</b>}</td>
                        <td>{p.speedMbps ? `${p.speedMbps} Mbps` : "—"}</td><td style={{ fontFamily: "monospace", fontSize: 11 }}>{p.mac || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="ndm-hint" style={{ marginTop: 6 }}>PPPoE / dynamic / tunnel session links start excluded automatically — you can enable or disable any port later under Ports.</div>
            </>
          ) : (
            <div className="ndm-empty">No discovery data — the first poll will populate the ports automatically.</div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 14 }}>
            <button className="ndm-btn" onClick={() => setStep(2)}>← Back</button>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {err && <span className="ndm-err">{err}</span>}
              <button className="ndm-btn pri" onClick={save} disabled={saving || !f.ip.trim()}>{saving ? "Saving…" : "Save device"}</button>
            </div>
          </div>
          <div className="ndm-hint" style={{ marginTop: 8 }}>After saving, the first poll runs within a few seconds. Credentials are encrypted at rest and never shown here again.</div>
        </>
      )}
    </NdmModal>
  );
}