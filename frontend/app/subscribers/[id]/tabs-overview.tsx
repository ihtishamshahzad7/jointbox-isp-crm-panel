"use client";

/**
 * Overview — the at-a-glance screen. Identity + package/NAS + live session
 * KPIs + data allowance + recent alerts + notes. Every value is real backend
 * data; "—" means no data, never a fabricated zero.
 */
import React from "react";
import { useSubscriberDetail } from "./context";
import { Panel, Kpi, DefList, GroupLabel, StatusChip, EmptyState } from "./ui";
import {
  fmtBytes, fmtDuration, fmtDateTime, fmtDateTimeFull, num, show, connLevel, detectFlapping,
} from "./lib";
import { UsageMeter } from "./charts";
import { RecordNotes } from "../../components/record-notes";

export function OverviewTab({ onGoto }: { onGoto: (t: string) => void }) {
  const {
    sub, serviceSettings, usage, liveSession, sessionChecked, sessionLogs,
    authLogs, radiusChecks, staticHealth, openSessions, invoices, payments, tickets, routerLog,
  } = useSubscriberDetail();

  if (!sub) return <EmptyState title="No subscriber data" />;

  const conn = connLevel({ liveSession, sessionChecked });
  const flap = detectFlapping(sessionLogs);
  const totalUpload = sessionLogs.reduce((a, s) => a + num(s.upload_bytes), 0) + num(liveSession?.upload_bytes);
  const totalDownload = sessionLogs.reduce((a, s) => a + num(s.download_bytes), 0) + num(liveSession?.download_bytes);
  const accepts = authLogs.filter((a) => a.reply === "Access-Accept").length;
  const rejects = authLogs.filter((a) => a.reply !== "Access-Accept").length;

  const balance = Number(sub.balance ?? 0);
  const expiry = serviceSettings?.expiryDate ? new Date(serviceSettings.expiryDate) : null;
  const daysLeft = expiry ? Math.ceil((expiry.getTime() - Date.now()) / 86400000) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Live connection strip */}
      <div className={`sd-banner ${conn.level === "online" ? "ok" : conn.level === "offline" ? "" : ""}`}
        style={{ borderColor: conn.level === "online" ? "rgba(33,150,83,.4)" : conn.level === "offline" ? "rgba(211,64,83,.4)" : "var(--border)",
                 background: conn.level === "online" ? "rgba(33,150,83,.07)" : conn.level === "offline" ? "rgba(211,64,83,.07)" : "var(--surface-2)" }}>
        <span className="ic">{conn.level === "online" ? "●" : conn.level === "offline" ? "○" : "◌"}</span>
        <div>
          <b style={{ color: conn.level === "online" ? "#219653" : conn.level === "offline" ? "#D34053" : "var(--muted)" }}>
            {conn.text}
          </b>
          {" · "}last session activity{" "}
          {liveSession?.lastactivity ? fmtDateTimeFull(liveSession.lastactivity) : sessionChecked ? "—" : "checking…"}
          {liveSession && (
            <span style={{ color: "var(--muted)" }}>
              {" "}· IP <code>{liveSession.framedipaddress || "—"}</code> · up {fmtDuration(liveSession.duration_seconds)}
            </span>
          )}
          {conn.level === "offline" && sessionChecked && sessionLogs.length > 0 && (
            <span style={{ color: "var(--muted)" }}>
              {" "}· last session ended {fmtDateTime(sessionLogs[0].acctstoptime)}
            </span>
          )}
        </div>
      </div>

      {/* Alert cluster: anything that needs a decision, never buried */}
      {(flap || openSessions > 1 || staticHealth?.status === "MISMATCH" || (usage?.state === "BLOCKED") || routerLog?.diagnosis?.severity === "critical") && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <GroupLabel right={<button className="sd-btn xs" onClick={() => onGoto("diagnostics")}>Diagnose →</button>}>Needs attention</GroupLabel>
          {flap && (
            <div className="sd-alert">
              <span className="sd-alert-ic">↻</span>
              <div>
                <b>Session flapping — {flap.count} sessions in {flap.windowHrs}h</b>
                <div style={{ color: "var(--muted)", marginTop: 2 }}>{flap.reason} Check the cable/ONT/credentials before assuming a random drop.</div>
              </div>
            </div>
          )}
          {openSessions > 1 && (
            <div className="sd-alert">
              <span className="sd-alert-ic">⚠</span>
              <div>
                <b>Duplicate login — same username online {openSessions}×</b>
                <div style={{ color: "var(--muted)", marginTop: 2 }}>Password sharing or a stuck session. Cut them in the Connection tab.</div>
              </div>
            </div>
          )}
          {staticHealth?.status === "MISMATCH" && (
            <div className="sd-alert">
              <span className="sd-alert-ic">⚠</span>
              <div>
                <b>Static IP mismatch — expected {staticHealth.configuredIp || "—"}, sources disagree</b>
                <div style={{ color: "var(--muted)", marginTop: 2 }}>DB / RADIUS / live session do not agree. Fix it in Service → Static IP.</div>
              </div>
            </div>
          )}
          {usage?.state === "BLOCKED" && (
            <div className="sd-alert">
              <span className="sd-alert-ic">⛔</span>
              <div><b>Net blocked — data allowance reached.</b> Extend quota or restore in the Usage tab.</div>
            </div>
          )}
          {routerLog?.diagnosis?.severity === "critical" && (
            <div className="sd-alert">
              <span className="sd-alert-ic">⚠</span>
              <div><b>Router fault detected:</b> {routerLog.diagnosis.title} — see Router Log.</div>
            </div>
          )}
        </div>
      )}

      {/* KPI row */}
      <div className="sd-kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 7 }}>
        <Kpi label="Uptime" value={liveSession ? fmtDuration(liveSession.duration_seconds) : "—"} color={liveSession ? "#219653" : "var(--muted)"} />
        <Kpi label="Leased IP" value={<code>{liveSession?.framedipaddress || "—"}</code>} color={liveSession ? "#2563EB" : "var(--muted)"} />
        <Kpi label="Download" value={fmtBytes(liveSession?.download_bytes)} color="#2563EB" />
        <Kpi label="Upload" value={fmtBytes(liveSession?.upload_bytes)} color="#219653" />
        <Kpi label="All-time traffic" value={fmtBytes(totalDownload + totalUpload)} sub={`${sessionLogs.length + (liveSession ? 1 : 0)} sessions`} color="#7C3AED" />
        <Kpi label="Auth log" value={`${accepts}✓ / ${rejects}✗`} sub="last 100 attempts" color={rejects ? "#D34053" : "#219653"} />
        <Kpi label="Balance" value={`Rs ${(balance || 0).toLocaleString()}`} sub={balance < 0 ? "owes money" : "in credit"} color={balance < 0 ? "#D34053" : balance > 0 ? "#219653" : "var(--muted)"} />
        <Kpi label="Expiry" value={daysLeft === null ? "—" : daysLeft < 0 ? `${-daysLeft}d overdue` : `${daysLeft}d left`}
          color={daysLeft !== null && daysLeft < 3 ? "#D34053" : daysLeft !== null && daysLeft < 10 ? "#B45309" : "var(--muted)"}
          sub={expiry ? fmtDateTime(expiry) : "no expiry set"} />
      </div>

      {/* Data allowance (compact meter) */}
      {usage?.quotaGb ? (
        <Panel title="Data allowance" sub={usage.cycleStart ? `cycle began ${fmtDate(usage.cycleStart)}` : undefined}
          actions={usage.percentUsed != null ? <StatusChip level={usage.state === "BLOCKED" ? "bad" : usage.state === "THROTTLED" || usage.percentUsed >= 85 ? "warn" : "ok"} text={`${usage.percentUsed}% used`} dotPulse={false} /> : undefined}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10, marginBottom: 10 }}>
            <div><span className="sd-kpi-label">USED</span><div style={{ fontSize: 16, fontWeight: 800 }}>{usage.usedGb} GB</div></div>
            <div><span className="sd-kpi-label">ALLOWANCE</span><div style={{ fontSize: 16, fontWeight: 800 }}>{usage.quotaGb} GB</div></div>
            <div><span className="sd-kpi-label">LEFT</span><div style={{ fontSize: 16, fontWeight: 800, color: usage.remainingGb !== null && usage.remainingGb <= 2 ? "#D34053" : "var(--text)" }}>{usage.remainingGb ?? "—"} GB</div></div>
            {usage.bonusGb ? <div><span className="sd-kpi-label">BONUS</span><div style={{ fontSize: 16, fontWeight: 800 }}>{usage.bonusGb} GB</div></div> : null}
          </div>
          <UsageMeter quotaGb={usage.quotaGb} usedGb={usage.usedGb} percentUsed={usage.percentUsed} state={usage.state} throttledTo={usage.throttledTo} />
        </Panel>
      ) : usage ? (
        <Panel title="Data allowance">
          <div style={{ fontSize: 12, color: "var(--muted)" }}>No data limit on this connection — unlimited usage. Set an allowance on the package (Plans &amp; Stock) or per customer in Service Settings.</div>
        </Panel>
      ) : null}

      {/* Two-column: identity + package/NAS */}
      <div className="sd-two-col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Panel title="Customer">
          <DefList rows={[
            ["Name", sub.fullName],
            ["Username", <code key="u">{sub.username || "—"}</code>],
            ["Phone", show(sub.phone)],
            ["Email", show(sub.email)],
            ["CNIC / ID", show(sub.identity)],
            ["Address", show(sub.address)],
            ["Joined", fmtDateTime(sub.installationDate || sub.createdAt)],
            ["Account", <StatusChip key="acct" level={sub.status === "ACTIVE" ? "ok" : sub.status === "SUSPENDED" ? "warn" : sub.status === "EXPIRED" ? "bad" : "off"} text={sub.status} dotPulse={false} />],
          ]} />
        </Panel>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Panel title="Package &amp; NAS">
            <DefList rows={[
              ["Package", show(sub.package?.name)],
              ["Speed", sub.package ? `${sub.package.downloadSpeed}/${sub.package.uploadSpeed} Mbps (D/U)` : "—"],
              ["Price", sub.package ? `Rs ${sub.package.price.toLocaleString()}` : "—"],
              ["Duration", sub.package ? `${sub.package.duration} days` : "—"],
              ["Pool", show(sub.package?.pool?.name)],
              ["NAS", show(sub.nas?.nasname)],
              ["NAS IP", sub.nas?.nasIp ? <code key="nip">{sub.nas.nasIp}</code> : "—"],
              ["Area", show(sub.area?.name)],
            ]} />
          </Panel>
          <Panel title="Account state">
            <DefList rows={[
              ["Balance", `Rs ${(balance || 0).toLocaleString()}`],
              ["Expiry", expiry ? fmtDateTimeFull(serviceSettings?.expiryDate) : "—"],
              ["RADIUS", radiusChecks.length ? <StatusChip key="rs" level="ok" text="In RADIUS" dotPulse={false} /> : <StatusChip key="rs" level="off" text="Not synced" dotPulse={false} />],
              ["Invoices", `${invoices.length} · ${invoices.filter((i) => i.status !== "PAID" && i.status !== "VOID").length} open`],
              ["Payments", payments.length ? `Rs ${payments.reduce((a, p) => a + Number(p.amount || 0), 0).toLocaleString()} total` : "none"],
              ["Tickets", tickets.length ? `${tickets.filter((t) => t.status !== "CLOSED" && t.status !== "RESOLVED").length} open of ${tickets.length}` : "none"],
            ]} />
          </Panel>
        </div>
      </div>

      {/* Notes — operational memos */}
      <Panel title="Notes" sub="Transmission, install, device — anything staff must remember">
        <RecordNotes entityType="SUBSCRIBER" entityId={sub.id} />
      </Panel>
    </div>
  );
}

function fmtDate(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}