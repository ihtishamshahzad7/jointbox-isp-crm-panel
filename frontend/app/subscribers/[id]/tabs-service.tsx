"use client";

/**
 * Service — ServiceSettings (expiry, IP, MAC lock, VLAN, multi-session, quota,
 * SMS), the static-IP health checker + assignment lifecycle, bandwidth
 * override, and the physical install record.
 *
 * Static IP health is verified against the REAL active session + RADIUS reply,
 * never just the DB — a mismatch is shown loudly with actions, not hidden.
 */
import React, { useState } from "react";
import { useSubscriberDetail } from "./context";
import { Panel, Btn, DefList, StatusChip, inputStyle, EmptyState } from "./ui";
import { apiGet, apiSend, fmtDate, fmtDateTime, show } from "./lib";
import type { ServiceSettings, StaticIpHealth } from "./lib";
import { money } from "../../components/currency";

export function ServiceTab() {
  const {
    sub, serviceSettings, ipv6, usage, staticIp, staticHealth, setStaticIp, setStaticHealth,
    liveSession, loadBundle, loadStatic, refreshLive, showToast, setBusy, busies,
  } = useSubscriberDetail();

  const [ipForm, setIpForm] = useState({
    ipAddress: staticIp?.ipAddress ?? "",
    monthlyPrice: staticIp?.monthlyPrice != null ? String(staticIp.monthlyPrice) : "",
    gateway: staticIp?.gateway ?? "",
  });

  if (!sub) return <EmptyState title="No subscriber" />;
  const ss: ServiceSettings = serviceSettings ?? ({} as ServiceSettings);
  const username = sub.username ?? "";
  const isOnline = !!liveSession;

  const syncRadiusNow = async () => {
    if (!sub?.id) return;
    setBusy("radius-sync", true);
    try {
      const r = await apiSend<any>(`/subscribers/${sub.id}/sync-to-radius`, "POST");
      if (!r) { showToast("RADIUS sync failed", "err"); return; }
      showToast(r.addressing ? `RADIUS synchronized — ${r.addressing}` : r.message || "RADIUS synchronized", "ok");
      const h = await apiGet<StaticIpHealth>(`/static-ips/subscriber/${sub.id}/health`);
      if (h) setStaticHealth(h);
      await refreshLive();
    } catch (e: any) {
      showToast(e?.message || "RADIUS sync failed", "err");
    } finally {
      setBusy("radius-sync", false);
    }
  };

  const saveStaticIp = async () => {
    if (!sub?.id) return;
    if (!ipForm.ipAddress.trim()) { showToast("Enter an IP address", "err"); return; }
    setBusy("ip-save", true);
    try {
      const r = await apiSend<any>(`/static-ips/subscriber/${sub.id}`, "POST", {
        ipAddress: ipForm.ipAddress.trim(),
        monthlyPrice: ipForm.monthlyPrice ? Number(ipForm.monthlyPrice) : undefined,
        gateway: ipForm.gateway.trim() || undefined,
      });
      if (!r) { showToast("Could not set the address", "err"); return; }
      if (r.warning) showToast(r.warning, "warn");
      else if (r.reconnected && r.applied === false) showToast(`${r.ipAddress} saved, but the router did not apply it on reconnect — check the PPP profile.`, "err");
      else showToast(r.reconnected ? `${r.ipAddress} is live — session reconnected and verified` : `${r.ipAddress} saved — applies on their next connection`, "ok");
      await loadBundle();
      await loadStatic();
      await refreshLive();
    } catch (e: any) {
      showToast(e?.message || "Could not set the address", "err");
    } finally {
      setBusy("ip-save", false);
    }
  };

  const removeStaticIp = async () => {
    if (!staticIp?.id) return;
    if (!confirm("Remove this static address? It returns to the pool and the monthly charge stops.")) return;
    setBusy("ip-remove", true);
    try {
      const r = await apiSend<any>(`/static-ips/${staticIp.id}/release`, "PATCH", { reason: "Removed from the subscriber page" });
      if (!r) { showToast("Could not remove the address", "err"); return; }
      showToast(r.message || "Address returned to the pool — monthly charge stopped", "ok");
      setStaticIp(null);
      setStaticHealth(null);
      setIpForm({ ipAddress: "", monthlyPrice: "", gateway: "" });
      await loadBundle();
      await loadStatic();
    } catch (e: any) {
      showToast(e?.message || "Could not remove the address", "err");
    } finally {
      setBusy("ip-remove", false);
    }
  };

  const toggleMultiSession = async () => {
    if (!sub?.id) return;
    const next = !ss.allowMultipleSessions;
    setBusy("multisession", true);
    try {
      const r = await apiSend<any>(`/service-settings/subscriber/${sub.id}/upsert`, "POST", { allowMultipleSessions: next });
      if (!r) { showToast("Failed to save setting", "err"); return; }
      const s = await apiSend<any>(`/subscribers/${sub.id}/sync-to-radius`, "POST");
      if (!s) showToast(`Saved, but RADIUS re-sync failed — the guard applies on next manual sync.`, "warn");
      showToast(next ? "Multiple sessions ENABLED — RADIUS will no longer reject a 2nd dial-in." : "One-device guard ON — RADIUS rejects a 2nd dial-in.", next ? "warn" : "ok");
      await loadBundle();
      await refreshLive();
    } catch (e: any) {
      showToast(e?.message || "Network error saving setting", "err");
    } finally {
      setBusy("multisession", false);
    }
  };

  const sh = staticHealth;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* ══ STATIC PUBLIC IP — health checker + lifecycle ══ */}
      <Panel title="Static public IP" sub={sh?.wantsStatic ? "DB assignment vs RADIUS radreply vs live session" : "No static address — the customer takes one from the package pool"}
        actions={sh ? <StaticHealthBadge h={sh} /> : undefined}>

        {sh?.wantsStatic && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 14 }}>
            {[
              ["DATABASE", sh.database.ok, sh.database.ip || "—"],
              ["RADIUS (radreply)", sh.radius.ok, sh.radius.ip || "—"],
              ["LIVE SESSION", sh.session.online ? sh.session.ok : null, sh.session.ip || (sh.session.online ? "—" : "offline")],
            ].map(([label, ok, val]) => (
              <div key={label as string} style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 9px", fontSize: 10.5 }}>
                <div style={{ color: "var(--muted)", fontWeight: 700, letterSpacing: ".04em" }}>{label}</div>
                <div style={{ marginTop: 3, display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ color: ok === null ? "#B45309" : ok ? "#219653" : "#D34053", fontWeight: 800 }}>
                    {ok === null ? "—" : ok ? "✓" : "✗"}
                  </span>
                  <code style={{ color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{val}</code>
                </div>
              </div>
            ))}
          </div>
        )}

        {sh?.status === "MISMATCH" && (
          <div className="sd-alert">
            <span className="sd-alert-ic">⚠</span>
            <div>
              <b>STATIC IP MISMATCH</b> — the sources disagree on the address.
              <div style={{ color: "var(--muted)", marginTop: 2 }}>Expected <code>{sh.configuredIp}</code>. Use Sync RADIUS to push the profile, then disconnect so the customer re-dials onto the configured address.</div>
              <div className="sd-alert-actions">
                <Btn size="xs" variant="primary" onClick={syncRadiusNow} disabled={busies["radius-sync"]}>Sync RADIUS</Btn>
                <Btn size="xs" variant="warn" onClick={() => isOnline ? confirm("Disconnect so the customer re-dials onto the static address?") && apiSend(`/network/disconnect/${encodeURIComponent(username)}`, "POST").then(() => refreshLive()) : undefined}>
                  Disconnect &amp; reconnect
                </Btn>
                <Btn size="xs" variant="ghost" onClick={() => showToast("Check MikroTik IP pool / PPP profile on the router", "warn")}>Check MikroTik</Btn>
              </div>
            </div>
          </div>
        )}

        {staticIp ? (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 19, fontWeight: 800, fontFamily: "ui-monospace,monospace", color: "var(--accent)" }}>{staticIp.ipAddress}</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                Assigned {fmtDateTime(staticIp.assignedAt)}
                {staticIp.nas?.nasname ? ` · via ${staticIp.nas.nasname}` : ""}
                {staticIp.nextBillingDate ? ` · next charge ${fmtDate(staticIp.nextBillingDate)}` : ""}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#219653" }}>{staticIp.monthlyPrice ? money(staticIp.monthlyPrice) : "No charge"}</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>per month</div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
            No static address on this connection — the customer takes one from the package pool on each dial-in.
          </div>
        )}

        {/* Assignment form */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10 }}>
          <div>
            <label className="sd-field-label">IP ADDRESS</label>
            <input style={inputStyle} placeholder="119.73.14.50" value={ipForm.ipAddress}
              onChange={(e) => setIpForm({ ...ipForm, ipAddress: e.target.value })} />
          </div>
          <div>
            <label className="sd-field-label">MONTHLY PRICE</label>
            <input style={inputStyle} type="number" placeholder="0" value={ipForm.monthlyPrice}
              onChange={(e) => setIpForm({ ...ipForm, monthlyPrice: e.target.value })} />
          </div>
          <div>
            <label className="sd-field-label">GATEWAY (OPTIONAL)</label>
            <input style={inputStyle} placeholder="—" value={ipForm.gateway}
              onChange={(e) => setIpForm({ ...ipForm, gateway: e.target.value })} />
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <Btn size="sm" variant="primary" onClick={saveStaticIp} disabled={busies["ip-save"]}>
            {staticIp ? "Update address" : "Set static IP"}
          </Btn>
          {staticIp && (
            <Btn size="sm" variant="default" onClick={syncRadiusNow} disabled={busies["radius-sync"]} title="Push the current profile (pool/static IP/MAC/speed) to FreeRADIUS right now">
              Sync RADIUS
            </Btn>
          )}
          {staticIp && (
            <Btn size="sm" variant="danger" onClick={removeStaticIp} disabled={busies["ip-remove"]}>
              Remove &amp; stop billing
            </Btn>
          )}
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 10, lineHeight: 1.6 }}>
          Setting an address stops the pool being requested — the customer gets exactly this IP. If they are online now the session is reconnected so it applies immediately.
          The address and its price live on the Static IPs page with full assignment history.
        </div>
      </Panel>

      {/* ══ Service settings ══ */}
      <Panel title="Service settings" sub="Expiry, addressing, device lock and connection policy">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
          <DefList rows={[
            ["Profile status", <StatusChip key="s" level={sub.status === "ACTIVE" ? "ok" : sub.status === "SUSPENDED" ? "warn" : sub.status === "EXPIRED" ? "bad" : "off"} text={sub.status} dotPulse={false} />],
            ["Connection type", show(sub.connectionType)],
            ["Auth method", show(sub.authMethod)],
            ["NAS", show(sub.nas?.nasname)],
            ["Package", show(sub.package?.name)],
            ["Expiry date", fmtDateTime(ss.expiryDate || null)],
            ["Duration (days)", show(ss.duration ?? sub.package?.duration)],
            ["IP address", ss.ipAddress ? <code key="ip">{ss.ipAddress}</code> : "—"],
            ["IP type", show(ss.ipType)],
            ["MAC address", ss.macAddress ? <code key="mac">{ss.macAddress}</code> : "—"],
            ["MAC lock", ss.macLockEnabled ? "Enabled" : "Disabled"],
            ["VLAN ID", show(ss.vlanId)],
            ["SMS notifications", ss.smsEnabled ? "Enabled" : "Disabled"],
            ["Custom price", ss.customPrice ? money(ss.customPrice) : "—"],
            ["Discount", ss.discountType ? `${show(ss.discountType)} ${ss.discountValue ?? ""}` : "—"],
          ]} />
          <DefList rows={[
            ["Data allowance", usage?.quotaGb ? `${usage.quotaGb} GB` : show(ss.quota || "Unlimited")],
            ["Used this cycle", usage?.usedGb != null ? `${usage.usedGb} GB` : "—"],
            ["Bonus quota", ss.bonusQuotaGb ? `${ss.bonusQuotaGb} GB` : "—"],
            ["Quota reset", fmtDateTime(ss.quotaResetDate || null)],
            ...(ipv6?.framedPrefix ? [["IPv6 prefix", <code key="v6">{ipv6.framedPrefix}</code>] as [string, React.ReactNode]] : []),
            ...(ipv6?.delegatedPrefix ? [["IPv6 delegated (PD)", <code key="v6pd">{ipv6.delegatedPrefix}</code>] as [string, React.ReactNode]] : []),
            ["Box / POP", show(ss.boxNumber || ss.ontSerial)],
            ["Box address", show(ss.boxAddress || ss.ontModel)],
            ["Uplink port", show(ss.uplinkPort)],
            ["Fiber code", show(ss.fiberCode)],
            ["Fiber color", show(ss.fiberColor)],
            ["Cable type", show(ss.cableType)],
            ["Switch board", show(ss.switchBoard)],
            ["Switch port", show(ss.switchPort)],
          ]} />
        </div>

        {/* SIMULTANEOUS-USE toggle */}
        <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 700, fontSize: 12.5 }}>Allow multiple simultaneous connections</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, lineHeight: 1.5 }}>
              OFF (default): one account = one online device; RADIUS rejects the second dial-in.
              ON: the same username may be online from several devices at once — use only for genuinely shared accounts.
            </div>
          </div>
          <Btn size="sm" variant={ss.allowMultipleSessions ? "warn" : "success"} onClick={toggleMultiSession} disabled={busies.multisession}>
            {ss.allowMultipleSessions ? "MULTI-SESSION: ON" : "ONE DEVICE: ON"}
          </Btn>
        </div>
      </Panel>

      {/* ══ Bandwidth override ══ */}
      <Panel title="Bandwidth override" sub="Set here only when the customer should NOT use the package speed">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div><span className="sd-field-label">UPLOAD SPEED (MBPS)</span><div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>{ss.uploadSpeed ? `${ss.uploadSpeed} Mbps` : "— (uses package)"}</div></div>
          <div><span className="sd-field-label">DOWNLOAD SPEED (MBPS)</span><div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>{ss.downloadSpeed ? `${ss.downloadSpeed} Mbps` : "— (uses package)"}</div></div>
        </div>
      </Panel>

      {/* ══ Physical installation ══ */}
      <Panel title="Physical installation" sub="ONT / optical and PPTP backup records">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
          <DefList rows={[
            ["ONT serial", show(ss.ontSerial)],
            ["ONT model", show(ss.ontModel)],
            ["Signal level", show(ss.signalLevel)],
            ["RX power", show(ss.rxPower)],
            ["TX power", show(ss.txPower)],
            ["PPTP username", show(ss.pptpUsername)],
          ]} />
          <DefList rows={[
            ["PPTP password", ss.pptpPassword ? "••••••" : "—"],
            ["Has backup", ss.hasBackup ? "Yes" : "No"],
            ["ONU note", show(ss.onuNote)],
            ["Notes", show(ss.notes)],
          ]} />
        </div>
      </Panel>
    </div>
  );
}

/** Small badge for the static-IP health state. */
function StaticHealthBadge({ h }: { h: any }) {
  const map: Record<string, { label: string; color: string }> = {
    HEALTHY: { label: "✓ HEALTHY", color: "#219653" },
    MISMATCH: { label: "⚠ MISMATCH", color: "#D34053" },
    NOT_ONLINE: { label: "NOT ONLINE", color: "#B45309" },
    DYNAMIC: { label: "DYNAMIC", color: "var(--muted)" },
  };
  const m = map[h.status] ?? { label: h.status ?? "—", color: "var(--muted)" };
  return <span className="sd-badge" style={{ color: m.color, borderColor: m.color }}>{m.label}</span>;
}