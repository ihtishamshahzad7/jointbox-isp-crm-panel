"use client";

import React from "react";
import useSWR from "swr";
import API from "../../components/api";

const STAGES = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "FOLLOW_UP",
  "INTERESTED",
  "WON",
  "LOST",
] as const;
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
type Stage = (typeof STAGES)[number];
type Priority = (typeof PRIORITIES)[number];
type Lead = {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  serviceArea: string | null;
  source: string | null;
  channel: string | null;
  estimatedMonthlyValue: string | number | null;
  stage: Stage;
  priority: Priority;
  notes: string | null;
  followUpAt: string | null;
  lostReason: string | null;
  assignedEmployeeId: number | null;
  packageId: number | null;
  convertedSubscriberId: number | null;
  convertedAt: string | null;
  conversionType: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  package?: { id: number; name: string; price?: number } | null;
  assignedEmployee?: { id: number; name: string } | null;
  convertedSubscriber?: { id: number; fullName: string; status: string } | null;
  activities?: Activity[];
};
type Activity = {
  id: number;
  type: string;
  detail: string;
  fromStage: Stage | null;
  toStage: Stage | null;
  createdAt: string;
  actor: { id: number; name: string } | null;
};
type LeadPage = { items: Lead[]; total: number; page: number; pageSize: number };
type Options = {
  packages: Array<{ id: number; name: string; price: number }>;
  employees: Array<{ id: number; name: string; department: string | null }>;
};
type Candidate = {
  id: number;
  fullName: string;
  phone: string;
  email: string | null;
  username: string;
  status: string;
  matchingReasons: string[];
};
type Draft = {
  name: string;
  phone: string;
  email: string;
  address: string;
  serviceArea: string;
  source: string;
  channel: string;
  estimatedMonthlyValue: string;
  priority: Priority;
  packageId: string;
  assignedEmployeeId: string;
  followUpAt: string;
  notes: string;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  phone: "",
  email: "",
  address: "",
  serviceArea: "",
  source: "",
  channel: "",
  estimatedMonthlyValue: "",
  priority: "NORMAL",
  packageId: "",
  assignedEmployeeId: "",
  followUpAt: "",
  notes: "",
};

const STAGE_LABELS: Record<Stage, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  FOLLOW_UP: "Follow-up",
  INTERESTED: "Interested",
  WON: "Won",
  LOST: "Lost",
};

function stageLabel(stage: Stage): string {
  return STAGE_LABELS[stage];
}

function localDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const token =
    typeof window === "undefined" ? "" : localStorage.getItem("token") || "";
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
    let message = `Request failed (${response.status})`;
    if (body && typeof body === "object" && "message" in body) {
      const candidate = body.message;
      if (typeof candidate === "string") message = candidate;
      else if (Array.isArray(candidate)) message = candidate.join(", ");
    }
    throw new Error(message);
  }
  return body;
}

async function loadLeadPage(path: string): Promise<LeadPage> {
  const value = await request(path);
  if (
    !value ||
    typeof value !== "object" ||
    !("items" in value) ||
    !Array.isArray(value.items) ||
    !("total" in value) ||
    typeof value.total !== "number"
  ) {
    throw new Error("Invalid lead list response.");
  }
  return value as LeadPage;
}

async function loadOptions(): Promise<Options> {
  const value = await request("/crm/leads/options");
  if (
    !value ||
    typeof value !== "object" ||
    !("packages" in value) ||
    !Array.isArray(value.packages) ||
    !("employees" in value) ||
    !Array.isArray(value.employees)
  ) {
    throw new Error("Invalid lead options response.");
  }
  return value as Options;
}

async function loadLead(path: string): Promise<Lead> {
  const value = await request(path);
  if (!value || typeof value !== "object" || !("id" in value)) {
    throw new Error("Invalid lead details response.");
  }
  return value as Lead;
}

async function loadPipeline(path: string): Promise<{
  stages: Array<{
    stage: Stage;
    count: number;
    estimatedMonthlyValue: number;
  }>;
  total: number;
  dueFollowUps: number;
}> {
  const value = await request(path);
  if (
    !value ||
    typeof value !== "object" ||
    !("stages" in value) ||
    !Array.isArray(value.stages) ||
    !("total" in value) ||
    typeof value.total !== "number" ||
    !("dueFollowUps" in value) ||
    typeof value.dueFollowUps !== "number"
  ) {
    throw new Error("Invalid pipeline summary response.");
  }
  return value as {
    stages: Array<{
      stage: Stage;
      count: number;
      estimatedMonthlyValue: number;
    }>;
    total: number;
    dueFollowUps: number;
  };
}

async function loadCandidates(path: string): Promise<{
  alreadyConverted: boolean;
  subscriberId?: number;
  candidates: Candidate[];
}> {
  const value = await request(path);
  if (
    !value ||
    typeof value !== "object" ||
    !("candidates" in value) ||
    !Array.isArray(value.candidates)
  ) {
    throw new Error("Invalid duplicate review response.");
  }
  return value as {
    alreadyConverted: boolean;
    subscriberId?: number;
    candidates: Candidate[];
  };
}

function formatValue(value: Lead["estimatedMonthlyValue"]): string {
  if (value == null || value === "") return "—";
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(amount)
    : "—";
}

function panelStyle(): React.CSSProperties {
  return {
    background: "var(--surface, #fff)",
    border: "1px solid var(--border, #e5e7eb)",
    borderRadius: 12,
    color: "var(--text, #172033)",
  };
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 40,
  boxSizing: "border-box",
  border: "1px solid var(--border, #d0d5dd)",
  borderRadius: 8,
  padding: "8px 10px",
  background: "var(--surface, #fff)",
  color: "var(--text, #172033)",
};

const buttonStyle: React.CSSProperties = {
  minHeight: 38,
  border: "1px solid var(--border, #d0d5dd)",
  borderRadius: 8,
  padding: "7px 12px",
  background: "var(--surface, #fff)",
  color: "var(--text, #172033)",
  cursor: "pointer",
};

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export default function CrmLeadsPage() {
  const [view, setView] = React.useState<"list" | "pipeline" | "archive">("list");
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const [stageFilter, setStageFilter] = React.useState("");
  const [priorityFilter, setPriorityFilter] = React.useState("");
  const [employeeFilter, setEmployeeFilter] = React.useState("");
  const [sourceFilter, setSourceFilter] = React.useState("");
  const [fromFilter, setFromFilter] = React.useState("");
  const [toFilter, setToFilter] = React.useState("");
  const [sort, setSort] = React.useState("createdAt");
  const [direction, setDirection] = React.useState("desc");
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [editingLead, setEditingLead] = React.useState<Lead | null>(null);
  const [showCreate, setShowCreate] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft>(EMPTY_DRAFT);
  const [activityType, setActivityType] = React.useState("NOTE");
  const [activityText, setActivityText] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [conversionId, setConversionId] = React.useState<number | null>(null);
  const [selectedCandidate, setSelectedCandidate] = React.useState<number | null>(
    null,
  );
  const [conversionMessage, setConversionMessage] = React.useState("");

  const { data: options, error: optionsError } = useSWR<Options, Error>(
    "/crm/leads/options",
    loadOptions,
  );

  const listQuery = React.useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: "100",
      archived: String(view === "archive"),
      sort,
      direction,
    });
    if (search.trim()) params.set("search", search.trim());
    if (stageFilter) params.set("stage", stageFilter);
    if (priorityFilter) params.set("priority", priorityFilter);
    if (employeeFilter) params.set("assignedEmployeeId", employeeFilter);
    if (sourceFilter.trim()) params.set("source", sourceFilter.trim());
    if (fromFilter) params.set("from", fromFilter);
    if (toFilter) params.set("to", toFilter);
    return `/crm/leads?${params.toString()}`;
  }, [
    page,
    view,
    search,
    stageFilter,
    priorityFilter,
    employeeFilter,
    sourceFilter,
    fromFilter,
    toFilter,
    sort,
    direction,
  ]);
  const {
    data: leadPage,
    error: listError,
    mutate: mutateLeads,
  } = useSWR<LeadPage, Error>(listQuery, loadLeadPage);

  const pipelineQuery = React.useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (stageFilter) params.set("stage", stageFilter);
    if (priorityFilter) params.set("priority", priorityFilter);
    if (employeeFilter) params.set("assignedEmployeeId", employeeFilter);
    if (sourceFilter.trim()) params.set("source", sourceFilter.trim());
    if (fromFilter) params.set("from", fromFilter);
    if (toFilter) params.set("to", toFilter);
    return `/crm/leads/pipeline?${params.toString()}`;
  }, [
    search,
    stageFilter,
    priorityFilter,
    employeeFilter,
    sourceFilter,
    fromFilter,
    toFilter,
  ]);
  const { data: pipeline, error: pipelineError, mutate: mutatePipeline } =
    useSWR<{
      stages: Array<{
        stage: Stage;
        count: number;
        estimatedMonthlyValue: number;
      }>;
      total: number;
      dueFollowUps: number;
    }>(view === "pipeline" ? pipelineQuery : null, loadPipeline);

  const detailPath = selectedId ? `/crm/leads/${selectedId}` : null;
  const {
    data: selectedLead,
    error: detailError,
    mutate: mutateDetail,
  } = useSWR<Lead, Error>(detailPath, loadLead);

  const candidatesPath = conversionId
    ? `/crm/leads/${conversionId}/conversion-candidates`
    : null;
  const {
    data: candidateReview,
    error: candidatesError,
    mutate: mutateCandidates,
  } = useSWR(candidatesPath, loadCandidates);

  React.useEffect(() => {
    setPage(1);
  }, [
    view,
    search,
    stageFilter,
    priorityFilter,
    employeeFilter,
    sourceFilter,
    fromFilter,
    toFilter,
  ]);

  function startCreate() {
    setEditingLead(null);
    setDraft(EMPTY_DRAFT);
    setError("");
    setShowCreate(true);
  }

  function startEdit(lead: Lead) {
    setEditingLead(lead);
    setDraft({
      name: lead.name,
      phone: lead.phone,
      email: lead.email || "",
      address: lead.address || "",
      serviceArea: lead.serviceArea || "",
      source: lead.source || "",
      channel: lead.channel || "",
      estimatedMonthlyValue:
        lead.estimatedMonthlyValue == null
          ? ""
          : String(lead.estimatedMonthlyValue),
      priority: lead.priority,
      packageId: lead.packageId == null ? "" : String(lead.packageId),
      assignedEmployeeId:
        lead.assignedEmployeeId == null ? "" : String(lead.assignedEmployeeId),
      followUpAt: localDateTime(lead.followUpAt),
      notes: lead.notes || "",
    });
    setError("");
    setShowCreate(true);
  }

  function closeForm() {
    setShowCreate(false);
    setEditingLead(null);
  }

  async function saveLead(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        ...draft,
        email: draft.email || null,
        estimatedMonthlyValue: draft.estimatedMonthlyValue || null,
        packageId: draft.packageId || null,
        assignedEmployeeId: draft.assignedEmployeeId || null,
        followUpAt: draft.followUpAt
          ? new Date(draft.followUpAt).toISOString()
          : null,
      };
      if (editingLead) {
        const { assignedEmployeeId, ...leadPayload } = payload;
        await request(`/crm/leads/${editingLead.id}`, {
          method: "PATCH",
          body: JSON.stringify(leadPayload),
        });
        if (
          String(editingLead.assignedEmployeeId || "") !==
          String(assignedEmployeeId || "")
        ) {
          await request(`/crm/leads/${editingLead.id}/assignment`, {
            method: "PATCH",
            body: JSON.stringify({ assignedEmployeeId }),
          });
        }
        setNotice("Lead updated.");
      } else {
        const { assignedEmployeeId, ...leadPayload } = payload;
        const created = (await request("/crm/leads", {
          method: "POST",
          body: JSON.stringify({ ...leadPayload, assignedEmployeeId }),
        })) as Lead;
        setSelectedId(created.id);
        setNotice("Lead created.");
      }
      closeForm();
      await Promise.all([mutateLeads(), mutatePipeline(), mutateDetail()]);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  }

  async function changeStage(lead: Lead, stage: Stage) {
    const lostReason =
      stage === "LOST"
        ? window.prompt("Why was this lead lost?")
        : null;
    if (stage === "LOST" && !lostReason?.trim()) return;
    setError("");
    try {
      await request(`/crm/leads/${lead.id}/stage`, {
        method: "PATCH",
        body: JSON.stringify({ stage, lostReason }),
      });
      await Promise.all([mutateLeads(), mutatePipeline(), mutateDetail()]);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  async function archiveLead(lead: Lead, restore = false) {
    setError("");
    try {
      await request(`/crm/leads/${lead.id}/${restore ? "restore" : "archive"}`, {
        method: "POST",
      });
      if (!restore) setSelectedId(null);
      await Promise.all([mutateLeads(), mutatePipeline(), mutateDetail()]);
      setNotice(restore ? "Lead restored." : "Lead archived.");
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  async function addActivity(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedLead || !activityText.trim()) return;
    setSaving(true);
    setError("");
    try {
      await request(`/crm/leads/${selectedLead.id}/activities`, {
        method: "POST",
        body: JSON.stringify({ type: activityType, detail: activityText }),
      });
      setActivityText("");
      await mutateDetail();
      setNotice("Interaction added to the lead timeline.");
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  }

  function openConversion(lead: Lead) {
    setConversionId(lead.id);
    setSelectedCandidate(null);
    setConversionMessage("");
    setError("");
    void mutateCandidates();
  }

  async function convertLead() {
    if (!conversionId) return;
    const matches = candidateReview?.candidates ?? [];
    if (matches.length && selectedCandidate == null) {
      setConversionMessage(
        "A possible duplicate must be reviewed. Select the matching subscriber; creating a second record is blocked while these contact conflicts exist.",
      );
      return;
    }
    if (!matches.length && !window.confirm(
      "Create an inactive subscriber record? This will not activate service, create an invoice, charge a wallet, or send a welcome message.",
    )) {
      return;
    }
    setSaving(true);
    setConversionMessage("");
    setError("");
    try {
      const result = (await request(`/crm/leads/${conversionId}/convert`, {
        method: "POST",
        body: JSON.stringify(
          selectedCandidate == null
            ? {}
            : { existingSubscriberId: selectedCandidate },
        ),
      })) as { subscriber?: { id: number; fullName: string; status: string } };
      const subscriberId = result.subscriber?.id;
      setConversionMessage(
        subscriberId
          ? `Lead converted and linked to subscriber #${subscriberId}.`
          : "Lead conversion completed.",
      );
      setSelectedId(conversionId);
      await Promise.all([
        mutateLeads(),
        mutatePipeline(),
        mutateDetail(),
        mutateCandidates(),
      ]);
    } catch (reason) {
      setError(messageOf(reason));
      void mutateCandidates();
    } finally {
      setSaving(false);
    }
  }

  const totalPages = Math.max(
    1,
    Math.ceil((leadPage?.total ?? 0) / (leadPage?.pageSize ?? 100)),
  );

  return (
    <main style={{ padding: 24, color: "var(--text, #172033)" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 20,
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Leads &amp; Sales Pipeline</h1>
          <p style={{ color: "var(--muted, #667085)", margin: "8px 0 0" }}>
            Track new-connection enquiries through to UPLINKO subscribers.
            Conversion reuses subscriber records and never activates service.
          </p>
        </div>
        <button type="button" style={buttonStyle} onClick={startCreate}>
          + New lead
        </button>
      </header>

      {(error || listError || detailError || optionsError || pipelineError) && (
        <p role="alert" style={{ color: "var(--danger, #b42318)" }}>
          {error ||
            listError?.message ||
            detailError?.message ||
            optionsError?.message ||
            pipelineError?.message}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}

      <section
        style={{
          ...panelStyle(),
          padding: 14,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))",
          gap: 10,
          marginBottom: 16,
        }}
      >
        <label>
          Search
          <input
            style={inputStyle}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name, phone, email, area"
          />
        </label>
        <label>
          Stage
          <select
            style={inputStyle}
            value={stageFilter}
            onChange={(event) => setStageFilter(event.target.value)}
          >
            <option value="">All stages</option>
            {STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {stageLabel(stage)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select
            style={inputStyle}
            value={priorityFilter}
            onChange={(event) => setPriorityFilter(event.target.value)}
          >
            <option value="">All priorities</option>
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </label>
        <label>
          Assigned employee
          <select
            style={inputStyle}
            value={employeeFilter}
            onChange={(event) => setEmployeeFilter(event.target.value)}
          >
            <option value="">All employees</option>
            {(options?.employees ?? []).map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source
          <input
            style={inputStyle}
            value={sourceFilter}
            onChange={(event) => setSourceFilter(event.target.value)}
            placeholder="Walk-in, referral…"
          />
        </label>
        <label>
          Created from
          <input
            style={inputStyle}
            type="date"
            value={fromFilter}
            onChange={(event) => setFromFilter(event.target.value)}
          />
        </label>
        <label>
          Created to
          <input
            style={inputStyle}
            type="date"
            value={toFilter}
            onChange={(event) => setToFilter(event.target.value)}
          />
        </label>
        <label>
          Sort by
          <select
            style={inputStyle}
            value={sort}
            onChange={(event) => setSort(event.target.value)}
          >
            <option value="createdAt">Created date</option>
            <option value="name">Name</option>
            <option value="followUpAt">Follow-up date</option>
            <option value="estimatedMonthlyValue">Estimated value</option>
          </select>
        </label>
        <label>
          Order
          <select
            style={inputStyle}
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>
      </section>

      <nav
        aria-label="Lead views"
        style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}
      >
        {(
          [
            ["list", "Lead list"],
            ["pipeline", "Pipeline"],
            ["archive", "Archived"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            style={{
              ...buttonStyle,
              background:
                view === key ? "var(--primary, #175cd3)" : buttonStyle.background,
              color: view === key ? "#fff" : buttonStyle.color,
            }}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {view === "pipeline" && pipeline && (
        <section style={{ marginBottom: 16 }}>
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              marginBottom: 12,
            }}
          >
            <strong>{pipeline.total} leads in this view</strong>
            <span>{pipeline.dueFollowUps} follow-ups due</span>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, minmax(230px, 1fr))",
              overflowX: "auto",
              gap: 12,
              paddingBottom: 8,
            }}
          >
            {STAGES.map((stage) => {
              const summary = pipeline.stages.find((item) => item.stage === stage);
              const cards = (leadPage?.items ?? []).filter(
                (lead) => lead.stage === stage,
              );
              return (
                <section
                  key={stage}
                  style={{ ...panelStyle(), padding: 12, minWidth: 220 }}
                >
                  <header style={{ marginBottom: 10 }}>
                    <strong>{stageLabel(stage)}</strong>
                    <div style={{ color: "var(--muted, #667085)", fontSize: 13 }}>
                      {summary?.count ?? 0} leads · estimated{" "}
                      {formatValue(summary?.estimatedMonthlyValue ?? 0)}
                    </div>
                  </header>
                  {cards.map((lead) => (
                    <article
                      key={lead.id}
                      style={{
                        border: "1px solid var(--border, #e5e7eb)",
                        borderRadius: 9,
                        padding: 10,
                        marginBottom: 8,
                        cursor: "pointer",
                      }}
                      onClick={() => setSelectedId(lead.id)}
                    >
                      <strong>{lead.name}</strong>
                      <div>{lead.phone}</div>
                      <small style={{ color: "var(--muted, #667085)" }}>
                        {lead.assignedEmployee?.name || "Unassigned"}
                        {lead.followUpAt
                          ? ` · Follow-up ${new Date(lead.followUpAt).toLocaleDateString()}`
                          : ""}
                      </small>
                      <select
                        aria-label={`Move ${lead.name} to another stage`}
                        style={{ ...inputStyle, marginTop: 8 }}
                        value={lead.stage}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          changeStage(lead, event.target.value as Stage)
                        }
                      >
                        {STAGES.map((option) => (
                          <option key={option} value={option}>
                            {stageLabel(option)}
                          </option>
                        ))}
                      </select>
                    </article>
                  ))}
                  {!cards.length && (
                    <p style={{ color: "var(--muted, #667085)" }}>No leads.</p>
                  )}
                  {summary && summary.count > cards.length && (
                    <small style={{ color: "var(--muted, #667085)" }}>
                      More leads are available on the paginated results below.
                    </small>
                  )}
                </section>
              );
            })}
          </div>
        </section>
      )}
      {!leadPage && !listError && (
        <p role="status" style={{ color: "var(--muted, #667085)" }}>
          Loading leads…
        </p>
      )}
      {view === "pipeline" && !pipeline && !pipelineError && (
        <p role="status" style={{ color: "var(--muted, #667085)" }}>
          Loading pipeline summary…
        </p>
      )}

      <section style={{ ...panelStyle(), overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              {["Lead", "Contact", "Stage", "Package", "Assigned", "Follow-up", "Est. monthly", "Actions"].map((heading) => (
                <th key={heading} style={{ padding: 12 }}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(leadPage?.items ?? []).map((lead) => (
              <tr
                key={lead.id}
                style={{ borderBottom: "1px solid var(--border, #e5e7eb)" }}
              >
                <td style={{ padding: 12 }}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(lead.id)}
                    style={{
                      border: 0,
                      padding: 0,
                      background: "transparent",
                      color: "var(--primary, #175cd3)",
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    {lead.name}
                  </button>
                  <div style={{ color: "var(--muted, #667085)", fontSize: 12 }}>
                    {lead.source || "No source"}{lead.serviceArea ? ` · ${lead.serviceArea}` : ""}
                  </div>
                </td>
                <td style={{ padding: 12 }}>
                  {lead.phone}
                  {lead.email && <div>{lead.email}</div>}
                </td>
                <td style={{ padding: 12 }}>{stageLabel(lead.stage)}</td>
                <td style={{ padding: 12 }}>{lead.package?.name || "—"}</td>
                <td style={{ padding: 12 }}>{lead.assignedEmployee?.name || "Unassigned"}</td>
                <td style={{ padding: 12 }}>
                  {lead.followUpAt
                    ? new Date(lead.followUpAt).toLocaleString()
                    : "—"}
                </td>
                <td style={{ padding: 12 }}>{formatValue(lead.estimatedMonthlyValue)}</td>
                <td style={{ padding: 12, whiteSpace: "nowrap" }}>
                  <button type="button" style={buttonStyle} onClick={() => startEdit(lead)}>
                    Edit
                  </button>{" "}
                  {view === "archive" ? (
                    <button type="button" style={buttonStyle} onClick={() => archiveLead(lead, true)}>
                      Restore
                    </button>
                  ) : (
                    <button type="button" style={buttonStyle} onClick={() => archiveLead(lead)}>
                      Archive
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!leadPage?.items.length && (
              <tr>
                <td colSpan={8} style={{ padding: 22, textAlign: "center", color: "var(--muted, #667085)" }}>
                  {listError ? "Unable to load leads." : "No leads match these filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <footer
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: 12,
            gap: 8,
          }}
        >
          <span>
            {leadPage?.total ?? 0} total · page {page} of {totalPages}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              style={buttonStyle}
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              style={buttonStyle}
              disabled={page >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            >
              Next
            </button>
          </div>
        </footer>
      </section>

      {selectedLead && (
        <aside
          role="dialog"
          aria-modal="true"
          aria-label={`Lead details for ${selectedLead.name}`}
          style={{
            position: "fixed",
            zIndex: 50,
            inset: 0,
            overflowY: "auto",
            background: "var(--surface, #fff)",
            padding: 24,
            boxShadow: "0 0 0 100vmax rgba(16, 24, 40, .35)",
          }}
        >
          <div style={{ maxWidth: 1000, margin: "0 auto" }}>
            <header style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div>
                <h2 style={{ margin: 0 }}>{selectedLead.name}</h2>
                <p style={{ color: "var(--muted, #667085)" }}>
                  {stageLabel(selectedLead.stage)} · {selectedLead.phone}
                  {selectedLead.email ? ` · ${selectedLead.email}` : ""}
                </p>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                {!selectedLead.convertedSubscriberId &&
                  (selectedLead.stage === "QUALIFIED" || selectedLead.stage === "WON") && (
                    <button type="button" style={buttonStyle} onClick={() => openConversion(selectedLead)}>
                      Convert to subscriber
                    </button>
                  )}
                {!selectedLead.convertedSubscriberId && (
                  <button type="button" style={buttonStyle} onClick={() => startEdit(selectedLead)}>
                    Edit lead
                  </button>
                )}
                <button type="button" style={buttonStyle} onClick={() => setSelectedId(null)}>
                  Close
                </button>
              </div>
            </header>
            {selectedLead.convertedSubscriber && (
              <p role="status">
                Linked subscriber #{selectedLead.convertedSubscriber.id}:{" "}
                {selectedLead.convertedSubscriber.fullName} (
                {selectedLead.convertedSubscriber.status})
              </p>
            )}
            {selectedLead.conversionType && (
              <p>
                Conversion:{" "}
                {selectedLead.conversionType === "MATCHED_EXISTING"
                  ? "matched existing subscriber"
                  : "created inactive subscriber"}
                {selectedLead.convertedAt
                  ? ` · ${new Date(selectedLead.convertedAt).toLocaleString()}`
                  : ""}
              </p>
            )}
            <section
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
                margin: "16px 0",
              }}
            >
              {[
                ["Address", selectedLead.address],
                ["Service area", selectedLead.serviceArea],
                ["Package", selectedLead.package?.name],
                ["Lead source", selectedLead.source],
                ["Acquisition channel", selectedLead.channel],
                ["Assigned employee", selectedLead.assignedEmployee?.name],
                ["Priority", selectedLead.priority],
                ["Estimated monthly value", formatValue(selectedLead.estimatedMonthlyValue)],
                ["Follow-up", selectedLead.followUpAt ? new Date(selectedLead.followUpAt).toLocaleString() : "—"],
                ["Lost reason", selectedLead.lostReason],
                ["Created", new Date(selectedLead.createdAt).toLocaleString()],
                ["Updated", new Date(selectedLead.updatedAt).toLocaleString()],
              ].map(([label, value]) => (
                <div key={label} style={{ ...panelStyle(), padding: 12 }}>
                  <small style={{ color: "var(--muted, #667085)" }}>{label}</small>
                  <div>{value || "—"}</div>
                </div>
              ))}
            </section>
            {selectedLead.notes && (
              <section style={{ ...panelStyle(), padding: 14, marginBottom: 16 }}>
                <strong>Lead notes</strong>
                <p style={{ whiteSpace: "pre-wrap" }}>{selectedLead.notes}</p>
              </section>
            )}
            {!selectedLead.convertedSubscriberId && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end", marginBottom: 16 }}>
                <label>
                  Move to stage
                  <select
                    style={inputStyle}
                    value={selectedLead.stage}
                    onChange={(event) =>
                      changeStage(selectedLead, event.target.value as Stage)
                    }
                  >
                    {STAGES.map((stage) => (
                      <option key={stage} value={stage}>{stageLabel(stage)}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <section style={{ ...panelStyle(), padding: 14, marginBottom: 16 }}>
              <h3 style={{ marginTop: 0 }}>Record an interaction</h3>
              <form onSubmit={addActivity} style={{ display: "grid", gap: 10 }}>
                <select
                  style={inputStyle}
                  value={activityType}
                  onChange={(event) => setActivityType(event.target.value)}
                  aria-label="Interaction type"
                >
                  <option value="NOTE">Note</option>
                  <option value="CALL">Call</option>
                  <option value="EMAIL">Email</option>
                  <option value="MEETING">Meeting</option>
                  <option value="FOLLOW_UP">Follow-up</option>
                </select>
                <textarea
                  style={{ ...inputStyle, minHeight: 80 }}
                  value={activityText}
                  onChange={(event) => setActivityText(event.target.value)}
                  placeholder="Add interaction details"
                  maxLength={5000}
                  required
                />
                <button type="submit" style={buttonStyle} disabled={saving}>
                  Add to timeline
                </button>
              </form>
            </section>
            <section style={{ ...panelStyle(), padding: 14 }}>
              <h3 style={{ marginTop: 0 }}>Activity &amp; follow-up history</h3>
              {selectedLead.activities?.length ? (
                <ol style={{ paddingLeft: 20 }}>
                  {selectedLead.activities.map((activity) => (
                    <li key={activity.id} style={{ marginBottom: 12 }}>
                      <strong>{activity.type.replaceAll("_", " ")}</strong>
                      <span style={{ color: "var(--muted, #667085)" }}>
                        {" "}· {activity.actor?.name || "System"} ·{" "}
                        {new Date(activity.createdAt).toLocaleString()}
                      </span>
                      <div style={{ whiteSpace: "pre-wrap" }}>{activity.detail}</div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p style={{ color: "var(--muted, #667085)" }}>No interactions recorded yet.</p>
              )}
            </section>
          </div>
        </aside>
      )}

      {showCreate && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={editingLead ? "Edit lead" : "Create lead"}
          style={{
            position: "fixed",
            zIndex: 60,
            inset: 0,
            overflowY: "auto",
            background: "rgba(16, 24, 40, .45)",
            padding: 16,
          }}
        >
          <form
            onSubmit={saveLead}
            style={{
              ...panelStyle(),
              maxWidth: 760,
              margin: "24px auto",
              padding: 20,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
            <header style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>{editingLead ? "Edit lead" : "New lead"}</h2>
              <button type="button" style={buttonStyle} onClick={closeForm}>Close</button>
            </header>
            {(
              [
                ["name", "Lead name", true],
                ["phone", "Phone", true],
                ["email", "Email", false],
                ["address", "Address", false],
                ["serviceArea", "Service area", false],
                ["source", "Lead source", false],
                ["channel", "Acquisition channel", false],
                ["estimatedMonthlyValue", "Estimated monthly value", false],
              ] as const
            ).map(([key, label, required]) => (
              <label key={key}>
                {label}
                <input
                  style={inputStyle}
                  type={key === "email" ? "email" : key === "estimatedMonthlyValue" ? "number" : "text"}
                  min={key === "estimatedMonthlyValue" ? "0" : undefined}
                  step={key === "estimatedMonthlyValue" ? "0.01" : undefined}
                  maxLength={key === "estimatedMonthlyValue" ? undefined : key === "address" ? 500 : 254}
                  required={required}
                  value={draft[key]}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [key]: event.target.value }))
                  }
                />
              </label>
            ))}
            <label>
              Interested package
              <select
                style={inputStyle}
                value={draft.packageId}
                onChange={(event) => setDraft((current) => ({ ...current, packageId: event.target.value }))}
              >
                <option value="">No package selected</option>
                {(options?.packages ?? []).map((pkg) => (
                  <option key={pkg.id} value={pkg.id}>{pkg.name}</option>
                ))}
              </select>
            </label>
            <label>
              Assigned employee
              <select
                style={inputStyle}
                value={draft.assignedEmployeeId}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, assignedEmployeeId: event.target.value }))
                }
              >
                <option value="">Unassigned</option>
                {(options?.employees ?? []).map((employee) => (
                  <option key={employee.id} value={employee.id}>{employee.name}</option>
                ))}
              </select>
            </label>
            <label>
              Priority
              <select
                style={inputStyle}
                value={draft.priority}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, priority: event.target.value as Priority }))
                }
              >
                {PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>{priority}</option>
                ))}
              </select>
            </label>
            <label>
              Follow-up date &amp; time
              <input
                style={inputStyle}
                type="datetime-local"
                value={draft.followUpAt}
                onChange={(event) => setDraft((current) => ({ ...current, followUpAt: event.target.value }))}
              />
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              Notes
              <textarea
                style={{ ...inputStyle, minHeight: 90 }}
                value={draft.notes}
                maxLength={5000}
                onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
              />
            </label>
            {error && (
              <p role="alert" style={{ gridColumn: "1 / -1", color: "var(--danger, #b42318)" }}>
                {error}
              </p>
            )}
            <footer style={{ gridColumn: "1 / -1", display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={closeForm}>Cancel</button>
              <button type="submit" style={buttonStyle} disabled={saving}>
                {saving ? "Saving…" : editingLead ? "Save changes" : "Create lead"}
              </button>
            </footer>
          </form>
        </div>
      )}

      {conversionId != null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Review subscriber matches"
          style={{
            position: "fixed",
            zIndex: 70,
            inset: 0,
            overflowY: "auto",
            background: "rgba(16, 24, 40, .55)",
            padding: 16,
          }}
        >
          <section
            style={{
              ...panelStyle(),
              maxWidth: 700,
              margin: "48px auto",
              padding: 20,
            }}
          >
            <header style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <h2 style={{ marginTop: 0 }}>Review subscriber matches</h2>
              <button type="button" style={buttonStyle} onClick={() => setConversionId(null)}>
                Close
              </button>
            </header>
            {candidatesError && (
              <p role="alert" style={{ color: "var(--danger, #b42318)" }}>
                {candidatesError.message}
              </p>
            )}
            {candidateReview?.alreadyConverted ? (
              <p role="status">
                This lead is already linked to subscriber #{candidateReview.subscriberId}.
              </p>
            ) : candidateReview?.candidates.length ? (
              <>
                <p>
                  These existing subscribers match the lead&apos;s normalized phone
                  or email. Review each person; names alone are never used to link
                  records. Select the legitimate match to reuse it without changing
                  subscriber data.
                </p>
                <div style={{ display: "grid", gap: 8 }}>
                  {candidateReview.candidates.map((candidate) => (
                    <label
                      key={candidate.id}
                      style={{
                        ...panelStyle(),
                        padding: 12,
                        display: "flex",
                        gap: 10,
                        alignItems: "flex-start",
                      }}
                    >
                      <input
                        type="radio"
                        name="subscriber-match"
                        checked={selectedCandidate === candidate.id}
                        onChange={() => setSelectedCandidate(candidate.id)}
                      />
                      <span>
                        <strong>{candidate.fullName}</strong> · #{candidate.id}
                        <br />
                        {candidate.phone}
                        {candidate.email ? ` · ${candidate.email}` : ""}
                        <br />
                        Login: {candidate.username} · {candidate.status}
                        <br />
                        Match: {candidate.matchingReasons.join(", ")}
                      </span>
                    </label>
                  ))}
                </div>
                <p style={{ color: "var(--muted, #667085)" }}>
                  New subscriber creation is blocked while these contact conflicts
                  remain. If none is the same person, correct the lead contact
                  details and review again.
                </p>
              </>
            ) : candidateReview ? (
              <p>
                No company-scoped subscriber matches this lead&apos;s phone or email.
                Creating a new record will leave it inactive and will not create
                billing or activate service.
              </p>
            ) : (
              <p>Checking company-scoped subscriber records…</p>
            )}
            {conversionMessage && (
              <p role="status" style={{ color: "var(--success, #067647)" }}>
                {conversionMessage}
              </p>
            )}
            {error && (
              <p role="alert" style={{ color: "var(--danger, #b42318)" }}>
                {error}
              </p>
            )}
            {!candidateReview?.alreadyConverted && candidateReview && (
              <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={saving || (!!candidateReview.candidates.length && selectedCandidate == null)}
                  onClick={convertLead}
                >
                  {saving
                    ? "Converting…"
                    : candidateReview.candidates.length
                      ? "Link selected subscriber"
                      : "Create inactive subscriber"}
                </button>
              </footer>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
