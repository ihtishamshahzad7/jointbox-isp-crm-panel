"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import API_BASE from "../components/api";

type Status = "PENDING" | "ASSIGNED" | "IN_PROGRESS" | "PENDING_REVIEW" | "COMPLETED" | "FAILED" | "CANCELLED";
type JobType = "INSTALLATION" | "FAULT_REPAIR" | "MAINTENANCE" | "DISCONNECTION" | "SURVEY" | "UPGRADE" | "RELOCATION";
type Employee = { id: number; employeeId: number; name: string; designation: string | null; workload: number };
type InventoryOption = {
  id: number;
  serialNumber: string;
  type: string;
  brand: string | null;
  model: string | null;
  status: string;
  ownerId: number | null;
  fieldJobId: number | null;
  reservedForFieldJobId: number | null;
  updatedAt?: string;
};
type Activity = { id: number; action: string; detail: string; createdAt: string; actor: { name: string } | null };
type Attachment = {
  id: number;
  filename: string;
  evidenceType: string;
  note: string | null;
  createdAt: string;
  uploader: { id: number; name: string } | null;
};
type Movement = {
  id: number;
  itemId: number;
  movementType: string;
  notes: string | null;
  createdAt: string;
  fromStatus: string | null;
  toStatus: string;
  byUserId: number | null;
  item: { id: number; serialNumber: string; type: string; status: string };
  employee: { id: number; name: string } | null;
};
type Visit = {
  id: number;
  visitNumber: number;
  arrivedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  outcome: string | null;
  notes: string | null;
  nextAction: string | null;
  checkInLocationStatus: string | null;
  checkInLatitude: number | null;
  checkInLongitude: number | null;
  checkInAccuracy: number | null;
  checkInCapturedAt: string | null;
  checkOutLocationStatus: string | null;
  checkOutLatitude: number | null;
  checkOutLongitude: number | null;
  checkOutAccuracy: number | null;
  checkOutCapturedAt: string | null;
  technician: { name: string } | null;
};
type Job = {
  id: number;
  jobNo: string;
  type: JobType;
  status: Status;
  priority: string;
  description: string;
  workInstructions: string | null;
  address: string | null;
  subscriber: { id: number; fullName: string; username: string; phone: string | null; address: string | null } | null;
  ticket: { id: number; ticketNo: string; subject: string; status: string } | null;
  lead: { id: number; name: string; phone: string; stage: string } | null;
  technician: { id: number; name: string; phone: string | null } | null;
  assignedTo: number | null;
  scheduledAt: string | null;
  appointmentEndsAt: string | null;
  visitOrder: number | null;
  arrivedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completionNotes: string | null;
  failureReason: string | null;
  cancellationReason: string | null;
  resolution: string | null;
  nextAction: string | null;
  checklist: unknown;
  customerConfirmedAt: string | null;
  activities: Activity[];
  attachments: Attachment[];
  visits: Visit[];
  inventoryMovements: Movement[];
  issuedMaterialCount: number;
  reservedMaterialCount: number;
  reservedInventoryItems: InventoryOption[];
  issuedInventoryItems: InventoryOption[];
};
type Draft = {
  type: JobType;
  priority: string;
  description: string;
  workInstructions: string;
  address: string;
  linkType: "" | "subscriberId" | "ticketId" | "leadId";
  linkId: string;
};
type Options = {
  canCreate: boolean;
  canDispatch: boolean;
  canTechnician: boolean;
  canReview: boolean;
  canMaterials: boolean;
  canDelete: boolean;
  canReport: boolean;
  canEvidence: boolean;
  canLocation: boolean;
  canSchedules: boolean;
  currentUserId: number;
  technicians: Employee[];
  inventoryItems: InventoryOption[];
};
type Schedule = {
  id: number;
  type: JobType;
  priority: string;
  description: string;
  workInstructions: string | null;
  address: string | null;
  subscriberId: number | null;
  ticketId: number | null;
  leadId: number | null;
  frequency: string;
  interval: number;
  timeZone: string;
  startAt: string;
  endAt: string | null;
  nextRunAt: string | null;
  status: string;
  occurrences: Array<{ id: number; occurrenceAt: string; fieldJob: { id: number; jobNo: string; status: Status } | null }>;
};
type ScheduleDraft = {
  type: JobType;
  priority: string;
  description: string;
  workInstructions: string;
  address: string;
  frequency: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: string;
  timeZone: string;
  startAtLocal: string;
  endAtLocal: string;
  linkType: "" | "subscriberId" | "ticketId" | "leadId";
  linkId: string;
};

const API = API_BASE;
const INITIAL: Draft = {
  type: "INSTALLATION",
  priority: "MEDIUM",
  description: "",
  workInstructions: "",
  address: "",
  linkType: "",
  linkId: "",
};
const INITIAL_SCHEDULE: ScheduleDraft = {
  type: "MAINTENANCE",
  priority: "MEDIUM",
  description: "",
  workInstructions: "",
  address: "",
  frequency: "MONTHLY",
  interval: "1",
  timeZone: "",
  startAtLocal: "",
  endAtLocal: "",
  linkType: "",
  linkId: "",
};
const TYPES: JobType[] = ["INSTALLATION", "FAULT_REPAIR", "MAINTENANCE", "DISCONNECTION", "SURVEY", "UPGRADE", "RELOCATION"];
const STATUSES: Status[] = ["PENDING", "ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "COMPLETED", "FAILED", "CANCELLED"];
const MATERIAL_ACTIONS = ["RESERVE", "UNRESERVE", "ISSUE", "CONSUME", "RETURN", "DAMAGED", "LOST"] as const;
const EVIDENCE_TYPES = ["BEFORE_WORK", "AFTER_WORK", "INSTALLATION", "REPAIR", "EQUIPMENT", "SERIAL_NUMBER", "OTHER"] as const;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function formatDate(value: string | null) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Invalid date" : date.toLocaleString();
}

function formatDateInZone(value: string | null, timeZone: string) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
  } catch {
    return formatDate(value);
  }
}

function localInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function localInputInZone(value: string | null, timeZone: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const parts = new Map(new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}T${parts.get("hour")}:${parts.get("minute")}`;
  } catch {
    return "";
  }
}

async function request(path: string, token: string, init?: RequestInit) {
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

export default function FieldJobsPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Record<string, unknown>>({});
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(INITIAL_SCHEDULE);
  const [editingScheduleId, setEditingScheduleId] = useState<number | null>(null);
  const [mediaToken, setMediaToken] = useState("");
  const [options, setOptions] = useState<Options | null>(null);
  const [selected, setSelected] = useState<Job | null>(null);
  const [draft, setDraft] = useState<Draft>(INITIAL);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [technicianId, setTechnicianId] = useState("");
  const [reassignmentReason, setReassignmentReason] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [appointmentEndsAt, setAppointmentEndsAt] = useState("");
  const [visitOrder, setVisitOrder] = useState("");
  const [materialItemId, setMaterialItemId] = useState("");
  const [materialAction, setMaterialAction] = useState<(typeof MATERIAL_ACTIONS)[number]>("ISSUE");
  const [materialIdempotencyKey, setMaterialIdempotencyKey] = useState<string | null>(null);
  const [materialNotes, setMaterialNotes] = useState("");
  const [checklistJson, setChecklistJson] = useState("");
  const [completionNotes, setCompletionNotes] = useState("");
  const [resolution, setResolution] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [assistanceDetail, setAssistanceDetail] = useState("");
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidenceType, setEvidenceType] = useState<(typeof EVIDENCE_TYPES)[number]>("BEFORE_WORK");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const listQuery = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (query.trim()) params.set("q", query.trim());
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    if (typeFilter !== "ALL") params.set("type", typeFilter);
    return params.toString();
  }, [page, query, statusFilter, typeFilter]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const [list, perms] = await Promise.all([
        request(`/field-jobs?${listQuery}`, token),
        request("/field-jobs/options", token),
      ]);
      if (!list || typeof list !== "object" || !("items" in list) || !Array.isArray(list.items) || !("total" in list)) {
        throw new Error("The field-job list response is invalid.");
      }
      if (!perms || typeof perms !== "object" || !("technicians" in perms) || !Array.isArray(perms.technicians)) {
        throw new Error("The field-job options response is invalid.");
      }
      setItems(list.items as Job[]);
      setTotal(Number(list.total));
      setOptions(perms as Options);
      if ((perms as Options).canSchedules) {
        try {
          setSchedules(await request("/field-jobs/schedules", token) as Schedule[]);
        } catch (reason) {
          setSchedules([]);
          setError(`Recurring schedules: ${messageOf(reason)}`);
        }
      } else {
        setSchedules([]);
      }
      if ((perms as Options).canReport) {
        try {
          setStats(await request("/field-jobs/stats", token) as Record<string, unknown>);
        } catch (reason) {
          setStats({});
          setError(`Field-job report: ${messageOf(reason)}`);
        }
      } else {
        setStats({});
      }
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setLoading(false);
    }
  }, [listQuery, token]);

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

  const loadDetail = useCallback(async (id: number) => {
    setError("");
    try {
      const job = await request(`/field-jobs/${id}`, token) as Job;
      if (selected?.id !== id) setMaterialIdempotencyKey(null);
      setSelected(job);
      if (job.attachments?.length && !mediaToken) {
        try {
          const media = await request("/uploads/media-token", token) as { token: string };
          setMediaToken(media.token);
        } catch (reason) {
          setError(`Evidence preview: ${messageOf(reason)}`);
        }, [mediaToken, selected?.id, token]);

        useEffect(() => {
          if (!token) return;
          const jobId = Number(new URLSearchParams(window.location.search).get("jobId"));
          if (!Number.isSafeInteger(jobId) || jobId < 1) return;
          router.replace("/field-jobs");
          void loadDetail(jobId);
        }, [loadDetail, router, token]);
      }
      setTechnicianId(String(job.assignedTo ?? ""));
      setReassignmentReason("");
      setScheduledAt(localInput(job.scheduledAt));
      setAppointmentEndsAt(localInput(job.appointmentEndsAt));
      setVisitOrder(job.visitOrder == null ? "" : String(job.visitOrder));
      setChecklistJson(job.checklist == null ? "" : JSON.stringify(job.checklist, null, 2));
      setCompletionNotes(job.completionNotes || "");
      setResolution(job.resolution || "");
      setNextAction(job.nextAction || "");
      setEvidenceFile(null);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  function startCreate() {
    setSelected(null);
    setDraft(INITIAL);
    setCreating(true);
    setEditing(false);
    setNotice("");
    setError("");
  }

  function startEdit(job: Job) {
    const link = job.ticket
      ? ["ticketId", job.ticket.id]
      : job.subscriber
        ? ["subscriberId", job.subscriber.id]
        : job.lead
          ? ["leadId", job.lead.id]
          : ["", ""];
    setDraft({
      type: job.type,
      priority: job.priority,
      description: job.description,
      workInstructions: job.workInstructions || "",
      address: job.address || "",
      linkType: link[0] as Draft["linkType"],
      linkId: String(link[1] || ""),
    });
    setCreating(false);
    setEditing(true);
    setError("");
  }

  async function saveJob(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const linked = draft.linkType && draft.linkId ? { [draft.linkType]: Number(draft.linkId) } : {
        subscriberId: null,
        ticketId: null,
        leadId: null,
      };
      const body = {
        type: draft.type,
        priority: draft.priority,
        description: draft.description,
        workInstructions: draft.workInstructions || null,
        address: draft.address || null,
        ...linked,
      };
      let jobId = selected?.id;
      if (editing && selected) {
        await request(`/field-jobs/${selected.id}`, token, { method: "PUT", body: JSON.stringify(body) });
      } else {
        const job = await request("/field-jobs", token, { method: "POST", body: JSON.stringify(body) }) as Job;
        jobId = job.id;
      }
      setCreating(false);
      setEditing(false);
      setNotice(editing ? "Field job updated." : "Field job created.");
      await load();
      if (jobId) await loadDetail(jobId);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  }

  async function saveSchedule(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const linkId = scheduleDraft.linkType && scheduleDraft.linkId ? Number(scheduleDraft.linkId) : null;
      const payload = {
        type: scheduleDraft.type,
        priority: scheduleDraft.priority,
        description: scheduleDraft.description,
        workInstructions: scheduleDraft.workInstructions,
        address: scheduleDraft.address,
        frequency: scheduleDraft.frequency,
        interval: Number(scheduleDraft.interval),
        timeZone: scheduleDraft.timeZone,
        startAtLocal: scheduleDraft.startAtLocal,
        endAtLocal: scheduleDraft.endAtLocal || null,
        subscriberId: scheduleDraft.linkType === "subscriberId" ? linkId : null,
        ticketId: scheduleDraft.linkType === "ticketId" ? linkId : null,
        leadId: scheduleDraft.linkType === "leadId" ? linkId : null,
      };
      await request(editingScheduleId
        ? `/field-jobs/schedules/${editingScheduleId}`
        : "/field-jobs/schedules", token, {
        method: editingScheduleId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      setScheduleDraft(INITIAL_SCHEDULE);
      setEditingScheduleId(null);
      setNotice(editingScheduleId
        ? "Schedule updated. Changes apply to future occurrences only; generated work orders and occurrence history are unchanged."
        : "Recurring work schedule saved. Occurrences are generated by the persisted scheduler.");
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  }

  function editSchedule(schedule: Schedule) {
    const linkType = schedule.subscriberId ? "subscriberId"
      : schedule.ticketId ? "ticketId"
        : schedule.leadId ? "leadId" : "";
    const linkId = linkType === "subscriberId" ? schedule.subscriberId
      : linkType === "ticketId" ? schedule.ticketId
        : linkType === "leadId" ? schedule.leadId : null;
    setEditingScheduleId(schedule.id);
    setScheduleDraft({
      type: schedule.type,
      priority: schedule.priority,
      description: schedule.description,
      workInstructions: schedule.workInstructions ?? "",
      address: schedule.address ?? "",
      frequency: schedule.frequency as ScheduleDraft["frequency"],
      interval: String(schedule.interval),
      timeZone: schedule.timeZone,
      startAtLocal: localInputInZone(schedule.startAt, schedule.timeZone),
      endAtLocal: localInputInZone(schedule.endAt, schedule.timeZone),
      linkType,
      linkId: linkId == null ? "" : String(linkId),
    });
    setError("");
    setNotice(`Editing schedule ${schedule.id}. Only future, not-yet-generated occurrences will use these changes.`);
  }

  function cancelScheduleEdit() {
    setEditingScheduleId(null);
    setScheduleDraft(INITIAL_SCHEDULE);
    setError("");
    setNotice("");
  }

  async function changeScheduleStatus(schedule: Schedule, status: "ACTIVE" | "PAUSED" | "CANCELLED") {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await request(`/field-jobs/schedules/${schedule.id}/status`, token, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setNotice(`Schedule ${schedule.id} ${status.toLowerCase()}.`);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  }

  async function uploadEvidence(event: FormEvent) {
    event.preventDefault();
    if (!selected || !evidenceFile) return;
    if (evidenceFile.size > 8 * 1024 * 1024) {
      setError("Choose an image no larger than 8 MB.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const formData = new FormData();
      formData.append("file", evidenceFile);
      const response = await fetch(`${API}/uploads`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const uploaded = await response.json().catch(() => null) as { filename?: string; message?: string | string[] } | null;
      if (!response.ok || !uploaded?.filename) {
        const detail = Array.isArray(uploaded?.message) ? uploaded?.message.join(", ") : uploaded?.message;
        throw new Error(detail || `Photo upload failed (${response.status}).`);
      }
      await request(`/field-jobs/${selected.id}/attachments`, token, {
        method: "POST",
        body: JSON.stringify({ filename: uploaded.filename, evidenceType, note: evidenceNote || null }),
      });
      setEvidenceFile(null);
      setEvidenceNote("");
      setNotice("Private field-job evidence uploaded.");
      await loadDetail(selected.id);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  }

  function recordLocation(phase: "CHECK_IN" | "CHECK_OUT") {
    if (!selected) return;
    const path = `/field-jobs/${selected.id}/location/${phase.toLowerCase().replace("_", "-")}`;
    const successMessage = phase === "CHECK_IN" ? "Check-in and location outcome recorded." : "Check-out location outcome recorded.";
    const recordWithoutCoordinates = (status: "DENIED" | "UNAVAILABLE" | "ERROR" | "NOT_REQUESTED") => {
      void perform(path, "PATCH", { status }, successMessage);
    };
    if (!navigator.geolocation) {
      recordWithoutCoordinates("UNAVAILABLE");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        void perform(path, "PATCH", {
          status: "GRANTED",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
        }, successMessage);
      },
      (error) => {
        const status = error.code === error.PERMISSION_DENIED
          ? "DENIED"
          : error.code === error.POSITION_UNAVAILABLE ? "UNAVAILABLE" : "ERROR";
        recordWithoutCoordinates(status);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }

  async function perform(path: string, method: string, body?: unknown, success = "Field job updated.") {
    if (!selected) return false;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await request(path, token, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      setNotice(success);
      await load();
      if (method.toUpperCase() === "DELETE") {
        setSelected(null);
      } else {
        await loadDetail(selected.id);
      }
      return true;
    } catch (reason) {
      setError(messageOf(reason));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function assign(event: FormEvent) {
    event.preventDefault();
    if (!selected || !technicianId) return;
    await perform(
      `/field-jobs/${selected.id}/assign/${technicianId}`,
      "PATCH",
      {
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        appointmentEndsAt: appointmentEndsAt ? new Date(appointmentEndsAt).toISOString() : null,
        visitOrder: visitOrder ? Number(visitOrder) : null,
        reason: reassignmentReason || undefined,
        expectedAssignedTo: selected.assignedTo,
      },
      "Technician and appointment saved.",
    );
  }

  async function updateChecklist(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    let itemsValue: unknown = null;
    try {
      itemsValue = checklistJson.trim() ? JSON.parse(checklistJson) : null;
    } catch {
      setError("Checklist must be valid JSON.");
      return;
    }
    await perform(`/field-jobs/${selected.id}/checklist`, "PATCH", { items: itemsValue }, "Checklist saved.");
  }

  async function moveMaterial(event: FormEvent) {
    event.preventDefault();
    if (!selected || !materialItemId) return;
    const idempotencyKey = materialIdempotencyKey ?? crypto.randomUUID();
    setMaterialIdempotencyKey(idempotencyKey);
    const succeeded = await perform(
      `/field-jobs/${selected.id}/materials/${materialAction.toLowerCase()}`,
      "POST",
      { itemId: Number(materialItemId), idempotencyKey, notes: materialNotes || null },
      `${materialAction.toLowerCase()} recorded.`,
    );
    if (succeeded) {
      setMaterialIdempotencyKey(null);
      setMaterialItemId("");
      setMaterialNotes("");
    }
  }

  async function requestAssistance(event: FormEvent) {
    event.preventDefault();
    if (!selected || !assistanceDetail.trim()) return;
    await perform(
      `/field-jobs/${selected.id}/assistance`,
      "POST",
      { detail: assistanceDetail.trim() },
      "Assistance request recorded.",
    );
    setAssistanceDetail("");
  }

  async function complete(success: boolean) {
    if (!selected) return;
    const failureReason = success ? undefined : window.prompt("Reason this visit could not be completed");
    if (!success && !failureReason?.trim()) return;
    await perform(
      `/field-jobs/${selected.id}/complete`,
      "PATCH",
      {
        success,
        notes: completionNotes || null,
        failureReason,
        resolution: resolution || null,
        nextAction: nextAction || null,
      },
      success ? "Completion submitted for dispatcher review." : "Failed visit recorded.",
    );
  }

  async function cancel() {
    if (!selected) return;
    const reason = window.prompt("Reason for cancellation");
    if (!reason?.trim()) return;
    await perform(`/field-jobs/${selected.id}/cancel`, "PATCH", { reason }, "Field job cancelled.");
  }

  const canActOnSelectedJob = !!(
    options?.canTechnician &&
    selected &&
    selected.assignedTo === options.currentUserId
  );
  const materialChoices = useMemo(() => {
    if (!selected || !options) return [];
    const available = options.inventoryItems;
    const reserved = selected.reservedInventoryItems ?? [];
    const issued = selected.issuedInventoryItems ?? [];
    const canReserveOrIssue =
      selected.assignedTo != null &&
      ["PENDING", "ASSIGNED", "IN_PROGRESS"].includes(selected.status);
    switch (materialAction) {
      case "RESERVE":
        return canReserveOrIssue ? available.map((item) => ({ item, custody: "Available" })) : [];
      case "UNRESERVE":
        return reserved.map((item) => ({ item, custody: "Reserved for this job" }));
      case "ISSUE":
        return canReserveOrIssue ? [
          ...available.map((item) => ({ item, custody: "Available" })),
          ...reserved.map((item) => ({ item, custody: "Reserved for this job" })),
        ] : [];
      case "CONSUME":
        return selected.subscriber && ["IN_PROGRESS", "PENDING_REVIEW"].includes(selected.status)
          ? issued.map((item) => ({ item, custody: "Issued to this job" }))
          : [];
      case "RETURN":
      case "DAMAGED":
      case "LOST":
        return issued.map((item) => ({ item, custody: "Issued to this job" }));
    }
  }, [materialAction, options, selected]);
  const outstandingMaterials = (selected?.reservedMaterialCount ?? 0) + (selected?.issuedMaterialCount ?? 0);
  const assignmentChangesTechnician = !!selected && !!technicianId && Number(technicianId) !== selected.assignedTo;
  const card: React.CSSProperties = {
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
  const button: React.CSSProperties = {
    color: "var(--text)",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "8px 12px",
    cursor: "pointer",
  };

  return (
    <main style={{ color: "var(--text)", padding: "clamp(12px, 2vw, 24px)", maxWidth: 1600, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>Field Jobs</h1>
          <p style={{ color: "var(--muted)", margin: "5px 0 0" }}>Dispatch, technician visits, materials, and completion review.</p>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {options?.canDispatch && <button type="button" style={button} onClick={() => router.push("/field-jobs/dispatch")}>Dispatch workspace</button>}
          {options?.canReport && <button type="button" style={button} onClick={() => router.push("/field-jobs/reports")}>Reporting &amp; performance</button>}
          {options?.canCreate && <button style={button} onClick={startCreate}>Create field job</button>}
        </div>
      </header>
      {error && <div role="alert" style={{ ...card, borderColor: "#dc2626", color: "#b91c1c", marginBottom: 12 }}>{error}</div>}
      {notice && <div role="status" style={{ ...card, borderColor: "#16a34a", marginBottom: 12 }}>{notice}</div>}

      {options?.canReport && <section aria-label="Field job summary" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10, marginBottom: 14 }}>
        {[
          ["Total", stats.total],
          ["Pending", (stats.byStatus as Record<string, number> | undefined)?.PENDING],
          ["In progress", (stats.byStatus as Record<string, number> | undefined)?.IN_PROGRESS],
          ["Awaiting review", (stats.byStatus as Record<string, number> | undefined)?.PENDING_REVIEW],
          ["Overdue", stats.overdue],
          ["Today", stats.scheduledToday],
          ["Unassigned", stats.unassigned],
        ].map(([label, value]) => <div key={label} style={card}><div style={{ color: "var(--muted)", fontSize: 12 }}>{label}</div><strong style={{ display: "block", fontSize: 23, marginTop: 4 }}>{value ?? 0}</strong></div>)}
      </section>}

      {options?.canSchedules && <section style={{ ...card, marginBottom: 14, display: "grid", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Recurring maintenance and inspection</h2>
        {editingScheduleId != null && <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>
          Editing schedule #{editingScheduleId}. Changes affect work orders generated after saving; existing work orders and occurrence history are unchanged. Recurrence changes move the next run to the first matching time at or after saving, skipping overdue ungenerated slots. Paused schedules remain paused.
        </p>}
        <form onSubmit={saveSchedule} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 8 }}>
          <label>Work type<select value={scheduleDraft.type} style={inputStyle} onChange={(event) => setScheduleDraft({ ...scheduleDraft, type: event.target.value as JobType })}>{TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
          <label>Priority<select value={scheduleDraft.priority} style={inputStyle} onChange={(event) => setScheduleDraft({ ...scheduleDraft, priority: event.target.value })}>{["LOW", "MEDIUM", "HIGH", "URGENT"].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Frequency<select value={scheduleDraft.frequency} style={inputStyle} onChange={(event) => setScheduleDraft({ ...scheduleDraft, frequency: event.target.value as ScheduleDraft["frequency"] })}>{["DAILY", "WEEKLY", "MONTHLY"].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Interval<input required type="number" min="1" max="365" value={scheduleDraft.interval} style={inputStyle} onChange={(event) => setScheduleDraft({ ...scheduleDraft, interval: event.target.value })} /></label>
          <label>Company time zone (IANA)<input required placeholder="e.g. Asia/Karachi" value={scheduleDraft.timeZone} style={inputStyle} onChange={(event) => setScheduleDraft({ ...scheduleDraft, timeZone: event.target.value })} /></label>
          <label>First occurrence in company time zone<input required type="datetime-local" value={scheduleDraft.startAtLocal} style={inputStyle} onChange={(event) => setScheduleDraft({ ...scheduleDraft, startAtLocal: event.target.value })} /></label>
          <label>End date (optional)<input type="datetime-local" value={scheduleDraft.endAtLocal} style={inputStyle} onChange={(event) => setScheduleDraft({ ...scheduleDraft, endAtLocal: event.target.value })} /></label>
          <label>Related subscriber, ticket, or CRM lead<select value={scheduleDraft.linkType} style={inputStyle} onChange={(event) => setScheduleDraft({ ...scheduleDraft, linkType: event.target.value as ScheduleDraft["linkType"], linkId: "" })}>
            <option value="">None</option><option value="subscriberId">Subscriber ID</option><option value="ticketId">Support ticket ID</option><option value="leadId">CRM lead ID</option>
          </select></label>
          {scheduleDraft.linkType && <label>Related record ID<input required type="number" min="1" value={scheduleDraft.linkId} style={inputStyle} onChange={(event) => setScheduleDraft({ ...scheduleDraft, linkId: event.target.value })} /></label>}
          <label style={{ gridColumn: "1 / -1" }}>Description / work-order summary<input required maxLength={5000} value={scheduleDraft.description} style={inputStyle} onChange={(event) => setScheduleDraft({ ...scheduleDraft, description: event.target.value })} /></label>
          <label>Work instructions<textarea maxLength={5000} value={scheduleDraft.workInstructions} style={inputStyle} onChange={(event) => setScheduleDraft({ ...scheduleDraft, workInstructions: event.target.value })} /></label>
          <label>Service address<input maxLength={500} value={scheduleDraft.address} style={inputStyle} onChange={(event) => setScheduleDraft({ ...scheduleDraft, address: event.target.value })} /></label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignSelf: "end" }}>
            <button type="submit" disabled={saving} style={button}>{saving ? "Saving schedule…" : editingScheduleId != null ? "Save schedule changes" : "Create recurring schedule"}</button>
            {editingScheduleId != null && <button type="button" disabled={saving} style={button} onClick={cancelScheduleEdit}>Cancel edit</button>}
          </div>
        </form>
        {schedules.length ? schedules.map((schedule) => <article key={schedule.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 9, display: "grid", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <strong>#{schedule.id} · {schedule.type.replaceAll("_", " ")} · every {schedule.interval} {schedule.frequency.toLowerCase()} · {schedule.status}</strong>
            <span>Next: {formatDateInZone(schedule.nextRunAt, schedule.timeZone)}</span>
          </div>
          <small>{schedule.description} · {schedule.timeZone} · {schedule.endAt ? `ends ${formatDateInZone(schedule.endAt, schedule.timeZone)}` : "no end date"}</small>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {schedule.status !== "CANCELLED" && <button type="button" disabled={saving} style={button} onClick={() => editSchedule(schedule)}>Edit schedule</button>}
            {schedule.status === "ACTIVE" && <button type="button" disabled={saving} style={button} onClick={() => void changeScheduleStatus(schedule, "PAUSED")}>Pause</button>}
            {schedule.status === "PAUSED" && <button type="button" disabled={saving} style={button} onClick={() => void changeScheduleStatus(schedule, "ACTIVE")}>Resume</button>}
            {schedule.status !== "CANCELLED" && <button type="button" disabled={saving} style={button} onClick={() => {
              if (window.confirm("Cancel this recurring schedule? Existing work orders are not changed.")) void changeScheduleStatus(schedule, "CANCELLED");
            }}>Cancel schedule</button>}
          </div>
          {schedule.occurrences.map((occurrence) => <small key={occurrence.id}>Generated {formatDateInZone(occurrence.occurrenceAt, schedule.timeZone)} · {occurrence.fieldJob?.jobNo || "Work-order link unavailable"}</small>)}
        </article>) : <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>No recurring work schedules.</p>}
        <small style={{ color: "var(--muted)" }}>Occurrences are persisted in the database, generated by a primary-instance scheduler, and protected by a schedule/time uniqueness constraint. Calendar recurrence follows the saved IANA time zone; no route optimization is implied.</small>
      </section>}

      <section style={{ display: "grid", gridTemplateColumns: selected || editing || creating ? "minmax(0,1.1fr) minmax(320px,.9fr)" : "1fr", gap: 14, alignItems: "start" }}>
        <div style={card}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(150px,1fr) repeat(2,minmax(130px,.55fr)) auto", gap: 8, marginBottom: 12 }}>
            <input aria-label="Search field jobs" placeholder="Search job, subscriber, address" value={query} style={inputStyle} onChange={(event) => { setPage(1); setQuery(event.target.value); }} />
            <select aria-label="Filter by status" value={statusFilter} style={inputStyle} onChange={(event) => { setPage(1); setStatusFilter(event.target.value); }}>
              <option value="ALL">All statuses</option>
              {STATUSES.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}
            </select>
            <select aria-label="Filter by job type" value={typeFilter} style={inputStyle} onChange={(event) => { setPage(1); setTypeFilter(event.target.value); }}>
              <option value="ALL">All job types</option>
              {TYPES.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}
            </select>
            <button style={button} disabled={loading} onClick={() => void load()}>Refresh</button>
          </div>
          {loading ? <p role="status">Loading field jobs…</p> : items.length ? (
            <div style={{ display: "grid", gap: 8 }}>
              {items.map((job) => (
                <article key={job.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 10, flexWrap: "wrap" }}>
                    <button onClick={() => { setCreating(false); setEditing(false); void loadDetail(job.id); }} style={{ border: 0, padding: 0, background: "transparent", color: "var(--text)", textAlign: "left", cursor: "pointer", fontWeight: 700 }}>
                      {job.jobNo} · {job.type.replaceAll("_", " ")}
                    </button>
                    <span style={{ fontSize: 11, color: job.scheduledAt && new Date(job.scheduledAt).getTime() < Date.now() && ["PENDING", "ASSIGNED", "IN_PROGRESS"].includes(job.status) ? "#dc2626" : "var(--text)" }}>
                      {job.priority} · {job.status.replaceAll("_", " ")}
                      {job.scheduledAt && new Date(job.scheduledAt).getTime() < Date.now() && ["PENDING", "ASSIGNED", "IN_PROGRESS"].includes(job.status) ? " · OVERDUE" : ""}
                    </span>
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: 12, display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <span>{job.subscriber?.fullName || job.lead?.name || (job.ticket ? `Ticket ${job.ticket.ticketNo}` : "No linked customer")}</span>
                    <span>{job.technician?.name || "Unassigned"}</span>
                    <span>{formatDate(job.scheduledAt)}</span>
                    {job.visitOrder != null && <span>Visit order {job.visitOrder}</span>}
                    {job.address && <span>{job.address}</span>}
                  </div>
                  <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap" }}>{job.description}</p>
                </article>
              ))}
            </div>
          ) : <p style={{ color: "var(--muted)" }}>No field jobs match these filters.</p>}
          <footer style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 14 }}>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>{total} jobs · Page {page} of {Math.max(1, Math.ceil(total / 20))}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={button} disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>Previous</button>
              <button style={button} disabled={page * 20 >= total || loading} onClick={() => setPage((value) => value + 1)}>Next</button>
            </div>
          </footer>
        </div>

        {(creating || editing) && (
          <aside style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <h2 style={{ marginTop: 0, fontSize: 18 }}>{editing ? `Edit ${selected?.jobNo}` : "Create field job"}</h2>
              <button style={button} onClick={() => { setCreating(false); setEditing(false); }}>Close</button>
            </div>
            <form onSubmit={saveJob} style={{ display: "grid", gap: 10 }}>
              <label>Job type<select value={draft.type} style={inputStyle} onChange={(event) => setDraft({ ...draft, type: event.target.value as JobType })}>{TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
              <label>Priority<select value={draft.priority} style={inputStyle} onChange={(event) => setDraft({ ...draft, priority: event.target.value })}>{["LOW", "MEDIUM", "HIGH", "URGENT"].map((value) => <option key={value}>{value}</option>)}</select></label>
              <label>Description<textarea required maxLength={5000} value={draft.description} style={{ ...inputStyle, minHeight: 85 }} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
              <label>Work instructions<textarea maxLength={5000} value={draft.workInstructions} style={{ ...inputStyle, minHeight: 65 }} onChange={(event) => setDraft({ ...draft, workInstructions: event.target.value })} /></label>
              <label>Service address<input maxLength={500} value={draft.address} style={inputStyle} onChange={(event) => setDraft({ ...draft, address: event.target.value })} /></label>
              <label>Related record<select value={draft.linkType} style={inputStyle} onChange={(event) => setDraft({ ...draft, linkType: event.target.value as Draft["linkType"], linkId: "" })}>
                <option value="">None</option><option value="subscriberId">Subscriber ID</option><option value="ticketId">Support ticket ID</option><option value="leadId">CRM lead ID</option>
              </select></label>
              {draft.linkType && <label>Record ID<input required type="number" min="1" value={draft.linkId} style={inputStyle} onChange={(event) => setDraft({ ...draft, linkId: event.target.value })} /></label>}
              <button disabled={saving} style={button}>{saving ? "Saving…" : editing ? "Save changes" : "Create job"}</button>
            </form>
          </aside>
        )}

        {selected && !editing && !creating && (
          <aside style={{ ...card, maxHeight: "82vh", overflow: "auto", display: "grid", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 8 }}>
              <div><h2 style={{ margin: 0, fontSize: 18 }}>{selected.jobNo}</h2><p style={{ color: "var(--muted)", margin: "4px 0" }}>{selected.type.replaceAll("_", " ")} · {selected.status.replaceAll("_", " ")} · {selected.priority}</p></div>
              <button style={button} onClick={() => setSelected(null)}>Close</button>
            </div>
            <div style={{ display: "grid", gap: 4, fontSize: 13 }}>
              <strong>{selected.subscriber?.fullName || selected.lead?.name || (selected.ticket ? `Ticket ${selected.ticket.ticketNo}` : "No linked customer")}</strong>
              {selected.subscriber?.username && <span>Username: {selected.subscriber.username}</span>}
              {selected.subscriber?.phone && <span>Phone: {selected.subscriber.phone}</span>}
              <span>Technician: {selected.technician?.name || "Unassigned"}</span>
              <span>Appointment: {formatDate(selected.scheduledAt)}{selected.appointmentEndsAt ? ` – ${formatDate(selected.appointmentEndsAt)}` : ""}</span>
              {selected.visitOrder != null && <span>Planned visit order: {selected.visitOrder}</span>}
              {selected.address && <span>Address: {selected.address}</span>}
              {selected.workInstructions && <span>Instructions: {selected.workInstructions}</span>}
              {selected.arrivedAt && <span>Arrived: {formatDate(selected.arrivedAt)}</span>}
              {selected.startedAt && <span>Started: {formatDate(selected.startedAt)}</span>}
              {selected.completionNotes && <span>Work notes: {selected.completionNotes}</span>}
              {selected.resolution && <span>Resolution: {selected.resolution}</span>}
              {selected.failureReason && <span>Failure/review reason: {selected.failureReason}</span>}
              {selected.cancellationReason && <span>Cancellation: {selected.cancellationReason}</span>}
              {selected.customerConfirmedAt && <span>Customer confirmation recorded</span>}
            </div>

            {options?.canDispatch && !["COMPLETED", "CANCELLED", "IN_PROGRESS", "PENDING_REVIEW"].includes(selected.status) && (
              <form onSubmit={assign} style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "grid", gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 14 }}>Assignment and appointment</h3>
                {assignmentChangesTechnician && outstandingMaterials > 0 && <p role="status" style={{ color: "var(--muted)", margin: 0 }}>Release reserved materials and resolve issued materials before changing technicians.</p>}
                <select required aria-label="Technician" value={technicianId} style={inputStyle} onChange={(event) => setTechnicianId(event.target.value)}>
                  <option value="">Select technician</option>{options.technicians.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}{employee.designation ? ` · ${employee.designation}` : ""} · {employee.workload} open jobs</option>)}
                </select>
                <label>Scheduled start<input type="datetime-local" value={scheduledAt} style={inputStyle} onChange={(event) => setScheduledAt(event.target.value)} /></label>
                <label>Appointment end<input type="datetime-local" value={appointmentEndsAt} style={inputStyle} onChange={(event) => setAppointmentEndsAt(event.target.value)} /></label>
                <label>Planned visit order (optional)<input type="number" min="1" max="1000" value={visitOrder} style={inputStyle} onChange={(event) => setVisitOrder(event.target.value)} /></label>
                {assignmentChangesTechnician && selected.assignedTo != null && <label>Reason for reassignment<input required maxLength={500} value={reassignmentReason} style={inputStyle} onChange={(event) => setReassignmentReason(event.target.value)} /></label>}
                <button disabled={saving || !technicianId || (assignmentChangesTechnician && outstandingMaterials > 0) || (assignmentChangesTechnician && selected.assignedTo != null && !reassignmentReason.trim())} style={button}>Save assignment</button>
                {selected.assignedTo && <button type="button" disabled={saving} style={button} onClick={() => void perform(`/field-jobs/${selected.id}/unassign`, "PATCH", undefined, "Technician unassigned.")}>Unassign</button>}
              </form>
            )}

            {canActOnSelectedJob && (
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {selected.status === "ASSIGNED" && !selected.arrivedAt && options?.canLocation && <>
                  <button disabled={saving} style={button} onClick={() => recordLocation("CHECK_IN")}>Capture location and check in</button>
                  <button disabled={saving} style={button} onClick={() => void perform(`/field-jobs/${selected.id}/location/check-in`, "PATCH", { status: "NOT_REQUESTED" }, "Check-in recorded without location.")}>Check in without requesting location</button>
                </>}
                {selected.status === "ASSIGNED" && !selected.arrivedAt && !options?.canLocation &&
                  <button disabled={saving} style={button} onClick={() => void perform(`/field-jobs/${selected.id}/arrive`, "PATCH", {}, "Arrival recorded.")}>Record arrival</button>}
                {selected.status === "ASSIGNED" && selected.arrivedAt && <button disabled={saving} style={button} onClick={() => void perform(`/field-jobs/${selected.id}/start`, "PATCH", {}, "Work started.")}>Start work</button>}
                {selected.status === "IN_PROGRESS" && <>
                  {options?.canLocation && <div style={{ flexBasis: "100%", display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" disabled={saving} style={button} onClick={() => recordLocation("CHECK_OUT")}>Capture check-out location</button>
                    <button type="button" disabled={saving} style={button} onClick={() => void perform(`/field-jobs/${selected.id}/location/check-out`, "PATCH", { status: "NOT_REQUESTED" }, "Check-out recorded without requesting location.")}>Record check-out without location</button>
                    {selected.visits[0]?.checkOutLocationStatus && <small role="status">Check-out location outcome: {selected.visits[0].checkOutLocationStatus}</small>}
                  </div>}
                  <label style={{ flex: "1 1 100%" }}>Work notes<textarea maxLength={5000} value={completionNotes} style={{ ...inputStyle, minHeight: 60 }} onChange={(event) => setCompletionNotes(event.target.value)} /></label>
                  <label>Resolution<textarea maxLength={3000} value={resolution} style={inputStyle} onChange={(event) => setResolution(event.target.value)} /></label>
                  <label>Next action<textarea maxLength={2000} value={nextAction} style={inputStyle} onChange={(event) => setNextAction(event.target.value)} /></label>
                  {options?.canLocation && <small style={{ flexBasis: "100%", color: "var(--muted)" }}>Location is optional. The browser requests permission only after a button press; completion is still available if location is denied or unavailable.</small>}
                  <button disabled={saving} style={button} onClick={() => void complete(true)}>Submit for review</button>
                  <button disabled={saving} style={button} onClick={() => void complete(false)}>Record failed visit</button>
                </>}
              </div>
            )}

            {options?.canReview && selected.status === "PENDING_REVIEW" && <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {outstandingMaterials > 0 && <p role="status" style={{ color: "var(--muted)", flexBasis: "100%", margin: 0 }}>Resolve {outstandingMaterials} reserved or issued material item(s) before approving closure.</p>}
              <button disabled={saving || outstandingMaterials > 0} style={button} onClick={() => void perform(`/field-jobs/${selected.id}/review`, "PATCH", { approved: true }, "Completion approved.")}>Approve completion</button>
              <button disabled={saving} style={button} onClick={() => {
                const reason = window.prompt("Reason for rejecting completion");
                if (reason?.trim()) void perform(`/field-jobs/${selected.id}/review`, "PATCH", { approved: false, reason }, "Completion rejected.");
              }}>Reject completion</button>
            </div>}

            {selected.status !== "COMPLETED" && selected.status !== "CANCELLED" && options?.canDispatch && <>
              {selected.issuedMaterialCount > 0 && <p role="status" style={{ color: "var(--muted)", margin: 0 }}>Return or report issued materials before cancelling this job. Reservations will be released as part of cancellation.</p>}
              <button disabled={saving || selected.issuedMaterialCount > 0} style={button} onClick={() => void cancel()}>Cancel job</button>
            </>}

            {canActOnSelectedJob && ["ASSIGNED", "IN_PROGRESS"].includes(selected.status) && <form onSubmit={updateChecklist} style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "grid", gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Checklist (JSON)</h3>
              <textarea aria-label="Checklist JSON" value={checklistJson} onChange={(event) => setChecklistJson(event.target.value)} style={{ ...inputStyle, minHeight: 95, fontFamily: "monospace" }} placeholder='[{"label":"Signal checked","done":true}]' />
              <button disabled={saving} style={button}>Save checklist</button>
            </form>}

            {canActOnSelectedJob && ["ASSIGNED", "IN_PROGRESS"].includes(selected.status) && <form onSubmit={requestAssistance} style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "grid", gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Request assistance</h3>
              <textarea aria-label="Assistance request" maxLength={1000} required value={assistanceDetail} onChange={(event) => setAssistanceDetail(event.target.value)} style={{ ...inputStyle, minHeight: 75 }} />
              <button disabled={saving || !assistanceDetail.trim()} style={button}>Record assistance request</button>
            </form>}

            {options?.canEvidence && ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW"].includes(selected.status) && <form onSubmit={uploadEvidence} style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "grid", gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Private photo evidence</h3>
              <small style={{ color: "var(--muted)" }}>Images only · maximum 8 MB each · stored privately and attributed to the uploader.</small>
              <select aria-label="Evidence category" value={evidenceType} style={inputStyle} onChange={(event) => setEvidenceType(event.target.value as (typeof EVIDENCE_TYPES)[number])}>
                {EVIDENCE_TYPES.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}
              </select>
              <input aria-label="Evidence photo" required type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif" onChange={(event) => setEvidenceFile(event.target.files?.[0] ?? null)} />
              <input aria-label="Technician evidence note" maxLength={500} value={evidenceNote} style={inputStyle} placeholder="Equipment, serial number, or work note" onChange={(event) => setEvidenceNote(event.target.value)} />
              <button disabled={saving || !evidenceFile} style={button}>{saving ? "Uploading evidence…" : "Upload private photo"}</button>
            </form>}
            <section style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Photo evidence</h3>
              {selected.attachments.length ? <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 8 }}>
                {selected.attachments.map((attachment) => <article key={attachment.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 7 }}>
                  {mediaToken ? <a href={`${API}/uploads/${encodeURIComponent(attachment.filename)}?mt=${encodeURIComponent(mediaToken)}`} target="_blank" rel="noreferrer">
                    <img alt={`${attachment.evidenceType.replaceAll("_", " ")} evidence`} src={`${API}/uploads/${encodeURIComponent(attachment.filename)}?mt=${encodeURIComponent(mediaToken)}`} style={{ width: "100%", height: 110, objectFit: "cover", borderRadius: 5 }} />
                  </a> : <span role="status">Loading private preview…</span>}
                  <strong style={{ display: "block", fontSize: 11 }}>{attachment.evidenceType.replaceAll("_", " ")}</strong>
                  {attachment.note && <small>{attachment.note}</small>}
                  <small style={{ display: "block", color: "var(--muted)" }}>{attachment.uploader?.name || "Uploader unavailable"} · {formatDate(attachment.createdAt)}</small>
                </article>)}
              </div> : <p style={{ color: "var(--muted)", fontSize: 13 }}>No photo evidence has been attached.</p>}
            </section>

            {options?.canMaterials && <form onSubmit={moveMaterial} style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "grid", gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Inventory movement</h3>
              <select aria-label="Inventory action" value={materialAction} style={inputStyle} onChange={(event) => {
                setMaterialAction(event.target.value as (typeof MATERIAL_ACTIONS)[number]);
                setMaterialItemId("");
                setMaterialIdempotencyKey(null);
              }}>
                {MATERIAL_ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}
              </select>
              <select aria-label="Inventory item" required value={materialItemId} style={inputStyle} onChange={(event) => {
                setMaterialItemId(event.target.value);
                setMaterialIdempotencyKey(null);
              }}>
                <option value="">Select a material</option>
                {materialChoices.map(({ item, custody }) => <option key={`${custody}-${item.id}`} value={item.id}>
                  {custody} · #{item.id} · {item.serialNumber} · {item.type} · {item.status} · owner {item.ownerId ?? "unassigned"}
                </option>)}
              </select>
              <input aria-label="Material movement notes" maxLength={1000} value={materialNotes} style={inputStyle} placeholder="Movement notes (optional)" onChange={(event) => setMaterialNotes(event.target.value)} />
              <button disabled={saving || !materialItemId || !materialChoices.some(({ item }) => item.id === Number(materialItemId))} style={button}>
                {saving ? "Recording material movement…" : "Record material movement"}
              </button>
              {!materialChoices.length && <p role="status" style={{ color: "var(--muted)", margin: 0 }}>No items are currently eligible for {materialAction.toLowerCase()}.</p>}
            </form>}

            {options?.canMaterials && <section style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Current material custody</h3>
              {[...selected.reservedInventoryItems.map((item) => ({ item, custody: "Reserved" })), ...selected.issuedInventoryItems.map((item) => ({ item, custody: "Issued" }))].length
                ? <div style={{ display: "grid", gap: 7 }}>
                    {[...selected.reservedInventoryItems.map((item) => ({ item, custody: "Reserved" })), ...selected.issuedInventoryItems.map((item) => ({ item, custody: "Issued" }))].map(({ item, custody }) => <div key={`${custody}-${item.id}`} style={{ fontSize: 12, borderLeft: "2px solid var(--border)", paddingLeft: 9 }}>
                      <strong>{custody} · #{item.id} · {item.serialNumber}</strong>
                      <div>{item.type} · {item.status} · owner {item.ownerId ?? "unassigned"} · updated {formatDate(item.updatedAt ?? null)}</div>
                    </div>)}
                  </div>
                : <p style={{ color: "var(--muted)", fontSize: 13 }}>No materials are reserved or issued to this job.</p>}
            </section>}

            <section style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Material history</h3>
              {selected.inventoryMovements.length ? <div style={{ display: "grid", gap: 7 }}>
                {selected.inventoryMovements.map((move) => <div key={move.id} style={{ fontSize: 12, borderLeft: "2px solid var(--border)", paddingLeft: 9 }}>
                  <strong>{move.movementType} · #{move.itemId} · {move.item.serialNumber}</strong>
                  <div>{move.fromStatus || "—"} → {move.toStatus} · {move.item.status} · {move.employee?.name || "Employee unavailable"} · {formatDate(move.createdAt)}</div>
                  {move.byUserId != null && <div>Recorded by user #{move.byUserId}</div>}
                  {move.notes && <div>{move.notes}</div>}
                </div>)}
              </div> : <p style={{ color: "var(--muted)", fontSize: 13 }}>No materials have been moved for this job.</p>}
            </section>

            <section style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Visits</h3>
              {selected.visits.map((visit) => <div key={visit.id} style={{ fontSize: 12, marginBottom: 8 }}>
                <strong>Visit {visit.visitNumber} · {visit.outcome || "Open"}</strong>
                <div>{visit.technician?.name || "Technician"} · Arrived {formatDate(visit.arrivedAt)} · Started {formatDate(visit.startedAt)} · Completed {formatDate(visit.completedAt)}</div>
                <div>Check-in: {visit.checkInLocationStatus || "not captured"}
                  {visit.checkInLatitude != null && visit.checkInLongitude != null ? ` · ${visit.checkInLatitude}, ${visit.checkInLongitude}${visit.checkInAccuracy != null ? ` ±${visit.checkInAccuracy}m` : ""}` : ""}
                  {visit.checkInCapturedAt ? ` · ${formatDate(visit.checkInCapturedAt)}` : ""}
                </div>
                <div>Check-out: {visit.checkOutLocationStatus || "not captured"}
                  {visit.checkOutLatitude != null && visit.checkOutLongitude != null ? ` · ${visit.checkOutLatitude}, ${visit.checkOutLongitude}${visit.checkOutAccuracy != null ? ` ±${visit.checkOutAccuracy}m` : ""}` : ""}
                  {visit.checkOutCapturedAt ? ` · ${formatDate(visit.checkOutCapturedAt)}` : ""}
                </div>
                {visit.notes && <div>{visit.notes}</div>}{visit.nextAction && <div>Next: {visit.nextAction}</div>}
              </div>)}
            </section>

            <section style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Activity</h3>
              {selected.activities.map((activity) => <div key={activity.id} style={{ borderLeft: "2px solid var(--border)", paddingLeft: 9, marginBottom: 8 }}>
                <strong style={{ fontSize: 12 }}>{activity.action.replaceAll("_", " ")}</strong>
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{activity.detail}</div>
                <small style={{ color: "var(--muted)" }}>{activity.actor?.name || "System"} · {formatDate(activity.createdAt)}</small>
              </div>)}
            </section>
            {options?.canCreate && selected.status !== "COMPLETED" && selected.status !== "CANCELLED" && <button style={button} onClick={() => startEdit(selected)}>Edit job</button>}
            {options?.canDelete && selected.status === "PENDING" && <button disabled={saving} style={button} onClick={() => {
              if (window.confirm("Delete this unassigned pending field job?")) void perform(`/field-jobs/${selected.id}`, "DELETE", undefined, "Field job deleted.");
            }}>Delete pending job</button>}
          </aside>
        )}
      </section>
    </main>
  );
}
