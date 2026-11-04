"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import API_BASE from "../components/api";

type TaskStatus = "PLANNED" | "IN_PROGRESS" | "DONE" | "CANCELLED";
type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

type Task = {
  id: number;
  title: string;
  description: string | null;
  category: string | null;
  priority: Priority;
  status: TaskStatus;
  dueAt: string | null;
  reminderAt: string | null;
  updatedAt: string;
  assignee: { id: number; name: string; designation: string | null } | null;
  subscriber: { id: number; fullName: string; username: string } | null;
  lead: { id: number; name: string; stage: string } | null;
  ticket: { id: number; ticketNo: string; subject: string; status: string } | null;
  fieldJob: { id: number; jobNo: string; type: string; status: string } | null;
  activities: Array<{ id: number; type: string; detail: string; createdAt: string; actor: { name: string } | null }>;
};

type Employee = { id: number; name: string; designation: string | null; department?: string | null };
type RelatedType = "" | "subscriberId" | "leadId" | "ticketId" | "fieldJobId";
type Draft = {
  title: string;
  description: string;
  category: string;
  priority: Priority;
  dueAt: string;
  reminderAt: string;
  assignedEmployeeId: string;
  relatedType: RelatedType;
  relatedId: string;
};

const API = API_BASE;
const INITIAL: Draft = {
  title: "",
  description: "",
  category: "",
  priority: "NORMAL",
  dueAt: "",
  reminderAt: "",
  assignedEmployeeId: "",
  relatedType: "",
  relatedId: "",
};
const STATUSES: TaskStatus[] = ["PLANNED", "IN_PROGRESS", "DONE", "CANCELLED"];
const PRIORITIES: Priority[] = ["LOW", "NORMAL", "HIGH", "URGENT"];

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function localDate(value: string | null) {
  if (!value) return "No due date";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Invalid date" : date.toLocaleString();
}

async function request(path: string, token: string, init?: RequestInit) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `******`,
      ...(init?.headers || {}),
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      body && typeof body === "object" && "message" in body
        ? Array.isArray(body.message)
          ? body.message.join(", ")
          : String(body.message)
        : `Request failed (${response.status}).`;
    throw new Error(detail);
  }
  return body;
}

export default function TasksPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [canCreate, setCanCreate] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [canComment, setCanComment] = useState(false);
  const [canStatus, setCanStatus] = useState(false);
  const [canReport, setCanReport] = useState(false);
  const [selected, setSelected] = useState<Task | null>(null);
  const [draft, setDraft] = useState<Draft>(INITIAL);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (query.trim()) params.set("q", query.trim());
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    return params.toString();
  }, [page, query, statusFilter]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const [list, options] = await Promise.all([
        request(`/tasks?${queryString}`, token),
        request("/tasks/options", token),
      ]);
      if (!list || typeof list !== "object" || !("items" in list) || !Array.isArray(list.items) || !("total" in list)) {
        throw new Error("The task list response is invalid.");
      }
      if (!options || typeof options !== "object" || !("employees" in options) || !Array.isArray(options.employees)) {
        throw new Error("The task options response is invalid.");
      }
      setItems(list.items as Task[]);
      setTotal(Number(list.total));
      setEmployees(options.employees as Employee[]);
      setCanManage(options.canManage === true);
      setCanCreate(options.canCreate === true);
      setCanEdit(options.canEdit === true);
      setCanComment(options.canComment === true);
      setCanStatus(options.canStatus === true);
      setCanReport(options.canReport === true);
      if (options.canReport === true) {
        try {
          const count = await request("/tasks/summary", token);
          if (!count || typeof count !== "object") throw new Error("The task summary response is invalid.");
          setSummary(count as Record<string, number>);
        } catch (reason) {
          setSummary({});
          setError(`Task summary: ${messageOf(reason)}`);
        }
      } else {
        setSummary({});
      }
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setLoading(false);
    }
  }, [token, queryString]);

  useEffect(() => {
    const stored = localStorage.getItem("token");
    if (!stored) {
      router.push("/login");
      return;
    }
    setToken(stored);
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadDetail(id: number) {
    try {
      const value = await request(`/tasks/${id}`, token);
      setSelected(value as Task);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  function openCreate() {
    setSelected(null);
    setDraft(INITIAL);
    setEditing(true);
    setError("");
    setNotice("");
  }

  function openEdit(task: Task) {
    const related = task.subscriber
      ? ["subscriberId", task.subscriber.id]
      : task.lead
        ? ["leadId", task.lead.id]
        : task.ticket
          ? ["ticketId", task.ticket.id]
          : task.fieldJob
            ? ["fieldJobId", task.fieldJob.id]
            : ["", ""];
    setDraft({
      title: task.title,
      description: task.description || "",
      category: task.category || "",
      priority: task.priority,
      dueAt: task.dueAt ? new Date(new Date(task.dueAt).getTime() - new Date(task.dueAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "",
      reminderAt: task.reminderAt ? new Date(new Date(task.reminderAt).getTime() - new Date(task.reminderAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "",
      assignedEmployeeId: String(task.assignee?.id || ""),
      relatedType: related[0] as RelatedType,
      relatedId: String(related[1] || ""),
    });
    setSelected(task);
    setEditing(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const related = draft.relatedType && draft.relatedId
        ? { [draft.relatedType]: Number(draft.relatedId) }
        : {};
      const payload = !selected || canManage ? {
        title: draft.title,
        description: draft.description || null,
        category: draft.category || null,
        priority: draft.priority,
        dueAt: draft.dueAt ? new Date(draft.dueAt).toISOString() : null,
        reminderAt: draft.reminderAt ? new Date(draft.reminderAt).toISOString() : null,
        ...related,
      } : { description: draft.description || null };
      let taskId = selected?.id;
      if (selected) {
        await request(`/tasks/${selected.id}`, token, { method: "PATCH", body: JSON.stringify(payload) });
        if (canManage && String(selected.assignee?.id || "") !== draft.assignedEmployeeId) {
          await request(`/tasks/${selected.id}/assignment`, token, {
            method: "PATCH",
            body: JSON.stringify({ assignedEmployeeId: draft.assignedEmployeeId || null }),
          });
        }
      } else {
        const created = await request("/tasks", token, {
          method: "POST",
          body: JSON.stringify({
            ...payload,
            assignedEmployeeId: draft.assignedEmployeeId || null,
          }),
        }) as Task;
        taskId = created.id;
      }
      setEditing(false);
      setNotice(selected ? "Task updated." : "Task created.");
      await load();
      if (taskId) await loadDetail(taskId);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(task: Task, status: TaskStatus) {
    const detail = status === "CANCELLED" ? window.prompt("Reason for cancellation") : null;
    if (status === "CANCELLED" && !detail?.trim()) return;
    setSaving(true);
    setError("");
    try {
      await request(`/tasks/${task.id}/status`, token, {
        method: "PATCH",
        body: JSON.stringify({ status, detail }),
      });
      setNotice(`Task moved to ${status.replace("_", " ").toLowerCase()}.`);
      await load();
      if (selected?.id === task.id) await loadDetail(task.id);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  }

  async function addComment(event: FormEvent) {
    event.preventDefault();
    if (!selected || !comment.trim()) return;
    setSaving(true);
    setError("");
    try {
      await request(`/tasks/${selected.id}/comments`, token, {
        method: "POST",
        body: JSON.stringify({ detail: comment }),
      });
      setComment("");
      await loadDetail(selected.id);
      setNotice("Comment added to the task history.");
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  }

  const surface: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    color: "var(--text)",
    padding: 16,
  };
  const inputStyle: React.CSSProperties = {
    color: "var(--text)",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "9px 10px",
    width: "100%",
  };
  const buttonStyle: React.CSSProperties = {
    color: "var(--text)",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "8px 12px",
    cursor: "pointer",
  };

  return (
    <main style={{ color: "var(--text)", padding: "clamp(12px, 2vw, 24px)", maxWidth: 1500, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>Tasks</h1>
          <p style={{ color: "var(--muted)", margin: "5px 0 0" }}>Internal task planning and team follow-up, separate from customer tickets.</p>
        </div>
        {canCreate && <button style={buttonStyle} onClick={openCreate}>Create task</button>}
      </header>
      {error && <div role="alert" style={{ ...surface, borderColor: "#dc2626", color: "#b91c1c", marginBottom: 12 }}>{error}</div>}
      {notice && <div role="status" style={{ ...surface, borderColor: "#16a34a", marginBottom: 12 }}>{notice}</div>}

      {canReport && <section aria-label="Task summary" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10, marginBottom: 14 }}>
        {[
          ["Planned", summary.planned],
          ["In progress", summary.inProgress],
          ["Done", summary.done],
          ["Overdue", summary.overdue],
          ["Due within 24h", summary.dueSoon],
          ...(canManage ? [["Unassigned", summary.unassigned] as [string, number]] : []),
        ].map(([label, value]) => (
          <div key={label} style={surface}>
            <div style={{ color: "var(--muted)", fontSize: 12 }}>{label}</div>
            <strong style={{ display: "block", fontSize: 23, marginTop: 4 }}>{value ?? 0}</strong>
          </div>
        ))}
      </section>}

      <section style={{ display: "grid", gridTemplateColumns: selected ? "minmax(0,1.3fr) minmax(300px,.7fr)" : "1fr", gap: 14, alignItems: "start" }}>
        <div style={surface}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(160px,1fr) 180px auto", gap: 8, marginBottom: 12 }}>
            <input aria-label="Search tasks" placeholder="Search title, description, category" value={query} style={inputStyle} onChange={(event) => { setPage(1); setQuery(event.target.value); }} />
            <select aria-label="Filter by status" value={statusFilter} style={inputStyle} onChange={(event) => { setPage(1); setStatusFilter(event.target.value); }}>
              <option value="ALL">All statuses</option>
              {STATUSES.map((status) => <option key={status} value={status}>{status.replace("_", " ")}</option>)}
            </select>
            <button style={buttonStyle} onClick={() => void load()}>Refresh</button>
          </div>
          {loading ? <p role="status">Loading tasks…</p> : items.length ? (
            <div style={{ display: "grid", gap: 8 }}>
              {items.map((task) => (
                <article key={task.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 10 }}>
                    <button onClick={() => void loadDetail(task.id)} style={{ border: 0, padding: 0, background: "transparent", color: "var(--text)", textAlign: "left", cursor: "pointer", fontWeight: 700 }}>
                      {task.title}
                    </button>
                    <span style={{ fontSize: 11, whiteSpace: "nowrap" }}>{task.priority} · {task.status.replace("_", " ")}</span>
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: 12, display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <span>{task.assignee?.name || "Unassigned"}</span>
                    <span>{localDate(task.dueAt)}</span>
                    {task.reminderAt && <span>Reminder: {localDate(task.reminderAt)}</span>}
                    {task.category && <span>{task.category}</span>}
                    {task.subscriber && <span>Subscriber: {task.subscriber.fullName}</span>}
                    {task.lead && <span>Lead: {task.lead.name}</span>}
                    {task.ticket && <span>Ticket: {task.ticket.ticketNo}</span>}
                    {task.fieldJob && <span>Work order: {task.fieldJob.jobNo}</span>}
                  </div>
                  {task.description && <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap" }}>{task.description}</p>}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {canEdit && task.status !== "DONE" && task.status !== "CANCELLED" && <button style={buttonStyle} onClick={() => openEdit(task)}>Edit</button>}
                    {canStatus && task.status === "PLANNED" && <button disabled={saving} style={buttonStyle} onClick={() => void setStatus(task, "IN_PROGRESS")}>Start</button>}
                    {canStatus && task.status === "IN_PROGRESS" && <button disabled={saving} style={buttonStyle} onClick={() => void setStatus(task, "DONE")}>Complete</button>}
                    {canStatus && canManage && !["DONE", "CANCELLED"].includes(task.status) && <button disabled={saving} style={buttonStyle} onClick={() => void setStatus(task, "CANCELLED")}>Cancel</button>}
                  </div>
                </article>
              ))}
            </div>
          ) : <p style={{ color: "var(--muted)" }}>No tasks match these filters.</p>}
          <footer style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 14 }}>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>{total} task{total === 1 ? "" : "s"} · Page {page} of {Math.max(1, Math.ceil(total / 20))}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={buttonStyle} disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>Previous</button>
              <button style={buttonStyle} disabled={page * 20 >= total || loading} onClick={() => setPage((value) => value + 1)}>Next</button>
            </div>
          </footer>
        </div>

        {selected && !editing && (
          <aside style={{ ...surface, maxHeight: "80vh", overflow: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>{selected.title}</h2>
              <button style={buttonStyle} onClick={() => setSelected(null)}>Close</button>
            </div>
            <p style={{ color: "var(--muted)", fontSize: 12 }}>{selected.status.replace("_", " ")} · {selected.priority} · Due {localDate(selected.dueAt)}</p>
            {selected.description && <p style={{ whiteSpace: "pre-wrap" }}>{selected.description}</p>}
            <h3 style={{ fontSize: 14 }}>Activity</h3>
            <div style={{ display: "grid", gap: 8 }}>
              {selected.activities.map((activity) => (
                <div key={activity.id} style={{ borderLeft: "2px solid var(--border)", paddingLeft: 10 }}>
                  <strong style={{ fontSize: 12 }}>{activity.type.replace("_", " ")}</strong>
                  <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{activity.detail}</div>
                  <small style={{ color: "var(--muted)" }}>{activity.actor?.name || "System"} · {localDate(activity.createdAt)}</small>
                </div>
              ))}
            </div>
            {canComment && <form onSubmit={addComment} style={{ display: "grid", gap: 8, marginTop: 12 }}>
              <label htmlFor="task-comment">Internal comment</label>
              <textarea id="task-comment" value={comment} onChange={(event) => setComment(event.target.value)} style={{ ...inputStyle, minHeight: 70 }} maxLength={4000} />
              <button disabled={saving || !comment.trim()} style={buttonStyle}>Add comment</button>
            </form>}
          </aside>
        )}

        {editing && (
          <aside style={surface}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>{selected ? "Edit task" : "Create task"}</h2>
            <form onSubmit={save} style={{ display: "grid", gap: 10 }}>
              {(!selected || canManage) && <label>Title<input required maxLength={160} value={draft.title} style={inputStyle} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>}
              <label>Description<textarea maxLength={10000} value={draft.description} style={{ ...inputStyle, minHeight: 90 }} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
              {(!selected || canManage) && <>
                <label>Category<input maxLength={80} value={draft.category} style={inputStyle} onChange={(event) => setDraft({ ...draft, category: event.target.value })} /></label>
                <label>Priority<select value={draft.priority} style={inputStyle} onChange={(event) => setDraft({ ...draft, priority: event.target.value as Priority })}>{PRIORITIES.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label>Due date<input type="datetime-local" value={draft.dueAt} style={inputStyle} onChange={(event) => setDraft({ ...draft, dueAt: event.target.value })} /></label>
                {canManage && <label>Assigned employee<select value={draft.assignedEmployeeId} style={inputStyle} onChange={(event) => setDraft({ ...draft, assignedEmployeeId: event.target.value })}><option value="">Unassigned</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}{employee.designation ? ` · ${employee.designation}` : ""}</option>)}</select></label>}
                <label>Reminder time<input type="datetime-local" value={draft.reminderAt} style={inputStyle} onChange={(event) => setDraft({ ...draft, reminderAt: event.target.value })} /><small style={{ color: "var(--muted)" }}>Delivered to the assigned employee using their enabled SMS or email preference.</small></label>
                <label>Related record<select value={draft.relatedType} style={inputStyle} onChange={(event) => setDraft({ ...draft, relatedType: event.target.value as RelatedType, relatedId: "" })}><option value="">None</option><option value="subscriberId">Subscriber</option><option value="leadId">CRM lead</option><option value="ticketId">Support ticket</option><option value="fieldJobId">Field work order</option></select></label>
                {draft.relatedType && <label>Related record ID<input required type="number" min="1" value={draft.relatedId} style={inputStyle} onChange={(event) => setDraft({ ...draft, relatedId: event.target.value })} /></label>}
              </>}
              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={saving} style={buttonStyle}>{saving ? "Saving…" : "Save task"}</button>
                <button type="button" disabled={saving} style={buttonStyle} onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </form>
          </aside>
        )}
      </section>
    </main>
  );
}
