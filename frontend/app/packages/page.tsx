"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import useSWR from "swr";
import { money, currencySymbol } from "../components/currency";
import { silent } from "../components/silent";
import { PackageShareModal } from "./package-share-modal";

const API = (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:"http://localhost:3001");

type StatusFilter = "ALL" | "ACTIVE" | "INACTIVE";
type ServiceType = "RESIDENTIAL" | "BUSINESS" | "CORPORATE" | "EDUCATIONAL" | "GOVERNMENT";
type DurationType = "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "HALF_YEARLY" | "YEARLY";

type PackageRow = {
  id: number;
  name: string;
  description: string | null;
  invoiceDescription?: string | null;
  serviceType?: ServiceType;
  durationType?: DurationType;
  price: number;
  duration: number;
  isActive: boolean;
  downloadSpeed: number;
  uploadSpeed: number;
  dataQuotaGb: number | null;
  fupDownloadSpeed: number | null;
  fupUploadSpeed: number | null;
  burstDownload: number | null;
  burstUpload: number | null;
  burstThreshold: number | null;
  burstTime: number | null;
  poolId: number | null;
  pool: { id: number; name: string } | null;
  _count?: { subscribers: number };
  settings?: any;
};

type Stats = {
  total: number;
  active: number;
  inactive: number;
  totalSubscribers: number;
};

type Tax = {
  id: number;
  groupName: string;
  name: string;
  type: "FIXED" | "PERCENTAGE" | "FORMULA";
  value: string;
  description?: string;
  isActive: boolean;
};

type Policy = {
  id: number;
  groupName: string;
  attributeName: string;
  attributeType: "TEXT" | "NUMBER" | "DATE" | "BOOLEAN";
  attributeOp: "=" | "!=" | ">" | "<" | ">=" | "<=" | "CONTAINS";
  attributeValue: string;
  description?: string;
};

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

const serviceTypes: ServiceType[] = ["RESIDENTIAL", "BUSINESS", "CORPORATE", "EDUCATIONAL", "GOVERNMENT"];
const durationTypes: DurationType[] = ["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "HALF_YEARLY", "YEARLY"];

// Own file so a mistake here cannot take down the packages page.
import { PackageWizard } from "./package-wizard";
import ImportWizard from "../components/import-wizard";
import { downloadCsv } from "../components/csv-export";
import { PackageTable } from "../components/network-tables";

const packageDefaults = {
  name: "",
  description: "",
  invoiceDescription: "",
  serviceType: "RESIDENTIAL" as ServiceType,
  isActive: true,
  duration: "30",
  durationType: "MONTHLY" as DurationType,
  price: "",
  autoRenew: false,
  allowReseller: false,
  generateInvoice: "AUTOMATIC",
  selfActivation: false,
  carryLeftoverQuota: false,
  carryLeftoverSessions: false,
  customExpiryStatus: "ACTIVE",
  downloadSpeed: "10",
  uploadSpeed: "5",
  fupDownloadSpeed: "",
  fupUploadSpeed: "",
  burstDownload: "",
  burstUpload: "",
  burstThreshold: "",
  burstTime: "",
  dataQuotaGb: "",
  dataQuotaOver: "NOTIFY",
  fupQuotaGb: "",
  sessionQuotaMin: "",
  sessionQuotaOver: "NOTIFY",
  sessionFupQuotaMin: "",
  expirationEnabled: false,
  fixedExpireDay: "",
  fixedExpireDayAcct: "",
  fixedExpireTime: "",
  nextExpiredPackageId: "",
  nextDisabledPackageId: "",
  poolId: "",
  taxIds: [] as number[],
  policyIds: [] as number[],
  allocationIds: [] as number[],
};

export default function PackagesPage() {
  const [token, setToken] = useState<string | null>(null);
  /**
   * The catalogue belongs to the ISP. Everyone else reads it and prices it.
   * Without this the page offered Edit/Delete to accounts the server refuses,
   * which is a permission error dressed up as a button.
   */
  const [me, setMe] = useState<any>(null);
  const isIsp = !me || me.role === "ADMIN" || me.role === "SUPER_ADMIN";
  const [searchQ, setSearchQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [serviceTypeFilter, setServiceTypeFilter] = useState<string>("ALL");
  const [durationTypeFilter, setDurationTypeFilter] = useState<string>("ALL");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" | "warn" } | null>(null);

  // Modal states
  const [showPackageModal, setShowPackageModal] = useState(false);
  const [showTaxModal, setShowTaxModal] = useState(false);
  const [showPolicyModal, setShowPolicyModal] = useState(false);
  const [showAllocationModal, setShowAllocationModal] = useState(false);
  const [showSubscribersModal, setShowSubscribersModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [sharePackage, setSharePackage] = useState<PackageRow | null>(null);
  const [showImport, setShowImport] = useState(false);

  // Group-based package filters used by the package list UI
  const [franchiseGroups, setFranchiseGroups] = useState<Array<{ id: number; name: string; color: string | null }>>([]);
  const [groupFilter, setGroupFilter] = useState("ALL");

  const [editingPackage, setEditingPackage] = useState<PackageRow | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<PackageRow | null>(null);
  const [packageForm, setPackageForm] = useState({ ...packageDefaults });

  const [taxForm, setTaxForm] = useState({
    groupName: "General",
    name: "",
    type: "FIXED",
    value: "",
    description: "",
    isActive: true,
  });

  const [policyForm, setPolicyForm] = useState({
    groupName: "General",
    attributeName: "",
    attributeType: "TEXT",
    attributeOp: "=",
    attributeValue: "",
    description: "",
  });

  const [allocationForm, setAllocationForm] = useState({
    groupName: "General",
    isActive: true,
    days: [] as string[],
    startTime: "00:00",
    endTime: "23:59",
    policyId: "",
    description: "",
  });

  useEffect(() => {
    const t = localStorage.getItem("token");
    setToken(t);
    if (!t) return;
    fetch(`${API}/auth/profile`, { headers: { Authorization: `Bearer ${t}` } })
      .then((r) => (r.ok ? r.json() : null))
      // /auth/profile returns { user: {...} }, not the user itself.
      .then((d) => setMe(d?.user ?? d))
      .catch(silent("authProfileFetch"));
    // Fetch franchise groups
    fetch(`${API}/groups/options`, { headers: { Authorization: `Bearer ${t}` } })
      .then(r => r.ok ? r.json() : [])
      .then(data => setFranchiseGroups(Array.isArray(data) ? data : []))
      .catch(silent("groupsFetch"));
  }, []);

  const queryString = useMemo(() => {
    const q = new URLSearchParams();
    if (searchQ) q.set("q", searchQ);
    if (statusFilter !== "ALL") q.set("status", statusFilter);
    if (serviceTypeFilter !== "ALL") q.set("serviceType", serviceTypeFilter);
    if (durationTypeFilter !== "ALL") q.set("durationType", durationTypeFilter);
    if (groupFilter !== "ALL") q.set("group", groupFilter);
    return q.toString();
  }, [searchQ, statusFilter, serviceTypeFilter, durationTypeFilter, groupFilter]);

  const fetcher = useCallback(async (url: string) => {
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token || ""}`,
      },
    });
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.json();
  }, [token]);

  const { data: packages, mutate: mutatePackages, isLoading } = useSWR<PackageRow[]>(
    token ? `${API}/packages${queryString ? `?${queryString}` : ""}` : null,
    fetcher
  );

  const { data: stats, mutate: mutateStats } = useSWR<Stats>(token ? `${API}/packages/stats` : null, fetcher);
  const { data: pools } = useSWR<Array<{ id: number; name: string }>>(token ? `${API}/ip-pools` : null, fetcher);
  const { data: options, mutate: mutateOptions } = useSWR<{ taxes: Tax[]; policies: Policy[]; allocations: Allocation[] }>(
    token ? `${API}/packages/options` : null,
    fetcher
  );

  const { data: packageSubscribers, mutate: mutateSubscribers } = useSWR<any[]>(
    token && selectedPackage && showSubscribersModal ? `${API}/packages/${selectedPackage.id}/subscribers` : null,
    fetcher
  );

  const showToast = (msg: string, type: "ok" | "err" | "warn" = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2600);
  };

  const pagedPackages = useMemo(() => {
    const list = packages || [];
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    return list.slice(start, end);
  }, [packages, page, pageSize]);

  const totalPages = Math.max(1, Math.ceil((packages?.length || 0) / pageSize));

  const setFormValue = (key: string, value: any) => {
    setPackageForm((prev) => ({ ...prev, [key]: value }));
  };

  const openCreatePackage = () => {
    console.log("Opening create package modal");
    setEditingPackage(null);
    setPackageForm({ ...packageDefaults });
    setShowPackageModal(true);
  };

  const openEditPackage = (pkg: PackageRow) => {
    setEditingPackage(pkg);
    setPackageForm({
      ...packageDefaults,
      name: pkg.name,
      description: pkg.description || "",
      invoiceDescription: pkg.invoiceDescription || pkg.settings?.invoiceDescription || "",
      serviceType: pkg.serviceType || pkg.settings?.serviceType || "RESIDENTIAL",
      isActive: pkg.isActive,
      duration: String(pkg.duration || 30),
      durationType: pkg.durationType || pkg.settings?.durationType || "MONTHLY",
      price: String(pkg.price),
      autoRenew: !!pkg.settings?.autoRenew,
      allowReseller: !!pkg.settings?.allowReseller,
      generateInvoice: pkg.settings?.generateInvoice || "AUTOMATIC",
      selfActivation: !!pkg.settings?.selfActivation,
      carryLeftoverQuota: !!pkg.settings?.carryLeftoverQuota,
      carryLeftoverSessions: !!pkg.settings?.carryLeftoverSessions,
      customExpiryStatus: pkg.settings?.customExpiryStatus || "ACTIVE",
      downloadSpeed: String(pkg.downloadSpeed),
      uploadSpeed: String(pkg.uploadSpeed),
      fupDownloadSpeed: pkg.fupDownloadSpeed ? String(pkg.fupDownloadSpeed) : "",
      fupUploadSpeed: pkg.fupUploadSpeed ? String(pkg.fupUploadSpeed) : "",
      burstDownload: pkg.burstDownload ? String(pkg.burstDownload) : "",
      burstUpload: pkg.burstUpload ? String(pkg.burstUpload) : "",
      burstThreshold: pkg.burstThreshold ? String(pkg.burstThreshold) : "",
      burstTime: pkg.burstTime ? String(pkg.burstTime) : "",
      dataQuotaGb: pkg.dataQuotaGb ? String(pkg.dataQuotaGb) : pkg.settings?.dataQuotaGb ? String(pkg.settings.dataQuotaGb) : "",
      dataQuotaOver: pkg.settings?.dataQuotaOver || "NOTIFY",
      fupQuotaGb: pkg.settings?.fupQuotaGb ? String(pkg.settings.fupQuotaGb) : "",
      sessionQuotaMin: pkg.settings?.sessionQuotaMin ? String(pkg.settings.sessionQuotaMin) : "",
      sessionQuotaOver: pkg.settings?.sessionQuotaOver || "NOTIFY",
      sessionFupQuotaMin: pkg.settings?.sessionFupQuotaMin ? String(pkg.settings.sessionFupQuotaMin) : "",
      expirationEnabled: !!pkg.settings?.expirationEnabled,
      fixedExpireDay: pkg.settings?.fixedExpireDay ? String(pkg.settings.fixedExpireDay) : "",
      fixedExpireDayAcct: pkg.settings?.fixedExpireDayAcct ? String(pkg.settings.fixedExpireDayAcct) : "",
      fixedExpireTime: pkg.settings?.fixedExpireTime || "",
      nextExpiredPackageId: pkg.settings?.nextExpiredPackageId ? String(pkg.settings.nextExpiredPackageId) : "",
      nextDisabledPackageId: pkg.settings?.nextDisabledPackageId ? String(pkg.settings.nextDisabledPackageId) : "",
      poolId: pkg.poolId ? String(pkg.poolId) : "",
      taxIds: Array.isArray(pkg.settings?.taxIds) ? pkg.settings.taxIds : [],
      policyIds: Array.isArray(pkg.settings?.policyIds) ? pkg.settings.policyIds : [],
      allocationIds: Array.isArray(pkg.settings?.allocationIds) ? pkg.settings.allocationIds : [],
    });
    setShowPackageModal(true);
  };

  const openPackageShare = (pkg: PackageRow) => {
    setSharePackage(pkg);
    setShowShareModal(true);
  };

  const submitPackage = async () => {
    if (!packageForm.name.trim()) return showToast("Name is required", "err");
    if (!packageForm.price.trim()) return showToast("Price is required", "err");

    const payload = {
      name: packageForm.name,
      description: packageForm.description,
      invoiceDescription: packageForm.invoiceDescription,
      serviceType: packageForm.serviceType,
      isActive: packageForm.isActive,
      duration: Number(packageForm.duration || 30),
      durationType: packageForm.durationType,
      price: Number(packageForm.price || 0),
      autoRenew: packageForm.autoRenew,
      allowReseller: packageForm.allowReseller,
      generateInvoice: packageForm.generateInvoice,
      selfActivation: packageForm.selfActivation,
      carryLeftoverQuota: packageForm.carryLeftoverQuota,
      carryLeftoverSessions: packageForm.carryLeftoverSessions,
      customExpiryStatus: packageForm.customExpiryStatus,
      downloadSpeed: Number(packageForm.downloadSpeed || 0),
      uploadSpeed: Number(packageForm.uploadSpeed || 0),
      fupDownloadSpeed: packageForm.fupDownloadSpeed ? Number(packageForm.fupDownloadSpeed) : null,
      fupUploadSpeed: packageForm.fupUploadSpeed ? Number(packageForm.fupUploadSpeed) : null,
      burstDownload: packageForm.burstDownload ? Number(packageForm.burstDownload) : null,
      burstUpload: packageForm.burstUpload ? Number(packageForm.burstUpload) : null,
      burstThreshold: packageForm.burstThreshold ? Number(packageForm.burstThreshold) : null,
      burstTime: packageForm.burstTime ? Number(packageForm.burstTime) : null,
      dataQuotaGb: packageForm.dataQuotaGb ? Number(packageForm.dataQuotaGb) : null,
      dataQuotaOver: packageForm.dataQuotaOver,
      fupQuotaGb: packageForm.fupQuotaGb ? Number(packageForm.fupQuotaGb) : null,
      sessionQuotaMin: packageForm.sessionQuotaMin ? Number(packageForm.sessionQuotaMin) : null,
      sessionQuotaOver: packageForm.sessionQuotaOver,
      sessionFupQuotaMin: packageForm.sessionFupQuotaMin ? Number(packageForm.sessionFupQuotaMin) : null,
      expirationEnabled: packageForm.expirationEnabled,
      fixedExpireDay: packageForm.fixedExpireDay ? Number(packageForm.fixedExpireDay) : null,
      fixedExpireDayAcct: packageForm.fixedExpireDayAcct ? Number(packageForm.fixedExpireDayAcct) : null,
      fixedExpireTime: packageForm.fixedExpireTime || null,
      nextExpiredPackageId: packageForm.nextExpiredPackageId ? Number(packageForm.nextExpiredPackageId) : null,
      nextDisabledPackageId: packageForm.nextDisabledPackageId ? Number(packageForm.nextDisabledPackageId) : null,
      poolId: packageForm.poolId ? Number(packageForm.poolId) : null,
      taxIds: packageForm.taxIds,
      policyIds: packageForm.policyIds,
      allocationIds: packageForm.allocationIds,
    };

    const url = editingPackage ? `${API}/packages/${editingPackage.id}` : `${API}/packages`;
    const method = editingPackage ? "PUT" : "POST";

    try {
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token || ""}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        /**
         * Read the message, not the raw body.
         *
         * `res.text()` printed the whole JSON envelope — status code, error
         * name and all — so a plain "Only the ISP can change packages" arrived
         * as an unreadable blob. And returning instead of throwing let the
         * wizard close as though the package had been created.
         */
        const body: any = await res.json().catch(() => null);
        const msg = Array.isArray(body?.message) ? body.message.join(" ") : body?.message;
        const text = msg || `Failed to save (HTTP ${res.status})`;
        showToast(text, "err");
        throw new Error(text);
      }

      setShowPackageModal(false);
      await Promise.all([mutatePackages(), mutateStats()]);
      showToast(editingPackage ? "✅ Package updated" : "✅ Package created", "ok");
    } catch (error: any) {
      if (!error?.__handled) showToast(error?.message || "Failed to save package", "err");
      throw error;
    }
  };

  const togglePackageStatus = async (pkg: PackageRow) => {
    try {
      const res = await fetch(`${API}/packages/${pkg.id}/toggle`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token || ""}`,
        },
      });
      if (!res.ok) return showToast("Failed to toggle status", "err");
      await Promise.all([mutatePackages(), mutateStats()]);
      showToast("Status updated", "ok");
    } catch (error) {
      showToast("Failed to toggle status", "err");
    }
  };

  const duplicatePackage = async (pkg: PackageRow) => {
    try {
      const res = await fetch(`${API}/packages/${pkg.id}/duplicate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token || ""}`,
        },
      });
      if (!res.ok) return showToast("Failed to duplicate", "err");
      await Promise.all([mutatePackages(), mutateStats()]);
      showToast("Package duplicated", "ok");
    } catch (error) {
      showToast("Failed to duplicate", "err");
    }
  };

  const deletePackage = async () => {
    if (!selectedPackage) return;
    try {
      const res = await fetch(`${API}/packages/${selectedPackage.id}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token || ""}`,
        },
      });
      if (!res.ok) return showToast("Delete failed", "err");
      setShowDeleteModal(false);
      setSelectedPackage(null);
      await Promise.all([mutatePackages(), mutateStats()]);
      showToast("Package deleted", "ok");
    } catch (error) {
      showToast("Delete failed", "err");
    }
  };

  const createTax = async () => {
    if (!taxForm.name.trim()) return showToast("Tax name is required", "err");
    try {
      const res = await fetch(`${API}/packages/taxes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token || ""}`,
        },
        body: JSON.stringify(taxForm),
      });
      if (!res.ok) return showToast("Failed to create tax/fee", "err");
      setShowTaxModal(false);
      setTaxForm({ groupName: "General", name: "", type: "FIXED", value: "", description: "", isActive: true });
      await mutateOptions();
      showToast("Tax/Fee created", "ok");
    } catch (error) {
      showToast("Failed to create tax/fee", "err");
    }
  };

  const createPolicy = async () => {
    if (!policyForm.attributeName.trim()) return showToast("Attribute name is required", "err");
    try {
      const res = await fetch(`${API}/packages/policies`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token || ""}`,
        },
        body: JSON.stringify(policyForm),
      });
      if (!res.ok) return showToast("Failed to create policy", "err");
      setShowPolicyModal(false);
      setPolicyForm({ groupName: "General", attributeName: "", attributeType: "TEXT", attributeOp: "=", attributeValue: "", description: "" });
      await mutateOptions();
      showToast("Policy created", "ok");
    } catch (error) {
      showToast("Failed to create policy", "err");
    }
  };

  const createAllocation = async () => {
    if (!allocationForm.groupName.trim()) return showToast("Group name is required", "err");
    try {
      const res = await fetch(`${API}/packages/allocations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token || ""}`,
        },
        body: JSON.stringify({
          ...allocationForm,
          policyId: allocationForm.policyId ? Number(allocationForm.policyId) : null,
        }),
      });
      if (!res.ok) return showToast("Failed to create allocation", "err");
      setShowAllocationModal(false);
      setAllocationForm({ groupName: "General", isActive: true, days: [], startTime: "00:00", endTime: "23:59", policyId: "", description: "" });
      await mutateOptions();
      showToast("Allocation created", "ok");
    } catch (error) {
      showToast("Failed to create allocation", "err");
    }
  };

  // Skeleton rows for loading state
  const skeletonRows = useMemo(() => {
    return Array.from({ length: 6 }).map((_, idx) => (
      <tr key={`skeleton-${idx}`}>
        {Array.from({ length: 10 }).map((__, c) => (
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

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px", marginBottom: "16px" }}>
        {[
          { label: "Total Packages", value: stats?.total ?? 0, color: "#00C9FF" },
          { label: "Active Packages", value: stats?.active ?? 0, color: "#10B981" },
          { label: "Inactive Packages", value: stats?.inactive ?? 0, color: "#ff7070" },
          { label: "Subscribers on Packages", value: stats?.totalSubscribers ?? 0, color: "#f0a500" },
        ].map((s) => (
          <div
            key={s.label}
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: "14px",
              padding: "16px 20px",
              transition: "all 0.2s ease",
            }}
          >
            <div style={{ fontSize: "24px", fontWeight: "800", letterSpacing: "-0.02em", color: s.color }}>{s.value}</div>
            <div style={{ fontSize: "10px", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.1em", color: "rgba(255,255,255,0.25)", marginTop: "6px" }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Tell a reseller what this screen is for, before they hunt for buttons
          that are not theirs. The catalogue is the ISP's; the sharing step lives
          here, and each downline account decides its own onward price. */}
      {me && !isIsp && (
        <div style={{ padding: "12px 16px", marginBottom: 14, borderRadius: 12,
          background: "rgba(56,189,248,.08)", border: "1px solid rgba(56,189,248,.3)",
          fontSize: 12, lineHeight: 1.7, color: "rgba(255,255,255,.65)" }}>
          <b style={{ color: "#7dd3fc" }}>These are the ISP's packages — the price shown is what YOU pay.</b><br />
          You cannot change the speed, quota or the catalogue itself. Share a package to a group here,
          then set your own child pricing in <b>Billing → Reseller Pricing</b>.
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "16px" }}>
        {isIsp && <button
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
          onClick={openCreatePackage}
        >
          Add New Package
        </button>}
        {isIsp && <button
          style={{ padding: "8px 18px", borderRadius: "10px", fontSize: "12px", fontWeight: 600, border: "1px solid var(--border)", cursor: "pointer", background: "var(--surface)", color: "var(--text)" }}
          onClick={() => setShowImport(true)}
        >
          ⬆ Import
        </button>}
        {isIsp && <button
          style={{ padding: "8px 18px", borderRadius: "10px", fontSize: "12px", fontWeight: 600, border: "1px solid var(--border)", cursor: "pointer", background: "var(--surface)", color: "var(--text)" }}
          onClick={() => downloadCsv("packages.csv", (packages || []).map((p:any)=>({ name:p.name, price:p.price, downloadSpeed:p.downloadSpeed, uploadSpeed:p.uploadSpeed })), [
            { key:"name", label:"name" }, { key:"price", label:"price" }, { key:"downloadSpeed", label:"downloadSpeed" }, { key:"uploadSpeed", label:"uploadSpeed" },
          ])}
        >
          ⬇ Export
        </button>}
        {showImport && (
          <ImportWizard
            onClose={() => setShowImport(false)}
            onDone={() => { mutatePackages(); mutateStats(); }}
            config={{
              title: "Import Packages",
              endpoint: "/packages/import",
              required: [{ label: "Name", field: "name" }, { label: "Price", field: "price" }],
              optional: [{ label: "Download (Mbps)", field: "downloadSpeed" }, { label: "Upload (Mbps)", field: "uploadSpeed" }],
              alias: {
                package_name: "name", plan: "name", plan_name: "name", name: "name",
                monthly_price: "price", amount: "price", price: "price",
                download: "downloadSpeed", download_speed: "downloadSpeed", dl: "downloadSpeed",
                upload: "uploadSpeed", upload_speed: "uploadSpeed", ul: "uploadSpeed",
                rate_limit: "rateLimit", validity: "validity", validity_days: "validity",
              },
              drop: ["id", "isp_id", "branch_id"],
              sample: "name,price,downloadSpeed,uploadSpeed\n10MB Home,1500,10,10",
            }}
          />
        )}
        {isIsp && <button
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
          onClick={() => setShowTaxModal(true)}
        >
          Add Tax/Extra Fee
        </button>}
        {isIsp && <button
          style={{
            padding: "8px 18px",
            borderRadius: "10px",
            fontSize: "12px",
            fontWeight: "600",
            border: "none",
            cursor: "pointer",
            background: "#155e75",
            color: "#cffafe",
          }}
          onClick={() => setShowPolicyModal(true)}
        >
          Add Policy
        </button>}
        {isIsp && <button
          style={{
            padding: "8px 18px",
            borderRadius: "10px",
            fontSize: "12px",
            fontWeight: "600",
            border: "none",
            cursor: "pointer",
            background: "#134e4a",
            color: "#99f6e4",
          }}
          onClick={() => setShowAllocationModal(true)}
        >
          Add Allocation
        </button>}
        <a
          style={{
            padding: "8px 18px",
            borderRadius: "10px",
            fontSize: "12px",
            fontWeight: "600",
            border: "1px solid rgba(255,255,255,0.08)",
            cursor: "pointer",
            background: "rgba(255,255,255,0.06)",
            color: "rgba(255,255,255,0.7)",
            textDecoration: "none",
          }}
          href="/packages/taxes"
        >
          Taxes Page
        </a>
        <a
          style={{
            padding: "8px 18px",
            borderRadius: "10px",
            fontSize: "12px",
            fontWeight: "600",
            border: "1px solid rgba(255,255,255,0.08)",
            cursor: "pointer",
            background: "rgba(255,255,255,0.06)",
            color: "rgba(255,255,255,0.7)",
            textDecoration: "none",
          }}
          href="/packages/policies"
        >
          Policies Page
        </a>
        <a
          style={{
            padding: "8px 18px",
            borderRadius: "10px",
            fontSize: "12px",
            fontWeight: "600",
            border: "1px solid rgba(255,255,255,0.08)",
            cursor: "pointer",
            background: "rgba(255,255,255,0.06)",
            color: "rgba(255,255,255,0.7)",
            textDecoration: "none",
          }}
          href="/packages/allocations"
        >
          Allocations Page
        </a>
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
          placeholder="Search package, description, service type"
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
          onChange={(e) => { setStatusFilter(e.target.value as StatusFilter); setPage(1); }}
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
          value={serviceTypeFilter}
          onChange={(e) => { setServiceTypeFilter(e.target.value); setPage(1); }}
        >
          <option value="ALL">All Service Types</option>
          {serviceTypes.map((v) => <option key={v} value={v}>{v}</option>)}
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
          value={durationTypeFilter}
          onChange={(e) => { setDurationTypeFilter(e.target.value); setPage(1); }}
        >
          <option value="ALL">All Duration Types</option>
          {durationTypes.map((v) => <option key={v} value={v}>{v}</option>)}
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
          value={groupFilter}
          onChange={(e) => { setGroupFilter(e.target.value); setPage(1); }}
        >
          <option value="ALL">All Groups</option>
          <option value="UNGROUPED">Ungrouped</option>
          {franchiseGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>

      {/* Table */}
      <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "14px", overflow: "hidden", marginBottom: "12px" }}>
        {isLoading ? (
          <div style={{ textAlign: "center", padding: 50, color: "rgba(255,255,255,0.35)" }}>⏳ Loading packages…</div>
        ) : !pagedPackages.length ? (
          <div style={{ padding: "48px 24px", textAlign: "center", color: "rgba(255,255,255,0.3)" }}>
            <div style={{ fontSize: "48px", marginBottom: "12px" }}>📦</div>
            <div style={{ fontSize: "16px", fontWeight: "600", color: "rgba(255,255,255,0.5)", marginBottom: "4px" }}>No packages found</div>
            <div style={{ fontSize: "13px", color: "rgba(255,255,255,0.2)", marginBottom: 16 }}>Create your first package to get started</div>
            <button
              style={{ padding: "8px 24px", borderRadius: "10px", border: "1px solid rgba(16,185,129,0.2)", background: "transparent", color: "#10B981", fontSize: "13px", fontWeight: "600", cursor: "pointer" }}
              onClick={openCreatePackage}
            >
              + Add Package
            </button>
          </div>
        ) : (
          <PackageTable
            rows={pagedPackages}
            isIsp={isIsp}
            money={money}
            onEdit={openEditPackage}
            onToggle={togglePackageStatus}
            onDelete={(pkg) => { setSelectedPackage(pkg); setShowDeleteModal(true); }}
            onPrice={() => { window.location.href = "/pricing"; }}
            onViewSubs={(pkg) => { setSelectedPackage(pkg); setShowSubscribersModal(true); mutateSubscribers(); }}
            onDuplicate={duplicatePackage}
            onShare={openPackageShare}
          />
        )}
      </div>

      {/* Pagination */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px", fontSize: "13px", color: "rgba(255,255,255,0.35)" }}>
        <div>
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
            {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}/page</option>)}
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <button
            style={{
              padding: "6px 14px",
              borderRadius: "8px",
              border: "1px solid rgba(255,255,255,0.08)",
              background: "transparent",
              color: "rgba(255,255,255,0.5)",
              fontSize: "13px",
              cursor: "pointer",
              opacity: page <= 1 ? "0.3" : "1",
              pointerEvents: page <= 1 ? "none" : "auto",
            }}
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </button>
          <span style={{ padding: "6px 14px", background: "rgba(255,255,255,0.04)", borderRadius: "8px", minWidth: "80px", textAlign: "center", fontFamily: "monospace", fontSize: "12px", color: "rgba(255,255,255,0.4)" }}>Page {page} / {totalPages}</span>
          <button
            style={{
              padding: "6px 14px",
              borderRadius: "8px",
              border: "1px solid rgba(255,255,255,0.08)",
              background: "transparent",
              color: "rgba(255,255,255,0.5)",
              fontSize: "13px",
              cursor: "pointer",
              opacity: page >= totalPages ? "0.3" : "1",
              pointerEvents: page >= totalPages ? "none" : "auto",
            }}
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next
          </button>
        </div>
      </div>

      {/* ============================================================ */}
      {/* ADD PACKAGE MODAL */}
      {/* ============================================================ */}
      {showPackageModal && (
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
            padding: "20px" 
          }} 
          onClick={() => setShowPackageModal(false)}
        >
          <div 
            style={{ 
              background: "var(--surface)", 
              border: "1px solid rgba(255,255,255,0.06)", 
              borderRadius: "20px", 
              padding: "28px", 
              maxWidth: "900px", 
              width: "100%", 
              maxHeight: "90vh", 
              overflowY: "auto" 
            }} 
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#fff" }}>
                {editingPackage ? "✏️ Edit Package" : "➕ Add New Package"}
              </h2>
              <button 
                style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.3)", fontSize: "20px", cursor: "pointer" }} 
                onClick={() => setShowPackageModal(false)}
              >
                ✕
              </button>
            </div>

            {/* Stepped form for NEW packages. Editing keeps the full grid —
                changing one field should not walk through four steps. */}
            {!editingPackage && (
              <PackageWizard
                form={packageForm}
                setForm={setPackageForm}
                onSave={submitPackage}
                onCancel={() => setShowPackageModal(false)}
                pools={(pools || []).map((p: any) => ({ id: p.id, name: p.name }))}
              />
            )}

            {editingPackage && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Name *</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={packageForm.name} onChange={(e) => setFormValue("name", e.target.value)} placeholder="e.g., Premium Plan" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Price * ({currencySymbol()})</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} type="number" value={packageForm.price} onChange={(e) => setFormValue("price", e.target.value)} placeholder="0.00" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Description</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={packageForm.description} onChange={(e) => setFormValue("description", e.target.value)} placeholder="Package description" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Invoice Description</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={packageForm.invoiceDescription} onChange={(e) => setFormValue("invoiceDescription", e.target.value)} placeholder="Invoice line item" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Service Type</label>
                <select style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={packageForm.serviceType} onChange={(e) => setFormValue("serviceType", e.target.value)}>
                  {serviceTypes.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Status</label>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "8px 0" }}>
                  <button
                    style={{
                      width: "44px",
                      height: "24px",
                      background: packageForm.isActive ? "rgba(16,185,129,0.4)" : "rgba(255,255,255,0.08)",
                      borderRadius: "12px",
                      border: "none",
                      cursor: "pointer",
                      position: "relative",
                      transition: "background 0.2s ease",
                    }}
                    onClick={() => setFormValue("isActive", !packageForm.isActive)}
                  >
                    <span style={{
                      position: "absolute",
                      top: "2px",
                      left: packageForm.isActive ? "22px" : "2px",
                      width: "20px",
                      height: "20px",
                      background: "#fff",
                      borderRadius: "50%",
                      transition: "transform 0.2s ease",
                    }} />
                  </button>
                  <span style={{ fontSize: "13px", color: "rgba(255,255,255,0.6)" }}>{packageForm.isActive ? "Active" : "Inactive"}</span>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Duration</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} type="number" value={packageForm.duration} onChange={(e) => setFormValue("duration", e.target.value)} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Duration Type</label>
                <select style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={packageForm.durationType} onChange={(e) => setFormValue("durationType", e.target.value)}>
                  {durationTypes.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Download Speed (Mbps)</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} type="number" value={packageForm.downloadSpeed} onChange={(e) => setFormValue("downloadSpeed", e.target.value)} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Upload Speed (Mbps)</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} type="number" value={packageForm.uploadSpeed} onChange={(e) => setFormValue("uploadSpeed", e.target.value)} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Data Quota (GB)</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} type="number" value={packageForm.dataQuotaGb} onChange={(e) => setFormValue("dataQuotaGb", e.target.value)} />
              </div>

              {/* Speed applied once the quota above is used up. Leaving these
                  empty means the quota is never enforced — the customer simply
                  keeps full speed, which is the right default for unlimited
                  packages. Throttling keeps them connected and billable. */}
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>FUP Download (Mbps)</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} type="number" placeholder="blank = no throttle" value={packageForm.fupDownloadSpeed} onChange={(e) => setFormValue("fupDownloadSpeed", e.target.value)} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>FUP Upload (Mbps)</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} type="number" placeholder="blank = no throttle" value={packageForm.fupUploadSpeed} onChange={(e) => setFormValue("fupUploadSpeed", e.target.value)} />
              </div>

              {/* IP Pool — sent to the NAS as Framed-Pool in the Access-Accept.
                  The name must exist on the MikroTik exactly as written here,
                  otherwise the router ignores it and uses its own profile pool. */}
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>IP Pool</label>
                <select
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }}
                  value={packageForm.poolId}
                  onChange={(e) => setFormValue("poolId", e.target.value)}
                >
                  <option value="">— Router decides (no Framed-Pool sent) —</option>
                  {(pools || []).map((p) => (
                    <option key={p.id} value={String(p.id)}>{p.name}</option>
                  ))}
                </select>
                <span style={{ fontSize: "10.5px", color: "rgba(255,255,255,0.28)" }}>
                  Pool name must match the MikroTik exactly. Leave blank to let the router assign from its own PPPoE profile pool.
                </span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Auto Renew</label>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "8px 0" }}>
                  <button
                    style={{
                      width: "44px",
                      height: "24px",
                      background: packageForm.autoRenew ? "rgba(16,185,129,0.4)" : "rgba(255,255,255,0.08)",
                      borderRadius: "12px",
                      border: "none",
                      cursor: "pointer",
                      position: "relative",
                      transition: "background 0.2s ease",
                    }}
                    onClick={() => setFormValue("autoRenew", !packageForm.autoRenew)}
                  >
                    <span style={{
                      position: "absolute",
                      top: "2px",
                      left: packageForm.autoRenew ? "22px" : "2px",
                      width: "20px",
                      height: "20px",
                      background: "#fff",
                      borderRadius: "50%",
                      transition: "transform 0.2s ease",
                    }} />
                  </button>
                  <span style={{ fontSize: "13px", color: "rgba(255,255,255,0.6)" }}>{packageForm.autoRenew ? "Enabled" : "Disabled"}</span>
                </div>
              </div>
            </div>
            )}

            {/* The wizard carries its own Cancel/Finish. */}
            {editingPackage && (
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "20px", paddingTop: "16px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
              <button 
                style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "1px solid rgba(255,255,255,0.06)", cursor: "pointer", background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.4)" }} 
                onClick={() => setShowPackageModal(false)}
              >
                Cancel
              </button>
              <button 
                style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "none", cursor: "pointer", background: "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)", color: "#fff" }} 
                onClick={submitPackage}
              >
                Update Package
              </button>
            </div>
            )}
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* ADD TAX MODAL */}
      {/* ============================================================ */}
      {showTaxModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }} onClick={() => setShowTaxModal(false)}>
          <div style={{ background: "var(--surface)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "20px", padding: "28px", maxWidth: "600px", width: "100%", maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#fff" }}>➕ Add Tax/Extra Fee</h2>
              <button style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.3)", fontSize: "20px", cursor: "pointer" }} onClick={() => setShowTaxModal(false)}>✕</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Group Name</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={taxForm.groupName} onChange={(e) => setTaxForm((p) => ({ ...p, groupName: e.target.value }))} placeholder="e.g., Service Fees" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Name *</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={taxForm.name} onChange={(e) => setTaxForm((p) => ({ ...p, name: e.target.value }))} placeholder="e.g., Service Tax" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Type</label>
                <select style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={taxForm.type} onChange={(e) => setTaxForm((p) => ({ ...p, type: e.target.value as any }))}>
                  <option value="FIXED">Fixed</option>
                  <option value="PERCENTAGE">Percentage</option>
                  <option value="FORMULA">Formula</option>
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Value *</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={taxForm.value} onChange={(e) => setTaxForm((p) => ({ ...p, value: e.target.value }))} placeholder="e.g., 5, 10%" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", gridColumn: "1 / -1" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Description</label>
                <textarea style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%", minHeight: "60px", resize: "vertical" }} value={taxForm.description} onChange={(e) => setTaxForm((p) => ({ ...p, description: e.target.value }))} placeholder="Optional description..." />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", gridColumn: "1 / -1" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Status</label>
                <select style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={String(taxForm.isActive)} onChange={(e) => setTaxForm((p) => ({ ...p, isActive: e.target.value === "true" }))}>
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "20px", paddingTop: "16px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
              <button style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "1px solid rgba(255,255,255,0.06)", cursor: "pointer", background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.4)" }} onClick={() => setShowTaxModal(false)}>Cancel</button>
              <button style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "none", cursor: "pointer", background: "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)", color: "#fff" }} onClick={createTax}>Create Tax/Fee</button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* ADD POLICY MODAL */}
      {/* ============================================================ */}
      {showPolicyModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }} onClick={() => setShowPolicyModal(false)}>
          <div style={{ background: "var(--surface)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "20px", padding: "28px", maxWidth: "600px", width: "100%", maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#fff" }}>➕ Add Policy</h2>
              <button style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.3)", fontSize: "20px", cursor: "pointer" }} onClick={() => setShowPolicyModal(false)}>✕</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Group Name</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={policyForm.groupName} onChange={(e) => setPolicyForm((p) => ({ ...p, groupName: e.target.value }))} placeholder="e.g., Bandwidth Rules" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Attribute Name *</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={policyForm.attributeName} onChange={(e) => setPolicyForm((p) => ({ ...p, attributeName: e.target.value }))} placeholder="e.g., Download-Speed" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Attribute Type</label>
                <select style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={policyForm.attributeType} onChange={(e) => setPolicyForm((p) => ({ ...p, attributeType: e.target.value as any }))}>
                  <option value="TEXT">Text</option>
                  <option value="NUMBER">Number</option>
                  <option value="DATE">Date</option>
                  <option value="BOOLEAN">Boolean</option>
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Operator</label>
                <select style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={policyForm.attributeOp} onChange={(e) => setPolicyForm((p) => ({ ...p, attributeOp: e.target.value as any }))}>
                  <option value="=">Equals</option>
                  <option value="!=">Not Equals</option>
                  <option value=">">Greater Than</option>
                  <option value="<">Less Than</option>
                  <option value=">=">Greater or Equal</option>
                  <option value="<=">Less or Equal</option>
                  <option value="CONTAINS">Contains</option>
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", gridColumn: "1 / -1" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Attribute Value *</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={policyForm.attributeValue} onChange={(e) => setPolicyForm((p) => ({ ...p, attributeValue: e.target.value }))} placeholder="e.g., 100, true, 'Active'" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", gridColumn: "1 / -1" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Description</label>
                <textarea style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%", minHeight: "60px", resize: "vertical" }} value={policyForm.description} onChange={(e) => setPolicyForm((p) => ({ ...p, description: e.target.value }))} placeholder="Optional description..." />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "20px", paddingTop: "16px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
              <button style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "1px solid rgba(255,255,255,0.06)", cursor: "pointer", background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.4)" }} onClick={() => setShowPolicyModal(false)}>Cancel</button>
              <button style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "none", cursor: "pointer", background: "#155e75", color: "#cffafe" }} onClick={createPolicy}>Create Policy</button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* ADD ALLOCATION MODAL */}
      {/* ============================================================ */}
      {showAllocationModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }} onClick={() => setShowAllocationModal(false)}>
          <div style={{ background: "var(--surface)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "20px", padding: "28px", maxWidth: "600px", width: "100%", maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#fff" }}>➕ Add Allocation</h2>
              <button style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.3)", fontSize: "20px", cursor: "pointer" }} onClick={() => setShowAllocationModal(false)}>✕</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Group Name *</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={allocationForm.groupName} onChange={(e) => setAllocationForm((p) => ({ ...p, groupName: e.target.value }))} placeholder="e.g., Peak Hours" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Status</label>
                <select style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={String(allocationForm.isActive)} onChange={(e) => setAllocationForm((p) => ({ ...p, isActive: e.target.value === "true" }))}>
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Start Time</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} type="time" value={allocationForm.startTime} onChange={(e) => setAllocationForm((p) => ({ ...p, startTime: e.target.value }))} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>End Time</label>
                <input style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} type="time" value={allocationForm.endTime} onChange={(e) => setAllocationForm((p) => ({ ...p, endTime: e.target.value }))} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", gridColumn: "1 / -1" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Policy</label>
                <select style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%" }} value={allocationForm.policyId} onChange={(e) => setAllocationForm((p) => ({ ...p, policyId: e.target.value }))}>
                  <option value="">— No Policy —</option>
                  {(options?.policies || []).map((p) => <option key={p.id} value={p.id}>{p.groupName} / {p.attributeName}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", gridColumn: "1 / -1" }}>
                <label style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Day(s) of Week *</label>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "6px" }}>
                  {["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"].map((d) => (
                    <button
                      key={d}
                      type="button"
                      style={{
                        padding: "8px 4px",
                        borderRadius: "8px",
                        fontSize: "11px",
                        fontWeight: "600",
                        border: allocationForm.days.includes(d) ? "2px solid #10B981" : "1px solid rgba(255,255,255,0.1)",
                        background: allocationForm.days.includes(d) ? "rgba(16,185,129,0.1)" : "rgba(255,255,255,0.03)",
                        color: allocationForm.days.includes(d) ? "#10B981" : "rgba(255,255,255,0.4)",
                        cursor: "pointer",
                      }}
                      onClick={() => {
                        setAllocationForm((p) => ({
                          ...p,
                          days: p.days.includes(d) ? p.days.filter((x) => x !== d) : [...p.days, d],
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
                <textarea style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "10px 14px", color: "var(--text)", fontSize: "13px", width: "100%", minHeight: "60px", resize: "vertical" }} value={allocationForm.description} onChange={(e) => setAllocationForm((p) => ({ ...p, description: e.target.value }))} placeholder="Optional description..." />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "20px", paddingTop: "16px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
              <button style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "1px solid rgba(255,255,255,0.06)", cursor: "pointer", background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.4)" }} onClick={() => setShowAllocationModal(false)}>Cancel</button>
              <button style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "none", cursor: "pointer", background: "#0f766e", color: "#ccfbf1" }} onClick={createAllocation}>Create Allocation</button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* VIEW SUBSCRIBERS MODAL */}
      {/* ============================================================ */}
      {showSubscribersModal && selectedPackage && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }} onClick={() => setShowSubscribersModal(false)}>
          <div style={{ background: "var(--surface)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "20px", padding: "28px", maxWidth: "800px", width: "100%", maxHeight: "80vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#fff" }}>Subscribers on {selectedPackage.name}</h2>
              <button style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.3)", fontSize: "20px", cursor: "pointer" }} onClick={() => setShowSubscribersModal(false)}>✕</button>
            </div>
            <div style={{ border: "1px solid rgba(255,255,255,0.06)", borderRadius: "12px", overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                    <th style={{ padding: "12px 16px", textAlign: "left", fontSize: "11px", fontFamily: "monospace", textTransform: "uppercase", color: "rgba(255,255,255,0.3)" }}>Name</th>
                    <th style={{ padding: "12px 16px", textAlign: "left", fontSize: "11px", fontFamily: "monospace", textTransform: "uppercase", color: "rgba(255,255,255,0.3)" }}>Username</th>
                    <th style={{ padding: "12px 16px", textAlign: "left", fontSize: "11px", fontFamily: "monospace", textTransform: "uppercase", color: "rgba(255,255,255,0.3)" }}>Phone</th>
                    <th style={{ padding: "12px 16px", textAlign: "left", fontSize: "11px", fontFamily: "monospace", textTransform: "uppercase", color: "rgba(255,255,255,0.3)" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(packageSubscribers || []).map((s) => (
                    <tr key={s.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                      <td style={{ padding: "12px 16px", fontSize: "13px" }}>{s.fullName}</td>
                      <td style={{ padding: "12px 16px", fontSize: "13px", color: "rgba(255,255,255,0.5)" }}>{s.username}</td>
                      <td style={{ padding: "12px 16px", fontSize: "13px", color: "rgba(255,255,255,0.5)" }}>{s.phone}</td>
                      <td style={{ padding: "12px 16px", fontSize: "13px" }}>
                        <span style={{
                          padding: "2px 12px",
                          borderRadius: "20px",
                          fontSize: "10px",
                          fontWeight: "600",
                          background: s.status === "ACTIVE" ? "rgba(16,185,129,0.12)" : "rgba(255,112,112,0.12)",
                          color: s.status === "ACTIVE" ? "#10B981" : "#ff7070",
                        }}>
                          {s.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {(packageSubscribers || []).length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ padding: "24px", textAlign: "center", color: "rgba(255,255,255,0.3)" }}>
                        No subscribers on this package
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* DELETE CONFIRMATION MODAL */}
      {/* ============================================================ */}
      {showDeleteModal && selectedPackage && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }} onClick={() => setShowDeleteModal(false)}>
          <div style={{ background: "var(--surface)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "20px", padding: "28px", maxWidth: "450px", width: "100%" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "48px", marginBottom: "12px" }}>🗑️</div>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>Delete Package</h2>
              <p style={{ fontSize: "14px", color: "rgba(255,255,255,0.4)" }}>
                Are you sure you want to delete <strong style={{ color: "#fff" }}>{selectedPackage.name}</strong>? This action cannot be undone.
              </p>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "20px", paddingTop: "16px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
              <button style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "1px solid rgba(255,255,255,0.06)", cursor: "pointer", background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.4)" }} onClick={() => setShowDeleteModal(false)}>Cancel</button>
              <button style={{ padding: "10px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", border: "none", cursor: "pointer", background: "rgba(127,29,29,0.8)", color: "#fecaca" }} onClick={deletePackage}>Delete Forever</button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* PACKAGE SHARE MODAL */}
      {/* ============================================================ */}
      {/* Enhanced Share Modal Component - Handles franchisee pricing */}
      <PackageShareModal
        isOpen={showShareModal}
        onClose={() => {
          setShowShareModal(false);
          setSharePackage(null);
        }}
        package={sharePackage}
        token={token}
        onSuccess={() => {
          mutatePackages();
        }}
      />
    </div>
  );
}