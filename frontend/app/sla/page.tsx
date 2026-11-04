"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import API_BASE from "../components/api";

const API = API_BASE;
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const VIEWS = [
  { id: "overview", label: "Overview", state: "ALL" },
  { id: "at-risk", label: "At Risk", state: "AT_RISK" },
  { id: "breached", label: "Breached", state: "BREACHED" },
  { id: "meeting-target", label: "Meeting Target", state: "MEETING_TARGET" },
  { id: "policies", label: "SLA Policies", state: "ALL" },
  { id: "performance", label: "Performance History", state: "ALL" },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];
type RecordType = "TICKET" | "FIELD_JOB";
type Filters = { from: string; to: string; priority: string; type: string };
type SlaMeasure = {
  eligible: number;
  met: number;
  breached: number;
  atRisk: number;
  notYetDue?: number;
  compliancePercent: number | null;
  averageMinutes: number | null;
  medianMinutes: number | null;
};
type TicketSummary = {
  unconfigured: number;
  unavailable: number;
  atRisk: number;
  breached: number;
  responseUnavailable: number;
  resolutionUnavailable: number;
  response: SlaMeasure;
  resolution: SlaMeasure;
  reopened: number;
  byPriority: Array<{ priority: string; total: number; responseEligible: number; responseMet: number; resolutionEligible: number; resolutionMet: number }>;
};
type FieldSummary = {
  serviceQuality: {
    firstResponse: { available: false; reason: string };
    resolution: SlaMeasure & { lateResolved: number };
    unconfigured: number;
    unavailable: number;
    byPriority: Array<{ priority: string; eligible: number; met: number; compliancePercent: number | null }>;
    byType: Array<{ type: string; eligible: number; met: number; compliancePercent: number | null }>;
    byTechnician: Array<{ technicianId: number | null; name: string | null; eligible: number; met: number; compliancePercent: number | null }>;
    byDate: Array<{ date: string; eligible: number; met: number; compliancePercent: number | null }>;
    reopened: number | null;
    reopenedUnavailableReason: string;
    measurement: string;
  };
};
type SlaRecord = {
  id: number;
  ticketNo?: string;
  jobNo?: string;
  subject?: string | null;
  subscriber?: { id: number; fullName: string; username: string } | null;
  technician?: { id: number; name: string } | null;
  assignedUserName?: string | null;
  type?: string;
  status: string;
  priority: string;
  createdAt: string;
  responseDueAt?: string | null;
  resolutionDueAt?: string | null;
  firstResponseAt?: string | null;
  firstResolvedAt?: string | null;
  slaResolutionDueAt?: string | null;
  slaResolvedAt?: string | null;
  responseStatus?: string;
  resolutionStatus?: string;
  slaStatus: string;
  responseMinutes?: number | null;
  resolutionMinutes?: number | null;
  slaResolutionTargetMinutes?: number | null;
};
type Page<T> = { items: T[]; total: number; page: number; pageSize: number; hasMore: boolean };
type Policy = {
  id: number;
  seriesId: string;
  version: number;
  name: string;
  recordType: RecordType;
  priority: string;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  firstResponseTargetMinutes: number | null;
  resolutionTargetMinutes: number;
  firstResponseWarningMinutes: number | null;
  resolutionWarningMinutes: number | null;
  clockMode: string;
  notes: string | null;
};

function dayString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function initialFilters(): Filters {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  return { from: dayString(from), to: dayString(to), priority: "", type: "" };
}

function queryString(values: Record<string, string>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  return params.toString();
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body
      ? Array.isArray(body.message) ? body.message.join(", ") : String(body.message)
      : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return body as T;
}

function formatDuration(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  if (value < 60) return `${Math.round(value)} min`;
  const hours = value / 60;
  if (hours < 48) return `${hours.toFixed(1)} hr`;
  return `${(hours / 24).toFixed(1)} days`;
}

function formatDeadline(value?: string | null) {
  if (!value) return "Not configured";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}

function statusLabel(status?: string | null) {
  if (!status || status === "NOT_CONFIGURED") return "SLA not configured";
  if (status === "UNAVAILABLE") return "SLA data unavailable";
  if (status === "AT_RISK") return "Approaching deadline";
  if (status === "BREACHED") return "Deadline missed";
  if (status === "MEETING_TARGET" || status === "MET") return "Met target";
  if (status === "ON_TRACK") return "Within target";
  return status.replaceAll("_", " ").toLowerCase();
}

function statusColor(status: string) {
  if (status === "BREACHED") return "#dc2626";
  if (status === "AT_RISK") return "#d97706";
  if (status === "MEETING_TARGET" || status === "MET") return "#15803d";
  return "var(--muted)";
}

export default function SlaWorkspacePage() {
  const [view, setView] = useState<ViewId>("overview");
  const [recordType, setRecordType] = useState<RecordType>("TICKET");
  const [draftFilters, setDraftFilters] = useState<Filters>(initialFilters);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [ticketSummary, setTicketSummary] = useState<TicketSummary | null>(null);
  const [fieldSummary, setFieldSummary] = useState<FieldSummary | null>(null);
  const [records, setRecords] = useState<Page<SlaRecord> | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [policyError, setPolicyError] = useState("");
  const [editingSeriesId, setEditingSeriesId] = useState("");
  const requestId = useRef(0);
  const [policyForm, setPolicyForm] = useState({
    name: "",
    recordType: "TICKET" as RecordType,
    priority: "MEDIUM",
    firstResponseTargetMinutes: "",
    resolutionTargetMinutes: "",
    firstResponseWarningMinutes: "",
    resolutionWarningMinutes: "",
    effectiveFrom: dayString(new Date()),
    active: true,
    notes: "",
  });

  const viewState = VIEWS.find((item) => item.id === view)?.state ?? "ALL";
  const token = typeof window !== "undefined" ? localStorage.getItem("token") || "" : "";
  const rangeDays = useMemo(() => {
    const from = new Date(`${filters.from}T00:00:00.000Z`);
    const to = new Date(`${filters.to}T00:00:00.000Z`);
    return Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000) + 1);
  }, [filters.from, filters.to]);

  const loadPolicies = useCallback(async () => {
    if (!token) return;
    try {
      setPolicies(await request<Policy[]>("/tickets/sla/policies", token));
      setPolicyError("");
    } catch (reason) {
      setPolicyError(reason instanceof Error ? reason.message : "Could not load SLA policies.");
    }
  }, [token]);

  const load = useCallback(async () => {
    if (!token) return;
    const currentRequestId = ++requestId.current;
    setLoading(true);
    setError("");
    const shared = {
      from: filters.from,
      to: filters.to,
      priority: filters.priority,
      page: String(page),
      pageSize: "25",
    };
    const ticketQuery = queryString({ ...shared, days: String(rangeDays), state: viewState });
    const fieldQuery = queryString({ ...shared, type: filters.type, slaState: viewState });
    try {
      const ticketPromise = request<TicketSummary>(`/tickets/sla/report?${ticketQuery}`, token);
      const fieldPromise = request<FieldSummary>(`/field-jobs/reports/summary?${queryString({
        from: filters.from,
        to: filters.to,
        priority: filters.priority,
        type: filters.type,
      })}`, token);
      const recordPromise = recordType === "TICKET"
        ? request<Page<SlaRecord>>(`/tickets/sla/records?${ticketQuery}`, token)
        : request<Page<SlaRecord>>(`/field-jobs/reports/sla/jobs?${fieldQuery}`, token);
      const [ticketResult, fieldResult, recordResult] = await Promise.allSettled([ticketPromise, fieldPromise, recordPromise]);
      if (currentRequestId !== requestId.current) return;
      if (ticketResult.status === "fulfilled") setTicketSummary(ticketResult.value);
      else setTicketSummary(null);
      if (fieldResult.status === "fulfilled") {
        setFieldSummary(fieldResult.value);
        setFieldError("");
      } else {
        setFieldError(fieldResult.reason instanceof Error ? fieldResult.reason.message : "Field-job reports are unavailable.");
      }
      if (recordResult.status === "fulfilled") setRecords(recordResult.value);
      else throw recordResult.reason;
      if (ticketResult.status === "rejected" && recordType === "TICKET") throw ticketResult.reason;
    } catch (reason) {
      if (currentRequestId === requestId.current) {
        setError(reason instanceof Error ? reason.message : "Could not load SLA data.");
      }
    } finally {
      if (currentRequestId === requestId.current) setLoading(false);
    }
  }, [filters, page, rangeDays, recordType, token, viewState]);

  useEffect(() => {
    if (!token) {
      window.location.assign("/login");
      return;
    }
    void load();
  }, [load, token]);

  useEffect(() => {
    if (view === "policies") void loadPolicies();
  }, [loadPolicies, view]);

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    if (draftFilters.from > draftFilters.to) {
      setError("Start date must not be after end date.");
      return;
    }
    setPage(1);
    setFilters({ ...draftFilters });
  }

  function startPolicyVersion(policy: Policy) {
    setEditingSeriesId(policy.seriesId);
    setPolicyForm({
      name: policy.name,
      recordType: policy.recordType,
      priority: policy.priority,
      firstResponseTargetMinutes: policy.firstResponseTargetMinutes == null ? "" : String(policy.firstResponseTargetMinutes),
      resolutionTargetMinutes: String(policy.resolutionTargetMinutes),
      firstResponseWarningMinutes: policy.firstResponseWarningMinutes == null ? "" : String(policy.firstResponseWarningMinutes),
      resolutionWarningMinutes: policy.resolutionWarningMinutes == null ? "" : String(policy.resolutionWarningMinutes),
      effectiveFrom: dayString(new Date()),
      active: policy.active,
      notes: policy.notes || "",
    });
  }

  async function savePolicy(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setSavingPolicy(true);
    setPolicyError("");
    const body = {
      ...policyForm,
      firstResponseTargetMinutes: policyForm.firstResponseTargetMinutes || null,
      firstResponseWarningMinutes: policyForm.firstResponseWarningMinutes || null,
      resolutionWarningMinutes: policyForm.resolutionWarningMinutes || null,
      resolutionTargetMinutes: policyForm.resolutionTargetMinutes,
    };
    try {
      const path = editingSeriesId
        ? `/tickets/sla/policies/${encodeURIComponent(editingSeriesId)}/versions`
        : "/tickets/sla/policies";
      await request(path, token, { method: "POST", body: JSON.stringify(body) });
      setEditingSeriesId("");
      setPolicyForm({
        name: "",
        recordType: "TICKET",
        priority: "MEDIUM",
        firstResponseTargetMinutes: "",
        resolutionTargetMinutes: "",
        firstResponseWarningMinutes: "",
        resolutionWarningMinutes: "",
        effectiveFrom: dayString(new Date()),
        active: true,
        notes: "",
      });
      await loadPolicies();
    } catch (reason) {
      setPolicyError(reason instanceof Error ? reason.message : "Could not save policy.");
    } finally {
      setSavingPolicy(false);
    }
  }

  const activeSection = VIEWS.find((item) => item.id === view)?.label ?? "Overview";
  const ticketResolution = ticketSummary?.resolution;
  const jobResolution = fieldSummary?.serviceQuality.resolution;
  const selectedResolution = recordType === "TICKET" ? ticketResolution : jobResolution;
  const selectedAtRisk = recordType === "TICKET"
    ? ticketSummary?.atRisk ?? 0
    : jobResolution?.atRisk ?? 0;
  const selectedBreached = recordType === "TICKET"
    ? ticketSummary?.breached ?? 0
    : jobResolution?.breached ?? 0;
  const selectedUnconfigured = recordType === "TICKET"
    ? ticketSummary?.unconfigured ?? 0
    : fieldSummary?.serviceQuality.unconfigured ?? 0;
  const selectedUnavailable = recordType === "TICKET"
    ? ticketSummary?.unavailable ?? 0
    : fieldSummary?.serviceQuality.unavailable ?? 0;

  return (
    <main className="sla-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">SUPPORT &amp; FIELD OPERATIONS</div>
          <h1>SLA &amp; Service Quality</h1>
          <p>Review recorded deadlines and outcomes. Targets apply only when your company has an active policy.</p>
        </div>
      </header>

      <nav className="tabs" aria-label="SLA workspace sections">
        {VIEWS.map((item) => (
          <button key={item.id} type="button" className={view === item.id ? "tab active" : "tab"} onClick={() => { setView(item.id); setPage(1); }}>
            {item.label}
          </button>
        ))}
      </nav>

      <form className="filters" onSubmit={applyFilters}>
        <label>From<input type="date" value={draftFilters.from} onChange={(event) => setDraftFilters({ ...draftFilters, from: event.target.value })} /></label>
        <label>To<input type="date" value={draftFilters.to} onChange={(event) => setDraftFilters({ ...draftFilters, to: event.target.value })} /></label>
        <label>Record type<select value={recordType} onChange={(event) => { setRecordType(event.target.value as RecordType); setPage(1); }}>
          <option value="TICKET">Support tickets</option>
          <option value="FIELD_JOB">Field jobs</option>
        </select></label>
        <label>Priority<select value={draftFilters.priority} onChange={(event) => setDraftFilters({ ...draftFilters, priority: event.target.value })}>
          <option value="">All priorities</option>
          {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
        </select></label>
        {recordType === "FIELD_JOB" && <label>Job type<select value={draftFilters.type} onChange={(event) => setDraftFilters({ ...draftFilters, type: event.target.value })}>
          <option value="">All job types</option>
          {["INSTALLATION", "FAULT_REPAIR", "MAINTENANCE", "DISCONNECTION", "SURVEY", "UPGRADE", "RELOCATION"].map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}
        </select></label>}
        <button className="primary" type="submit">Apply filters</button>
      </form>

      {error && <div className="notice error">{error}</div>}
      {fieldError && <div className="notice">Field-job data is unavailable for this account: {fieldError}</div>}
      {loading && <div className="notice">Loading current SLA data…</div>}

      {view === "policies" ? (
        <section className="policy-layout">
          <form className="panel policy-form" onSubmit={savePolicy}>
            <h2>{editingSeriesId ? "Create policy version" : "Create SLA policy"}</h2>
            <p className="muted">No targets are prefilled. Use only targets approved for your company.</p>
            <label>Policy name<input required maxLength={120} value={policyForm.name} onChange={(event) => setPolicyForm({ ...policyForm, name: event.target.value })} /></label>
            <label>Applies to<select value={policyForm.recordType} onChange={(event) => setPolicyForm({ ...policyForm, recordType: event.target.value as RecordType, firstResponseTargetMinutes: "", firstResponseWarningMinutes: "" })}>
              <option value="TICKET">Support tickets</option><option value="FIELD_JOB">Field jobs</option>
            </select></label>
            <label>Priority<select value={policyForm.priority} onChange={(event) => setPolicyForm({ ...policyForm, priority: event.target.value })}>
              {PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}
            </select></label>
            {policyForm.recordType === "TICKET" && <>
              <label>First-response target (minutes, optional)<input type="number" min="1" max="525600" value={policyForm.firstResponseTargetMinutes} onChange={(event) => setPolicyForm({ ...policyForm, firstResponseTargetMinutes: event.target.value })} /></label>
              <label>First-response warning (minutes before deadline)<input type="number" min="1" max="525600" value={policyForm.firstResponseWarningMinutes} onChange={(event) => setPolicyForm({ ...policyForm, firstResponseWarningMinutes: event.target.value })} /></label>
            </>}
            <label>Resolution target (minutes)<input required type="number" min="1" max="525600" value={policyForm.resolutionTargetMinutes} onChange={(event) => setPolicyForm({ ...policyForm, resolutionTargetMinutes: event.target.value })} /></label>
            <label>Resolution warning (minutes before deadline)<input type="number" min="1" max="525600" value={policyForm.resolutionWarningMinutes} onChange={(event) => setPolicyForm({ ...policyForm, resolutionWarningMinutes: event.target.value })} /></label>
            <label>Effective from (UTC)<input required type="date" value={policyForm.effectiveFrom} onChange={(event) => setPolicyForm({ ...policyForm, effectiveFrom: event.target.value })} /></label>
            <label className="checkbox"><input type="checkbox" checked={policyForm.active} onChange={(event) => setPolicyForm({ ...policyForm, active: event.target.checked })} /> Active from the effective date</label>
            <label>Notes<input maxLength={500} value={policyForm.notes} onChange={(event) => setPolicyForm({ ...policyForm, notes: event.target.value })} /></label>
            <button type="submit" className="primary" disabled={savingPolicy}>{savingPolicy ? "Saving…" : editingSeriesId ? "Save version" : "Create policy"}</button>
            {editingSeriesId && <button type="button" className="secondary" onClick={() => setEditingSeriesId("")}>Cancel version</button>}
            {policyError && <div className="notice error">{policyError}</div>}
          </form>
          <div className="panel policy-list">
            <h2>Policy history</h2>
            {policies.length === 0 && <p className="muted">No policy versions found for this company.</p>}
            {policies.map((policy) => (
              <article className="policy-row" key={policy.id}>
                <div>
                  <strong>{policy.name}</strong><span className="badge">{policy.recordType.replace("_", " ")} · {policy.priority} · v{policy.version}</span>
                  <div className="muted">{!policy.active ? "Inactive version" : new Date(policy.effectiveFrom) > new Date() ? "Scheduled version" : policy.effectiveTo && new Date(policy.effectiveTo) <= new Date() ? "Expired version" : "Active version"} · Effective {formatDeadline(policy.effectiveFrom)}{policy.effectiveTo ? ` · Through ${formatDeadline(policy.effectiveTo)}` : ""}</div>
                  <div className="muted">
                    {policy.firstResponseTargetMinutes == null ? "First response unavailable" : `Response ${policy.firstResponseTargetMinutes} min`}
                    {" · "}Resolution {policy.resolutionTargetMinutes} min · elapsed UTC
                  </div>
                </div>
                <button className="secondary" type="button" onClick={() => startPolicyVersion(policy)}>New version</button>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <>
          {view === "overview" && (
            <section className="metric-grid">
              <Metric title="First-response compliance" value={recordType === "TICKET" ? ticketSummary?.response.compliancePercent == null ? "—" : `${ticketSummary.response.compliancePercent}%` : "Unavailable"} detail={recordType === "TICKET" ? `${ticketSummary?.response.met ?? 0} met of ${ticketSummary?.response.eligible ?? 0} eligible` : "Field jobs have no recorded customer-response event"} />
              <Metric title="Resolution compliance" value={selectedResolution?.compliancePercent == null ? "—" : `${selectedResolution.compliancePercent}%`} detail={`${selectedResolution?.met ?? 0} met of ${selectedResolution?.eligible ?? 0} eligible`} />
              <Metric title="At risk" value={selectedAtRisk} detail="Open records within configured warning threshold" />
              <Metric title="Breached" value={selectedBreached} detail="Eligible deadlines missed or still unresolved after deadline" />
              <Metric title="SLA not configured" value={selectedUnconfigured} detail="Excluded from compliance calculations" />
              <Metric title="SLA data unavailable" value={selectedUnavailable} detail="Configured targets missing a usable deadline or clock mode" />
              <Metric title="Average first response" value={recordType === "TICKET" ? formatDuration(ticketSummary?.response.averageMinutes) : "Unavailable"} detail={recordType === "TICKET" ? "First staff message timestamp" : "No recorded customer-response event"} />
              <Metric title="Average resolution" value={formatDuration(selectedResolution?.averageMinutes)} detail="Recorded resolution timestamp only" />
              <Metric title="Median resolution" value={formatDuration(selectedResolution?.medianMinutes)} detail="Recorded resolution timestamp only" />
            </section>
          )}

          {view === "performance" && (
            <section className="panel performance">
              <h2>Performance history</h2>
              {recordType === "TICKET"
                ? <TicketPerformance summary={ticketSummary} />
                : <FieldPerformance summary={fieldSummary} />}
            </section>
          )}

          {view !== "performance" && (
            <section className="panel records-panel">
              <div className="section-title">
                <div><h2>{activeSection === "Overview" ? "SLA records" : activeSection}</h2><p className="muted">Page results are filtered and counted on the server.</p></div>
                <span className="muted">{records?.total ?? 0} records</span>
              </div>
              {!records?.items.length && !loading && <div className="empty">No records match this period and SLA status.</div>}
              {!!records?.items.length && <>
                <div className="record-table-wrap">
                  <table>
                    <thead><tr><th>Reference</th><th>Status</th><th>Priority</th><th>First response</th><th>Resolution</th><th>Created</th><th>Open</th></tr></thead>
                    <tbody>{records.items.map((record) => {
                      const id = record.ticketNo ?? record.jobNo ?? `#${record.id}`;
                      const responseStatus = recordType === "TICKET" ? record.responseStatus : "UNAVAILABLE";
                      const responseDuration = recordType === "TICKET" ? record.responseMinutes : null;
                      const responseDeadline = recordType === "TICKET" ? record.responseDueAt : null;
                      const resolutionDeadline = recordType === "TICKET" ? record.resolutionDueAt : record.slaResolutionDueAt;
                      const resolutionDuration = recordType === "TICKET" ? record.resolutionMinutes : (
                        record.slaResolvedAt ? (new Date(record.slaResolvedAt).getTime() - new Date(record.createdAt).getTime()) / 60_000 : null
                      );
                      const destination = recordType === "TICKET" ? `/complaints?ticketId=${record.id}` : `/field-jobs?jobId=${record.id}`;
                      return <tr key={`${recordType}-${record.id}`}>
                        <td><strong>{id}</strong><div className="muted">{record.subject || record.subscriber?.fullName || record.type?.replaceAll("_", " ") || "Record details are permission-limited"}</div></td>
                        <td><span className="status" style={{ color: statusColor(record.slaStatus) }}>{statusLabel(record.slaStatus)}</span></td>
                        <td>{record.priority}</td>
                        <td><span className="status" style={{ color: statusColor(responseStatus || "") }}>{recordType === "TICKET" ? statusLabel(responseStatus) : "Unavailable"}</span><div className="muted">{recordType === "TICKET" ? `${formatDuration(responseDuration)} · due ${formatDeadline(responseDeadline)}` : "No recorded customer-response event"}</div></td>
                        <td><span className="status" style={{ color: statusColor(recordType === "TICKET" ? record.resolutionStatus || "" : record.slaStatus) }}>{recordType === "TICKET" ? statusLabel(record.resolutionStatus) : statusLabel(record.slaStatus)}</span><div className="muted">{formatDuration(resolutionDuration)} · due {formatDeadline(resolutionDeadline)}</div></td>
                        <td>{formatDeadline(record.createdAt)}</td>
                        <td><a href={destination} className="record-link">Open {recordType === "TICKET" ? "ticket" : "job"}</a></td>
                      </tr>;
                    })}</tbody>
                  </table>
                </div>
                <div className="pagination">
                  <button className="secondary" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button>
                  <span>Page {records.page} · {records.total} total</span>
                  <button className="secondary" disabled={!records.hasMore || loading} onClick={() => setPage((value) => value + 1)}>Next</button>
                </div>
              </>}
            </section>
          )}

          <p className="notice">
            Clock mode is elapsed time using UTC timestamps. Business hours, pause periods, and internal SLA alerts are not configured. Field-job resolution is dispatcher approval; technician submission and the optional customer-confirmation checkbox are not treated as resolution.
          </p>
        </>
      )}
      <style jsx>{styles}</style>
    </main>
  );
}

function Metric({ title, value, detail }: { title: string; value: string | number; detail: string }) {
  return <article className="metric"><div className="muted">{title}</div><strong>{value}</strong><small>{detail}</small></article>;
}

function TicketPerformance({ summary }: { summary: TicketSummary | null }) {
  if (!summary) return <p className="muted">Ticket performance is unavailable.</p>;
  return <>
    <p className="muted">Compliance denominator: only tickets with a policy target whose first response/resolution timestamp exists or whose deadline has elapsed. Unknown and not-yet-due outcomes are not counted as met.</p>
    <div className="performance-grid">
      <div><h3>First response by priority</h3>{summary.byPriority.map((row) => <div className="performance-row" key={row.priority}><span>{row.priority}</span><span>{row.responseMet} / {row.responseEligible} met</span></div>)}</div>
      <div><h3>Resolution by priority</h3>{summary.byPriority.map((row) => <div className="performance-row" key={row.priority}><span>{row.priority}</span><span>{row.resolutionMet} / {row.resolutionEligible} met</span></div>)}</div>
    </div>
    <p className="muted">Reopened tickets: {summary.reopened}. The SLA outcome is the first recorded response and first transition to RESOLVED; later reopenings do not reset those original clocks.</p>
  </>;
}

function FieldPerformance({ summary }: { summary: FieldSummary | null }) {
  if (!summary) return <p className="muted">Field-job performance is unavailable.</p>;
  const quality = summary.serviceQuality;
  return <>
    <p className="muted">{quality.measurement} {quality.firstResponse.reason}</p>
    <div className="performance-grid">
      <div><h3>By job type</h3>{quality.byType.map((row) => <div className="performance-row" key={row.type}><span>{row.type}</span><span>{row.met} / {row.eligible} met</span></div>)}</div>
      <div><h3>By technician</h3>{quality.byTechnician.map((row) => <div className="performance-row" key={row.technicianId ?? "unassigned"}><span>{row.name || "Technician unavailable"}</span><span>{row.met} / {row.eligible} met</span></div>)}</div>
      <div><h3>By date</h3>{quality.byDate.map((row) => <div className="performance-row" key={row.date}><span>{row.date}</span><span>{row.met} / {row.eligible} met</span></div>)}</div>
    </div>
    <p className="muted">Reopened jobs: unavailable. The lifecycle does not reliably record reopen events.</p>
  </>;
}

const styles = `
.sla-page{max-width:1440px;margin:0 auto;padding:24px;color:var(--text);min-height:100%}
.page-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}
.eyebrow{font-size:11px;letter-spacing:.11em;font-weight:700;color:var(--accent,#3C50E0)}
h1{font-size:26px;margin:5px 0 6px}h2{font-size:17px;margin:0 0 8px}h3{font-size:14px}
.page-header p,.muted{color:var(--muted);font-size:13px;margin:0}
.tabs{display:flex;gap:6px;overflow-x:auto;border-bottom:1px solid var(--border);margin-bottom:16px}
.tab,.secondary{background:transparent;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 12px;white-space:nowrap;cursor:pointer}
.tab{border:0;border-bottom:2px solid transparent;border-radius:0}.tab.active{color:var(--accent,#3C50E0);border-bottom-color:var(--accent,#3C50E0);font-weight:700}
.filters{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr)) auto;gap:10px;align-items:end;margin:16px 0}
label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted)}
input,select{background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 10px;min-width:0}
.primary{background:var(--accent,#3C50E0);color:#fff;border:0;border-radius:8px;padding:10px 14px;font-weight:700;cursor:pointer;white-space:nowrap}
.primary:disabled,.secondary:disabled{opacity:.5;cursor:not-allowed}
.metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:16px 0}
.metric,.panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px}
.metric strong{display:block;font-size:25px;margin:8px 0}.metric small{display:block;color:var(--muted);font-size:12px}
.notice{border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:12px 0;color:var(--muted);font-size:13px}
.notice.error{border-color:#fca5a5;color:#b91c1c}
.records-panel{margin:14px 0}.section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.record-table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:880px}th,td{text-align:left;padding:11px;border-bottom:1px solid var(--border);vertical-align:top;font-size:13px}th{color:var(--muted);font-weight:600}
.status{font-weight:700}.record-link{color:var(--accent,#3C50E0);font-weight:600}
.pagination{display:flex;justify-content:flex-end;align-items:center;gap:12px;padding-top:14px;font-size:13px}
.empty{padding:30px;text-align:center;color:var(--muted)}
.policy-layout{display:grid;grid-template-columns:minmax(280px,380px) minmax(0,1fr);gap:14px}
.policy-form{display:grid;gap:12px;align-content:start}.policy-form .checkbox{display:flex;flex-direction:row;align-items:center}.checkbox input{min-width:auto}
.policy-list{min-width:0}.policy-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--border)}
.policy-row>div{display:grid;gap:5px}.badge{display:inline-block;margin-left:8px;border:1px solid var(--border);border-radius:20px;padding:3px 8px;font-size:11px;color:var(--muted)}
.performance-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.performance-row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--border);font-size:13px}
@media(max-width:900px){.filters{grid-template-columns:repeat(3,minmax(0,1fr))}.policy-layout{grid-template-columns:1fr}}
@media(max-width:600px){.sla-page{padding:14px}.page-header{display:block}h1{font-size:22px}.filters{grid-template-columns:repeat(2,minmax(0,1fr))}.filters .primary{grid-column:span 2}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.metric{padding:12px}.metric strong{font-size:20px}.performance-grid{grid-template-columns:1fr}.policy-row{align-items:flex-start;flex-direction:column}.section-title{align-items:flex-start;gap:8px;flex-direction:column}}
`;
