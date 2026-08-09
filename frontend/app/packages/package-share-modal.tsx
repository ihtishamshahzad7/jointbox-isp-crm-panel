"use client";

import { useState, useEffect, useMemo } from "react";
import { money } from "../components/currency";
import API_BASE from "../components/api";

const API = API_BASE;

interface PackageRow {
  id: number;
  name: string;
  price: number;
  downloadSpeed: number;
  uploadSpeed: number;
  dataQuotaGb: number | null;
}

interface FranchiseeData {
  id: number;
  name: string;
  email: string;
  role: "RESELLER" | "FRANCHISE" | "DEALER" | "RETAILER";
  wholesalePrice?: number | null;
  assigned?: boolean;
  color?: string;
  _count?: { salesSubscribers: number };
}

interface PackageShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  package: PackageRow | null;
  token: string | null;
  onSuccess?: () => void;
}

export function PackageShareModal({
  isOpen,
  onClose,
  package: pkg,
  token,
  onSuccess,
}: PackageShareModalProps) {
  const [franchisees, setFranchisees] = useState<FranchiseeData[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [savingIds, setSavingIds] = useState<Set<number>>(new Set());
  const [expandedPricing, setExpandedPricing] = useState<Set<number>>(new Set());
  const [priceInputs, setPriceInputs] = useState<Record<number, string>>({});
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" | "warn" } | null>(null);

  // Fetch franchisees with pricing when modal opens
  useEffect(() => {
    if (!isOpen || !pkg || !token) return;
    fetchFranchiseesWithPricing();
  }, [isOpen, pkg, token]);

  const fetchFranchiseesWithPricing = async () => {
    if (!pkg) return;
    setLoading(true);
    try {
      const hdrs = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };

      const pricingRes = await fetch(`${API}/organization/pricing?packageId=${pkg.id}`, { headers: hdrs });
      const pricingRows = pricingRes.ok ? await pricingRes.json() : [];
      const usersRes = await fetch(`${API}/users`, { headers: hdrs });
      const users = usersRes.ok ? await usersRes.json() : [];

      const resellerRoles = new Set(["RESELLER", "SUB_RESELLER", "RETAILER", "SALES"]);
      const franchiseeList = (Array.isArray(users) ? users : [])
        .filter((user: any) => resellerRoles.has(user.role))
        .map((user: any) => {
          const pricingRow = (Array.isArray(pricingRows) ? pricingRows : []).find((p: any) => p.userId === user.id);
          return {
            ...user,
            wholesalePrice: pricingRow?.price ?? null,
            assigned: !!pricingRow,
          };
        });

      setFranchisees(franchiseeList);
      const inputs: Record<number, string> = {};
      franchiseeList.forEach((f: FranchiseeData) => {
        if (f.wholesalePrice != null) inputs[f.id] = String(f.wholesalePrice);
      });
      setPriceInputs(inputs);
    } catch (error) {
      showToast("Failed to load child accounts", "err");
    }
    setLoading(false);
  };

  const showToast = (msg: string, type: "ok" | "err" | "warn" = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2600);
  };

  // Filter franchisees based on search query
  const filteredFranchisees = useMemo(() => {
    if (!searchQuery.trim()) return franchisees;
    const q = searchQuery.toLowerCase();
    return franchisees.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.email.toLowerCase().includes(q) ||
        f.role.toLowerCase().includes(q)
    );
  }, [franchisees, searchQuery]);

  const toggleSharePackage = async (franchiseeId: number, assign: boolean) => {
    if (!pkg) return;

    const newSaving = new Set(savingIds);
    newSaving.add(franchiseeId);
    setSavingIds(newSaving);

    try {
      const tk = token || localStorage.getItem("token");
      const hdrs = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tk}`,
      };

      if (assign) {
        const priceStr = priceInputs[franchiseeId];
        const price = priceStr ? parseFloat(priceStr) : pkg.price;

        const res = await fetch(`${API}/organization/pricing`, {
          method: "PUT",
          headers: hdrs,
          body: JSON.stringify({
            userId: franchiseeId,
            packageId: pkg.id,
            price,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showToast(err.message || "Failed to share package", "err");
        } else {
          setFranchisees((prev) =>
            prev.map((f) =>
              f.id === franchiseeId ? { ...f, wholesalePrice: price, assigned: true } : f
            )
          );
          showToast("Package shared successfully", "ok");
          onSuccess?.();
        }
      } else {
        const res = await fetch(`${API}/organization/pricing/${franchiseeId}/${pkg.id}`, {
          method: "DELETE",
          headers: hdrs,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showToast(err.message || "Failed to remove package", "err");
        } else {
          setFranchisees((prev) =>
            prev.map((f) =>
              f.id === franchiseeId ? { ...f, wholesalePrice: null, assigned: false } : f
            )
          );
          showToast("Package removed successfully", "ok");
          onSuccess?.();
        }
      }
    } catch (error) {
      showToast("Network error", "err");
    }

    newSaving.delete(franchiseeId);
    setSavingIds(newSaving);
  };

  const togglePricingExpanded = (franchiseeId: number) => {
    const newExpanded = new Set(expandedPricing);
    if (newExpanded.has(franchiseeId)) {
      newExpanded.delete(franchiseeId);
    } else {
      newExpanded.add(franchiseeId);
    }
    setExpandedPricing(newExpanded);
  };

  const updatePrice = (franchiseeId: number, value: string) => {
    setPriceInputs((prev) => ({
      ...prev,
      [franchiseeId]: value,
    }));
  };

  if (!isOpen || !pkg) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 50,
          background: "rgba(0,0,0,0.7)",
          backdropFilter: "blur(8px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px",
        }}
        onClick={onClose}
      >
        {/* Modal */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: "20px",
            padding: "28px",
            maxWidth: "900px",
            width: "100%",
            maxHeight: "90vh",
            overflowY: "auto",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "24px",
            }}
          >
            <div>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#fff", margin: 0 }}>
                📦 Share Package — {pkg.name}
              </h2>
              <p style={{ fontSize: "12px", color: "rgba(255,255,255,0.3)", margin: "4px 0 0" }}>
                Set resale prices for {pkg.downloadSpeed}/{pkg.uploadSpeed} Mbps package
                {pkg.dataQuotaGb && ` with ${pkg.dataQuotaGb} GB quota`}
              </p>
            </div>
            <button
              style={{
                background: "transparent",
                border: "none",
                color: "rgba(255,255,255,0.3)",
                fontSize: "20px",
                cursor: "pointer",
              }}
              onClick={onClose}
            >
              ✕
            </button>
          </div>

          {/* Search Bar */}
          <div style={{ marginBottom: "20px" }}>
            <input
              type="text"
              placeholder="🔍 Search franchisees by name, email, or role..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: "100%",
                padding: "10px 14px",
                borderRadius: "10px",
                border: "1px solid rgba(255,255,255,0.1)",
                background: "rgba(255,255,255,0.05)",
                color: "#fff",
                fontSize: "13px",
              }}
            />
          </div>

          {/* Loading State */}
          {loading ? (
            <div style={{ textAlign: "center", padding: "40px", color: "rgba(255,255,255,0.3)" }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  border: "2px solid rgba(255,255,255,0.1)",
                  borderTopColor: "#10B981",
                  borderRadius: "50%",
                  animation: "spin 1s linear infinite",
                  margin: "0 auto 12px",
                }}
              ></div>
              Loading franchisees...
            </div>
          ) : filteredFranchisees.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px", color: "rgba(255,255,255,0.3)" }}>
              <div style={{ fontSize: "40px", marginBottom: "12px" }}>🏢</div>
              <div style={{ fontSize: "14px", marginBottom: "8px" }}>
                {franchisees.length === 0 ? "No franchisees found" : "No results matching your search"}
              </div>
              <div style={{ fontSize: "12px" }}>
                {franchisees.length === 0
                  ? "Create reseller/franchise users under your organization."
                  : "Try a different search term."}
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: "12px" }}>
              {filteredFranchisees.map((franchisee, idx) => {
                const isShared = !!franchisee.assigned || franchisee.wholesalePrice != null;
                const isSaving = savingIds.has(franchisee.id);
                const isExpanded = expandedPricing.has(franchisee.id);
                const currentPrice = priceInputs[franchisee.id] || String(pkg.price);
                const margin =
                  franchisee.wholesalePrice && pkg.price
                    ? (((pkg.price - franchisee.wholesalePrice) / pkg.price) * 100).toFixed(1)
                    : null;

                return (
                  <div
                    key={franchisee.id}
                    style={{
                      border: "1px solid rgba(255,255,255,0.06)",
                      borderRadius: "12px",
                      background: isShared ? "rgba(16,185,129,0.04)" : "rgba(255,255,255,0.02)",
                      padding: "14px",
                      transition: "all 0.2s ease",
                    }}
                  >
                    {/* Franchisee Info Row */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "12px",
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "10px",
                            marginBottom: "4px",
                          }}
                        >
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: "50%",
                              background: franchisee.color || "#818cf8",
                            }}
                          />
                          <div style={{ fontSize: "13px", fontWeight: 700, color: "#fff" }}>
                            {franchisee.name}
                          </div>
                          <span
                            style={{
                              padding: "2px 8px",
                              borderRadius: "20px",
                              fontSize: "9px",
                              fontWeight: 600,
                              background:
                                franchisee.role === "FRANCHISE"
                                  ? "rgba(16,185,129,0.12)"
                                  : franchisee.role === "RESELLER"
                                    ? "rgba(99,102,241,0.12)"
                                    : "rgba(251,146,60,0.12)",
                              color:
                                franchisee.role === "FRANCHISE"
                                  ? "#6ee7b7"
                                  : franchisee.role === "RESELLER"
                                    ? "#818cf8"
                                    : "#fb923c",
                            }}
                          >
                            {franchisee.role}
                          </span>
                          {franchisee._count?.salesSubscribers && (
                            <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.3)" }}>
                              ({franchisee._count.salesSubscribers} subs)
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.35)" }}>
                          {franchisee.email}
                        </div>
                      </div>

                      {/* Action Buttons */}
                      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        {isShared && (
                          <button
                            onClick={() => togglePricingExpanded(franchisee.id)}
                            disabled={isSaving}
                            style={{
                              padding: "6px 10px",
                              borderRadius: "8px",
                              border: "1px solid rgba(16,185,129,0.3)",
                              background: "rgba(16,185,129,0.12)",
                              color: "#6ee7b7",
                              cursor: isSaving ? "not-allowed" : "pointer",
                              fontSize: "11px",
                              fontWeight: 600,
                              opacity: isSaving ? 0.5 : 1,
                            }}
                          >
                            {isExpanded ? "▼ Price" : "▶ Price"} ({money(franchisee.wholesalePrice!)})
                          </button>
                        )}

                        <button
                          onClick={() => toggleSharePackage(franchisee.id, !isShared)}
                          disabled={isSaving}
                          style={{
                            padding: "8px 14px",
                            borderRadius: "8px",
                            border: "1px solid rgba(255,255,255,0.08)",
                            background: isShared
                              ? "rgba(239,68,68,0.12)"
                              : "rgba(16,185,129,0.12)",
                            color: isShared ? "#f87171" : "#6ee7b7",
                            cursor: isSaving ? "not-allowed" : "pointer",
                            fontSize: "11px",
                            fontWeight: 700,
                            opacity: isSaving ? 0.5 : 1,
                          }}
                        >
                          {isSaving ? "Saving..." : isShared ? "Unshare" : "Share"}
                        </button>
                      </div>
                    </div>

                    {/* Pricing Section (Expandable) */}
                    {isExpanded && isShared && (
                      <div
                        style={{
                          marginTop: "14px",
                          paddingTop: "14px",
                          borderTop: "1px solid rgba(255,255,255,0.05)",
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr",
                          gap: "12px",
                        }}
                      >
                        <div>
                          <label style={{ fontSize: "10px", color: "rgba(255,255,255,0.4)", display: "block", marginBottom: "4px" }}>
                            Your Base Price
                          </label>
                          <div style={{ fontSize: "13px", fontWeight: 600, color: "#10B981" }}>
                            {money(pkg.price)}
                          </div>
                        </div>

                        <div>
                          <label style={{ fontSize: "10px", color: "rgba(255,255,255,0.4)", display: "block", marginBottom: "4px" }}>
                            Resale Price
                          </label>
                          <input
                            type="number"
                            step="0.01"
                            value={currentPrice}
                            onChange={(e) => updatePrice(franchisee.id, e.target.value)}
                            onBlur={() => {
                              if (currentPrice && currentPrice !== String(franchisee.wholesalePrice)) {
                                toggleSharePackage(franchisee.id, true);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                (e.target as HTMLInputElement).blur();
                              }
                            }}
                            style={{
                              width: "100%",
                              padding: "6px 8px",
                              borderRadius: "6px",
                              border: "1px solid rgba(255,255,255,0.1)",
                              background: "rgba(255,255,255,0.04)",
                              color: "#fff",
                              fontSize: "12px",
                              fontWeight: 600,
                              fontFamily: "monospace",
                            }}
                          />
                        </div>

                        {margin !== null && (
                          <div
                            style={{
                              gridColumn: "1 / -1",
                              padding: "8px 12px",
                              borderRadius: "8px",
                              background: "rgba(99,102,241,0.12)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                            }}
                          >
                            <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.6)" }}>
                              Your Margin
                            </span>
                            <span style={{ fontSize: "12px", fontWeight: 700, color: "#818cf8" }}>
                              {margin}% ({money(pkg.price - (franchisee.wholesalePrice || 0))})
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Toast Notification */}
          {toast && (
            <div
              style={{
                position: "fixed",
                bottom: "20px",
                right: "20px",
                padding: "12px 16px",
                borderRadius: "8px",
                background:
                  toast.type === "ok"
                    ? "rgba(16,185,129,0.12)"
                    : toast.type === "err"
                      ? "rgba(239,68,68,0.12)"
                      : "rgba(251,146,60,0.12)",
                color:
                  toast.type === "ok"
                    ? "#6ee7b7"
                    : toast.type === "err"
                      ? "#f87171"
                      : "#fb923c",
                fontSize: "12px",
                fontWeight: 600,
                border: `1px solid ${
                  toast.type === "ok"
                    ? "rgba(16,185,129,0.3)"
                    : toast.type === "err"
                      ? "rgba(239,68,68,0.3)"
                      : "rgba(251,146,60,0.3)"
                }`,
              }}
            >
              {toast.msg}
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
}
