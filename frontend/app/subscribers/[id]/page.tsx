"use client";

/**
 * Subscriber 360 — the NOC-grade subscriber detail page.
 *
 * Route: /subscribers/[id]
 *
 * Design rules honored here:
 *  - Connection state (RADIUS radacct live session) is the ONE source of
 *    truth for ONLINE/OFFLINE; account state (ACTIVE/EXPIRED/SUSPENDED) is a
 *    separate chip and never blended into the connection verdict.
 *  - Every number comes from a real backend endpoint; nothing is fabricated,
 *    and "no data" shows as "—" not as a fake zero.
 *  - Heavy tabs load lazily; logs paginate; secrets stay masked.
 *  - Dark/light via existing CSS variables; compact, information-dense.
 */
import React, { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { SubscriberDetailProvider, useSubscriberDetail } from "./context";
import { SubDetailStyles, RefreshControl, StatusChip, Btn, accountLevel } from "./ui";
import { connLevel, apiSend, fmtDateTime, fmtDuration } from "./lib";
import BoostButton from "./boost-button";

// Heavy tabs load lazily — opening the page never pulls every graph at once.
const OverviewTab = lazy(() => import("./tabs-overview").then((m) => ({ default: m.OverviewTab })));
const ConnectionTab = lazy(() => import("./tabs-connection").then((m) => ({ default: m.ConnectionTab })));
const ServiceTab = lazy(() => import("./tabs-service").then((m) => ({ default: m.ServiceTab })));
const UsageTab = lazy(() => import("./tabs-usage").then((m) => ({ default: m.UsageTab })));
const SessionsTab = lazy(() => import("./tabs-sessions").then((m) => ({ default: m.SessionsTab })));
const RadiusTab = lazy(() => import("./tabs-radius").then((m) => ({ default: m.RadiusTab })));
const RouterTab = lazy(() => import("./tabs-router").then((m) => ({ default: m.RouterTab })));
const BillingTab = lazy(() => import("./tabs-billing").then((m) => ({ default: m.BillingTab })));
const DiagnosticsTab = lazy(() => import("./tabs-diagnostics").then((m) => ({ default: m.DiagnosticsTab })));
const LoginLogTab = lazy(() => import("./tabs-login-log").then((m) => ({ default: m.LoginLogTab })));
const ActivitiesTab = lazy(() => import("./tabs-activities").then((m) => ({ default: m.ActivitiesTab })));

const TABS: Array<{ id: string; label: string; group: string }> = [
  { id: "overview", label: "Overview", group: "Overview" },
  { id: "connection", label: "Connection", group: "Network" },
  { id: "service", label: "Service", group: "Service" },
  { id: "usage", label: "Usage", group: "Service" },
  { id: "billing", label: "Billing", group: "Account" },
  { id: "diagnostics", label: "Diagnostics", group: "Account" },
  { id: "sessions", label: "Sessions", group: "History" },
  { id: "radius", label: "RADIUS", group: "History" },
  { id: "router", label: "Router Log", group: "History" },
  { id: "login-log", label: "Login Log", group: "History" },
  { id: "activities", label: "Activities", group: "History" },
];

export default function SubscriberDetailPage() {
  const params = useParams();
  const raw = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const id = Number(raw);
  const valid = Number.isInteger(id) && id > 0;

  if (!valid) {
    return (
      <div className="sd-root">
        <SubDetailStyles />
        <div className="sd-alert">
          <span className="sd-alert-ic">⚠</span>
          <div><b>Invalid subscriber id.</b> The URL should look like <code>/subscribers/3</code>.</div>
        </div>
      </div>
    );
  }

  return (
    <SubscriberDetailProvider subscriberId={id}>
      <DeviceShell key={id} />
    </SubscriberDetailProvider>
  );
}

function DeviceShell() {
  const {
    sub, loading, sessionChecked, liveSession,
    openSessions, staticHealth, mode, setMode, liveConnected, lastUpdate,
    refreshLive, loadBundle, showToast, setBusy, busies,
  } = useSubscriberDetail();
  const router = useRouter();
  const subscriberId = useSubscriberId();

  const [tab, setTab] = useState("overview");
  const [menuOpen, setMenuOpen] = useState(false);

  // Verified disconnect — the backend does the full chain (CoA/API → NAS →
  // re-check real active session) and reports what ACTUALLY happened.
  const disconnectNow = async () => {
    if (!sub?.username) return;
    if (!confirm(`Disconnect ${sub.fullName}'s active session? They will be forced offline immediately.`)) return;
    setBusy("kill", true);
    try {
      const r = await apiSend<any>(`/network/disconnect/${encodeURIComponent(sub.username)}`, "POST");
      if (r?.verified === false) {
        showToast(r.message || "Disconnect reported errors — session may still be live. Check the Connection tab.", "warn");
      } else if (r?.ok || r?.sessionsKilled) {
        showToast(r.message || "Disconnected — session verified gone", "ok");
      } else if (r?.message) {
        showToast(r.message, "err");
      } else {
        showToast("Disconnect failed — no session to cut (subscriber already offline)", "warn");
      }
      await refreshLive();
    } catch (e: any) {
      showToast(e?.message || "Disconnect failed", "err");
    } finally {
      setBusy("kill", false);
    }
  };

  // Remember the last tab per subscriber (session storage).
  useEffect(() => {
    const saved = sessionStorage.getItem(`jb-sub-tab-${subscriberId}`);
    if (saved && TABS.some((t) => t.id === saved)) setTab(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriberId]);

  const goTab = (t: string) => {
    setTab(t);
    try { sessionStorage.setItem(`jb-sub-tab-${subscriberId}`, t); } catch { /* private mode */ }
  };

  const conn = connLevel({ liveSession, sessionChecked });
  const acct = accountLevel(sub?.status);

  // Alerts that belong in the header banner (never hidden).
  const headerAlerts = useMemo(() => {
    const out: Array<{ level: "bad" | "warn" | "ok"; text: string }> = [];
    if (openSessions > 1) out.push({ level: "bad", text: `Duplicate login — ${openSessions} sessions online` });
    if (staticHealth?.status === "MISMATCH") out.push({ level: "bad", text: "Static IP mismatch — DB / RADIUS / session disagree" });
    if (staticHealth?.status === "NOT_ONLINE" && staticHealth.wantsStatic) out.push({ level: "warn", text: "Static IP configured but subscriber offline" });
    if (sub?.onHold) out.push({ level: "warn", text: "On hold — auto-suspend paused" });
    return out;
  }, [openSessions, staticHealth, sub?.onHold]);

  if (loading.bundle) {
    return (
      <div className="sd-root">
        <SubDetailStyles />
        <div className="sd-spinner"><span className="sd-spinner-ring" /><span>Loading subscriber…</span></div>
      </div>
    );
  }
  if (!sub) {
    return (
      <div className="sd-root">
        <SubDetailStyles />
        <div className="sd-alert">
          <span className="sd-alert-ic">⚠</span>
          <div>
            <b>Subscriber not found.</b>{" "}
            <button className="sd-btn sm" onClick={() => router.push("/subscribers")}>← Back to subscribers</button>
          </div>
        </div>
      </div>
    );
  }

  const initials = sub.fullName.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);

  return (
    <div className="sd-root">
      <SubDetailStyles />

      {/* ── Header ── */}
      <div className="sd-top">
        <button className="sd-back" onClick={() => router.push("/subscribers")}>← Subscribers</button>
        <div className="sd-top-right" style={{ marginLeft: "auto" }}>
          <RefreshControl mode={mode} setMode={setMode} liveConnected={liveConnected} lastUpdate={lastUpdate} />
        </div>
      </div>

      <div className="sd-title-block">
        <div className="sd-avatar">{initials}</div>
        <div className="sd-title">
          <h1>
            {sub.fullName}
            <code>{sub.username}</code>
          </h1>
          <div className="sd-meta">
            <span>{sub.connectionType} • {sub.authMethod}</span>
            {sub.phone && <span>☎ {sub.phone}</span>}
            {sub.email && <span>✉ {sub.email}</span>}
            <span style={{ color: "var(--muted)" }}>since {sub.installationDate ? fmtDateTime(sub.installationDate).split(",")[0] : "—"}</span>
          </div>
          <div className="sd-meta" style={{ color: "var(--muted)" }}>
            {sub.package?.name && <span>📦 <b style={{ color: "var(--text)" }}>{sub.package.name}</b></span>}
            {sub.nas?.nasname && <span>▤ NAS: <b style={{ color: "var(--text)" }}>{sub.nas.nasname}</b></span>}
            <span>IP: <b style={{ color: liveSession?.framedipaddress ? "var(--text)" : "var(--muted)" }}>{liveSession?.framedipaddress || "—"}</b></span>
            {sub.area?.name && <span>📍 {sub.area.name}</span>}
          </div>
          <div className="sd-status-row">
            <StatusChip level={conn.level === "online" ? "ok" : conn.level === "offline" ? "off" : "unknown"} text={conn.text} dotPulse={conn.level === "online"} />
            {/* Live uptime — only when the active radacct session proves it */}
            {conn.level === "online" && liveSession?.duration_seconds
              ? <span className="sd-chip" style={{ color: "#219653", background: "rgba(33,150,83,.10)" }}>Live • {fmtDuration(liveSession.duration_seconds)}</span>
              : null}
            <StatusChip level={acct.level} text={acct.text} detail={acct.detail} dotPulse={false} />
            {staticHealth?.status === "HEALTHY" && <StatusChip level="ok" text={`Static ${staticHealth.configuredIp}`} dotPulse={false} />}
            {staticHealth?.status === "MISMATCH" && <StatusChip level="bad" text="Static IP mismatch" dotPulse={false} />}
            {openSessions > 1 && <StatusChip level="bad" text={`${openSessions}× sessions`} dotPulse={false} />}
          </div>
        </div>

        {/* Actions */}
        <div className="sd-menu-wrap">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Btn size="sm" variant="default" onClick={() => { void refreshLive(); }} title="Re-query the live endpoints now">
              ⟳ Refresh
            </Btn>
            <Btn size="sm" variant="danger" onClick={() => { void disconnectNow(); }} disabled={busies.kill} title="Forces the subscriber offline — backend verifies the session actually terminated">
              {busies.kill ? "Disconnecting…" : "⏻ Disconnect"}
            </Btn>
            <Btn size="sm" variant="default" onClick={() => { void loadBundle(); }} title="Reload profile + invoices/payments/tickets">
              ⇅ Profile
            </Btn>
            {sub.id && <BoostButton subscriberId={sub.id} />}
            <Btn size="sm" variant="primary" onClick={() => router.push(`/subscribers?edit=${sub.id}`)}>✎ Edit</Btn>
            <Btn size="sm" variant="default" onClick={() => setMenuOpen((v) => !v)}>Actions ▾</Btn>
          </div>
          {menuOpen && (
            <div className="sd-menu">
              <button onClick={() => { setMenuOpen(false); goTab("diagnostics"); }}>⚡ Run diagnostics</button>
              <button onClick={() => { setMenuOpen(false); goTab("service"); }}>⚙ Service settings &amp; static IP</button>
              <button onClick={() => { setMenuOpen(false); goTab("billing"); }}>🧾 Invoices / payments</button>
              <div className="sd-menu-sep" />
              <button onClick={() => { setMenuOpen(false); goTab("connection"); }}>🔌 Connection &amp; sessions</button>
              <button onClick={() => { setMenuOpen(false); goTab("router"); }}>📄 Router log</button>
              <div className="sd-menu-sep" />
              <button className="danger" onClick={() => { setMenuOpen(false); goTab("sessions"); }}>🕒 Session history</button>
            </div>
          )}
        </div>
      </div>

      {/* ── Connection / alert banner (never hidden) ── */}
      {headerAlerts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {headerAlerts.map((a, i) => (
            <div key={i} className={`sd-alert${a.level === "warn" ? " warn" : ""}`}>
              <span className="sd-alert-ic">⚠</span>
              <div><b>{a.text}</b></div>
            </div>
          ))}
        </div>
      )}

      {/* ── Sticky tabs ── */}
      <nav className="sd-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`sd-tab${tab === t.id ? " on" : ""}`}
            onClick={() => goTab(t.id)}
            title={t.group}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* ── Tab body (lazy) ── */}
      <Suspense fallback={<div className="sd-root"><div className="sd-spinner"><span className="sd-spinner-ring" /><span>Loading…</span></div></div>}>
        {tab === "overview" && <OverviewTab onGoto={goTab} />}
        {tab === "connection" && <ConnectionTab />}
        {tab === "service" && <ServiceTab />}
        {tab === "usage" && <UsageTab />}
        {tab === "sessions" && <SessionsTab />}
        {tab === "radius" && <RadiusTab />}
        {tab === "router" && <RouterTab />}
        {tab === "billing" && <BillingTab />}
        {tab === "diagnostics" && <DiagnosticsTab />}
        {tab === "login-log" && <LoginLogTab />}
        {tab === "activities" && <ActivitiesTab />}
      </Suspense>
    </div>
  );
}

function useSubscriberId(): number {
  const params = useParams();
  const raw = Array.isArray(params?.id) ? params.id[0] : params?.id;
  return Number(raw) || 0;
}