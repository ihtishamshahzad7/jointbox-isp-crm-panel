"use client";

/**
 * Router Log — what the MikroTik itself reported, with the backend's diagnosis
 * rendered as a decision (title / why / fix) instead of raw PPPoE lines.
 * The backend pulls fresh from the router when this tab is opened — because
 * two-minute-old data is no use while a line is actually down.
 */
import React from "react";
import { useSubscriberDetail } from "./context";
import { Panel, Btn, EmptyState, severityOf } from "./ui";

export function RouterTab() {
  const { sub, routerLog, routerBusy, loadRouterLog } = useSubscriberDetail();

  if (!sub) return <EmptyState title="No subscriber" />;

  const dg = routerLog?.diagnosis;
  const lines = routerLog?.lines ?? [];

  return (
    <Panel
      title="What the router says"
      sub="Fresh read from the NAS — the backend interprets the log, you get the verdict"
      actions={
        <Btn size="xs" variant="default" onClick={() => { void loadRouterLog(); }} disabled={routerBusy}>
          {routerBusy ? "Reading router…" : "⟳ Refresh from router"}
        </Btn>
      }
    >
      {routerBusy && !routerLog ? (
        <div className="sd-spinner"><span className="sd-spinner-ring" /><span>Reading router…</span></div>
      ) : dg?.severity === "critical" || dg?.severity === "warning" ? (
        <div className="sd-alert warn">
          <span className="sd-alert-ic">⚠</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 13 }}>{dg.title}</div>
            {dg.occurrences != null && dg.occurrences > 0 && (
              <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>
                {dg.occurrences}× in the last 30 minutes
              </div>
            )}
            <div style={{ marginTop: 6, lineHeight: 1.6 }}>{dg.detail}</div>
            <div style={{ marginTop: 6, lineHeight: 1.6 }}>
              <b>Why:</b> {dg.cause}
            </div>
            <div style={{ marginTop: 4, lineHeight: 1.6, color: "#219653" }}>
              <b>Fix:</b> {dg.fix}
            </div>
          </div>
        </div>
      ) : routerLog ? (
        <div style={{ fontSize: 12.5, color: "#219653", fontWeight: 600, padding: "6px 0 10px" }}>
          No fault detected — the router reports nothing unusual for this connection.
        </div>
      ) : null}

      {!routerLog && !routerBusy && (
        <div style={{ fontSize: 12, color: "var(--muted)" }}>Open the tab to pull a fresh log from the router…</div>
      )}

      {lines.length === 0 && routerLog && (
        <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.7 }}>
          Nothing recorded for this user yet. The panel reads each router every two minutes;
          if this stays empty, the router may be missing its API username and password under Network → NAS / Routers.
        </div>
      )}

      {lines.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 6 }}>
            Log lines ({lines.length})
          </div>
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: 12, maxHeight: 420, overflowY: "auto", fontFamily: "ui-monospace,monospace", fontSize: 11 }}>
            {lines.map((l) => {
              const sv = severityOf(l.severity);
              const bad = /terminating|failed|error|reject|no more addresses/i.test(l.message);
              const up = /logged in|authenticated|connected/i.test(l.message) && !bad;
              return (
                <div key={l.id} style={{ display: "flex", gap: 10, padding: "3px 0", borderBottom: "1px solid color-mix(in srgb,var(--border) 50%,transparent)" }}>
                  <span style={{ color: "var(--muted)", flexShrink: 0, minWidth: 128 }}>
                    {new Date(l.loggedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span style={{ color: "var(--muted)", flexShrink: 0, minWidth: 92 }}>{l.nas?.nasname || "—"}</span>
                  <span style={{ color: bad ? "#D34053" : up ? "#219653" : "var(--muted)", wordBreak: "break-word" }}>
                    {l.message}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}