"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import API_BASE from "../components/api";

const API = API_BASE;

const STATUS_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  QUEUED:  { bg: "rgba(148,163,184,.15)", color: "#94a3b8", label: "Queued" },
  RUNNING: { bg: "rgba(14,165,233,.15)",  color: "#0ea5e9", label: "Running" },
  DONE:    { bg: "rgba(34,197,94,.15)",   color: "#22c55e", label: "Done" },
  FAILED:  { bg: "rgba(239,68,68,.15)",   color: "#ef4444", label: "Failed" },
};

const fdate = (d: string | Date) => new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export default function JobsPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<any[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const timer = useRef<any>(null);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/jobs`, { headers });
      if (r.status === 401) { router.push("/login"); return; }
      const data = await r.json();
      setJobs(Array.isArray(data) ? data : []);
    } catch { /* transient — keep last view */ }
  }, [token]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    fetch(`${API}/jobs/types`, { headers }).then((r) => r.json()).then((t) => setTypes(Array.isArray(t) ? t : [])).catch(() => {});
    load();
    // Poll while any job is active so progress bars move live.
    timer.current = setInterval(load, 2000);
    return () => clearInterval(timer.current);
  }, []);

  const enqueue = useCallback(async (type: string, payload?: any, label?: string) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/jobs`, { method: "POST", headers, body: JSON.stringify({ type, payload, label }) });
      const data = await r.json();
      if (!r.ok) { setMsg(data?.message || "Failed to start job"); return; }
      setMsg(`Started: ${label || type}`);
      load();
    } catch { setMsg("Failed to start job"); }
    finally { setBusy(false); }
  }, [token, load]);

  const activeCount = jobs.filter((j) => j.status === "QUEUED" || j.status === "RUNNING").length;

  const card: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16 };

  return (
    <div style={{ padding: 20, color: "var(--text)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Background Jobs</h1>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            Long-running and bulk work runs here off the request path. {activeCount > 0 ? `${activeCount} active.` : "Nothing running."}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button disabled={busy} onClick={() => enqueue("demo.progress", { steps: 8, ms: 400 }, "Queue test")}
            style={{ background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 13, cursor: "pointer" }}>
            ▶ Run test job
          </button>
          {types.includes("integrity.reconcile") && (
            <button disabled={busy} onClick={() => enqueue("integrity.reconcile", {}, "Money & RADIUS reconcile")}
              style={{ background: "#0ea5e9", color: "#fff", border: "none", borderRadius: 8, padding: "8px 12px", fontSize: 13, cursor: "pointer" }}>
              🛡️ Run reconcile
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div style={{ ...card, padding: "8px 12px", marginBottom: 12, fontSize: 12, color: "var(--muted)", cursor: "pointer" }} onClick={() => setMsg("")}>
          {msg} ✕
        </div>
      )}

      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 130px 1fr 150px", gap: 8, padding: "10px 16px", fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "1px solid var(--border)" }}>
          <div>Job</div><div>Status</div><div>Progress</div><div>Started</div>
        </div>
        {jobs.length === 0 && (
          <div style={{ padding: 24, color: "var(--muted)", fontSize: 13, textAlign: "center" }}>No jobs yet. Start one above.</div>
        )}
        {jobs.map((j) => {
          const s = STATUS_STYLE[j.status] || STATUS_STYLE.QUEUED;
          return (
            <div key={j.id} style={{ display: "grid", gridTemplateColumns: "1fr 130px 1fr 150px", gap: 8, padding: "12px 16px", alignItems: "center", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
              <div>
                <div style={{ fontWeight: 600 }}>{j.label || j.type}</div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>#{j.id} · {j.type}</div>
                {j.error && <div style={{ fontSize: 11, color: "#ef4444", marginTop: 2 }}>{j.error}</div>}
              </div>
              <div>
                <span style={{ background: s.bg, color: s.color, borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 600 }}>{s.label}</span>
              </div>
              <div>
                <div style={{ background: "var(--surface-2)", borderRadius: 6, height: 8, overflow: "hidden" }}>
                  <div style={{ width: `${j.progress || 0}%`, height: 8, background: j.status === "FAILED" ? "#ef4444" : "#22c55e", transition: "width .3s" }} />
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
                  {j.progress || 0}%{j.total ? ` · ${j.done}/${j.total}` : ""}
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>{j.startedAt ? fdate(j.startedAt) : fdate(j.createdAt)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
