"use client";

import React from "react";
import useSWR from "swr";
import API from "../../components/api";

type LeaveType = {
  id: number;
  name: string;
  description: string | null;
  isPaid: boolean;
  annualAllocationDays: number | string | null;
  isActive: boolean;
};

type LeaveRequest = {
  id: number;
  employeeId: number;
  leaveTypeId: number;
  leaveDates: string[];
  requestedDays: number;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  decisionComment: string | null;
  submittedAt: string;
  employee: { id: number; name: string; department: string | null };
  leaveType: { id: number; name: string; isPaid: boolean };
};

type LeaveRequestPage = {
  items: LeaveRequest[];
  total: number;
};

type LeaveBalance = {
  id: number;
  employeeId: number;
  leaveTypeId: number;
  periodYear: number;
  allocatedDays: number | string;
  adjustmentDays: number | string;
  usedDays: number | string;
  employee: { id: number; name: string; department: string | null };
  leaveType: { id: number; name: string; isPaid: boolean };
};

type LeaveAccess = {
  canWrite: boolean;
  canApprove: boolean;
  canManageTypes: boolean;
  canManageBalances: boolean;
};

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

function tomorrowInPakistan(): string {
  const date = new Date(`${todayInPakistan()}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function dateRange(start: string, end: string): string[] {
  if (!start || !end || start > end) return [];
  const first = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  const days = Math.floor((last.getTime() - first.getTime()) / 86_400_000) + 1;
  if (days > 366) return [];
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(first.getTime() + index * 86_400_000);
    return date.toISOString().slice(0, 10);
  });
}

function amount(value: number | string): number {
  return Number(value);
}

function statusColor(status: LeaveRequest["status"]): string {
  if (status === "APPROVED") return "#18794e";
  if (status === "REJECTED" || status === "CANCELLED") return "#b42318";
  return "#9a6700";
}

export default function LeavePage() {
  const [tab, setTab] = React.useState<
    "request" | "mine" | "approvals" | "balances" | "types"
  >("request");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [excludedDates, setExcludedDates] = React.useState<string[]>([]);
  const [leaveTypeId, setLeaveTypeId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [newTypeName, setNewTypeName] = React.useState("");
  const [newTypeDescription, setNewTypeDescription] = React.useState("");
  const [newTypePaid, setNewTypePaid] = React.useState(false);
  const [newTypeAllocation, setNewTypeAllocation] = React.useState("");
  const [allocationEmployee, setAllocationEmployee] = React.useState("");
  const [allocationType, setAllocationType] = React.useState("");
  const [allocationYear, setAllocationYear] = React.useState(
    String(new Date().getFullYear()),
  );
  const [allocationDays, setAllocationDays] = React.useState("");
  const [balanceReason, setBalanceReason] = React.useState("");
  const [adjustingBalance, setAdjustingBalance] =
    React.useState<LeaveBalance | null>(null);
  const [adjustmentDays, setAdjustmentDays] = React.useState("");
  const [adjustmentReason, setAdjustmentReason] = React.useState("");
  const [history, setHistory] = React.useState<unknown[] | null>(null);

  const accessState = useSWR<LeaveAccess, Error>(
    "/hr/leave/access",
    (path: string) => request(path) as Promise<LeaveAccess>,
  );
  const access = accessState.data;
  const typesState = useSWR<LeaveType[], Error>(
    access ? "/hr/leave/types" : null,
    (path: string) => request(path) as Promise<LeaveType[]>,
  );
  const mineState = useSWR<LeaveRequestPage, Error>(
    access ? "/hr/leave/requests/mine?pageSize=100" : null,
    (path: string) => request(path) as Promise<LeaveRequestPage>,
  );
  const approvalsState = useSWR<LeaveRequestPage, Error>(
    access?.canApprove
      ? "/hr/leave/requests?status=PENDING&pageSize=100"
      : null,
    (path: string) => request(path) as Promise<LeaveRequestPage>,
  );
  const balancesState = useSWR<LeaveBalance[], Error>(
    tab === "balances" ? "/hr/leave/balances" : null,
    (path: string) => request(path) as Promise<LeaveBalance[]>,
  );

  const dates = React.useMemo(
    () => dateRange(startDate, endDate),
    [startDate, endDate],
  );
  const selectedDates = dates.filter((date) => !excludedDates.includes(date));
  const types = typesState.data ?? [];
  const activeTypes = types.filter((type) => type.isActive);
  const pageError =
    accessState.error ||
    typesState.error ||
    mineState.error ||
    approvalsState.error ||
    (tab === "balances" ? balancesState.error : undefined);

  function changeRange(field: "start" | "end", value: string) {
    setExcludedDates([]);
    if (field === "start") setStartDate(value);
    else setEndDate(value);
  }

  async function submitRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDates.length || selectedDates.length > 366) {
      setError("Choose at least one valid leave date.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await request("/hr/leave/requests", {
        method: "POST",
        body: JSON.stringify({
          leaveTypeId: Number(leaveTypeId),
          dates: selectedDates,
          reason,
        }),
      });
      setReason("");
      await mineState.mutate();
      setTab("mine");
      setNotice("Leave request submitted for approval.");
    } catch (reasonValue) {
      setError(
        reasonValue instanceof Error
          ? reasonValue.message
          : String(reasonValue),
      );
    } finally {
      setSaving(false);
    }
  }

  async function requestAction(
    requestId: number,
    action: "approve" | "reject" | "cancel",
  ) {
    const comment =
      action === "reject"
        ? window.prompt("Enter the reason for rejection:") || ""
        : action === "cancel"
          ? window.prompt("Optional cancellation note:") || ""
          : window.prompt("Optional approval note:") || "";
    if (action === "reject" && !comment.trim()) {
      setError("A rejection reason is required.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await request(`/hr/leave/requests/${requestId}/${action}`, {
        method: action === "cancel" ? "PATCH" : "POST",
        body: JSON.stringify({ comment }),
      });
      await Promise.all([
        mineState.mutate(),
        approvalsState.mutate(),
        balancesState.mutate(),
      ]);
      setNotice(
        action === "approve"
          ? "Leave request approved."
          : action === "reject"
            ? "Leave request rejected."
            : "Leave request cancelled.",
      );
    } catch (reasonValue) {
      setError(
        reasonValue instanceof Error
          ? reasonValue.message
          : String(reasonValue),
      );
    } finally {
      setSaving(false);
    }
  }

  async function showHistory(requestId: number) {
    setError("");
    try {
      const response = await request(`/hr/leave/requests/${requestId}/history`);
      if (!Array.isArray(response))
        throw new Error("Invalid leave history response.");
      setHistory(response);
    } catch (reasonValue) {
      setError(
        reasonValue instanceof Error
          ? reasonValue.message
          : String(reasonValue),
      );
    }
  }

  async function createType(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await request("/hr/leave/types", {
        method: "POST",
        body: JSON.stringify({
          name: newTypeName,
          description: newTypeDescription,
          isPaid: newTypePaid,
          annualAllocationDays: newTypeAllocation || null,
        }),
      });
      setNewTypeName("");
      setNewTypeDescription("");
      setNewTypeAllocation("");
      await typesState.mutate();
      setNotice("Leave type added.");
    } catch (reasonValue) {
      setError(
        reasonValue instanceof Error
          ? reasonValue.message
          : String(reasonValue),
      );
    } finally {
      setSaving(false);
    }
  }

  async function setTypeActive(type: LeaveType) {
    setSaving(true);
    setError("");
    try {
      await request(`/hr/leave/types/${type.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !type.isActive }),
      });
      await typesState.mutate();
    } catch (reasonValue) {
      setError(
        reasonValue instanceof Error
          ? reasonValue.message
          : String(reasonValue),
      );
    } finally {
      setSaving(false);
    }
  }

  async function allocateBalance(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await request("/hr/leave/balances/allocate", {
        method: "POST",
        body: JSON.stringify({
          employeeId: Number(allocationEmployee),
          leaveTypeId: Number(allocationType),
          year: Number(allocationYear),
          days: Number(allocationDays),
          reason: balanceReason,
        }),
      });
      setAllocationDays("");
      setBalanceReason("");
      await balancesState.mutate();
      setNotice("Explicit leave balance allocated.");
    } catch (reasonValue) {
      setError(
        reasonValue instanceof Error
          ? reasonValue.message
          : String(reasonValue),
      );
    } finally {
      setSaving(false);
    }
  }

  async function adjustBalance(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adjustingBalance) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await request(`/hr/leave/balances/${adjustingBalance.id}/adjust`, {
        method: "PATCH",
        body: JSON.stringify({
          days: Number(adjustmentDays),
          reason: adjustmentReason,
        }),
      });
      setAdjustingBalance(null);
      setAdjustmentDays("");
      setAdjustmentReason("");
      await balancesState.mutate();
      setNotice("Balance adjustment recorded.");
    } catch (reasonValue) {
      setError(
        reasonValue instanceof Error
          ? reasonValue.message
          : String(reasonValue),
      );
    } finally {
      setSaving(false);
    }
  }

  const tabs: Array<{ id: typeof tab; label: string }> = [
    { id: "request", label: "Request leave" },
    { id: "mine", label: "My requests" },
    ...(access?.canApprove
      ? [{ id: "approvals" as const, label: "Approvals" }]
      : []),
    { id: "balances", label: "Balances" },
    ...(access?.canManageTypes
      ? [{ id: "types" as const, label: "Leave types" }]
      : []),
  ];

  return (
    <main style={{ padding: 24, color: "var(--text)" }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>Leave Management</h1>
        <p style={{ color: "var(--muted)" }}>
          Request selected dates, review approvals, and track explicitly
          allocated balances. Leave types and allocations are not created with
          assumed defaults.
        </p>
      </header>

      {(error || pageError) && (
        <p role="alert" style={{ color: "var(--danger, #b42318)" }}>
          {error || pageError?.message}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}

      <nav
        aria-label="Leave sections"
        style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}
      >
        {tabs.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-current={tab === item.id ? "page" : undefined}
            onClick={() => {
              setTab(item.id);
              setError("");
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === "request" && (
        <form
          onSubmit={submitRequest}
          style={{
            display: "grid",
            gap: 14,
            maxWidth: 760,
            padding: 18,
            border: "1px solid var(--border)",
            borderRadius: 12,
          }}
        >
          <h2 style={{ margin: 0 }}>New leave request</h2>
          <label>
            Leave type
            <select
              required
              value={leaveTypeId}
              onChange={(event) => setLeaveTypeId(event.target.value)}
            >
              <option value="">Select a configured leave type</option>
              {activeTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name} {type.isPaid ? "(paid)" : "(unpaid)"}
                </option>
              ))}
            </select>
          </label>
          {activeTypes.length === 0 && (
            <p>
              No active leave types are configured. Ask an administrator to add
              one.
            </p>
          )}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            <label>
              First date
              <input
                type="date"
                required
                min={tomorrowInPakistan()}
                value={startDate}
                onChange={(event) => changeRange("start", event.target.value)}
              />
            </label>
            <label>
              Last date
              <input
                type="date"
                required
                min={startDate || tomorrowInPakistan()}
                value={endDate}
                onChange={(event) => changeRange("end", event.target.value)}
              />
            </label>
          </div>
          {dates.length > 0 && (
            <fieldset
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                gap: 8,
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 12,
              }}
            >
              <legend>Requested days ({selectedDates.length})</legend>
              {dates.map((date) => (
                <label key={date} style={{ display: "flex", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={!excludedDates.includes(date)}
                    onChange={() =>
                      setExcludedDates((current) =>
                        current.includes(date)
                          ? current.filter((value) => value !== date)
                          : [...current, date],
                      )
                    }
                  />
                  {date}
                </label>
              ))}
            </fieldset>
          )}
          {startDate && endDate && dates.length === 0 && (
            <p role="alert">The selected range must not exceed 366 days.</p>
          )}
          <label>
            Reason
            <textarea
              required
              maxLength={1000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={
              saving ||
              !access?.canWrite ||
              !leaveTypeId ||
              selectedDates.length === 0
            }
          >
            {saving ? "Submitting…" : "Submit request"}
          </button>
          {!access?.canWrite && (
            <small>
              Your role does not have permission to submit leave requests.
            </small>
          )}
        </form>
      )}

      {tab === "mine" && (
        <RequestList
          title="My leave requests"
          requests={mineState.data?.items ?? []}
          loading={!mineState.data && !mineState.error}
          saving={saving}
          onAction={requestAction}
          onHistory={showHistory}
          showCancel
        />
      )}

      {tab === "approvals" && access?.canApprove && (
        <RequestList
          title="Department approval queue"
          requests={approvalsState.data?.items ?? []}
          loading={!approvalsState.data && !approvalsState.error}
          saving={saving}
          onAction={requestAction}
          onHistory={showHistory}
          showDecisions
        />
      )}

      {tab === "balances" && (
        <section>
          <h2>Leave balances</h2>
          <p style={{ color: "var(--muted)" }}>
            Approvals require an explicitly created balance for each year
            covered by the selected dates. A leave type&apos;s annual allocation
            is descriptive and is not automatically applied.
          </p>
          {balancesState.data ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th align="left">Employee</th>
                    <th align="left">Leave type</th>
                    <th align="left">Year</th>
                    <th align="right">Allocated</th>
                    <th align="right">Adjustment</th>
                    <th align="right">Used</th>
                    <th align="right">Available</th>
                    {access?.canManageBalances && <th align="right">Action</th>}
                  </tr>
                </thead>
                <tbody>
                  {balancesState.data.map((balance) => {
                    const available =
                      amount(balance.allocatedDays) +
                      amount(balance.adjustmentDays) -
                      amount(balance.usedDays);
                    return (
                      <tr key={balance.id}>
                        <td>{balance.employee.name}</td>
                        <td>{balance.leaveType.name}</td>
                        <td>{balance.periodYear}</td>
                        <td align="right">
                          {amount(balance.allocatedDays).toFixed(2)}
                        </td>
                        <td align="right">
                          {amount(balance.adjustmentDays).toFixed(2)}
                        </td>
                        <td align="right">
                          {amount(balance.usedDays).toFixed(2)}
                        </td>
                        <td align="right">{available.toFixed(2)}</td>
                        {access?.canManageBalances && (
                          <td align="right">
                            <button
                              type="button"
                              onClick={() => setAdjustingBalance(balance)}
                            >
                              Adjust
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {balancesState.data.length === 0 && (
                    <tr>
                      <td colSpan={access?.canManageBalances ? 8 : 7}>
                        No leave balances have been allocated.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : !balancesState.error ? (
            <p>Loading balances…</p>
          ) : null}
          {access?.canManageBalances && (
            <form
              onSubmit={allocateBalance}
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: 12,
                marginTop: 24,
                padding: 16,
                border: "1px solid var(--border)",
                borderRadius: 10,
              }}
            >
              <h3 style={{ gridColumn: "1 / -1", margin: 0 }}>
                Allocate a new employee balance
              </h3>
              <label>
                Employee profile ID
                <input
                  type="number"
                  required
                  min="1"
                  value={allocationEmployee}
                  onChange={(event) =>
                    setAllocationEmployee(event.target.value)
                  }
                />
              </label>
              <label>
                Leave type
                <select
                  required
                  value={allocationType}
                  onChange={(event) => setAllocationType(event.target.value)}
                >
                  <option value="">Select type</option>
                  {activeTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Year
                <input
                  type="number"
                  min="1900"
                  max="2200"
                  required
                  value={allocationYear}
                  onChange={(event) => setAllocationYear(event.target.value)}
                />
              </label>
              <label>
                Days
                <input
                  type="number"
                  min="0"
                  max="366"
                  step="0.01"
                  required
                  value={allocationDays}
                  onChange={(event) => setAllocationDays(event.target.value)}
                />
              </label>
              <label style={{ gridColumn: "1 / -1" }}>
                Allocation reason
                <input
                  required
                  maxLength={500}
                  value={balanceReason}
                  onChange={(event) => setBalanceReason(event.target.value)}
                />
              </label>
              <button type="submit" disabled={saving}>
                Allocate balance
              </button>
            </form>
          )}
        </section>
      )}

      {tab === "types" && access?.canManageTypes && (
        <section>
          <h2>Leave types and policy settings</h2>
          <p style={{ color: "var(--muted)" }}>
            Configure the leave types this company supports. No types or
            balances are seeded automatically.
          </p>
          <form
            onSubmit={createType}
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              padding: 16,
              border: "1px solid var(--border)",
              borderRadius: 10,
            }}
          >
            <label>
              Type name
              <input
                required
                maxLength={80}
                value={newTypeName}
                onChange={(event) => setNewTypeName(event.target.value)}
              />
            </label>
            <label>
              Annual allocation (optional)
              <input
                type="number"
                min="0.01"
                max="366"
                step="0.01"
                value={newTypeAllocation}
                onChange={(event) => setNewTypeAllocation(event.target.value)}
              />
            </label>
            <label>
              Description
              <input
                maxLength={500}
                value={newTypeDescription}
                onChange={(event) => setNewTypeDescription(event.target.value)}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={newTypePaid}
                onChange={(event) => setNewTypePaid(event.target.checked)}
              />
              Paid leave
            </label>
            <button type="submit" disabled={saving}>
              Add leave type
            </button>
          </form>
          <ul>
            {types.map((type) => (
              <li key={type.id} style={{ margin: "12px 0" }}>
                <strong>{type.name}</strong>
                {" — "}
                {type.isPaid ? "Paid" : "Unpaid"}
                {type.annualAllocationDays != null &&
                  ` — suggested annual allocation: ${type.annualAllocationDays} day(s)`}
                {type.description ? ` — ${type.description}` : ""}
                {" — "}
                {type.isActive ? "Active" : "Inactive"}
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void setTypeActive(type)}
                  style={{ marginLeft: 10 }}
                >
                  {type.isActive ? "Deactivate" : "Reactivate"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {adjustingBalance && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="leave-adjustment-title"
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
            onSubmit={adjustBalance}
            style={{
              display: "grid",
              gap: 12,
              width: "min(100%, 480px)",
              padding: 20,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
            }}
          >
            <h2 id="leave-adjustment-title" style={{ margin: 0 }}>
              Adjust {adjustingBalance.employee.name}&apos;s balance
            </h2>
            <p>
              {adjustingBalance.leaveType.name} · {adjustingBalance.periodYear}
            </p>
            <label>
              Adjustment days (positive or negative)
              <input
                type="number"
                required
                step="0.01"
                min="-366"
                max="366"
                value={adjustmentDays}
                onChange={(event) => setAdjustmentDays(event.target.value)}
              />
            </label>
            <label>
              Reason
              <textarea
                required
                maxLength={500}
                value={adjustmentReason}
                onChange={(event) => setAdjustmentReason(event.target.value)}
              />
            </label>
            <div style={{ display: "flex", justifyContent: "end", gap: 8 }}>
              <button type="button" onClick={() => setAdjustingBalance(null)}>
                Close
              </button>
              <button type="submit" disabled={saving}>
                Save adjustment
              </button>
            </div>
          </form>
        </div>
      )}

      {history && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Leave request history"
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
            <h2>Request history</h2>
            <ul>
              {history.map((item, index) => (
                <li key={index}>{JSON.stringify(item)}</li>
              ))}
              {history.length === 0 && <li>No history available.</li>}
            </ul>
            <button type="button" onClick={() => setHistory(null)}>
              Close
            </button>
          </section>
        </div>
      )}
    </main>
  );
}

function RequestList({
  title,
  requests,
  loading,
  saving,
  onAction,
  onHistory,
  showCancel = false,
  showDecisions = false,
}: {
  title: string;
  requests: LeaveRequest[];
  loading: boolean;
  saving: boolean;
  onAction: (
    requestId: number,
    action: "approve" | "reject" | "cancel",
  ) => void;
  onHistory: (requestId: number) => void;
  showCancel?: boolean;
  showDecisions?: boolean;
}) {
  return (
    <section>
      <h2>{title}</h2>
      {loading ? (
        <p>Loading requests…</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {showDecisions && <th align="left">Employee</th>}
                <th align="left">Leave type</th>
                <th align="left">Dates</th>
                <th align="left">Days</th>
                <th align="left">Reason</th>
                <th align="left">Status</th>
                <th align="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((item) => (
                <tr key={item.id}>
                  {showDecisions && (
                    <td>
                      {item.employee.name}
                      {item.employee.department
                        ? ` · ${item.employee.department}`
                        : ""}
                    </td>
                  )}
                  <td>{item.leaveType.name}</td>
                  <td>
                    {item.leaveDates
                      .map((date) => date.slice(0, 10))
                      .join(", ")}
                  </td>
                  <td>{item.requestedDays}</td>
                  <td>{item.reason}</td>
                  <td style={{ color: statusColor(item.status) }}>
                    {item.status.replace("_", " ")}
                  </td>
                  <td align="right">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => onHistory(item.id)}
                    >
                      History
                    </button>{" "}
                    {showCancel &&
                      (item.status === "PENDING" ||
                        item.status === "APPROVED") && (
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => onAction(item.id, "cancel")}
                        >
                          Cancel
                        </button>
                      )}
                    {showDecisions && item.status === "PENDING" && (
                      <>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => onAction(item.id, "approve")}
                        >
                          Approve
                        </button>{" "}
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => onAction(item.id, "reject")}
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {requests.length === 0 && (
                <tr>
                  <td colSpan={showDecisions ? 7 : 6}>
                    No leave requests found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
