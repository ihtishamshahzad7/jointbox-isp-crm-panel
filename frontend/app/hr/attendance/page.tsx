"use client";

import React from "react";
import useSWR from "swr";
import API from "../../components/api";

type AttendanceStatus =
  | "PRESENT"
  | "ABSENT"
  | "LATE"
  | "HALF_DAY"
  | "APPROVED_LEAVE"
  | "CANCELLED_LEAVE";

type Employee = {
  id: number;
  employeeNumber: string;
  name: string;
  department: string | null;
};

type Attendance = {
  id: number;
  employeeId: number;
  attendanceDate: string;
  status: AttendanceStatus;
  leaveRequestId?: number | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  durationMinutes: number | null;
  employee: Employee;
};

type AttendanceResponse = {
  items: Attendance[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    total: number;
    checkedIn: number;
    checkedOut: number;
    durationMinutes: number;
    statusCounts: Record<AttendanceStatus, number>;
  };
};

type Correction = {
  id: number;
  reason: string;
  previousStatus: AttendanceStatus;
  newStatus: AttendanceStatus;
  previousCheckInAt: string | null;
  newCheckInAt: string | null;
  previousCheckOutAt: string | null;
  newCheckOutAt: string | null;
  createdAt: string;
  actor: { id: number; name: string } | null;
};

const STATUSES: AttendanceStatus[] = [
  "PRESENT",
  "ABSENT",
  "LATE",
  "HALF_DAY",
  "APPROVED_LEAVE",
  "CANCELLED_LEAVE",
];
const CORRECTION_STATUSES = STATUSES.filter(
  (status) => status !== "CANCELLED_LEAVE",
);
const PAGE_SIZE = 50;

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
    if (response.status === 403) message = `Permission denied: ${message}`;
    throw new Error(message);
  }
  return body;
}

function isEmployee(value: unknown): value is Employee {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "number" &&
    "employeeNumber" in value &&
    typeof value.employeeNumber === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "department" in value &&
    (typeof value.department === "string" || value.department === null)
  );
}

async function loadEmployees(path: string): Promise<Employee[]> {
  const response = await request(path);
  if (!Array.isArray(response) || !response.every(isEmployee)) {
    throw new Error("Invalid employee profile response.");
  }
  return response;
}

async function loadAttendance(path: string): Promise<AttendanceResponse> {
  const response = await request(path);
  if (
    typeof response !== "object" ||
    response === null ||
    !("items" in response) ||
    !Array.isArray(response.items) ||
    !("summary" in response) ||
    typeof response.summary !== "object" ||
    response.summary === null ||
    !("total" in response)
  ) {
    throw new Error("Invalid attendance response.");
  }
  return response as AttendanceResponse;
}

function todayInPakistan(): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateTimeLocal(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function displayDuration(value: number | null): string {
  if (value == null) return "—";
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${hours}h ${minutes}m`;
}

export default function AttendancePage() {
  const [dateFrom, setDateFrom] = React.useState(todayInPakistan);
  const [dateTo, setDateTo] = React.useState(todayInPakistan);
  const [department, setDepartment] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [employeeFilter, setEmployeeFilter] = React.useState("");
  const [employeeForPunch, setEmployeeForPunch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [correctionRecord, setCorrectionRecord] =
    React.useState<Attendance | null>(null);
  const [correctionStatus, setCorrectionStatus] =
    React.useState<AttendanceStatus>("PRESENT");
  const [correctionIn, setCorrectionIn] = React.useState("");
  const [correctionOut, setCorrectionOut] = React.useState("");
  const [correctionReason, setCorrectionReason] = React.useState("");
  const [historyRecord, setHistoryRecord] = React.useState<number | null>(null);
  const [history, setHistory] = React.useState<Correction[]>([]);

  const { data: employees, error: employeeError } = useSWR<Employee[], Error>(
    "/hr/employees",
    loadEmployees,
  );
  const attendancePath = React.useMemo(() => {
    const params = new URLSearchParams({
      dateFrom,
      dateTo,
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    if (department.trim()) params.set("department", department.trim());
    if (status) params.set("status", status);
    if (employeeFilter) params.set("employeeId", employeeFilter);
    return `/hr/attendance?${params.toString()}`;
  }, [dateFrom, dateTo, page, department, status, employeeFilter]);
  const {
    data: attendance,
    error: attendanceError,
    mutate,
  } = useSWR<AttendanceResponse, Error>(attendancePath, loadAttendance);

  async function punch(action: "check-in" | "check-out") {
    if (!employeeForPunch) {
      setError("Select an employee before recording attendance.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await request(
        `/hr/attendance/employees/${employeeForPunch}/${action}`,
        { method: "POST" },
      );
      await mutate();
      setNotice(action === "check-in" ? "Check-in recorded." : "Check-out recorded.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  function beginCorrection(record: Attendance) {
    setCorrectionRecord(record);
    setCorrectionStatus(record.status);
    setCorrectionIn(dateTimeLocal(record.checkInAt));
    setCorrectionOut(dateTimeLocal(record.checkOutAt));
    setCorrectionReason("");
    setError("");
    setNotice("");
  }

  async function saveCorrection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!correctionRecord) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await request(`/hr/attendance/${correctionRecord.id}/correction`, {
        method: "PATCH",
        body: JSON.stringify({
          status: correctionStatus,
          checkInAt: correctionIn
            ? new Date(correctionIn).toISOString()
            : null,
          checkOutAt: correctionOut
            ? new Date(correctionOut).toISOString()
            : null,
          reason: correctionReason,
        }),
      });
      setCorrectionRecord(null);
      await mutate();
      setNotice("Attendance correction saved to the history.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function showHistory(record: Attendance) {
    setHistoryRecord(record.id);
    setError("");
    try {
      const response = await request(
        `/hr/attendance/${record.id}/history`,
      );
      if (
        typeof response !== "object" ||
        response === null ||
        !("items" in response) ||
        !Array.isArray(response.items)
      ) {
        throw new Error("Invalid correction history response.");
      }
      setHistory(response.items as Correction[]);
    } catch (reason) {
      setHistoryRecord(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const totalPages = Math.max(
    1,
    Math.ceil((attendance?.total ?? 0) / PAGE_SIZE),
  );
  const pageError = attendanceError || employeeError;

  return (
    <main style={{ padding: 24, color: "var(--text)" }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>Attendance</h1>
        <p style={{ color: "var(--muted)" }}>
          Recorded check-ins and check-outs use server timestamps. Missing events
          are never inferred. Approved leave is linked from Leave Management
          without fabricating check-in or check-out events.
        </p>
      </header>

      {(error || pageError) && (
        <p role="alert" style={{ color: "var(--danger, #b42318)" }}>
          {error || pageError?.message}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}

      <section
        aria-label="Record attendance"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "end",
          gap: 12,
          padding: 16,
          marginBottom: 20,
          border: "1px solid var(--border)",
          borderRadius: 10,
        }}
      >
        <label>
          Employee
          <select
            value={employeeForPunch}
            onChange={(event) => setEmployeeForPunch(event.target.value)}
          >
            <option value="">Select employee</option>
            {(employees || []).map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.employeeNumber} — {employee.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={saving || !employeeForPunch}
          onClick={() => void punch("check-in")}
        >
          Check in
        </button>
        <button
          type="button"
          disabled={saving || !employeeForPunch}
          onClick={() => void punch("check-out")}
        >
          Check out
        </button>
      </section>

      <section
        aria-label="Attendance filters"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <label>
          From
          <input
            type="date"
            value={dateFrom}
            onChange={(event) => {
              setDateFrom(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={dateTo}
            onChange={(event) => {
              setDateTo(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          Employee
          <select
            value={employeeFilter}
            onChange={(event) => {
              setEmployeeFilter(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All employees</option>
            {(employees || []).map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Department
          <input
            maxLength={80}
            value={department}
            onChange={(event) => {
              setDepartment(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replace("_", " ")}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section
        aria-label="Attendance summary"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 12,
          marginBottom: 20,
        }}
      >
        {[
          ["Records", attendance?.summary.total ?? 0],
          ["Checked in", attendance?.summary.checkedIn ?? 0],
          ["Checked out", attendance?.summary.checkedOut ?? 0],
          [
            "Recorded time",
            displayDuration(attendance?.summary.durationMinutes ?? null),
          ],
          ...STATUSES.map((value) => [
            value.replace("_", " "),
            attendance?.summary.statusCounts[value] ?? 0,
          ]),
        ].map(([label, value]) => (
          <div
            key={String(label)}
            style={{
              padding: 16,
              border: "1px solid var(--border)",
              borderRadius: 10,
            }}
          >
            <div style={{ color: "var(--muted)", fontSize: 13 }}>{label}</div>
            <strong style={{ fontSize: 20 }}>{value}</strong>
          </div>
        ))}
      </section>

      {attendance ? (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th align="left">Date</th>
                  <th align="left">Employee</th>
                  <th align="left">Department</th>
                  <th align="left">Status</th>
                  <th align="left">Check in</th>
                  <th align="left">Check out</th>
                  <th align="left">Duration</th>
                  <th align="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {attendance.items.map((record) => (
                  <tr key={record.id}>
                    <td>{record.attendanceDate.slice(0, 10)}</td>
                    <td>
                      {record.employee.employeeNumber} — {record.employee.name}
                    </td>
                    <td>{record.employee.department || "—"}</td>
                    <td>{record.status.replace("_", " ")}</td>
                    <td>
                      {record.checkInAt
                        ? new Date(record.checkInAt).toLocaleTimeString()
                        : "—"}
                    </td>
                    <td>
                      {record.checkOutAt
                        ? new Date(record.checkOutAt).toLocaleTimeString()
                        : "—"}
                    </td>
                    <td>{displayDuration(record.durationMinutes)}</td>
                    <td align="right">
                      {!record.leaveRequestId &&
                        record.status !== "CANCELLED_LEAVE" && (
                          <button
                            type="button"
                            onClick={() => beginCorrection(record)}
                          >
                            Correct
                          </button>
                        )}{" "}
                      <button
                        type="button"
                        onClick={() => void showHistory(record)}
                      >
                        History
                      </button>
                    </td>
                  </tr>
                ))}
                {attendance.items.length === 0 && (
                  <tr>
                    <td colSpan={8}>No recorded attendance for this filter.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <nav
            aria-label="Attendance pages"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: 16,
            }}
          >
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
            >
              Previous
            </button>
            <span>
              Page {page} of {totalPages} ({attendance.total} records)
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </button>
          </nav>
        </>
      ) : !pageError ? (
        <p>Loading attendance…</p>
      ) : null}

      {correctionRecord && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="attendance-correction-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "grid",
            placeItems: "center",
            padding: 16,
            background: "rgba(0,0,0,.45)",
          }}
        >
          <form
            onSubmit={saveCorrection}
            style={{
              display: "grid",
              gap: 12,
              width: "min(100%, 520px)",
              padding: 20,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
            }}
          >
            <h2 id="attendance-correction-title" style={{ margin: 0 }}>
              Correct attendance
            </h2>
            <label>
              Status
              <select
                value={correctionStatus}
                onChange={(event) => {
                  const next = event.target.value as AttendanceStatus;
                  setCorrectionStatus(next);
                  if (next === "ABSENT" || next === "APPROVED_LEAVE") {
                    setCorrectionIn("");
                    setCorrectionOut("");
                  }
                }}
              >
                {CORRECTION_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value.replace("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Check-in time
              <input
                type="datetime-local"
                value={correctionIn}
                onChange={(event) => setCorrectionIn(event.target.value)}
              />
            </label>
            <label>
              Check-out time
              <input
                type="datetime-local"
                value={correctionOut}
                onChange={(event) => setCorrectionOut(event.target.value)}
              />
            </label>
            <label>
              Reason
              <textarea
                required
                maxLength={500}
                value={correctionReason}
                onChange={(event) => setCorrectionReason(event.target.value)}
              />
            </label>
            <div style={{ display: "flex", justifyContent: "end", gap: 8 }}>
              <button
                type="button"
                onClick={() => setCorrectionRecord(null)}
              >
                Cancel
              </button>
              <button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save correction"}
              </button>
            </div>
          </form>
        </div>
      )}

      {historyRecord !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Attendance correction history"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1001,
            display: "grid",
            placeItems: "center",
            padding: 16,
            background: "rgba(0,0,0,.45)",
          }}
        >
          <section
            style={{
              width: "min(100%, 620px)",
              maxHeight: "80vh",
              overflow: "auto",
              padding: 20,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
            }}
          >
            <h2>Correction history</h2>
            {history.length ? (
              history.map((change) => (
                <article
                  key={change.id}
                  style={{
                    padding: 12,
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <strong>
                    {change.previousStatus.replace("_", " ")} →{" "}
                    {change.newStatus.replace("_", " ")}
                  </strong>
                  <p>{change.reason}</p>
                  <small>
                    {change.actor?.name || "Former user"} ·{" "}
                    {new Date(change.createdAt).toLocaleString()}
                  </small>
                </article>
              ))
            ) : (
              <p>No corrections have been recorded.</p>
            )}
            <button type="button" onClick={() => setHistoryRecord(null)}>
              Close
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
