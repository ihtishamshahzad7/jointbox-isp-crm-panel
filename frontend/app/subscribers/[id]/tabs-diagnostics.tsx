"use client";

/**
 * Diagnostics — one-click "Diagnose subscriber": runs the real checks against
 * live backend state (session, RADIUS sync status, static-IP health, FUP,
 * router diagnosis, duplicate login) and renders a single verdict with
 * actionable next steps. Nothing is fabricated; every row is a real probe.
 */
import React, { useCallback, useState } from "react";
import { useSubscriberDetail } from "./context";
import { Panel, Btn, StatusChip, EmptyState } from "./ui";
import { apiGet, show } from "./lib";

interface DiagRow {
  key: string;
  label: string;
  status: "running" | "ok" | "warn" | "bad" | "off";
  message: string;
}

export function DiagnosticsTab() {
  const {
    sub, sessionLogs, openSessions, staticHealth,
    usage, radiusChecks, loadRouterLog, refreshLive,
  } = useSubscriberDetail();

  const [rows, setRows] = useState<DiagRow[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    if (!sub?.username || !sub.id) return;
    setRunning(true);
    setRows(null);
    const update = (key: string, patch: Partial<DiagRow>) =>
      setRows((p) => (p ?? []).map((r) => (r.key === key ? { ...r, ...patch } : r)));

    // Probe each domain in parallel; each reports its own result.
    const mk = (key: string, label: string): DiagRow => ({ key, label, status: "running", message: "…" });
    const init: DiagRow[] = [
      mk("session", "RADIUS session"),
      mk("sync", "RADIUS sync status"),
      mk("static", "Static IP health"),
      mk("fup", "Data allowance"),
      mk("router", "Router diagnosis"),
      mk("duplicate", "Duplicate sessions"),
    ];
    setRows(init);

    // 1. Session
    const ses = await apiGet<any>(`/subscribers/radius-session/${encodeURIComponent(sub.username!)}`);
    const online = !!ses?.session;
    update("session", online
      ? { status: "ok", message: `Online — IP ${ses.session.framedipaddress || "—"}, up ${ses.session.duration_seconds}s` }
      : { status: "off", message: ses?.error ? `Could not read session: ${ses.error}` : "Offline — no active session in radacct" });

    // 2. RADIUS sync status
    const rs = await apiGet<any>(`/subscribers/radius-status/${encodeURIComponent(sub.username!)}`);
    update("sync", rs?.existsInRadius
      ? { status: "ok", message: "Username is in FreeRADIUS (radcheck present)" }
      : { status: rs?.error ? "warn" : "bad", message: rs?.error ? `Error: ${rs.error}` : "Not in RADIUS — run Sync profile" });

    // 3. Static IP health
    const h = await apiGet<any>(`/static-ips/subscriber/${sub.id}/health`);
    if (h) {
      if (h.status === "HEALTHY") update("static", { status: "ok", message: `Healthy — ${h.configuredIp} on DB, RADIUS and live session` });
      else if (h.status === "MISMATCH") update("static", { status: "bad", message: `MISMATCH — expected ${h.configuredIp || "—"}; DB:${h.database.ip || "—"} RADIUS:${h.radius.ip || "—"} session:${h.session.ip || "offline"}` });
      else if (h.status === "NOT_ONLINE") update("static", { status: "warn", message: `Static ${h.configuredIp} configured but subscriber is offline` });
      else update("static", { status: "ok", message: "Dynamic (pool) addressing — nothing to verify" });
    } else {
      update("static", { status: "off", message: "Static-IP health unavailable" });
    }

    // 4. FUP / allowance
    const fup = await apiGet<any>(`/compliance/fup/${sub.id}`);
    if (fup) {
      update("fup", fup.state === "BLOCKED"
        ? { status: "bad", message: `Net BLOCKED — ${fup.usedGb} GB of ${fup.quotaGb} GB used` }
        : fup.state === "THROTTLED"
          ? { status: "warn", message: `THROTTLED to ${fup.throttledTo || "FUP speed"} — ${fup.usedGb}/${fup.quotaGb} GB` }
          : { status: "ok", message: fup.quotaGb ? `${fup.usedGb}/${fup.quotaGb} GB used (${fup.percentUsed}%)` : "Unlimited — no quota set" });
    } else {
      update("fup", { status: "off", message: "FUP data unavailable" });
    }

    // 5. Router diagnosis
    const rt = await loadRouterLog();
    if (rt?.diagnosis?.severity) {
      update("router", { status: rt.diagnosis.severity === "critical" ? "bad" : "warn", message: `${rt.diagnosis.title} — ${rt.diagnosis.fix}` });
    } else if (rt) {
      update("router", { status: "ok", message: "No fault detected on the router" });
    } else {
      update("router", { status: "off", message: "Router log not loaded" });
    }

    // 6. Duplicate sessions
    update("duplicate", openSessions > 1
      ? { status: "bad", message: `${openSessions} simultaneous sessions — cut them in Connection` }
      : { status: "ok", message: "One session or none — no duplicate" });

    await refreshLive();
    setRunning(false);
  }, [sub, loadRouterLog, openSessions, refreshLive]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel
        title="Diagnose subscriber"
        sub="Runs real checks against the live backend — session, RADIUS, static IP, FUP, router, duplicates"
        actions={
          <Btn size="sm" variant="primary" onClick={() => { void run(); }} disabled={running}>
            {running ? "Diagnosing…" : "⚡ Diagnose now"}
          </Btn>
        }
      >
        {!rows ? (
          <div style={{ fontSize: 12, color: "var(--muted)", padding: "8px 0" }}>
            Press <b>Diagnose now</b> to probe every layer at once. Each row reports what its source actually says right now.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {rows.map((r) => (
              <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-2)" }}>
                <span style={{ fontSize: 11.5, fontWeight: 800, width: 120, flex: "none" }}>{r.label}</span>
                {r.status === "running"
                  ? <span className="sd-spinner" style={{ padding: 0 }}><span className="sd-spinner-ring" /></span>
                  : <StatusChip level={r.status} text={r.status.toUpperCase()} dotPulse={false} />}
                <span style={{ fontSize: 11.5, color: "var(--muted)", flex: 1, minWidth: 0, lineHeight: 1.5 }}>{r.message}</span>
              </div>
            ))}

            {rows.every((r) => r.status !== "running" && r.status !== "bad") && rows.length > 0 && (
              <div className="sd-alert ok" style={{ marginTop: 4 }}>
                <span className="sd-alert-ic">✓</span>
                <div><b>No critical problems detected.</b> Everything this panel can probe is reporting normal.</div>
              </div>
            )}
            {rows.some((r) => r.status === "bad") && (
              <div className="sd-alert" style={{ marginTop: 4 }}>
                <span className="sd-alert-ic">⚠</span>
                <div><b>At least one check is failing.</b> Fix the red rows first, then re-run to confirm.</div>
              </div>
            )}
          </div>
        )}
      </Panel>

      {/* Facts that explain the verdict */}
      <Panel title="Facts behind the verdict">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 7 }}>
          <div className="sd-mini-cell">
            <div className="m-label">RADIUS records</div>
            <div className="m-value">{radiusChecks.length}</div>
            <div className="m-sub">{radiusChecks.length ? "profile present in radcheck" : "not synced yet"}</div>
          </div>
          <div className="sd-mini-cell">
            <div className="m-label">Sessions (window)</div>
            <div className="m-value">{sessionLogs.length}</div>
            <div className="m-sub">last 50 completed</div>
          </div>
          <div className="sd-mini-cell">
            <div className="m-label">Open sessions</div>
            <div className="m-value" style={{ color: openSessions > 1 ? "#D34053" : "var(--text)" }}>{openSessions}</div>
            <div className="m-sub">{openSessions > 1 ? "duplicate login" : "expected"}</div>
          </div>
          <div className="sd-mini-cell">
            <div className="m-label">Static IP</div>
            <div className="m-value">{show(staticHealth?.status)}</div>
            <div className="m-sub">{staticHealth?.configuredIp || "dynamic / pool"}</div>
          </div>
          <div className="sd-mini-cell">
            <div className="m-label">Allowance</div>
            <div className="m-value">{usage?.quotaGb ? `${usage.usedGb}/${usage.quotaGb} GB` : "∞"}</div>
            <div className="m-sub">{usage?.state || "no FUP"}</div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 12, lineHeight: 1.6 }}>
          Diagnosis is only as good as its sources: session state comes from radacct, sync from a live check against the radius DB,
          static-IP health from DB + radreply + the live session, FUP from the allowance engine, router state from the last fresh read.
        </div>
      </Panel>
    </div>
  );
}