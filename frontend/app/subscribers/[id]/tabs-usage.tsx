"use client";

/**
 * Usage — data allowance (FUP) and daily traffic history.
 * The allowance is measured server-side over the customer's OWN billing cycle,
 * so a renewal correctly resets it. Extend/release act on the real FUP state.
 */
import React, { useState } from "react";
import { useSubscriberDetail } from "./context";
import { Panel, Btn, StatusChip, EmptyState } from "./ui";
import { apiSend, fmtDateTime, show } from "./lib";
import { UsageMeter, UsageBars } from "./charts";

export function UsageTab() {
  const {
    sub, usage, loadUsage, refreshLive, showToast, setBusy, busies,
  } = useSubscriberDetail();

  const [addingGb, setAddingGb] = useState(50);

  if (!sub) return <EmptyState title="No subscriber" />;

  const extendQuota = async () => {
    if (!sub?.id) return;
    const gb = Number(addingGb);
    if (!gb || gb <= 0) { showToast("Enter a positive number of GB", "err"); return; }
    setBusy("extend", true);
    try {
      const r = await apiSend<any>(`/compliance/fup/${sub.id}/extend`, "POST", { gb });
      showToast(r?.restored ? `Added ${gb} GB — service restored automatically` : `Added ${gb} GB to this cycle`, "ok");
      await loadUsage();
    } catch (e: any) {
      showToast(e?.message || "Failed to extend quota", "err");
    } finally {
      setBusy("extend", false);
    }
  };

  const release = async () => {
    if (!sub?.id) return;
    setBusy("release", true);
    try {
      const r = await apiSend<any>(`/compliance/fup/${sub.id}/release`, "PATCH");
      showToast(r?.message || "Service restored", "ok");
      await loadUsage();
      await refreshLive();
    } catch (e: any) {
      showToast(e?.message || "Failed to restore", "err");
    } finally {
      setBusy("release", false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel title="Data allowance" sub="Measured over this customer's own billing cycle — a renewal resets it">
        {!usage ? (
          <div style={{ fontSize: 12, color: "var(--muted)", padding: "8px 0" }}>
            No data-limit service on this connection — usage is unlimited.
            Set an allowance on the package (Plans &amp; Stock) or per customer in Service Settings.
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10, marginBottom: 14 }}>
              <div><span className="sd-kpi-label">USED</span><div style={{ fontSize: 18, fontWeight: 800, color: usage.percentUsed != null && usage.percentUsed >= 100 ? "#D34053" : "var(--text)" }}>{usage.usedGb} GB</div></div>
              <div><span className="sd-kpi-label">ALLOWANCE</span><div style={{ fontSize: 18, fontWeight: 800 }}>{usage.quotaGb} GB</div></div>
              <div><span className="sd-kpi-label">LEFT</span><div style={{ fontSize: 18, fontWeight: 800, color: usage.remainingGb !== null && usage.remainingGb <= 2 ? "#D34053" : "var(--text)" }}>{usage.remainingGb ?? "—"} GB</div></div>
              {usage.bonusGb ? <div><span className="sd-kpi-label">BONUS</span><div style={{ fontSize: 18, fontWeight: 800 }}>{usage.bonusGb} GB</div></div> : null}
            </div>
            <UsageMeter quotaGb={usage.quotaGb} usedGb={usage.usedGb} percentUsed={usage.percentUsed} state={usage.state} throttledTo={usage.throttledTo} />
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
              Cycle began {usage.cycleStart ? fmtDateTime(usage.cycleStart) : "—"}
              {usage.mode ? ` · enforcement mode: ${usage.mode}` : ""}
            </div>

            {/* Quota top-up + restore */}
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input type="number" min={1} value={addingGb} onChange={(e) => setAddingGb(Number(e.target.value))}
                style={{ width: 90, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 9px", color: "var(--text)", fontSize: 12 }} />
              <Btn size="sm" variant="primary" onClick={extendQuota} disabled={busies.extend}>
                {busies.extend ? "Extending…" : "+ Extend quota (GB)"}
              </Btn>
              {usage.fupApplied && (
                <Btn size="sm" variant="success" onClick={release} disabled={busies.release}>
                  {busies.release ? "Restoring…" : `Restore ${usage.state === "BLOCKED" ? "net" : "full speed"}`}
                </Btn>
              )}
              {usage.state === "BLOCKED" && <StatusChip level="bad" text="NET BLOCKED" dotPulse={false} />}
              {usage.state === "THROTTLED" && <StatusChip level="warn" text="THROTTLED" dotPulse={false} />}
            </div>
          </>
        )}
      </Panel>

      <Panel title="Traffic history" sub="Daily totals from radacct — attributed to the day each session started">
        {sub.username ? <UsageBars username={sub.username} days={14} /> : <EmptyState title="No username" />}
      </Panel>
    </div>
  );
}