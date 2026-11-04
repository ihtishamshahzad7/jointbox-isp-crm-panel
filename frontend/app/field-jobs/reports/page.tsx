"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import API_BASE from "../../components/api";

const API = API_BASE;
const STATUSES = ["PENDING", "ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "COMPLETED", "FAILED", "CANCELLED"];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const TYPES = ["INSTALLATION", "FAULT_REPAIR", "MAINTENANCE", "DISCONNECTION", "SURVEY", "UPGRADE", "RELOCATION"];

type Filters = {
  from: string;
  to: string;
  technicianId: string;
  status: string;
  priority: string;
  type: string;
  subscriberId: string;
};
type Summary = {
  period: { from: string; to: string };
  canFilterSubscribers: boolean;
  technicianOptions: Array<{ id: number; name: string }>;
  overview: {
    total: number;
    open: number;
    assigned: number;
    inProgress: number;
    completed: number;
    overdue: number;
    unassigned: number;
    cancelled: number;
    awaitingReview: number;
    completionRate: number | null;
    averageCompletionMinutes: number | null;
  };
  metrics: { completionRateDenominator: number; approaching: number };
  byStatus: Array<{ key: string; count: number }>;
  technicians: Array<{
    technicianId: number;
    name: string;
    assigned: number;
    completed: number;
    open: number;
    overdue: number;
    completionRate: number | null;
    averageCompletionMinutes: number | null;
  }>;
  delayGroups: Array<{ key: string; count: number }>;
  averageDelayMinutes: number | null;
  overdueByPriority: Array<{ key: string; count: number }>;
  overdueByType: Array<{ key: string; count: number }>;
  repeatedlyRescheduled: number;
  schedules: {
    generated: number;
    completed: number;
    upcoming: number | null;
    upcomingAvailable: boolean;
    skipped: number | null;
    failed: number | null;
    statesAvailable: boolean;
    states: { active: number | null; paused: number | null; cancelled: number | null };
  };
};
type ReportJob = {
  id: number;
  jobNo: string;
  type: string;
  status: string;
  priority: string;
  scheduledAt: string | null;
  appointmentEndsAt: string | null;
  completedAt: string | null;
  technician?: { id: number; name: string } | null;
  subscriber?: { id: number; fullName: string; username: string } | null;
};
type JobPage = { items: ReportJob[]; total: number; page: number; pageSize: number };

function dayString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function initialFilters(): Filters {
  const today = new Date();
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - 29);
  return {
    from: dayString(from),
    to: dayString(today),
    technicianId: "",
    status: "",
    priority: "",
    type: "",
    subscriberId: "",
  };
}

function makeQuery(filters: Filters, extras: Record<string, string> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(extras)) {
    if (value) params.set(key, value);
  }
  return params.toString();
}

class ReportRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body
      ? Array.isArray(body.message)
        ? body.message.join(", ")
        : String(body.message)
      : `Request failed (${response.status}).`;
    throw new ReportRequestError(message, response.status);
  }
  return body as T;
}

function formatDuration(minutes: number | null) {
  if (minutes == null) return "Unavailable";
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes} min`;
}

function dateLabel(value: string | null) {
  if (!value) return "No deadline recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Invalid date" : date.toLocaleString();
}

const panelStyle = {
  border: "1px solid var(--border, #d9dde6)",
  borderRadius: 12,
  padding: 16,
  background: "var(--surface, #fff)",
};
const buttonStyle = {
  border: "1px solid var(--border, #d9dde6)",
  borderRadius: 9,
  padding: "9px 12px",
  background: "var(--surface, #fff)",
  color: "var(--text, inherit)",
  cursor: "pointer",
};

export default function FieldJobReportsPage() {
  const [initial] = useState<Filters>(initialFilters);
  const [token, setToken] = useState("");
  const [draftFilters, setDraftFilters] = useState<Filters>(initial);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(initial);
  const [summaryRevision, setSummaryRevision] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState("");
  const [summaryDenied, setSummaryDenied] = useState(false);
  const [activeSection, setActiveSection] = useState("overview");
  const [detail, setDetail] = useState<JobPage | null>(null);
  const [detailBucket, setDetailBucket] = useState("");
  const [detailPage, setDetailPage] = useState(1);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailDenied, setDetailDenied] = useState(false);
  const summaryRequestId = useRef(0);
  const detailRequestId = useRef(0);

  useEffect(() => {
    const stored = localStorage.getItem("token");
    if (!stored) {
      setSummaryError("A valid session is required to view field operations reports.");
      setSummaryLoading(false);
      return;
    }
    setToken(stored);
  }, []);

  const loadSummary = useCallback(async (nextFilters: Filters) => {
    if (!token) return;
    const requestId = ++summaryRequestId.current;
    setSummaryLoading(true);
    setSummaryError("");
    setSummaryDenied(false);
    try {
      const result = await request<Summary>(`/field-jobs/reports/summary?${makeQuery(nextFilters)}`, token);
      if (requestId === summaryRequestId.current) setSummary(result);
    } catch (reason) {
      if (requestId === summaryRequestId.current) {
        setSummaryError(reason instanceof Error ? reason.message : "Unable to load field operations reports.");
        setSummaryDenied(reason instanceof ReportRequestError && reason.status === 403);
      }
    } finally {
      if (requestId === summaryRequestId.current) setSummaryLoading(false);
    }
  }, [token]);

  const loadDetail = useCallback(async (bucket: string, page: number, currentFilters: Filters) => {
    if (!token) return;
    const requestId = ++detailRequestId.current;
    setDetailLoading(true);
    setDetail(null);
    setDetailPage(page);
    setDetailError("");
    setDetailDenied(false);
    try {
      const query = makeQuery(currentFilters, { bucket, page: String(page), pageSize: "25" });
      const result = await request<JobPage>(`/field-jobs/reports/jobs?${query}`, token);
      if (requestId === detailRequestId.current) {
        setDetail(result);
        setDetailPage(page);
      }
    } catch (reason) {
      if (requestId === detailRequestId.current) {
        setDetailError(reason instanceof Error ? reason.message : "Unable to load matching jobs.");
        setDetailDenied(reason instanceof ReportRequestError && reason.status === 403);
      }
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) void loadSummary(appliedFilters);
  }, [token, appliedFilters, summaryRevision, loadSummary]);

  const statusRows = useMemo(() => summary?.byStatus ?? [], [summary]);
  const techRows = useMemo(() => summary?.technicians ?? [], [summary]);
  const delayRows = useMemo(() => summary?.delayGroups ?? [], [summary]);
  const maxStatusCount = Math.max(1, ...statusRows.map((row) => row.count));
  const maxDelayCount = Math.max(1, ...delayRows.map((row) => row.count));

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const snapshot = { ...draftFilters };
    summaryRequestId.current++;
    detailRequestId.current++;
    setAppliedFilters(snapshot);
    setSummaryRevision((revision) => revision + 1);
    setDetail(null);
    setDetailBucket("");
    setDetailLoading(false);
  }

  function openDetail(bucket: string) {
    setDetailBucket(bucket);
    setDetailPage(1);
    void loadDetail(bucket, 1, appliedFilters);
  }

  function resetFilters() {
    summaryRequestId.current++;
    detailRequestId.current++;
    setDraftFilters(initial);
    setAppliedFilters(initial);
    setSummaryRevision((revision) => revision + 1);
    setDetail(null);
    setDetailBucket("");
    setDetailLoading(false);
  }

  const overview = summary?.overview;
  const cards = overview ? [
    { label: "Total jobs", value: overview.total, bucket: "ALL" },
    { label: "Open", value: overview.open, bucket: "OPEN" },
    { label: "Assigned", value: overview.assigned, bucket: "ASSIGNED" },
    { label: "In progress", value: overview.inProgress, bucket: "IN_PROGRESS" },
    { label: "Completed", value: overview.completed, bucket: "COMPLETED" },
    { label: "Overdue", value: overview.overdue, bucket: "OVERDUE" },
    { label: "Unassigned", value: overview.unassigned, bucket: "UNASSIGNED" },
    { label: "Cancelled", value: overview.cancelled, bucket: "CANCELLED" },
    { label: "Awaiting review", value: overview.awaitingReview, bucket: "PENDING_REVIEW" },
  ] : [];

  return (
    <main className="field-report" style={{ maxWidth: 1240, margin: "0 auto", padding: "clamp(12px, 3vw, 28px)", minWidth: 0 }}>
      <style>{`
        .field-report, .field-report * { box-sizing: border-box; }
        .field-report button, .field-report input, .field-report select { font: inherit; max-width: 100%; }
        .field-report button:focus-visible, .field-report input:focus-visible, .field-report select:focus-visible { outline: 2px solid var(--accent, #3C50E0); outline-offset: 2px; }
        .field-report-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 12px; }
        .field-report-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 12px; }
        .field-report-tech-row { display: grid; grid-template-columns: minmax(140px, 1.5fr) repeat(6, minmax(76px, 1fr)); gap: 8px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border, #e7eaf0); }
        .field-report-mobile-label { display: none; }
        @media (max-width: 700px) {
          .field-report { padding: 12px !important; }
          .field-report-tech-header { display: none; }
          .field-report-tech-row { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px 12px; }
          .field-report-tech-row > :first-child { grid-column: 1 / -1; font-weight: 700; }
          .field-report-mobile-label { display: inline; color: var(--muted); font-size: 12px; margin-right: 4px; }
          .field-report-card-value { font-size: 24px !important; }
        }
      `}</style>

      <header style={{ display: "flex", alignItems: "end", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
        <div>
          <div style={{ color: "var(--muted)", fontSize: 12, letterSpacing: ".08em", textTransform: "uppercase", fontWeight: 700 }}>Field operations</div>
          <h1 style={{ margin: "5px 0 0", fontSize: "clamp(25px, 4vw, 34px)" }}>Reporting &amp; performance</h1>
        </div>
        <div style={{ color: "var(--muted)", fontSize: 13 }}>
          {summary?.period ? `${summary.period.from.slice(0, 10)} – ${summary.period.to.slice(0, 10)}` : "Date range applies to job creation date"}
        </div>
      </header>

      <form onSubmit={applyFilters} style={{ ...panelStyle, marginBottom: 18 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Shared filters</h2>
        <div className="field-report-filters">
          <label>From<input type="date" required value={draftFilters.from} max={draftFilters.to || undefined} onChange={(event) => setDraftFilters((current) => ({ ...current, from: event.target.value }))} style={{ display: "block", width: "100%", marginTop: 5 }} /></label>
          <label>To<input type="date" required value={draftFilters.to} min={draftFilters.from || undefined} onChange={(event) => setDraftFilters((current) => ({ ...current, to: event.target.value }))} style={{ display: "block", width: "100%", marginTop: 5 }} /></label>
          <label>Technician<select value={draftFilters.technicianId} onChange={(event) => setDraftFilters((current) => ({ ...current, technicianId: event.target.value }))} style={{ display: "block", width: "100%", marginTop: 5 }}>
            <option value="">All technicians</option>
            {(summary?.technicianOptions ?? []).map((technician) => <option key={technician.id} value={technician.id}>{technician.name}</option>)}
          </select></label>
          <label>Status<select value={draftFilters.status} onChange={(event) => setDraftFilters((current) => ({ ...current, status: event.target.value }))} style={{ display: "block", width: "100%", marginTop: 5 }}>
            <option value="">All statuses</option>{STATUSES.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}
          </select></label>
          <label>Priority<select value={draftFilters.priority} onChange={(event) => setDraftFilters((current) => ({ ...current, priority: event.target.value }))} style={{ display: "block", width: "100%", marginTop: 5 }}>
            <option value="">All priorities</option>{PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
          </select></label>
          <label>Job type<select value={draftFilters.type} onChange={(event) => setDraftFilters((current) => ({ ...current, type: event.target.value }))} style={{ display: "block", width: "100%", marginTop: 5 }}>
            <option value="">All types</option>{TYPES.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}
          </select></label>
          {summary?.canFilterSubscribers && <label>Subscriber ID<input type="number" min="1" step="1" inputMode="numeric" value={draftFilters.subscriberId} onChange={(event) => setDraftFilters((current) => ({ ...current, subscriberId: event.target.value }))} placeholder="Optional" style={{ display: "block", width: "100%", marginTop: 5 }} /></label>}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button type="submit" style={buttonStyle} disabled={summaryLoading}>Apply filters</button>
          <button type="button" style={buttonStyle} onClick={resetFilters}>Reset</button>
        </div>
      </form>

      {summaryLoading && <p role="status">Loading field operations report…</p>}
      {!summaryLoading && summaryError && <div role="alert" style={{ ...panelStyle, color: "var(--danger, #b42318)" }}><strong>{summaryDenied ? "Permission denied" : "Report unavailable"}</strong><p style={{ marginBottom: 0 }}>{summaryError}</p></div>}
      {!summaryLoading && !summaryError && summary && (
        <>
          <nav aria-label="Reporting sections" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            {[
              ["overview", "Operations Overview"],
              ["technicians", "Technician Performance"],
              ["delays", "SLA & Delays"],
              ["schedules", "Schedule Performance"],
            ].map(([key, label]) => (
              <button key={key} type="button" aria-pressed={activeSection === key} onClick={() => setActiveSection(key)} style={{ ...buttonStyle, background: activeSection === key ? "var(--accent, #3C50E0)" : undefined, color: activeSection === key ? "#fff" : undefined }}>{label}</button>
            ))}
          </nav>

          {activeSection === "overview" && (
            <section aria-labelledby="operations-overview">
              <h2 id="operations-overview">Operations Overview</h2>
              <div className="field-report-grid" style={{ marginBottom: 16 }}>
                {cards.map((card) => <button key={card.label} type="button" onClick={() => openDetail(card.bucket)} style={{ ...panelStyle, textAlign: "left", cursor: "pointer", color: "inherit" }}>
                  <span style={{ display: "block", color: "var(--muted)", fontSize: 13 }}>{card.label}</span>
                  <strong className="field-report-card-value" style={{ display: "block", fontSize: 29, marginTop: 6 }}>{card.value}</strong>
                </button>)}
                <button type="button" onClick={() => openDetail("COMPLETION_RATE")} style={{ ...panelStyle, textAlign: "left", cursor: "pointer", color: "inherit" }}><span style={{ color: "var(--muted)", fontSize: 13 }}>Completion rate</span><strong className="field-report-card-value" style={{ display: "block", fontSize: 29, marginTop: 6 }}>{overview.completionRate == null ? "Unavailable" : `${overview.completionRate}%`}</strong><small>Completed ÷ non-cancelled jobs ({summary.metrics.completionRateDenominator})</small></button>
                <button type="button" onClick={() => openDetail("COMPLETED_TIMED")} style={{ ...panelStyle, textAlign: "left", cursor: "pointer", color: "inherit" }}><span style={{ color: "var(--muted)", fontSize: 13 }}>Average completion duration</span><strong className="field-report-card-value" style={{ display: "block", fontSize: 24, marginTop: 6 }}>{formatDuration(overview.averageCompletionMinutes)}</strong><small>Valid started/completed timestamps only</small></button>
              </div>
              <div style={panelStyle}>
                <h3 style={{ marginTop: 0 }}>Status breakdown</h3>
                {statusRows.length === 0 && <p>No jobs were recorded in this period.</p>}
                <div style={{ display: "grid", gap: 8 }}>
                  {statusRows.map((row) => <button key={row.key} type="button" onClick={() => openDetail(row.key)} style={{ ...buttonStyle, display: "grid", gridTemplateColumns: "minmax(90px, 1fr) minmax(80px, 3fr) auto", alignItems: "center", gap: 10, textAlign: "left" }}>
                    <span>{row.key.replaceAll("_", " ")}</span>
                    <span aria-hidden="true" style={{ height: 9, background: "var(--border, #e7eaf0)", borderRadius: 9, overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${(row.count / maxStatusCount) * 100}%`, background: "var(--accent, #3C50E0)" }} /></span>
                    <strong>{row.count}</strong>
                  </button>)}
                </div>
              </div>
            </section>
          )}

          {activeSection === "technicians" && (
            <section aria-labelledby="technician-performance">
              <h2 id="technician-performance">Technician Performance</h2>
              <p style={{ color: "var(--muted)" }}>Workload is shown alongside rates. Completion rate = completed ÷ assigned jobs excluding cancelled jobs. Attendance is not inferred from job status. Period: {summary.period.from.slice(0, 10)} to {summary.period.to.slice(0, 10)}.</p>
              <div style={panelStyle}>
                <div className="field-report-tech-row field-report-tech-header" style={{ borderTop: 0, fontWeight: 700 }}>
                  <span>Technician</span><span>Assigned</span><span>Completed</span><span>Open</span><span>Overdue</span><span>Completion</span><span>Avg. duration</span>
                </div>
                {techRows.length === 0 && <p>No technician workload was recorded in the selected period.</p>}
                {techRows.map((tech) => <div className="field-report-tech-row" key={tech.technicianId}>
                  <button type="button" onClick={() => openDetail(`TECHNICIAN_${tech.technicianId}`)} style={{ ...buttonStyle, textAlign: "left" }}>{tech.name}</button>
                  <span><small className="field-report-mobile-label">Assigned</small>{tech.assigned}</span>
                  <span><small className="field-report-mobile-label">Completed</small>{tech.completed}</span>
                  <span><small className="field-report-mobile-label">Open</small>{tech.open}</span>
                  <span><small className="field-report-mobile-label">Overdue</small>{tech.overdue}</span>
                  <span><small className="field-report-mobile-label">Completion</small>{tech.completionRate == null ? "Unavailable" : `${tech.completionRate}%`}</span>
                  <span><small className="field-report-mobile-label">Avg. duration</small>{formatDuration(tech.averageCompletionMinutes)}</span>
                </div>)}
              </div>
            </section>
          )}

          {activeSection === "delays" && (
            <section aria-labelledby="sla-delays">
              <h2 id="sla-delays">SLA &amp; Delays</h2>
              <p style={{ color: "var(--muted)" }}>Deadline-based indicators only; no contractual SLA target is assumed. Deadline is appointment end, falling back to scheduled time.</p>
              <div className="field-report-grid" style={{ marginBottom: 16 }}>
                <button type="button" onClick={() => openDetail("OVERDUE")} style={{ ...panelStyle, textAlign: "left", cursor: "pointer", color: "inherit" }}>Overdue now<strong className="field-report-card-value" style={{ display: "block", fontSize: 29, marginTop: 6 }}>{overview.overdue}</strong></button>
                <button type="button" onClick={() => openDetail("APPROACHING")} style={{ ...panelStyle, textAlign: "left", cursor: "pointer", color: "inherit" }}>Deadline within 24 hours<strong className="field-report-card-value" style={{ display: "block", fontSize: 29, marginTop: 6 }}>{summary.metrics.approaching}</strong></button>
                <button type="button" onClick={() => openDetail("DELAY_ALL")} style={{ ...panelStyle, textAlign: "left", cursor: "pointer", color: "inherit" }}>Average delay<strong className="field-report-card-value" style={{ display: "block", fontSize: 24, marginTop: 6 }}>{formatDuration(summary.averageDelayMinutes)}</strong><small>Delayed open/completed jobs with a recorded deadline</small></button>
                <button type="button" onClick={() => openDetail("RESCHEDULED")} style={{ ...panelStyle, textAlign: "left", cursor: "pointer", color: "inherit" }}>Repeatedly rescheduled<strong className="field-report-card-value" style={{ display: "block", fontSize: 29, marginTop: 6 }}>{summary.repeatedlyRescheduled}</strong><small>More than one recorded SCHEDULED activity</small></button>
              </div>
              <div style={panelStyle}>
                <h3 style={{ marginTop: 0 }}>Delay duration</h3>
                <p style={{ color: "var(--muted)" }}>Open jobs use current time; completed jobs use recorded completion time. Only jobs with a recorded deadline are included.</p>
                <div style={{ display: "grid", gap: 8 }}>
                  {delayRows.map((row) => {
                    const bucket = row.key === "UP_TO_1_DAY" ? "DELAY_UP_TO_1_DAY" : row.key === "1_TO_7_DAYS" ? "DELAY_1_TO_7_DAYS" : "DELAY_OVER_7_DAYS";
                    const label = row.key === "UP_TO_1_DAY" ? "Up to 1 day late" : row.key === "1_TO_7_DAYS" ? "1–7 days late" : "Over 7 days late";
                    return <button key={row.key} type="button" onClick={() => openDetail(bucket)} style={{ ...buttonStyle, display: "grid", gridTemplateColumns: "minmax(120px, 1fr) minmax(80px, 3fr) auto", alignItems: "center", gap: 10, textAlign: "left" }}>
                      <span>{label}</span><span aria-hidden="true" style={{ height: 9, background: "var(--border, #e7eaf0)", borderRadius: 9, overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${(row.count / maxDelayCount) * 100}%`, background: "var(--accent, #3C50E0)" }} /></span><strong>{row.count}</strong>
                    </button>;
                  })}
                </div>
                <p style={{ color: "var(--muted)", marginBottom: 0 }}>Delay reasons are unavailable: the existing model records failure/cancellation reasons, not a distinct delay reason.</p>
              </div>
              <div className="field-report-grid" style={{ marginTop: 16 }}>
                <div style={panelStyle}><h3 style={{ marginTop: 0 }}>Overdue by priority</h3>{summary.overdueByPriority.length === 0 && <p>None in this period.</p>}
                  {summary.overdueByPriority.map((row) => <button key={row.key} type="button" onClick={() => openDetail(`OVERDUE_PRIORITY_${row.key}`)} style={{ ...buttonStyle, width: "100%", display: "flex", justifyContent: "space-between", marginBottom: 6 }}><span>{row.key}</span><strong>{row.count}</strong></button>)}</div>
                <div style={panelStyle}><h3 style={{ marginTop: 0 }}>Overdue by job type</h3>{summary.overdueByType.length === 0 && <p>None in this period.</p>}
                  {summary.overdueByType.map((row) => <button key={row.key} type="button" onClick={() => openDetail(`OVERDUE_TYPE_${row.key}`)} style={{ ...buttonStyle, width: "100%", display: "flex", justifyContent: "space-between", marginBottom: 6 }}><span>{row.key.replaceAll("_", " ")}</span><strong>{row.count}</strong></button>)}</div>
              </div>
            </section>
          )}

          {activeSection === "schedules" && (
            <section aria-labelledby="schedule-performance">
              <h2 id="schedule-performance">Schedule Performance</h2>
              <p style={{ color: "var(--muted)" }}>Generated and completed counts use recorded FieldJobOccurrence records whose occurrence date falls in the selected range.</p>
              <div className="field-report-grid" style={{ marginBottom: 16 }}>
                <button type="button" onClick={() => openDetail("SCHEDULED_GENERATED")} style={{ ...panelStyle, textAlign: "left", cursor: "pointer", color: "inherit" }}>Generated occurrences<strong className="field-report-card-value" style={{ display: "block", fontSize: 29, marginTop: 6 }}>{summary.schedules.generated}</strong></button>
                <button type="button" onClick={() => openDetail("SCHEDULED_COMPLETED")} style={{ ...panelStyle, textAlign: "left", cursor: "pointer", color: "inherit" }}>Completed scheduled jobs<strong className="field-report-card-value" style={{ display: "block", fontSize: 29, marginTop: 6 }}>{summary.schedules.completed}</strong></button>
                <div style={panelStyle}>Upcoming next runs<strong className="field-report-card-value" style={{ display: "block", fontSize: 29, marginTop: 6 }}>{summary.schedules.upcomingAvailable ? summary.schedules.upcoming : "Unavailable"}</strong><small>{summary.schedules.upcomingAvailable ? "Active schedules whose nextRunAt falls within the selected date range; these are not generated occurrences." : "A status or technician filter cannot be applied to an ungenerated occurrence."}</small></div>
                <div style={panelStyle}>Skipped occurrences<strong className="field-report-card-value" style={{ display: "block", fontSize: 24, marginTop: 6 }}>Unavailable</strong><small>No skipped-occurrence records exist.</small></div>
                <div style={panelStyle}>Failed generation attempts<strong className="field-report-card-value" style={{ display: "block", fontSize: 24, marginTop: 6 }}>Unavailable</strong><small>No failed-generation history is persisted.</small></div>
              </div>
              <div style={panelStyle}>
                <h3 style={{ marginTop: 0 }}>Current schedule states</h3>
                <p style={{ color: "var(--muted)" }}>Counts are the schedules' current states for schedules created within the selected date range. They are not counts of status changes during that period.</p>
                {!summary.schedules.statesAvailable && <p>Unavailable with the selected status or technician filter because schedules have no corresponding job state or assignment.</p>}
                <div className="field-report-grid">
                  {(["active", "paused", "cancelled"] as const).map((state) => <div key={state} style={panelStyle}>{state[0].toUpperCase() + state.slice(1)}: {summary.schedules.states[state] ?? "Unavailable"}</div>)}
                </div>
              </div>
            </section>
          )}
        </>
      )}

      {detailBucket && (
        <section aria-labelledby="report-details" style={{ ...panelStyle, marginTop: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <h2 id="report-details" style={{ margin: 0 }}>Matching jobs: {detailBucket.replaceAll("_", " ")}</h2>
            <button type="button" style={buttonStyle} onClick={() => { detailRequestId.current++; setDetailLoading(false); setDetailBucket(""); setDetail(null); }}>Close list</button>
          </div>
          {detailLoading && <p role="status">Loading page {detailPage}…</p>}
          {detailError && <div role="alert" style={{ color: "var(--danger, #b42318)" }}><strong>{detailDenied ? "Permission denied" : "Details unavailable"}</strong><p style={{ marginBottom: 0 }}>{detailError}</p></div>}
          {!detailLoading && !detailError && detail && <>
            <p>{detail.total} matching jobs · Page {detail.page} of {Math.max(1, Math.ceil(detail.total / detail.pageSize))}</p>
            {detail.items.length === 0 && <p>No matching jobs were found for these filters.</p>}
            <div style={{ display: "grid", gap: 8 }}>
              {detail.items.map((job) => <article key={job.id} style={{ border: "1px solid var(--border, #e7eaf0)", borderRadius: 9, padding: 12, minWidth: 0 }}>
                <strong>{job.jobNo}</strong><span> · {job.type.replaceAll("_", " ")} · {job.status.replaceAll("_", " ")} · {job.priority}</span>
                <div style={{ color: "var(--muted)", marginTop: 5, overflowWrap: "anywhere" }}>
                  {job.technician?.name ?? "Unassigned"}{job.subscriber ? ` · ${job.subscriber.fullName} (${job.subscriber.username})` : ""}
                  {" · Deadline: "}{dateLabel(job.appointmentEndsAt ?? job.scheduledAt)}
                  {job.completedAt ? ` · Completed: ${dateLabel(job.completedAt)}` : ""}
                </div>
              </article>)}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 12 }}>
              <button type="button" style={buttonStyle} disabled={detail.page <= 1 || detailLoading} onClick={() => void loadDetail(detailBucket, detail.page - 1, appliedFilters)}>Previous</button>
              <button type="button" style={buttonStyle} disabled={detail.page * detail.pageSize >= detail.total || detailLoading} onClick={() => void loadDetail(detailBucket, detail.page + 1, appliedFilters)}>Next</button>
            </div>
          </>}
        </section>
      )}
    </main>
  );
}
