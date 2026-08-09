"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import API_BASE from "../components/api";

const API =
  API_BASE;

const T = {
  card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)",
  accent: "#0ea5e9", green: "#22c55e", amber: "#f59e0b", red: "#ef4444", purple: "#8b5cf6",
};

const TYPE: Record<string, { c: string; bg: string; label: string }> = {
  SCHEDULED:   { c: "#a78bfa", bg: "rgba(139,92,246,.14)", label: "Load-shedding (scheduled)" },
  UNSCHEDULED: { c: "#f59e0b", bg: "rgba(245,158,11,.14)", label: "Power cut (unscheduled)" },
  NETWORK:     { c: "#ef4444", bg: "rgba(239,68,68,.14)",  label: "Network fault (ours)" },
  UNKNOWN:     { c: "#94a3b8", bg: "rgba(148,163,184,.14)",label: "Unclassified" },
};

const DAYS = ["Every day", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const fdt = (d?: string | null) =>
  d ? new Date(d).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—";

export default function OutagesPage() {
  const router = useRouter();
  const [tab, setTab] = useState<"live" | "history" | "schedule" | "uptime">("live");
  const [status, setStatus] = useState<any[]>([]);
  const [outages, setOutages] = useState<any[]>([]);
  const [schedules, setSchedules] = useState<any[]>([]);
  const [uptime, setUptime] = useState<any>(null);
  const [areas, setAreas] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [form, setForm] = useState({ areaId: "", dayOfWeek: "", startTime: "18:00", endTime: "20:00", notes: "" });

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    try {
      const [st, ou, sc, up, ar] = await Promise.all([
        fetch(`${API}/outages/status`, { headers }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/outages?days=30`, { headers }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/outages/schedules/all`, { headers }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/outages/uptime?days=30`, { headers }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API}/areas`, { headers }).then((r) => (r.ok ? r.json() : [])),
      ]);
      setStatus(Array.isArray(st) ? st : []);
      setOutages(Array.isArray(ou) ? ou : []);
      setSchedules(Array.isArray(sc) ? sc : []);
      setUptime(up);
      setAreas(Array.isArray(ar) ? ar : ar?.data || []);
    } catch { /* ignore */ }
  }, [token]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    load();
    const iv = setInterval(load, 60_000); // live board refreshes itself
    return () => clearInterval(iv);
  }, [token]);

  const note = (msg: string, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3500); };

  async function call(path: string, method: string, body?: any, okMsg = "Done") {
    setBusy(true);
    try {
      const r = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Failed");
      note(okMsg); load(); return d;
    } catch (e: any) { note(e.message, false); return null; } finally { setBusy(false); }
  }

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 16 };
  const input: React.CSSProperties = {
    background: T.row, border: `1px solid ${T.border}`, borderRadius: 9,
    padding: "8px 10px", color: T.text, fontSize: 12.5, width: "100%",
  };
  const btn = (bg: string, ghost = false): React.CSSProperties => ({
    background: ghost ? "transparent" : bg, color: ghost ? bg : "#fff",
    border: ghost ? `1px solid ${bg}` : "none", borderRadius: 9,
    padding: "6px 13px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", opacity: busy ? .6 : 1,
  });

  const dark = status.filter((s) => s.offlinePercent >= 50);
  const scheduledNow = status.filter((s) => s.scheduledOutage);

  return (
    <div style={{ padding: 20, color: T.text }}>
      {toast && (
        <div style={{ ...card, marginBottom: 12, padding: "10px 14px",
          borderColor: toast.ok ? T.green : T.red, color: toast.ok ? T.green : T.red,
          fontSize: 12.5, fontWeight: 600 }}>{toast.msg}</div>
      )}

      {/* Headline — is this us or WAPDA? */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12, marginBottom: 16 }}>
        {[
          ["Areas dark now", dark.length, "#ef4444", "#b91c1c", dark.length ? "needs a decision" : "all normal"],
          ["On load-shedding", scheduledNow.length, "#8b5cf6", "#6d28d9", "expected — no action"],
          ["ISP uptime 30d", `${uptime?.ispUptimePercent ?? 100}%`, "#22c55e", "#15803d", "excluding power cuts"],
          ["Customer experience", `${uptime?.customerExperiencedUptimePercent ?? 100}%`, "#0ea5e9", "#2563eb", "including power cuts"],
        ].map(([label, value, from, to, sub]: any) => (
          <div key={label} style={{
            borderRadius: 14, padding: "14px 16px", color: "#fff",
            background: `linear-gradient(135deg, ${from}, ${to})`,
            boxShadow: "0 6px 18px rgba(0,0,0,.18)",
          }}>
            <div style={{ fontSize: 10.5, opacity: .85, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
            <div style={{ fontSize: 25, fontWeight: 800, marginTop: 3 }}>{value}</div>
            <div style={{ fontSize: 10.5, opacity: .85 }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {([["live", "Live board"], ["history", "Outage history"], ["schedule", "Load-shedding timetable"], ["uptime", "Uptime report"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k as any)} style={{
            background: tab === k ? T.accent : "transparent",
            color: tab === k ? "#fff" : T.muted,
            border: `1px solid ${tab === k ? T.accent : T.border}`,
            borderRadius: 9, padding: "7px 15px", fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}>{l}</button>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 10.5, color: T.muted, alignSelf: "center" }}>
          Refreshes every 60s
        </span>
      </div>

      {/* LIVE BOARD */}
      {tab === "live" && (
        <div style={{ ...card, padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
              <thead>
                <tr style={{ background: T.row }}>
                  {["Area", "Online", "Offline", "Coverage", "What this means", ""].map((h) => (
                    <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.muted, textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {status.map((a) => {
                  const bad = a.offlinePercent >= 50;
                  const verdictColor = a.scheduledOutage ? T.purple : bad ? T.red : a.offlinePercent > 15 ? T.amber : T.green;
                  return (
                    <tr key={a.areaId} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: "10px 12px" }}>
                        <div style={{ fontWeight: 700, fontSize: 12.5 }}>{a.name}</div>
                        <div style={{ fontSize: 10, color: T.muted }}>{a.city || "—"}</div>
                      </td>
                      <td style={{ padding: "10px 12px", fontSize: 12.5, color: T.green, fontWeight: 700 }}>{a.online}</td>
                      <td style={{ padding: "10px 12px", fontSize: 12.5, color: a.offline ? T.red : T.muted, fontWeight: 700 }}>{a.offline}</td>
                      <td style={{ padding: "10px 12px", width: 150 }}>
                        <div style={{ height: 7, background: T.row, borderRadius: 4, overflow: "hidden" }}>
                          <div style={{
                            width: `${100 - a.offlinePercent}%`, height: "100%",
                            background: `linear-gradient(90deg, ${verdictColor}, ${verdictColor}aa)`,
                          }} />
                        </div>
                        <div style={{ fontSize: 9.5, color: T.muted, marginTop: 3 }}>{a.offlinePercent}% offline</div>
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: verdictColor }}>{a.verdict}</span>
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        {a.outageId && (
                          <button style={btn(T.accent, true)} disabled={busy}
                            onClick={() => {
                              const message = prompt(`Message to send to affected customers in ${a.area || "this area"}:`, "We're aware of a service interruption in your area and are working to restore it. Sorry for the inconvenience.");
                              if (message === null) return; // cancelled (empty = use default)
                              call(`/outages/${a.outageId}/notify`, "POST", message ? { message } : {}, "Customers notified");
                            }}>
                            Notify area
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!status.length && (
                  <tr><td colSpan={6} style={{ padding: 22, textAlign: "center", color: T.muted, fontSize: 12.5 }}>
                    No areas with active customers yet.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* HISTORY */}
      {tab === "history" && (
        <div style={{ ...card, padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
              <thead>
                <tr style={{ background: T.row }}>
                  {["Area", "Started", "Ended", "Affected", "Cause", "Reclassify"].map((h) => (
                    <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.muted, textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {outages.map((o) => {
                  const t = TYPE[o.type] || TYPE.UNKNOWN;
                  return (
                    <tr key={o.id} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: "10px 12px", fontSize: 12.5, fontWeight: 600 }}>{o.area?.name || "—"}</td>
                      <td style={{ padding: "10px 12px", fontSize: 11.5, color: T.muted }}>{fdt(o.startedAt)}</td>
                      <td style={{ padding: "10px 12px", fontSize: 11.5, color: o.endedAt ? T.muted : T.red }}>
                        {o.endedAt ? fdt(o.endedAt) : "ongoing"}
                      </td>
                      <td style={{ padding: "10px 12px", fontSize: 12 }}>{o.affectedCount}/{o.areaTotal}</td>
                      <td style={{ padding: "10px 12px" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: t.c, background: t.bg, padding: "3px 9px", borderRadius: 20 }}>
                          {t.label}
                        </span>
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        <select style={{ ...input, width: 150, fontSize: 11, padding: "5px 8px" }} value=""
                          onChange={(e) => e.target.value && call(`/outages/${o.id}/classify`, "PATCH", { type: e.target.value }, "Reclassified")}>
                          <option value="">Change cause…</option>
                          {Object.keys(TYPE).map((k) => <option key={k} value={k}>{TYPE[k].label}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
                {!outages.length && (
                  <tr><td colSpan={6} style={{ padding: 22, textAlign: "center", color: T.muted, fontSize: 12.5 }}>
                    No outages recorded in the last 30 days.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TIMETABLE */}
      {tab === "schedule" && (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Add a load-shedding window</div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 10 }}>
              Drops inside these windows are treated as expected power cuts, not faults — and are excluded from your uptime figure.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10 }}>
              <select style={input} value={form.areaId} onChange={(e) => setForm({ ...form, areaId: e.target.value })}>
                <option value="">Select area *</option>
                {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <select style={input} value={form.dayOfWeek} onChange={(e) => setForm({ ...form, dayOfWeek: e.target.value })}>
                {DAYS.map((d, i) => <option key={d} value={i === 0 ? "" : i - 1}>{d}</option>)}
              </select>
              <input style={input} type="time" value={form.startTime}
                onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
              <input style={input} type="time" value={form.endTime}
                onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
            </div>
            <button style={{ ...btn(T.green), marginTop: 10 }} disabled={busy || !form.areaId}
              onClick={async () => {
                const d = await call("/outages/schedules", "POST", form, "Window added");
                if (d) setForm({ ...form, notes: "" });
              }}>Add window</button>
          </div>

          <div style={{ ...card, padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: T.row }}>
                  {["Area", "Day", "From", "To", ""].map((h) => (
                    <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.muted, textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: "10px 12px", fontSize: 12.5, fontWeight: 600 }}>{s.area?.name}</td>
                    <td style={{ padding: "10px 12px", fontSize: 12 }}>{s.dayOfWeek === null ? "Every day" : DAYS[s.dayOfWeek + 1]}</td>
                    <td style={{ padding: "10px 12px", fontSize: 12, color: T.purple, fontWeight: 700 }}>{s.startTime}</td>
                    <td style={{ padding: "10px 12px", fontSize: 12, color: T.purple, fontWeight: 700 }}>{s.endTime}</td>
                    <td style={{ padding: "10px 12px" }}>
                      <button style={btn(T.red, true)} onClick={() => call(`/outages/schedules/${s.id}`, "DELETE", undefined, "Removed")}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {!schedules.length && (
                  <tr><td colSpan={5} style={{ padding: 22, textAlign: "center", color: T.muted, fontSize: 12.5 }}>
                    No windows yet. Add your area's timetable so power cuts stop counting as faults.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* UPTIME */}
      {tab === "uptime" && uptime && (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Uptime by cause — last {uptime.periodDays} days</div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 14 }}>
              Most panels blame the ISP for every offline minute. Separating power from network is the
              difference between "we delivered {uptime.customerExperiencedUptimePercent}%" and
              "we delivered {uptime.ispUptimePercent}% — the rest was WAPDA".
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
              {[
                ["Scheduled load-shedding", `${uptime.scheduledPowerMinutes} min`, T.purple],
                ["Unscheduled power cuts", `${uptime.unscheduledPowerMinutes} min`, T.amber],
                ["Network faults (ours)", `${uptime.networkMinutes} min`, T.red],
                ["Outages recorded", uptime.outages, T.accent],
              ].map(([l, v, c]: any) => (
                <div key={l} style={{ background: T.row, borderRadius: 10, padding: 12 }}>
                  <div style={{ fontSize: 10.5, color: T.muted }}>{l}</div>
                  <div style={{ fontSize: 19, fontWeight: 800, color: c, marginTop: 2 }}>{v}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ ...card, padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: T.row }}>
                  {["Area", "Outages", "Power (min)", "Network (min)"].map((h) => (
                    <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.muted, textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(uptime.byArea || []).map((a: any) => (
                  <tr key={a.area} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: "10px 12px", fontSize: 12.5, fontWeight: 600 }}>{a.area}</td>
                    <td style={{ padding: "10px 12px", fontSize: 12 }}>{a.outages}</td>
                    <td style={{ padding: "10px 12px", fontSize: 12, color: T.amber }}>{a.power}</td>
                    <td style={{ padding: "10px 12px", fontSize: 12, color: a.network ? T.red : T.muted }}>{a.network}</td>
                  </tr>
                ))}
                {!(uptime.byArea || []).length && (
                  <tr><td colSpan={4} style={{ padding: 22, textAlign: "center", color: T.muted, fontSize: 12.5 }}>
                    No outages recorded — nothing to report.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
