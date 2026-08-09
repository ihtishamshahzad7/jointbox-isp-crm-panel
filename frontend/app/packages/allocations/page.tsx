"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import useSWR from "swr";
import API_BASE from "../../components/api";

const API = API_BASE;
const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

type Allocation = {
  id: number;
  groupName: string;
  isActive: boolean;
  days: string[];
  startTime: string;
  endTime: string;
  policyId?: number | null;
  description?: string;
};

type Policy = {
  id: number;
  groupName: string;
  attributeName: string;
  attributeType: string;
  attributeOp: string;
  attributeValue: string;
};

type Stats = {
  total: number;
  active: number;
  inactive: number;
  filtered: number;
};

export default function AllocationsPage() {
  const [token, setToken] = useState<string | null>(null);
  const [editItem, setEditItem] = useState<Allocation | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL");
  const [policyFilter, setPolicyFilter] = useState<string>("ALL");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" | "warn" } | null>(null);
  const [form, setForm] = useState({
    groupName: "General",
    isActive: true,
    days: [] as string[],
    startTime: "00:00",
    endTime: "23:59",
    policyId: "",
    description: "",
  });

  useEffect(() => {
    setToken(localStorage.getItem("token"));
  }, []);

  const fetcher = useCallback(async (url: string) => {
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token || ""}`,
      },
    });
    if (!res.ok) throw new Error("Failed to fetch");
    return res.json();
  }, [token]);

  const { data, mutate, isLoading } = useSWR<Allocation[]>(
    token ? `${API}/packages/allocations` : null,
    fetcher
  );

  const { data: policies } = useSWR<Policy[]>(
    token ? `${API}/packages/policies` : null,
    fetcher
  );

  const showToast = (msg: string, type: "ok" | "err" | "warn" = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const filtered = useMemo(() => {
    const rows = data || [];
    return rows.filter((item) => {
      const q = searchQ.trim().toLowerCase();
      const hit =
        !q ||
        item.groupName.toLowerCase().includes(q) ||
        (item.description || "").toLowerCase().includes(q) ||
        item.startTime.includes(q) ||
        item.endTime.includes(q);
      const statusOk =
        statusFilter === "ALL" || (statusFilter === "ACTIVE" ? item.isActive : !item.isActive);
      const policyOk =
        policyFilter === "ALL" || String(item.policyId || "") === policyFilter;
      return hit && statusOk && policyOk;
    });
  }, [data, searchQ, statusFilter, policyFilter]);

  const stats: Stats = useMemo(() => ({
    total: data?.length || 0,
    active: (data || []).filter((x) => x.isActive).length,
    inactive: (data || []).filter((x) => !x.isActive).length,
    filtered: filtered.length,
  }), [data, filtered]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paged = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, page, pageSize]);

  const openCreate = () => {
    setEditItem(null);
    setForm({
      groupName: "General",
      isActive: true,
      days: [],
      startTime: "00:00",
      endTime: "23:59",
      policyId: "",
      description: "",
    });
    setShowModal(true);
  };

  const openEdit = (item: Allocation) => {
    setEditItem(item);
    setForm({
      groupName: item.groupName,
      isActive: item.isActive,
      days: item.days || [],
      startTime: item.startTime,
      endTime: item.endTime,
      policyId: item.policyId ? String(item.policyId) : "",
      description: item.description || "",
    });
    setShowModal(true);
  };

  const submit = async () => {
    if (!form.groupName.trim()) return showToast("Group name is required", "err");
    if (!form.days.length) return showToast("Select at least one day", "err");

    const payload = {
      groupName: form.groupName,
      isActive: form.isActive,
      days: form.days,
      startTime: form.startTime,
      endTime: form.endTime,
      policyId: form.policyId ? Number(form.policyId) : null,
      description: form.description,
    };

    const url = editItem ? `${API}/packages/allocations/${editItem.id}` : `${API}/packages/allocations`;
    const method = editItem ? "PUT" : "POST";

    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token || ""}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const error = await res.text();
      return showToast(`Failed to save: ${error}`, "err");
    }

    setShowModal(false);
    await mutate();
    showToast(editItem ? "✅ Allocation updated" : "✅ Allocation created", "ok");
  };

  const remove = async () => {
    if (!deleteId) return;
    const res = await fetch(`${API}/packages/allocations/${deleteId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token || ""}`,
      },
    });
    if (!res.ok) return showToast("❌ Delete failed", "err");
    setDeleteId(null);
    await mutate();
    showToast("🗑️ Allocation deleted", "ok");
  };

  const getPolicyName = (policyId?: number | null) => {
    if (!policyId) return "—";
    const policy = (policies || []).find((p) => p.id === policyId);
    return policy ? `${policy.groupName} / ${policy.attributeName}` : `Policy #${policyId}`;
  };

  const dayShort = (day: string) => day.slice(0, 3);

  // Skeleton rows
  const skeletonRows = useMemo(() => {
    return Array.from({ length: 6 }).map((_, idx) => (
      <tr key={`skeleton-${idx}`}>
        {Array.from({ length: 7 }).map((__, c) => (
          <td key={`skeleton-cell-${c}`} style={{ padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ height: "16px", borderRadius: "4px", background: "rgba(255,255,255,0.06)", animation: "pulse 1.5s ease-in-out infinite" }} />
          </td>
        ))}
      </tr>
    ));
  }, []);

  return (
    <div style={{ minHeight: "100vh", padding: "24px", background: "linear-gradient(180deg,var(--bg),var(--surface))", color: "var(--text)" }}>
      {/* Toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            right: "24px",
            bottom: "24px",
            zIndex: 100,
            padding: "14px 24px",
            borderRadius: "12px",
            border: "1px solid",
            fontSize: "13px",
            fontWeight: "500",
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            maxWidth: "400px",
            background: toast.type === "ok" ? "rgba(16,185,129,0.08)" : toast.type === "err" ? "rgba(255,112,112,0.08)" : "rgba(240,165,0,0.08)",
            borderColor: toast.type === "ok" ? "rgba(16,185,129,0.25)" : toast.type === "err" ? "rgba(255,112,112,0.25)" : "rgba(240,165,0,0.25)",
            color: toast.type === "ok" ? "#10B981" : toast.type === "err" ? "#ff7070" : "#f0a500",
          }}
        >
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ marginBottom: "24px", display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "28px", fontWeight: "800", letterSpacing: "-0.02em", color: "#fff" }}>Allocations</h1>
          <p style={{ fontSize: "14px", color: "rgba(255,255,255,0.35)", marginTop: "4px", fontFamily: "monospace" }}>Define time-based resource allocation for packages</p>
        </div>
        <button
          style={{
            padding: "8px 18px",
            borderRadius: "10px",
            fontSize: "12px",
            fontWeight: "600",
            border: "none",
            cursor: "pointer",
            background: "#0f766e",
            color: "#ccfbf1",
          }}
          onClick={openCreate}
        >
          + Add Allocation
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "10px", marginBottom: "16px" }}>
        {[
          { label: "Total", value: stats.total, color: "#00C9FF" },
          { label: "Active", value: stats.active, color: "#10B981" },
          { label: "Inactive", value: stats.inactive, color: "#ff7070" },
          { label: "Filtered", value: stats.filtered, color: "#f0a500" },
        ].map((s) => (
          <div
            key={s.label}
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: "12px",
              padding: "12px 16px",
            }}
          >
            <div style={{ fontSize: "20px", fontWeight: "800", color: s.color }}>{s.value}</div>
            <div style={{ fontSize: "9px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px", marginBottom: "16px" }}>
        <input
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "10px",
            padding: "10px 14px",
            color: "var(--text)",
            fontSize: "13px",
            width: "100%",
          }}
          placeholder="Search group, description, time..."
          value={searchQ}
          onChange={(e) => { setSearchQ(e.target.value); setPage(1); }}
        />
        <select
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "10px",
            padding: "10px 14px",
            color: "var(--text)",
            fontSize: "13px",
            width: "100%",
          }}
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value as "ALL" | "ACTIVE" | "INACTIVE"); setPage(1); }}
        >
          <option value="ALL">All Status</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
        <select
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "10px",
            padding: "10px 14px",
            color: "var(--text)",
            fontSize: "13px",
            width: "100%",
          }}
          value={policyFilter}
          onChange={(e) => { setPolicyFilter(e.target.value); setPage(1); }}
        >
          <option value="ALL">All Policies</option>
          <option value="">No Policy</option>
          {(policies || []).map((p) => (
            <option key={p.id} value={String(p.id)}>{p.groupName} / {p.attributeName}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "14px", overflow: "hidden", marginBottom: "12px" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: "750px", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <th style={{ padding: "14px 16px", textAlign: "left", fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>Status</th>
                <th style={{ padding: "14px 16px", textAlign: "left", fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>Group</th>
                <th style={{ padding: "14px 16px", textAlign: "left", fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>Day(s)</th>
                <th style={{ padding: "14px 16px", textAlign: "left", fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>Start</th>
                <th style={{ padding: "14px 16px", textAlign: "left", fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>End</th>
                <th style={{ padding: "14px 16px", textAlign: "left", fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>Policy</th>
                <th style={{ padding: "14px 16px", textAlign: "left", fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && skeletonRows}

              {!isLoading && paged.map((a) => (
                <tr key={a.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }} onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.03)"} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                  <td style={{ padding: "12px 16px", fontSize: "13px" }}>
                    <span style={{
                      padding: "4px 12px",
                      borderRadius: "20px",
                      fontSize: "10px",
                      fontWeight: "700",
                      textTransform: "uppercase",
                      background: a.isActive ? "rgba(16,185,129,0.12)" : "rgba(255,112,112,0.12)",
                      color: a.isActive ? "#10B981" : "#ff7070",
                    }}>
                      {a.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: "13px", color: "#fff" }}>{a.groupName}</td>
                  <td style={{ padding: "12px 16px", fontSize: "13px", color: "rgba(255,255,255,0.5)" }}>{(a.days || []).map(dayShort).join(", ") || "—"}</td>
                  <td style={{ padding: "12px 16px", fontSize: "13px", fontFamily: "monospace", color: "rgba(255,255,255,0.7)" }}>{a.startTime}</td>
                  <td style={{ padding: "12px 16px", fontSize: "13px", fontFamily: "monospace", color: "rgba(255,255,255,0.7)" }}>{a.endTime}</td>
                  <td style={{ padding: "12px 16px", fontSize: "13px", color: "rgba(255,255,255,0.5)" }}>{getPolicyName(a.policyId)}</td>
                  <td style={{ padding: "12px 16px", fontSize: "13px" }}>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button style={{ padding: "4px 10px", borderRadius: "6px", fontSize: "10px", fontWeight: "600", border: "none", cursor: "pointer", background: "#1e3a8a", color: "#dbeafe" }} onClick={() => openEdit(a)}>Edit</button>
                      <button style={{ padding: "4px 10px", borderRadius: "6px", fontSize: "10px", fontWeight: "600", border: "none", cursor: "pointer", background: "rgba(127,29,29,0.8)", color: "#fecaca" }} onClick={() => setDeleteId(a.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}

              {!isLoading && !paged.length && (
                <tr>
                  <td colSpan={7} style={{ padding: "48px 24px", textAlign: "center", color: "rgba(255,255,255,0.3)" }}>
                    <div style={{ fontSize: "48px", marginBottom: "12px" }}>📋</div>
                    <div style={{ fontSize: "16px", fontWeight: "600", color: "rgba(255,255,255,0.5)" }}>No allocations found</div>
                    <button
                      style={{
                        marginTop: "16px",
                        padding: "8px 24px",
                        borderRadius: "10px",
                        border: "1px solid rgba(16,185,129,0.2)",
                        background: "transparent",
                        color: "#10B981",
                        fontSize: "13px",
                        fontWeight: "600",
                        cursor: "pointer",
                      }}
                      onClick={openCreate}
                    >
                      + Create your first allocation
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px", fontSize: "13px", color: "rgba(255,255,255,0.35)" }}>
        <select
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: "8px",
            padding: "6px 12px",
            color: "var(--text)",
            fontSize: "13px",
            cursor: "pointer",
          }}
          value={pageSize}
          onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
        >
          {[10, 25, 50].map((n) => <option key={n} value={n}>{n}/page</option>)}
        </select>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <button style={{ padding: "6px 14px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.08)", background: "transparent", color: "rgba(255,255,255,0.5)", fontSize: "13px", cursor: "pointer", opacity: page <= 1 ? "0.3" : "1", pointerEvents: page <= 1 ? "none" : "auto" }} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</button>
          <span style={{ padding: "6px 14px", background: "rgba(255,255,255,0.04)", borderRadius: "8px", minWidth: "80px", textAlign: "center", fontFamily: "monospace", fontSize: "12px", color: "rgba(255,255,255,0.4)" }}>Page {page} / {totalPages}</span>
          <button style={{ padding: "6px 14px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.08)", background: "transparent", color: "rgba(255,255,255,0.5)", fontSize: "13px", cursor: "pointer", opacity: page >= totalPages ? "0.3" : "1", pointerEvents: page >= totalPages ? "none" : "auto" }} disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</button>
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }} onClick={() => setShowModal(false)}>
          <div style={{ background: "var(--surface)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "20px", padding: "28px", maxWidth: "700px", width: "100%", maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#fff" }}>{editItem ? "✏️ Edit Allocation" : "➕ Add Allocation"}</h2>
              <button style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.3)", fontSize: "20px", cursor: "pointer" }} onClick={() => setShowModal(false)}>✕</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Group Name *</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={form.groupName} onChange={(e) => setForm((x) => ({ ...x, groupName: e.target.value }))} placeholder="e.g., Peak Hours" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Status</label>
                <select style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={String(form.isActive)} onChange={(e) => setForm((x) => ({ ...x, isActive: e.target.value === "true" }))}>
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Start Time</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} type="time" value={form.startTime} onChange={(e) => setForm((x) => ({ ...x, startTime: e.target.value }))} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>End Time</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} type="time" value={form.endTime} onChange={(e) => setForm((x) => ({ ...x, endTime: e.target.value }))} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", gridColumn: "1 / -1" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Policy</label>
                <select style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={form.policyId} onChange={(e) => setForm((x) => ({ ...x, policyId: e.target.value }))}>
                  <option value="">— No Policy —</option>
                  {(policies || []).map((p) => (
                    <option key={p.id} value={p.id}>{p.groupName} / {p.attributeName}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", gridColumn: "1 / -1" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Day(s) of Week *</label>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "6px" }}>
                  {days.map((d) => (
                    <button
                      key={d}
                      type="button"
                      style={{
                        padding: "8px 4px",
                        borderRadius: "8px",
                        fontSize: "11px",
                        fontWeight: "600",
                        border: form.days.includes(d) ? "2px solid #10B981" : "1px solid rgba(255,255,255,0.1)",
                        background: form.days.includes(d) ? "rgba(16,185,129,0.1)" : "rgba(255,255,255,0.03)",
                        color: form.days.includes(d) ? "#10B981" : "rgba(255,255,255,0.4)",
                        cursor: "pointer",
                      }}
                      onClick={() => {
                        setForm((x) => ({
                          ...x,
                          days: x.days.includes(d) ? x.days.filter((y) => y !== d) : [...x.days, d],
                        }));
                      }}
                    >
                      {d.slice(0, 3)}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", gridColumn: "1 / -1" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Description</label>
                <textarea style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%", minHeight: "60px", resize: "vertical" }} value={form.description} onChange={(e) => setForm((x) => ({ ...x, description: e.target.value }))} placeholder="Optional description..." />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "20px", paddingTop: "16px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
              <button style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "1px solid rgba(255,255,255,0.06)", cursor: "pointer", background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.4)" }} onClick={() => setShowModal(false)}>Cancel</button>
              <button style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "none", cursor: "pointer", background: "#0f766e", color: "#ccfbf1" }} onClick={submit}>{editItem ? "Update" : "Create"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Modal */}
      {deleteId !== null && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }} onClick={() => setDeleteId(null)}>
          <div style={{ background: "var(--surface)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "20px", padding: "28px", maxWidth: "450px", width: "100%" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "48px", marginBottom: "12px" }}>🗑️</div>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>Delete Allocation</h2>
              <p style={{ fontSize: "14px", color: "rgba(255,255,255,0.4)" }}>Are you sure you want to delete this allocation? This cannot be undone.</p>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "20px", paddingTop: "16px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
              <button style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "1px solid rgba(255,255,255,0.06)", cursor: "pointer", background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.4)" }} onClick={() => setDeleteId(null)}>Cancel</button>
              <button style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "none", cursor: "pointer", background: "rgba(127,29,29,0.8)", color: "#fecaca" }} onClick={remove}>Delete Forever</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}