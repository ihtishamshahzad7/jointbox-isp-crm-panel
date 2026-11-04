"use client";

import React from "react";
import useSWR from "swr";
import API from "../../components/api";

type Employee = {
  id: number;
  employeeNumber: string;
  name: string;
  department: string | null;
  designation: string | null;
  hiredAt: string | null;
  status: "ACTIVE" | "ON_LEAVE" | "INACTIVE";
};

type Draft = {
  employeeNumber: string;
  name: string;
  department: string;
  designation: string;
  hiredAt: string;
  status: Employee["status"];
};

const EMPTY_DRAFT: Draft = {
  employeeNumber: "",
  name: "",
  department: "",
  designation: "",
  hiredAt: "",
  status: "ACTIVE",
};

async function request(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const token =
    typeof window === "undefined" ? "" : localStorage.getItem("token") || "";
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: ["Bearer", token].join(" "),
      ...(init?.headers || {}),
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    if (body && typeof body === "object" && "message" in body) {
      const candidate = body.message;
      if (typeof candidate === "string") message = candidate;
    }
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
    (typeof value.department === "string" || value.department === null) &&
    "designation" in value &&
    (typeof value.designation === "string" || value.designation === null) &&
    "hiredAt" in value &&
    (typeof value.hiredAt === "string" || value.hiredAt === null) &&
    "status" in value &&
    (value.status === "ACTIVE" ||
      value.status === "ON_LEAVE" ||
      value.status === "INACTIVE")
  );
}

async function loadEmployees(path: string): Promise<Employee[]> {
  const response = await request(path);
  if (!Array.isArray(response) || !response.every(isEmployee)) {
    throw new Error("Invalid employee profile response.");
  }
  return response;
}

export default function EmployeesPage() {
  const {
    data: employees,
    error: loadError,
    mutate,
  } = useSWR<Employee[], Error>("/hr/employees", loadEmployees);
  const [draft, setDraft] = React.useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = React.useState<number | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");

  function edit(employee: Employee) {
    setEditingId(employee.id);
    setDraft({
      employeeNumber: employee.employeeNumber,
      name: employee.name,
      department: employee.department || "",
      designation: employee.designation || "",
      hiredAt: employee.hiredAt?.slice(0, 10) || "",
      status: employee.status,
    });
    setError("");
    setNotice("");
  }

  function reset() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await request(
        editingId == null
          ? "/hr/employees"
          : `/hr/employees/${editingId}`,
        {
          method: editingId == null ? "POST" : "PATCH",
          body: JSON.stringify({
            ...draft,
            hiredAt: draft.hiredAt || null,
          }),
        },
      );
      await mutate();
      reset();
      setNotice(editingId == null ? "Employee profile created." : "Employee profile updated.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function remove(employee: Employee) {
    if (!window.confirm(`Delete ${employee.name}'s profile?`)) return;
    setError("");
    setNotice("");
    try {
      await request(`/hr/employees/${employee.id}`, { method: "DELETE" });
      await mutate();
      setNotice("Employee profile deleted.");
      if (editingId === employee.id) reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <main style={{ padding: 24, color: "var(--text)" }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>Employee Profiles</h1>
        <p style={{ color: "var(--muted)" }}>
          Company-scoped HR profiles. Employee login accounts remain in Uplinko
          Users; this module does not create authentication accounts.
        </p>
      </header>

      {(error || loadError) && (
        <p role="alert" style={{ color: "var(--danger, #b42318)" }}>
          {error || loadError?.message}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}

      <form
        onSubmit={save}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
          padding: 16,
          marginBottom: 24,
          border: "1px solid var(--border)",
          borderRadius: 10,
        }}
      >
        <label>
          Employee number
          <input
            required
            maxLength={40}
            value={draft.employeeNumber}
            onChange={(event) =>
              setDraft({ ...draft, employeeNumber: event.target.value })
            }
          />
        </label>
        <label>
          Name
          <input
            required
            maxLength={120}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        <label>
          Department
          <input
            maxLength={80}
            value={draft.department}
            onChange={(event) =>
              setDraft({ ...draft, department: event.target.value })
            }
          />
        </label>
        <label>
          Designation
          <input
            maxLength={80}
            value={draft.designation}
            onChange={(event) =>
              setDraft({ ...draft, designation: event.target.value })
            }
          />
        </label>
        <label>
          Hire date
          <input
            type="date"
            value={draft.hiredAt}
            onChange={(event) => setDraft({ ...draft, hiredAt: event.target.value })}
          />
        </label>
        <label>
          Status
          <select
            value={draft.status}
            onChange={(event) =>
              setDraft({
                ...draft,
                status: event.target.value as Employee["status"],
              })
            }
          >
            <option value="ACTIVE">Active</option>
            <option value="ON_LEAVE">On leave</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </label>
        <div style={{ display: "flex", gap: 8, alignItems: "end" }}>
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : editingId == null ? "Add employee" : "Save changes"}
          </button>
          {editingId != null && (
            <button type="button" onClick={reset}>
              Cancel
            </button>
          )}
        </div>
      </form>

      {employees ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th align="left">Employee #</th>
                <th align="left">Name</th>
                <th align="left">Department</th>
                <th align="left">Designation</th>
                <th align="left">Hire date</th>
                <th align="left">Status</th>
                <th align="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((employee) => (
                <tr key={employee.id}>
                  <td>{employee.employeeNumber}</td>
                  <td>{employee.name}</td>
                  <td>{employee.department || "—"}</td>
                  <td>{employee.designation || "—"}</td>
                  <td>
                    {employee.hiredAt
                      ? new Date(employee.hiredAt).toLocaleDateString()
                      : "—"}
                  </td>
                  <td>{employee.status.replace("_", " ")}</td>
                  <td align="right">
                    <button type="button" onClick={() => edit(employee)}>
                      Edit
                    </button>{" "}
                    <button type="button" onClick={() => void remove(employee)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {employees.length === 0 && (
                <tr>
                  <td colSpan={7}>No employee profiles yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : !loadError ? (
        <p>Loading employee profiles…</p>
      ) : null}
    </main>
  );
}
