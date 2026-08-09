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

const STATUS: Record<string, { c: string; bg: string; label: string }> = {
  PENDING:     { c: "#fbbf24", bg: "#422006", label: "Pending" },
  ASSIGNED:    { c: "#38bdf8", bg: "#0c4a6e", label: "Assigned" },
  IN_PROGRESS: { c: "#a78bfa", bg: "#3730a3", label: "On site" },
  COMPLETED:   { c: "#4ade80", bg: "#14532d", label: "Completed" },
  FAILED:      { c: "#f87171", bg: "#450a0a", label: "Failed" },
  CANCELLED:   { c: "#94a3b8", bg: "#1e293b", label: "Cancelled" },
};

const TYPES = ["INSTALLATION", "FAULT_REPAIR", "MAINTENANCE", "DISCONNECTION", "SURVEY", "UPGRADE", "RELOCATION"];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];

const fdt = (d?: string | null) =>
  d ? new Date(d).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—";

export default function FieldJobsPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [perf, setPerf] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [subs, setSubs] = useState<any[]>([]);
  const [status, setStatus] = useState("ALL");
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [form, setForm] = useState({
    type: "INSTALLATION", priority: "MEDIUM", subscriberId: "",
    assignedTo: "", scheduledAt: "", description: "",
  });

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    const qs = status !== "ALL" ? `?status=${status}` : "";
    try {
      const [j, s, p, u, sb] = await Promise.all([
        fetch(`${API}/field-jobs${qs}`, { headers }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/field-jobs/stats`, { headers }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API}/field-jobs/performance?days=30`, { headers }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/users`, { headers }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/subscribers?limit=200`, { headers }).then((r) => (r.ok ? r.json() : [])),
      ]);
      setJobs(Array.isArray(j) ? j : []);
      setStats(s);
      setPerf(Array.isArray(p) ? p : []);
      setUsers(Array.isArray(u) ? u : []);
      setSubs(Array.isArray(sb) ? sb : sb?.data || []);
    } catch { /* ignore */ }
  }, [status, token]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    load();
  }, [status, token]);

  const note = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  async function create() {
    if (!form.description.trim()) return note("Describe the work to be done.", false);
    setBusy(true);
    try {
      const r = await fetch(`${API}/field-jobs`, { method: "POST", headers, body: JSON.stringify(form) });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Could not create");
      setShowForm(false);
      setForm({ type: "INSTALLATION", priority: "MEDIUM", subscriberId: "", assignedTo: "", scheduledAt: "", description: "" });
      note(`Created ${d.jobNo}`);
      load();
    } catch (e: any) { note(e.message, false); } finally { setBusy(false); }
  }

  async function act(path: string, body?: any) {
    setBusy(true);
    try {
      const r = await fetch(`${API}${path}`, { method: "PATCH", headers, body: body ? JSON.stringify(body) : undefined });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Action failed");
      note("Updated");
      load();
    } catch (e: any) { note(e.message, false); } finally { setBusy(false); }
  }

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 14 };
  const input: React.CSSProperties = {
    background: T.row, border: `1px solid ${T.border}`, borderRadius: 8,
    padding: "8px 10px", color: T.text, fontSize: 12, width: "100%",
  };
  const btn = (bg: string): React.CSSProperties => ({
    background: bg, color: "#fff", border: "none", borderRadius: 8,
    padding: "6px 12px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.6 : 1,
  });

  const staff = users.filter((u) => ["SALES", "RESELLER", "SUB_RESELLER", "RETAILER"].includes(u.role));

  return (
    <div style={{ padding: 20, color: T.text }}>
      {toast && (
        <div style={{ ...card, marginBottom: 12, borderColor: toast.ok ? T.green : T.red,
          color: toast.ok ? T.green : T.red, fontSize: 12, fontWeight: 600 }}>{toast.msg}</div>
      )}

      {/* Dispatch board — overdue is the number a dispatcher works from */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 10, marginBottom: 14 }}>
        {[
          ["Unassigned", stats?.unassigned, T.amber],
          ["Overdue", stats?.overdue, T.red],
          ["Today", stats?.scheduledToday, T.accent],
          ["On site", stats?.inProgress, T.purple],
          ["Completed 30d", stats?.completedLast30Days, T.green],
        ].map(([label, val, color]: any) => (
          <div key={label} style={card}>
            <div style={{ fontSize: 10.5, color: T.muted, textTransform: "uppercase" }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color, marginTop: 2 }}>{val ?? 0}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <select style={{ ...input, width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="ALL">All jobs</option>
          {Object.keys(STATUS).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
        </select>
        <button style={btn(T.accent)} onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "+ New job"}
        </button>
      </div>

      {showForm && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Dispatch a job</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10 }}>
            <div><label style={{ fontSize: 10.5, color: T.muted }}>Type</label>
              <select style={input} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
              </select></div>
            <div><label style={{ fontSize: 10.5, color: T.muted }}>Priority</label>
              <select style={input} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select></div>
            <div><label style={{ fontSize: 10.5, color: T.muted }}>Customer</label>
              <select style={input} value={form.subscriberId} onChange={(e) => setForm({ ...form, subscriberId: e.target.value })}>
                <option value="">— none —</option>
                {subs.map((s) => <option key={s.id} value={s.id}>{s.fullName} ({s.username})</option>)}
              </select></div>
            <div><label style={{ fontSize: 10.5, color: T.muted }}>Technician</label>
              <select style={input} value={form.assignedTo} onChange={(e) => setForm({ ...form, assignedTo: e.target.value })}>
                <option value="">— assign later —</option>
                {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select></div>
            <div><label style={{ fontSize: 10.5, color: T.muted }}>Scheduled for</label>
              <input style={input} type="datetime-local" value={form.scheduledAt}
                onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} /></div>
          </div>
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 10.5, color: T.muted }}>What needs doing *</label>
            <textarea style={{ ...input, minHeight: 60 }} value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <button style={{ ...btn(T.green), marginTop: 10 }} disabled={busy} onClick={create}>Create job</button>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, alignItems: "start" }}>
        {/* Job list */}
        <div style={{ ...card, padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
              <thead>
                <tr style={{ background: T.row }}>
                  {["Job", "Customer", "Technician", "Scheduled", "Status", "Actions"].map((h) => (
                    <th key={h} style={{ padding: "9px 10px", textAlign: "left", fontSize: 10, color: T.muted, textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const st = STATUS[j.status] || STATUS.PENDING;
                  const overdue = j.scheduledAt && new Date(j.scheduledAt) < new Date()
                    && ["PENDING", "ASSIGNED", "IN_PROGRESS"].includes(j.status);
                  return (
                    <tr key={j.id} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: "9px 10px" }}>
                        <div style={{ fontWeight: 600, fontSize: 12 }}>{j.jobNo}</div>
                        <div style={{ fontSize: 10, color: T.muted }}>{j.type.replace("_", " ")}</div>
                      </td>
                      <td style={{ padding: "9px 10px", fontSize: 11 }}>
                        {j.subscriber?.fullName || "—"}
                        <div style={{ fontSize: 10, color: T.muted }}>{j.subscriber?.phone || ""}</div>
                      </td>
                      <td style={{ padding: "9px 10px", fontSize: 11 }}>
                        {j.technician?.name || <span style={{ color: T.amber }}>Unassigned</span>}
                      </td>
                      <td style={{ padding: "9px 10px", fontSize: 11, color: overdue ? T.red : T.muted }}>
                        {fdt(j.scheduledAt)}{overdue && " ⚠"}
                      </td>
                      <td style={{ padding: "9px 10px" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: st.c, background: st.bg, padding: "2px 8px", borderRadius: 4 }}>
                          {st.label}
                        </span>
                      </td>
                      <td style={{ padding: "9px 10px" }}>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {!j.assignedTo && (
                            <select style={{ ...input, width: 120, fontSize: 10.5, padding: "4px 6px" }} value=""
                              onChange={(e) => e.target.value && act(`/field-jobs/${j.id}/assign/${e.target.value}`)}>
                              <option value="">Assign…</option>
                              {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                            </select>
                          )}
                          {j.status === "ASSIGNED" && (
                            <button style={btn(T.purple)} onClick={() => act(`/field-jobs/${j.id}/start`)}>Start</button>
                          )}
                          {["ASSIGNED", "IN_PROGRESS"].includes(j.status) && (
                            <>
                              <button style={btn(T.green)}
                                onClick={() => act(`/field-jobs/${j.id}/complete`, { success: true, notes: "Completed on site" })}>
                                Done
                              </button>
                              <button style={btn(T.red)}
                                onClick={() => {
                                  const reason = prompt("Why did it fail?") || "Not specified";
                                  act(`/field-jobs/${j.id}/complete`, { success: false, failureReason: reason });
                                }}>
                                Failed
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!jobs.length && (
                  <tr><td colSpan={6} style={{ padding: 20, textAlign: "center", color: T.muted, fontSize: 12 }}>
                    No jobs. Create one above.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Technician performance */}
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Technician performance</div>
          <div style={{ fontSize: 10.5, color: T.muted, marginBottom: 10 }}>Last 30 days</div>
          {perf.map((t) => (
            <div key={t.technicianId} style={{
              display: "flex", justifyContent: "space-between",
              padding: "7px 0", borderTop: `1px solid ${T.border}`, fontSize: 12,
            }}>
              <div>
                <div style={{ fontWeight: 600 }}>{t.name}</div>
                <div style={{ fontSize: 10, color: T.muted }}>
                  {t.open} open{t.failed ? ` · ${t.failed} failed` : ""}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: T.green, fontWeight: 700 }}>{t.completed}</div>
                <div style={{ fontSize: 10, color: T.muted }}>
                  {t.avgMinutesOnSite ? `${t.avgMinutesOnSite}m avg` : "—"}
                </div>
              </div>
            </div>
          ))}
          {!perf.length && <div style={{ fontSize: 12, color: T.muted }}>No completed jobs yet.</div>}
        </div>
      </div>
    </div>
  );
}
