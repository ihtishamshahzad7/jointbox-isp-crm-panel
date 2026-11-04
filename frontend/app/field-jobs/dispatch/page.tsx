"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import API_BASE from "../../components/api";

const API = API_BASE;
const STATUSES = ["PENDING", "ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "COMPLETED", "FAILED", "CANCELLED"];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const TYPES = ["INSTALLATION", "FAULT_REPAIR", "MAINTENANCE", "DISCONNECTION", "SURVEY", "UPGRADE", "RELOCATION"];

type Filters = { from: string; to: string; technicianId: string; status: string; priority: string; type: string; subscriberId: string };
type DispatchJob = {
  id: number;
  jobNo: string;
  type: string;
  status: string;
  priority: string;
  description: string;
  address?: string | null;
  assignedTo: number | null;
  scheduledAt: string | null;
  appointmentEndsAt: string | null;
  requiredSkills: string[];
  technician: { id: number; name: string } | null;
  subscriber?: { id: number; fullName: string; username: string } | null;
};
type Technician = {
  id: number;
  employeeId: number;
  name: string;
  designation: string | null;
  employeeStatus: string;
  active: boolean;
  open: number;
  inProgress: number;
  overdue: number;
  upcomingScheduled: number;
  completedInPeriod: number;
  availability: string;
  skills: string[] | null;
};
type Queue = {
  items: DispatchJob[];
  total: number;
  page: number;
  pageSize: number;
  period: { from: string; to: string };
  metrics: { total: number; byStatus: Record<string, number>; unassigned: number; overdue: number; dueSoon: number };
  technicians: Technician[];
  technicianRosterLimited: boolean;
  canFilterSubscribers: boolean;
  unavailableInputs: { availability: string; skills: string };
};
type Recommendation = {
  id: number;
  employeeId: number;
  name: string;
  designation: string | null;
  suitable: boolean;
  open: number;
  overdue: number;
  scheduledCommitments: number;
  sameTypeCompleted: number;
  availability: string;
  skillsMatch: boolean | null;
  reasons: string[];
  conflicts: Array<{ id: number; jobNo: string; scheduledAt: string | null; appointmentEndsAt: string | null }>;
};
type AssignmentActivity = {
  id: number;
  action: string;
  detail: string;
  createdAt: string;
  actor: { id: number; name: string } | null;
};
type Detail = {
  job: DispatchJob & {
    assignedAt: string | null;
    assignedById: number | null;
    arrivedAt: string | null;
  };
  activities: AssignmentActivity[];
  history: { hasMore: boolean; nextCursor: number | null; returned: number };
  assignable: boolean;
  inventoryBlocksReassignment: boolean;
  recommendations: Recommendation[];
  conflictsTruncated: boolean;
  unavailableInputs: { availability: string; skills: string; geographicProximity: string };
};

const panel = { border: "1px solid var(--border, #d9dde6)", borderRadius: 12, padding: 16, background: "var(--surface, #fff)" };
const button = { border: "1px solid var(--border, #d9dde6)", borderRadius: 9, padding: "9px 12px", background: "var(--surface, #fff)", color: "var(--text, inherit)", cursor: "pointer" };

function initialFilters(): Filters {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), technicianId: "", status: "", priority: "", type: "", subscriberId: "" };
}

function queryString(filters: Filters, extras: Record<string, string> = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
  Object.entries(extras).forEach(([key, value]) => { if (value) params.set(key, value); });
  return params.toString();
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body
      ? Array.isArray(body.message) ? body.message.join(", ") : String(body.message)
      : `Request failed (${response.status}).`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return body as T;
}

function displayDate(value: string | null) {
  if (!value) return "Not scheduled";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Invalid date" : parsed.toLocaleString();
}

export default function FieldJobDispatchPage() {
  const [initial] = useState<Filters>(initialFilters);
  const [token, setToken] = useState("");
  const [draftFilters, setDraftFilters] = useState<Filters>(initial);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(initial);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [technicianId, setTechnicianId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [appointmentEndsAt, setAppointmentEndsAt] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const queueRequestId = useRef(0);
  const detailRequestId = useRef(0);
  const historyRequestId = useRef(0);
  const historyLoadingRef = useRef(false);

  useEffect(() => {
    const stored = localStorage.getItem("token");
    if (stored) setToken(stored);
    else {
      setLoading(false);
      setDenied(true);
      setError("A valid session is required to use dispatch.");
    }
  }, []);

  const loadQueue = useCallback(async (filters: Filters, nextPage: number) => {
    if (!token) return;
    const requestId = ++queueRequestId.current;
    setLoading(true);
    setError("");
    setDenied(false);
    try {
      const result = await request<Queue>(`/field-jobs/dispatch?${queryString(filters, { page: String(nextPage), pageSize: "25" })}`, token);
      if (requestId === queueRequestId.current) {
        setQueue(result);
        setPage(nextPage);
      }
    } catch (reasonValue) {
      if (requestId === queueRequestId.current) {
        const requestError = reasonValue as Error & { status?: number };
        setError(requestError.message || "Unable to load dispatch queue.");
        setDenied(requestError.status === 403);
      }
    } finally {
      if (requestId === queueRequestId.current) setLoading(false);
    }
  }, [token]);

  const loadDetail = useCallback(async (jobId: number) => {
    if (!token) return;
    const requestId = ++detailRequestId.current;
    historyRequestId.current++;
    historyLoadingRef.current = false;
    setHistoryLoading(false);
    setHistoryError("");
    setDetailLoading(true);
    setDetailError("");
    try {
      const result = await request<Detail>(`/field-jobs/${jobId}/dispatch`, token);
      if (requestId === detailRequestId.current) {
        setDetail((current) => {
          if (!current || current.job.id !== jobId) return result;
          const activitiesById = new Map<number, AssignmentActivity>();
          for (const activity of [...result.activities, ...current.activities]) {
            if (!activitiesById.has(activity.id)) activitiesById.set(activity.id, activity);
          }
          return {
            ...result,
            activities: [...activitiesById.values()].sort((left, right) => right.id - left.id),
          };
        });
        setTechnicianId(String(result.job.assignedTo ?? result.recommendations.find((candidate) => candidate.suitable)?.id ?? ""));
        setScheduledAt(result.job.scheduledAt ? new Date(new Date(result.job.scheduledAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
        setAppointmentEndsAt(result.job.appointmentEndsAt ? new Date(new Date(result.job.appointmentEndsAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
        setReason("");
      }
    } catch (reasonValue) {
      if (requestId === detailRequestId.current) setDetailError(reasonValue instanceof Error ? reasonValue.message : "Unable to load assignment details.");
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) void loadQueue(appliedFilters, page);
  }, [token, appliedFilters, loadQueue]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    queueRequestId.current++;
    detailRequestId.current++;
    historyRequestId.current++;
    historyLoadingRef.current = false;
    setDetailLoading(false);
    setHistoryLoading(false);
    setSelectedId(null);
    setDetail(null);
    setPage(1);
    setAppliedFilters({ ...draftFilters });
  }

  function selectJob(jobId: number) {
    historyRequestId.current++;
    historyLoadingRef.current = false;
    setHistoryLoading(false);
    setHistoryError("");
    setSelectedId(jobId);
    setDetail(null);
    void loadDetail(jobId);
  }

  async function loadOlderHistory() {
    if (!detail?.history.hasMore || detail.history.nextCursor == null || historyLoadingRef.current) return;
    const requestId = ++historyRequestId.current;
    const jobId = detail.job.id;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const result = await request<Pick<Detail, "activities" | "history">>(
        `/field-jobs/${jobId}/dispatch/history?cursor=${detail.history.nextCursor}`,
        token,
      );
      if (requestId === historyRequestId.current && selectedId === jobId) {
        setDetail((current) => current && current.job.id === jobId
          ? {
              ...current,
              activities: [...new Map(
                [...current.activities, ...result.activities].map((activity) => [activity.id, activity] as const),
              ).values()].sort((left, right) => right.id - left.id),
              history: result.history,
            }
          : current);
      }
    } catch (reasonValue) {
      if (requestId === historyRequestId.current) {
        setHistoryError(reasonValue instanceof Error ? reasonValue.message : "Unable to load older assignment history.");
      }
    } finally {
      if (requestId === historyRequestId.current) {
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      }
    }
  }

  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || !technicianId) return;
    const reassignment = detail.job.assignedTo != null && Number(technicianId) !== detail.job.assignedTo;
    if (reassignment && !reason.trim()) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await request(`/field-jobs/${detail.job.id}/assign/${technicianId}`, token, {
        method: "PATCH",
        body: JSON.stringify({
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
          appointmentEndsAt: appointmentEndsAt ? new Date(appointmentEndsAt).toISOString() : null,
          expectedAssignedTo: detail.job.assignedTo,
          reason: reason.trim() || undefined,
        }),
      });
      setNotice("Assignment confirmed. No recommendation assigns automatically.");
      await Promise.all([loadQueue(appliedFilters, page), loadDetail(detail.job.id)]);
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "Assignment could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const currentRecommendation = detail?.recommendations.find((row) => row.id === Number(technicianId));
  const reassigning = !!detail && detail.job.assignedTo != null && Number(technicianId) !== detail.job.assignedTo;

  return (
    <main className="dispatch-page" style={{ maxWidth: 1440, margin: "0 auto", padding: "clamp(12px, 3vw, 28px)", minWidth: 0, color: "var(--text)" }}>
      <style>{`
        .dispatch-page, .dispatch-page * { box-sizing: border-box; }
        .dispatch-page input, .dispatch-page select, .dispatch-page button { font: inherit; max-width: 100%; }
        .dispatch-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 12px; }
        .dispatch-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); gap: 10px; }
        .dispatch-columns { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(300px, .8fr); gap: 14px; align-items: start; }
        .dispatch-job { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; }
        @media (max-width: 760px) {
          .dispatch-columns { grid-template-columns: minmax(0, 1fr); }
          .dispatch-job { grid-template-columns: minmax(0, 1fr); }
          .dispatch-page { padding: 12px !important; }
        }
      `}</style>

      <header style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "end", gap: 12, marginBottom: 18 }}>
        <div>
          <div style={{ color: "var(--muted)", fontSize: 12, letterSpacing: ".08em", textTransform: "uppercase", fontWeight: 700 }}>Field operations</div>
          <h1 style={{ margin: "5px 0 0", fontSize: "clamp(25px, 4vw, 34px)" }}>Dispatch intelligence</h1>
        </div>
        <a href="/field-jobs" style={{ color: "var(--accent, #3C50E0)" }}>Back to Field Jobs</a>
      </header>

      {notice && <p role="status" style={{ ...panel, borderColor: "var(--success, #16a34a)" }}>{notice}</p>}
      {error && <div role="alert" style={{ ...panel, color: "var(--danger, #b42318)", marginBottom: 12 }}><strong>{denied ? "Dispatch permission required" : "Dispatch unavailable"}</strong><p style={{ marginBottom: 0 }}>{error}</p></div>}

      <form onSubmit={applyFilters} style={{ ...panel, marginBottom: 16 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Dispatch filters</h2>
        <p style={{ margin: "0 0 10px", color: "var(--muted)", fontSize: 13 }}>Date range filters jobs by creation date. Workload shows current assignments; upcoming and completed technician counts use the selected period.</p>
        <div className="dispatch-filters">
          <label>From<input type="date" required value={draftFilters.from} max={draftFilters.to} onChange={(event) => setDraftFilters((value) => ({ ...value, from: event.target.value }))} style={{ display: "block", width: "100%", marginTop: 4 }} /></label>
          <label>To<input type="date" required value={draftFilters.to} min={draftFilters.from} onChange={(event) => setDraftFilters((value) => ({ ...value, to: event.target.value }))} style={{ display: "block", width: "100%", marginTop: 4 }} /></label>
          <label>Technician<select value={draftFilters.technicianId} onChange={(event) => setDraftFilters((value) => ({ ...value, technicianId: event.target.value }))} style={{ display: "block", width: "100%", marginTop: 4 }}>
            <option value="">All technicians</option>{(queue?.technicians ?? []).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select></label>
          <label>Status<select value={draftFilters.status} onChange={(event) => setDraftFilters((value) => ({ ...value, status: event.target.value }))} style={{ display: "block", width: "100%", marginTop: 4 }}>
            <option value="">All statuses</option>{STATUSES.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}
          </select></label>
          <label>Priority<select value={draftFilters.priority} onChange={(event) => setDraftFilters((value) => ({ ...value, priority: event.target.value }))} style={{ display: "block", width: "100%", marginTop: 4 }}>
            <option value="">All priorities</option>{PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
          </select></label>
          <label>Job type<select value={draftFilters.type} onChange={(event) => setDraftFilters((value) => ({ ...value, type: event.target.value }))} style={{ display: "block", width: "100%", marginTop: 4 }}>
            <option value="">All types</option>{TYPES.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}
          </select></label>
          {queue?.canFilterSubscribers && <label>Subscriber ID<input type="number" min="1" step="1" value={draftFilters.subscriberId} onChange={(event) => setDraftFilters((value) => ({ ...value, subscriberId: event.target.value }))} style={{ display: "block", width: "100%", marginTop: 4 }} /></label>}
        </div>
        <button type="submit" disabled={loading} style={{ ...button, marginTop: 12 }}>Apply filters</button>
      </form>

      {loading && <p role="status">Loading dispatch board…</p>}
      {queue && !error && <>
        <section className="dispatch-grid" aria-label="Dispatch overview" style={{ marginBottom: 16 }}>
          {[
            ["Jobs in period", queue.metrics.total],
            ["Unassigned", queue.metrics.unassigned],
            ["Assigned", queue.metrics.byStatus.ASSIGNED ?? 0],
            ["In progress", queue.metrics.byStatus.IN_PROGRESS ?? 0],
            ["Overdue", queue.metrics.overdue],
            ["Due in 24 hours", queue.metrics.dueSoon],
          ].map(([label, count]) => <div key={label} style={panel}><span style={{ color: "var(--muted)", fontSize: 13 }}>{label}</span><strong style={{ display: "block", fontSize: 28, marginTop: 5 }}>{count}</strong></div>)}
        </section>

        <div className="dispatch-columns">
          <section aria-labelledby="dispatch-queue">
            <h2 id="dispatch-queue">Job queue</h2>
            <div style={{ display: "grid", gap: 9 }}>
              {queue.items.map((job) => <article key={job.id} className="dispatch-job" style={{ ...panel, borderColor: selectedId === job.id ? "var(--accent, #3C50E0)" : undefined }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{job.jobNo}</strong><span> · {job.type.replaceAll("_", " ")} · {job.priority} · {job.status.replaceAll("_", " ")}</span>
                  <p style={{ margin: "5px 0", overflowWrap: "anywhere" }}>{job.description}</p>
                  {job.address && <p style={{ margin: "5px 0", overflowWrap: "anywhere" }}>Site address: {job.address}</p>}
                  <small style={{ color: "var(--muted)" }}>
                    {job.technician?.name ?? (job.assignedTo != null ? "Assigned technician details unavailable" : "Unassigned")} · {job.subscriber ? `${job.subscriber.fullName} (${job.subscriber.username}) · ` : ""}
                    Due: {displayDate(job.appointmentEndsAt ?? job.scheduledAt)}
                  </small>
                </div>
                <button type="button" style={button} onClick={() => selectJob(job.id)}>Review assignment</button>
              </article>)}
              {!queue.items.length && <div style={panel}>No jobs match the selected filters.</div>}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 12 }}>
              <span>{queue.total} jobs · Page {page} of {Math.max(1, Math.ceil(queue.total / queue.pageSize))}</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" disabled={page <= 1 || loading} style={button} onClick={() => void loadQueue(appliedFilters, page - 1)}>Previous</button>
                <button type="button" disabled={page * queue.pageSize >= queue.total || loading} style={button} onClick={() => void loadQueue(appliedFilters, page + 1)}>Next</button>
              </div>
            </div>
          </section>

          <section aria-labelledby="technician-workload">
            <h2 id="technician-workload">Technician workload</h2>
            <div style={{ display: "grid", gap: 8 }}>
              {queue.technicians.map((person) => <article key={person.id} style={panel}>
                <strong>{person.name}</strong>{person.designation && <span> · {person.designation}</span>}
                {!person.active && <span style={{ color: "var(--danger, #b42318)" }}> · Not active for new assignments</span>}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 5, marginTop: 8 }}>
                  <span>Open (includes in progress): {person.open}</span><span>In progress: {person.inProgress}</span>
                  <span>Overdue: {person.overdue}</span><span>Upcoming: {person.upcomingScheduled}</span>
                  <span>Completed in period: {person.completedInPeriod}</span><span>Availability schedule: unavailable</span>
                </div>
              </article>)}
              {!queue.technicians.length && <div style={panel}>No employee profiles are available in this company.</div>}
              {queue.technicianRosterLimited && <p role="status">Technician list is capped at 500 profiles; workload summaries are shown for the listed profiles.</p>}
            </div>
            <p style={{ color: "var(--muted)", fontSize: 13 }}>{queue.unavailableInputs.availability} {queue.unavailableInputs.skills}</p>
          </section>
        </div>
      </>}

      {selectedId != null && <section aria-labelledby="assignment-review" style={{ ...panel, marginTop: 18 }}>
        <h2 id="assignment-review">Assignment recommendations and history</h2>
        {detailLoading && <p role="status">Loading assignment context…</p>}
        {detailError && <p role="alert" style={{ color: "var(--danger, #b42318)" }}>{detailError}</p>}
        {detail && <>
          <p><strong>{detail.job.jobNo}</strong> · {detail.job.type.replaceAll("_", " ")} · {detail.job.priority} · {detail.job.status.replaceAll("_", " ")}</p>
          {detail.job.requiredSkills.length > 0 && <p>Required skills: {detail.job.requiredSkills.join(", ")} · Technician skill match unavailable.</p>}
          {detail.inventoryBlocksReassignment && <p role="status">Reserved/issued materials prevent changing the technician until inventory is resolved.</p>}
          {!detail.assignable && <p role="status">This job’s current state does not allow assignment or reassignment.</p>}

          <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
            <h3 style={{ marginBottom: 0 }}>Advisory recommendations</h3>
            {detail.recommendations.map((candidate) => <article key={candidate.id} style={{ ...panel, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <strong>{candidate.name}{candidate.designation ? ` · ${candidate.designation}` : ""}</strong>
                <span style={{ color: candidate.suitable ? "var(--success, #16803c)" : "var(--danger, #b42318)" }}>{candidate.suitable ? "No recorded blocking conflict" : "Review blocking condition"}</span>
              </div>
              <p style={{ margin: "6px 0" }}>Open {candidate.open} · Overdue {candidate.overdue} · Upcoming commitments {candidate.scheduledCommitments} · Completed same-type jobs {candidate.sameTypeCompleted}</p>
              <ul style={{ margin: "4px 0", paddingLeft: 20 }}>{candidate.reasons.map((item, index) => <li key={index}>{item}</li>)}</ul>
              {candidate.conflicts.map((conflict) => <p key={conflict.id} style={{ color: "var(--danger, #b42318)", margin: "4px 0" }}>Overlapping job {conflict.jobNo}: {displayDate(conflict.scheduledAt)} – {displayDate(conflict.appointmentEndsAt)}</p>)}
              <button type="button" style={button} onClick={() => setTechnicianId(String(candidate.id))}>Select {candidate.name}</button>
            </article>)}
            {!detail.recommendations.length && <p>No active company technicians are eligible for recommendation.</p>}
            {detail.conflictsTruncated && <p role="status">Conflict list was capped at 1,000 scheduled jobs.</p>}
            <p style={{ color: "var(--muted)", fontSize: 13 }}>{detail.unavailableInputs.availability} {detail.unavailableInputs.skills} {detail.unavailableInputs.geographicProximity}</p>
          </div>

          <form onSubmit={assign} style={{ display: "grid", gap: 9, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <h3 style={{ margin: 0 }}>Dispatcher-confirmed assignment</h3>
            <label>Technician<select required value={technicianId} onChange={(event) => setTechnicianId(event.target.value)} style={{ width: "100%", marginTop: 4 }}>
              <option value="">Select a technician</option>{detail.recommendations.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.suitable ? "" : " · conflict"}{candidate.id === detail.job.assignedTo ? " · current" : ""}</option>)}
            </select></label>
            <label>Scheduled start<input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} style={{ width: "100%", marginTop: 4 }} /></label>
            <label>Appointment end<input type="datetime-local" value={appointmentEndsAt} onChange={(event) => setAppointmentEndsAt(event.target.value)} style={{ width: "100%", marginTop: 4 }} /></label>
            {reassigning && <label>Reason for reassignment<input required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} style={{ width: "100%", marginTop: 4 }} /></label>}
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>Selection is advisory only. Confirming rechecks the current assignment, job state, employee eligibility, schedule conflicts and inventory restrictions.</p>
            <button type="submit" disabled={saving || !detail.assignable || !technicianId || !currentRecommendation?.suitable || (reassigning && !reason.trim())} style={button}>{saving ? "Saving…" : "Confirm assignment"}</button>
          </form>

          <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 12 }}>
            <h3 style={{ marginTop: 0 }}>Assignment and schedule history</h3>
            <p style={{ color: "var(--muted)", fontSize: 13 }}>
              Showing {detail.activities.length} recorded entries. {detail.history.hasMore ? "Additional older entries are available." : "No additional older entries remain."}
            </p>
            {detail.activities.length === 0 && <p>No assignment or schedule history is recorded.</p>}
            <div style={{ display: "grid", gap: 7 }}>
              {detail.activities.map((activity) => <div key={activity.id} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 7 }}>
                <strong>{activity.action.replaceAll("_", " ")}</strong> · {activity.actor?.name ?? "System"} · {displayDate(activity.createdAt)}
                <div style={{ overflowWrap: "anywhere" }}>{activity.detail}</div>
              </div>)}
            </div>
            {historyError && <p role="alert" style={{ color: "var(--danger, #b42318)" }}>{historyError}</p>}
            {detail.history.hasMore && <button type="button" disabled={historyLoading} style={button} onClick={() => void loadOlderHistory()}>
              {historyLoading ? "Loading older history…" : "Load older history"}
            </button>}
          </div>
        </>}
      </section>}
    </main>
  );
}
