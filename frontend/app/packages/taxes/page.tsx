"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import useSWR from "swr";
import API_BASE from "../../components/api";

const API = API_BASE;

type Tax = {
  id: number;
  groupName: string;
  name: string;
  type: "FIXED" | "PERCENTAGE" | "FORMULA";
  value: string;
  description?: string;
  isActive: boolean;
};

type Stats = {
  total: number;
  active: number;
  inactive: number;
  fixed: number;
  percentage: number;
  formula: number;
  filtered: number;
};

const typeLabels: Record<Tax["type"], { label: string; color: string; bg: string }> = {
  FIXED: { label: "Fixed", color: "#10B981", bg: "rgba(16,185,129,0.12)" },
  PERCENTAGE: { label: "Percentage", color: "#f0a500", bg: "rgba(240,165,0,0.12)" },
  FORMULA: { label: "Formula", color: "#6440f5", bg: "rgba(100,64,245,0.12)" },
};

export default function TaxesPage() {
  const [token, setToken] = useState<string | null>(null);
  const [editItem, setEditItem] = useState<Tax | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL");
  const [typeFilter, setTypeFilter] = useState<"ALL" | Tax["type"]>("ALL");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" | "warn" } | null>(null);
  const [form, setForm] = useState({
    groupName: "General",
    name: "",
    type: "FIXED" as Tax["type"],
    value: "",
    description: "",
    isActive: true,
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

  const { data, mutate, isLoading } = useSWR<Tax[]>(
    token ? `${API}/packages/taxes` : null,
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
        item.name.toLowerCase().includes(q) ||
        (item.description || "").toLowerCase().includes(q) ||
        item.value.toLowerCase().includes(q);
      const statusOk =
        statusFilter === "ALL" || (statusFilter === "ACTIVE" ? item.isActive : !item.isActive);
      const typeOk = typeFilter === "ALL" || item.type === typeFilter;
      return hit && statusOk && typeOk;
    });
  }, [data, searchQ, statusFilter, typeFilter]);

  const stats: Stats = useMemo(() => {
    const rows = data || [];
    return {
      total: rows.length,
      active: rows.filter((x) => x.isActive).length,
      inactive: rows.filter((x) => !x.isActive).length,
      fixed: rows.filter((x) => x.type === "FIXED").length,
      percentage: rows.filter((x) => x.type === "PERCENTAGE").length,
      formula: rows.filter((x) => x.type === "FORMULA").length,
      filtered: filtered.length,
    };
  }, [data, filtered]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paged = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, page, pageSize]);

  const openCreate = () => {
    setEditItem(null);
    setForm({
      groupName: "General",
      name: "",
      type: "FIXED",
      value: "",
      description: "",
      isActive: true,
    });
    setShowModal(true);
  };

  const openEdit = (item: Tax) => {
    setEditItem(item);
    setForm({
      groupName: item.groupName,
      name: item.name,
      type: item.type,
      value: item.value,
      description: item.description || "",
      isActive: item.isActive,
    });
    setShowModal(true);
  };

  const submit = async () => {
    if (!form.name.trim()) return showToast("Name is required", "err");
    if (!form.value.trim()) return showToast("Value is required", "err");

    const url = editItem ? `${API}/packages/taxes/${editItem.id}` : `${API}/packages/taxes`;
    const method = editItem ? "PUT" : "POST";

    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token || ""}`,
      },
      body: JSON.stringify(form),
    });

    if (!res.ok) {
      const error = await res.text();
      return showToast(`Failed to save: ${error}`, "err");
    }

    setShowModal(false);
    await mutate();
    showToast(editItem ? "✅ Tax/Fee updated" : "✅ Tax/Fee created", "ok");
  };

  const remove = async () => {
    if (!deleteId) return;
    const res = await fetch(`${API}/packages/taxes/${deleteId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token || ""}`,
      },
    });
    if (!res.ok) return showToast("❌ Delete failed", "err");
    setDeleteId(null);
    await mutate();
    showToast("🗑️ Tax/Fee deleted", "ok");
  };

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
          <h1 style={{ fontSize: "28px", fontWeight: "800", letterSpacing: "-0.02em", color: "#fff" }}>Taxes & Extra Fees</h1>
          <p style={{ fontSize: "14px", color: "rgba(255,255,255,0.35)", marginTop: "4px", fontFamily: "monospace" }}>Manage additional charges and taxes for packages</p>
        </div>
        <button
          style={{
            padding: "8px 18px",
            borderRadius: "10px",
            fontSize: "12px",
            fontWeight: "600",
            border: "none",
            cursor: "pointer",
            background: "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)",
            color: "var(--bg)",
            boxShadow: "0 2px 12px rgba(16,185,129,0.15)",
          }}
          onClick={openCreate}
        >
          + Add Tax/Fee
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "10px", marginBottom: "16px" }}>
        {[
          { label: "Total", value: stats.total, color: "#00C9FF" },
          { label: "Active", value: stats.active, color: "#10B981" },
          { label: "Inactive", value: stats.inactive, color: "#ff7070" },
          { label: "Fixed", value: stats.fixed, color: "#10B981" },
          { label: "Percentage", value: stats.percentage, color: "#f0a500" },
          { label: "Formula", value: stats.formula, color: "#6440f5" },
          { label: "Filtered", value: stats.filtered, color: "#00b4d8" },
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
          placeholder="Search group, name, value..."
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
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value as "ALL" | Tax["type"]); setPage(1); }}
        >
          <option value="ALL">All Types</option>
          <option value="FIXED">Fixed</option>
          <option value="PERCENTAGE">Percentage</option>
          <option value="FORMULA">Formula</option>
        </select>
      </div>

      {/* Table */}
      <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "14px", overflow: "hidden", marginBottom: "12px" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: "800px", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <th style={{ padding: "14px 16px", textAlign: "left", fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>Status</th>
                <th style={{ padding: "14px 16px", textAlign: "left", fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>Group</th>
                <th style={{ padding: "14px 16px", textAlign: "left", fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>Name</th>
                <th style={{ padding: "14px 16px", textAlign: "left", fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>Type</th>
                <th style={{ padding: "14px 16px", textAlign: "left", fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>Value</th>
                <th style={{ padding: "14px 16px", textAlign: "left", fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>Description</th>
                <th style={{ padding: "14px 16px", textAlign: "left", fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.25)" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && skeletonRows}

              {!isLoading && paged.map((t) => {
                const typeInfo = typeLabels[t.type] || typeLabels.FIXED;
                return (
                  <tr key={t.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }} onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.03)"} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                    <td style={{ padding: "12px 16px", fontSize: "13px" }}>
                      <span style={{
                        padding: "4px 12px",
                        borderRadius: "20px",
                        fontSize: "10px",
                        fontWeight: "700",
                        textTransform: "uppercase",
                        background: t.isActive ? "rgba(16,185,129,0.12)" : "rgba(255,112,112,0.12)",
                        color: t.isActive ? "#10B981" : "#ff7070",
                      }}>
                        {t.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: "13px", color: "#fff" }}>{t.groupName}</td>
                    <td style={{ padding: "12px 16px", fontSize: "13px", color: "rgba(255,255,255,0.8)" }}>{t.name}</td>
                    <td style={{ padding: "12px 16px", fontSize: "13px" }}>
                      <span style={{ padding: "4px 12px", borderRadius: "20px", fontSize: "10px", fontWeight: "600", background: typeInfo.bg, color: typeInfo.color }}>{typeInfo.label}</span>
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: "13px", fontFamily: "monospace", color: "#10B981" }}>{t.value}</td>
                    <td style={{ padding: "12px 16px", fontSize: "13px", color: "rgba(255,255,255,0.4)" }}>{t.description || "-"}</td>
                    <td style={{ padding: "12px 16px", fontSize: "13px" }}>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button style={{ padding: "4px 10px", borderRadius: "6px", fontSize: "10px", fontWeight: "600", border: "none", cursor: "pointer", background: "#1e3a8a", color: "#dbeafe" }} onClick={() => openEdit(t)}>Edit</button>
                        <button style={{ padding: "4px 10px", borderRadius: "6px", fontSize: "10px", fontWeight: "600", border: "none", cursor: "pointer", background: "rgba(127,29,29,0.8)", color: "#fecaca" }} onClick={() => setDeleteId(t.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {!isLoading && !paged.length && (
                <tr>
                  <td colSpan={7} style={{ padding: "48px 24px", textAlign: "center", color: "rgba(255,255,255,0.3)" }}>
                    <div style={{ fontSize: "48px", marginBottom: "12px" }}>💰</div>
                    <div style={{ fontSize: "16px", fontWeight: "600", color: "rgba(255,255,255,0.5)" }}>No taxes or fees found</div>
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
                      + Create your first tax/fee
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
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#fff" }}>{editItem ? "✏️ Edit Tax/Fee" : "➕ Add Tax/Fee"}</h2>
              <button style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.3)", fontSize: "20px", cursor: "pointer" }} onClick={() => setShowModal(false)}>✕</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Group Name</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={form.groupName} onChange={(e) => setForm((p) => ({ ...p, groupName: e.target.value }))} placeholder="e.g., Service Fees" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Name *</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="e.g., Service Tax" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Type</label>
                <select style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={form.type} onChange={(e) => setForm((p) => ({ ...p, type: e.target.value as Tax["type"] }))}>
                  <option value="FIXED">Fixed</option>
                  <option value="PERCENTAGE">Percentage</option>
                  <option value="FORMULA">Formula</option>
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Value *</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={form.value} onChange={(e) => setForm((p) => ({ ...p, value: e.target.value }))} placeholder="e.g., 5, 10%" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", gridColumn: "1 / -1" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Description</label>
                <textarea style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%", minHeight: "60px", resize: "vertical" }} value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} placeholder="Optional description..." />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", gridColumn: "1 / -1" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Status</label>
                <select style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={String(form.isActive)} onChange={(e) => setForm((p) => ({ ...p, isActive: e.target.value === "true" }))}>
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "20px", paddingTop: "16px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
              <button style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "1px solid rgba(255,255,255,0.06)", cursor: "pointer", background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.4)" }} onClick={() => setShowModal(false)}>Cancel</button>
              <button style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "none", cursor: "pointer", background: "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)", color: "#fff" }} onClick={submit}>{editItem ? "Update" : "Create"}</button>
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
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>Delete Tax/Fee</h2>
              <p style={{ fontSize: "14px", color: "rgba(255,255,255,0.4)" }}>Are you sure you want to delete this tax/fee? This cannot be undone.</p>
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