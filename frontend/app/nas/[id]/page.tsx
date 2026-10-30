"use client";

/**
 * NAS / Router device details — the NOC-grade view.
 *
 * Route: /nas/[id] (id = the NAS database id; middleware already guards /nas/*).
 *
 * Design rules honored here:
 *  - Device reachability is separate from API / RADIUS / CoA / SNMP
 *    health — "permission limited" never shows as "offline".
 *  - Every number comes from a real backend endpoint; nothing is fabricated.
 *  - Heavy tabs load lazily; logs/sessions paginate; secrets stay masked.
 *  - Dark/light via existing CSS variables; compact, information-dense.
 */
import React, { Suspense, lazy, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { NasDetailProvider, useNasDetail, RefreshMode } from "./context";
import { Session, buildServiceHealth } from "./lib";
import { NasDetailStyles, RefreshControl, StatusChip, Btn, Spinner } from "./ui";
import { SessionDrawer } from "./session-drawer";
import API from "../../components/api";
import { OverviewTab, OverviewCss } from "./tabs-overview";
import { PermCss } from "./permissions";
import { SessionCss } from "./session-drawer";
import { RulesCss } from "./alert-rules";
import { IfacesCss } from "./tabs-interfaces";
import { ServicesCss } from "./tabs-services";
import { NetCss } from "./tabs-network";
import { ConfigCss } from "./tabs-config";
import { ChartCss } from "./charts";
import { Icons } from "../../components/icons";

// Heavy tabs load lazily so opening the page never pulls every graph at once.
const HealthTab = lazy(() => import("./tabs-health").then((m) => ({ default: m.HealthTab })));
const TrafficTab = lazy(() => import("./tabs-traffic").then((m) => ({ default: m.TrafficTab })));
const InterfacesTab = lazy(() => import("./tabs-interfaces").then((m) => ({ default: m.InterfacesTab })));
const PppoeTab = lazy(() => import("./tabs-interfaces").then((m) => ({ default: m.PppoeTab })));
const SubscribersTab = lazy(() => import("./tabs-interfaces").then((m) => ({ default: m.SubscribersTab })));
const RadiusTab = lazy(() => import("./tabs-services").then((m) => ({ default: m.RadiusTab })));
const SnmpTab = lazy(() => import("./tabs-services").then((m) => ({ default: m.SnmpTab })));
const IpAddrTab = lazy(() => import("./tabs-network").then((m) => ({ default: m.IpAddrTab })));
const VlansTab = lazy(() => import("./tabs-network").then((m) => ({ default: m.VlansTab })));
const LogsTab = lazy(() => import("./tabs-network").then((m) => ({ default: m.LogsTab })));
const AuditTab = lazy(() => import("./tabs-network").then((m) => ({ default: m.AuditTab })));
const ConfigTab = lazy(() => import("./tabs-config").then((m) => ({ default: m.ConfigTab })));
const TestCenter = lazy(() => import("./test-center").then((m) => ({ default: m.TestCenter })));
const PermissionPanel = lazy(() => import("./permissions").then((m) => ({ default: m.PermissionPanel })));
const AlertRules = lazy(() => import("./alert-rules").then((m) => ({ default: m.AlertRules })));
// Lazy like the rest: a tunnel is provisioned once and then rarely looked at,
// so its panel should not be in the bundle every other tab pays for.
const NasVpnPanel = lazy(() => import("../nas-vpn-panel").then((m) => ({ default: m.NasVpnPanel })));

const TABS: Array<{ id: string; label: string; group: string }> = [
  { id: "overview", label: "Overview", group: "Device" },
  { id: "health", label: "Health", group: "Device" },
  { id: "traffic", label: "Traffic", group: "Device" },
  { id: "interfaces", label: "Interfaces", group: "Network" },
  { id: "pppoe", label: "PPPoE", group: "Network" },
  { id: "subscribers", label: "Subscribers", group: "Network" },
  { id: "radius", label: "RADIUS", group: "Services" },
  { id: "snmp", label: "SNMP", group: "Services" },
  { id: "ip", label: "IP Addresses", group: "Network" },
  { id: "vlans", label: "VLANs", group: "Network" },
  { id: "logs", label: "Logs", group: "History" },
  { id: "audit", label: "Audit", group: "History" },
  { id: "diagnostics", label: "Diagnostics", group: "Device" },
  { id: "configuration", label: "Configuration", group: "Device" },
  { id: "vpn", label: "VPN", group: "Services" },
];

const TAB_ICONS: Record<string, (props: React.SVGProps<SVGSVGElement>) => React.ReactNode> = {
  overview: Icons.Dashboard,
  health: Icons.Reports,
  traffic: Icons.Network,
  interfaces: Icons.Network,
  pppoe: Icons.Network,
  subscribers: Icons.Subscribers,
  radius: Icons.NAS,
  snmp: Icons.NAS,
  ip: Icons.Network,
  vlans: Icons.Network,
  logs: Icons.Logs,
  audit: Icons.Logs,
  diagnostics: Icons.Support,
  configuration: Icons.Settings,
  vpn: Icons.Network,
};

export default function NasDetailPage() {
  const params = useParams();
  const raw = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const id = Number(raw);
  const valid = Number.isInteger(id) && id > 0;

  if (!valid) {
    return (
      <div className="nd-root">
        <NasDetailStyles />
        <div className="nd-alert" style={{ borderColor: "rgba(211,64,83,.4)", background: "rgba(211,64,83,.07)" }}>
          <span className="nd-alert-ic">⚠</span>
          <div>
            <b>Invalid device id.</b> The URL should look like <code>/nas/3</code>.
          </div>
        </div>
      </div>
    );
  }

  return (
    <NasDetailProvider nasId={id}>
      <DevicePage key={id} />
    </NasDetailProvider>
  );
}

function DevicePage() {
  const {
    nas, reach, details, radiusStats,
    refreshAll, loadDetails,
    mode, setMode, liveConnected, lastUpdate,
    runAllTests, clearTests,
  } = useNasDetail();
  const router = useRouter();

  const [tab, setTab] = useState<string>("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [openSession, setOpenSession] = useState<Session | null>(null);
  const [syncing, setSyncing] = useState(false);

  const nasId = useNasDetailId();

  // Live management-tunnel status for the header chip — real data from the same
  // endpoint the Tunnel tab uses, so we never invent a connection state.
  const [tunnel, setTunnel] = useState<{ exists: boolean; online: boolean; lastHandshake: string | null } | null>(null);
  React.useEffect(() => {
    if (!nasId) return;
    let alive = true;
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
    const load = async () => {
      try {
        const r = await fetch(`${API}/nas/${nasId}/tunnel`, { headers: { Authorization: `Bearer ${token}` } });
        if (!alive) return;
        if (r.ok) {
          const d = await r.json();
          setTunnel(d ? { exists: true, online: !!d.online, lastHandshake: d.lastHandshake ?? null } : { exists: false, online: false, lastHandshake: null });
        } else {
          setTunnel({ exists: false, online: false, lastHandshake: null });
        }
      } catch { /* leave previous reading */ }
    };
    void load();
    const iv = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(iv); };
  }, [nasId]);

  // Remember the last tab per device (session storage, never persisted to disk).
  // A `?tab=` in the URL wins — it lets other screens deep-link to a tab
  // (e.g. the NAS list's "VPN" button jumps straight to this tab).
  React.useEffect(() => {
    let fromUrl: string | null = null;
    try {
      fromUrl = new URLSearchParams(window.location.search).get("tab");
    } catch {
      /* SSR / no window */
    }
    if (fromUrl && (TABS.some((t) => t.id === fromUrl) || fromUrl === "tunnel")) {
      setTab(fromUrl === "tunnel" ? "vpn" : fromUrl);
      return;
    }
    const saved = sessionStorage.getItem(`nb-nas-tab-${nasId}`);
    if (saved === "tunnel") setTab("vpn");
    else if (saved && TABS.some((t) => t.id === saved)) setTab(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nasId]);

  const goTab = (t: string) => {
    setTab(t);
    try { sessionStorage.setItem(`nb-nas-tab-${nasId}`, t); } catch { /* private mode */ }
  };

  const doSync = async () => {
    setSyncing(true);
    try { await loadDetails(); } finally { setSyncing(false); }
  };

  const subscriberName = useMemo(() => {
    if (!openSession) return null;
    return nas?.subscribers?.find((s) => s.username === openSession.username)?.fullName ?? null;
  }, [openSession, nas]);

  // Header chips — the three that matter most at a glance (full 6 in Overview).
  const chips = useMemo(() => {
    const hasSnmp = false; // header shows Device/API/RADIUS/CoA only
    const all = buildServiceHealth({ reach, details, nas, events: [], hasSnmpSamples: hasSnmp, radiusAlive: radiusStats?.alive });
    return all.filter((h) => h.key === "device" || h.key === "api" || h.key === "radius" || h.key === "coa");
  }, [reach, details, nas, radiusStats]);

  const title = nas?.shortname || nas?.nasname || `NAS #${nasId}`;

  return (
    <div className="nd-root">
      <NasDetailStyles />
      <style>{OverviewCss}{IfacesCss}{ServicesCss}{NetCss}{ConfigCss}{PermCss}{SessionCss}{RulesCss}{ChartCss}{PageCss}</style>

      {/* ── Header ── */}
      <div className="nd-top">
        <button className="nd-back" onClick={() => router.push("/nas")}>← NAS list</button>
        <div className="nd-top-right">
          <RefreshControl mode={mode} setMode={setMode} liveConnected={liveConnected} lastUpdate={lastUpdate} />
        </div>
      </div>

      <div className="nd-title-block">
        <div className="nd-title-ic">▤</div>
        <div className="nd-title">
          <h1>{title}</h1>
          <div className="nd-meta">
            <code>{nas?.nasIp ?? "no IP configured"}</code>
            {nas?.owner?.name && <span>🏢 {nas.owner.name}</span>}
            {nas?.deviceType && <span>{nas.deviceType}</span>}
            <span>{nas?.type ?? "router"}</span>
            {reach?.identity && <span className="nd-mono">{reach.identity}</span>}
            {reach?.version && <span className="nd-mono">v{reach.version}</span>}
          </div>
          <div className="nd-status-row">
            {chips.map((h) => (
              <StatusChip key={h.key} level={h.level} text={`${h.label}: ${h.text}`} detail={h.detail} dotPulse={h.level === "ok" || h.level === "bad"} />
            ))}
            {radiusStats && <StatusChip level={radiusStats.alive ? "ok" : "bad"} text={`Sessions: ${radiusStats.activeSessionCount}`} dotPulse={false} />}
            {tunnel && (
              <StatusChip
                level={!tunnel.exists ? "warn" : tunnel.online ? "ok" : "warn"}
                text={`VPN: ${!tunnel.exists ? "no tunnel" : tunnel.online ? "connected" : tunnel.lastHandshake ? "not responding" : "waiting"}`}
                detail={!tunnel.exists ? "Configure it on the VPN tab" : undefined}
                dotPulse={tunnel.exists && tunnel.online}
              />
            )}
          </div>
        </div>

        <div className="nd-menu-wrap">
          <Btn size="sm" variant="default" onClick={() => setMenuOpen((v) => !v)}>Actions ▾</Btn>
          {menuOpen && (
            <div className="nd-menu">
              <button onClick={() => { setMenuOpen(false); refreshAll(); }}>⟳ Refresh all data</button>
              <button onClick={() => { setMenuOpen(false); void doSync(); }} disabled={syncing}>
                {syncing ? "Syncing…" : "⇅ Run full router sync"}
              </button>
              <button onClick={() => { setMenuOpen(false); void runAllTests(); goTab("diagnostics"); }}>⚡ Run all tests</button>
              <button onClick={() => { setMenuOpen(false); clearTests(); }}>✕ Clear test results</button>
              <div className="nd-menu-sep" />
              <button onClick={() => { setMenuOpen(false); goTab("vpn"); }}>🛰️ VPN</button>
              <button onClick={() => { setMenuOpen(false); goTab("configuration"); }}>⚙ Edit configuration</button>
              <button className="danger" onClick={() => { setMenuOpen(false); goTab("logs"); }}>📄 Device logs</button>
            </div>
          )}
        </div>
      </div>

      {/* ── Body: vertical nav sidebar + main content ── */}
      <div className="nd-layout">
        {/* Mobile: the sidebar collapses behind this trigger. */}
        <button
          type="button"
          className="nd-navtrigger"
          aria-expanded={navOpen}
          onClick={() => setNavOpen((v) => !v)}
        >
          <span>{TABS.find((t) => t.id === tab)?.label ?? "Menu"}</span>
          <span className={`nd-navchev${navOpen ? " open" : ""}`}>▾</span>
        </button>

        <nav className={`nd-tabs mobile-hide-vertical-tabs${navOpen ? " open" : ""}`} role="tablist" aria-label="Router sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`nd-tab${tab === t.id ? " on" : ""}`}
              onClick={() => { goTab(t.id); setNavOpen(false); }}
              title={t.group}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* ── Tab body (lazy) ── */}
        <div className="nd-main">
          <Suspense fallback={<div className="nd-root"><Spinner label="Loading…" /></div>}>
            {tab === "overview" && <OverviewTab onOpenSession={setOpenSession} onGoto={goTab} />}
            {tab === "health" && <HealthTab />}
            {tab === "traffic" && <TrafficTab />}
            {tab === "interfaces" && <InterfacesTab />}
            {tab === "pppoe" && <PppoeTab />}
            {tab === "subscribers" && <SubscribersTab onOpenSession={setOpenSession} />}
            {tab === "radius" && <RadiusTab />}
            {tab === "snmp" && <SnmpTab />}
            {tab === "ip" && <IpAddrTab />}
            {tab === "vlans" && <VlansTab />}
            {tab === "logs" && <LogsTab />}
            {tab === "audit" && <AuditTab />}
            {tab === "diagnostics" && (
              <div className="nd-root" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <PermissionPanel onEditCredentials={() => goTab("configuration")} onGoto={goTab} />
                <TestCenter />
                <AlertRules />
              </div>
            )}
            {tab === "configuration" && <ConfigTab />}
            {tab === "vpn" && <NasVpnPanel nasId={nasId} nasName={nas?.shortname || nas?.nasname} />}
          </Suspense>
        </div>
      </div>

      <nav className="jb-bottomnav section nd-profile-dock" role="tablist" aria-label="NAS detail tabs">
        <div className="jb-bn-scroll">
          {TABS.map((t) => {
            const Icon = TAB_ICONS[t.id];
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={t.label}
                className={active ? "on" : ""}
                onClick={() => { goTab(t.id); setNavOpen(false); }}
              >
                <span className="ico"><Icon width={20} height={20} /></span>
                <span className="lbl">{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {openSession && (
        <SessionDrawer
          session={openSession}
          subscriberName={subscriberName}
          onClose={() => setOpenSession(null)}
        />
      )}
    </div>
  );
}

function useNasDetailId(): number {
  const params = useParams();
  const raw = Array.isArray(params?.id) ? params.id[0] : params?.id;
  return Number(raw) || 0;
}

// css helpers used above
export const PageCss = `
.nd-top-right{margin-left:auto}
.nd-menu-sep{height:1px;background:var(--border);margin:5px 4px}
.nd-menu button:disabled{opacity:.5;cursor:not-allowed}
@media(max-width:767px){
  .nd-root{width:100%;min-width:0;padding-bottom:calc(76px + env(safe-area-inset-bottom,0px))}
  .nd-layout{display:block}
  .nd-layout>.nd-navtrigger,body:has(.nd-root) .nd-layout>.nd-tabs{display:none!important}
  .nd-layout>.nd-main{width:100%;min-width:0}
  .nd-title-block{gap:9px;align-items:flex-start}
  .nd-title-ic{width:34px;height:34px}
  .nd-title h1{font-size:16px;line-height:1.2}
  .nd-title .nd-meta{gap:4px 7px;margin-top:3px;font-size:10px;line-height:1.3}
  .nd-status-row{gap:4px;margin-top:5px}
  .nd-chip{gap:4px;padding:2px 6px;font-size:9px}
  .nd-menu-wrap{flex:none}
  .nd-menu{right:0}
  .nd-overview .ov-tags{gap:4px}
  .nd-overview .ov-tag{padding:3px 6px;font-size:9px}
  .nd-overview .ov-grid{grid-template-columns:minmax(0,1fr)!important;gap:8px}
  .nd-overview .ov-wide{grid-column:auto}
  .nd-overview .ov-card{width:100%;min-width:0;padding:12px}
  .nd-overview .nd-def-row{flex-direction:row;align-items:flex-start;gap:8px;padding:5px 0}
  .nd-overview .nd-def dt{flex:0 0 36%;font-size:9px;line-height:1.35}
  .nd-overview .nd-def dd{flex:1;min-width:0;text-align:right;overflow-wrap:anywhere;word-break:break-word}
  .nd-overview .ov-subsum{padding:10px 12px;gap:8px}
  .nd-overview .ov-subsum-l{gap:6px}
  .nd-overview .ov-subsum-t{font-size:10px}
}
`;
