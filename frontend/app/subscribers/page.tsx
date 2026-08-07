"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { money } from "../components/currency";
import { SubscriberTable } from "./subscriber-table";
import { WinBoxToolbar } from "../components/winbox-toolbar";
import { Expandable } from "../components/expandable";
import { Menu } from "../components/menu";
import ImageUpload, { fileUrl } from "../components/image-upload";
import ExportDialog from "../components/export-dialog";
import { silent } from "../components/silent";

// ─── Types ──────────────────────────────────────────────────────────────────
interface Package {
  id: number;
  name: string;
  price: number;
  downloadSpeed: number;
  uploadSpeed: number;
  pool?: { name: string } | null;
}
interface Area    { id: number; name: string; }
interface NasEntry { id: number; nasname: string; nasIp: string | null; isActive: boolean; }
interface Salesperson { id: number; name: string; }

interface Subscriber {
  id: number;
  fullName: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  username: string | null;
  password: string | null;
  identity: string | null;
  connectionType: string;
  status: "ACTIVE" | "EXPIRED" | "SUSPENDED" | "INACTIVE";
  packageId: number | null;
  areaId: number | null;
  nasId: number | null;
  salespersonId: number | null;
  documentUrl: string | null;
  photoUrl?: string | null;
  cnicFrontUrl?: string | null;
  cnicBackUrl?: string | null;
  installationDate: string | null;
  latitude: number | null;
  longitude: number | null;
  createdAt: string;
  package?: Package;
  area?: Area;
  nas?: NasEntry;
  salesperson?: Salesperson;
  serviceSettings?: {
    expiryDate?: string | null;
  } | null;
  // Runtime-only flags added by the API / live-status merge (not columns).
  isStaleSession?: boolean;
  isOnline?: boolean;
}

interface RadiusSession {
  username: string;
  nasipaddress: string;
  framedipaddress: string | null;
  callingstationid: string | null;
  acctstarttime: string | null;
  acctupdatetime?: string | null;
  acctstoptime: string | null;
  duration_seconds: number | null;
  upload_bytes: number | null;
  download_bytes: number | null;
  nasportid?: string | null;
  nasporttype?: string | null;
  framedprotocol?: string | null;
  servicetype?: string | null;
  acctterminatecause?: string | null;
  acctinterval?: number | null;
}

interface RadiusAuth {
  username: string;
  reply: string;
  authdate: string;
}

interface RadiusCheck {
  id: number;
  username: string;
  attribute: string;
  op: string;
  value: string;
}

interface Stats { total: number; active: number; expired: number; suspended: number; }
interface RadiusSyncResult { total: number; success: number; failed: number; }
interface OverviewStats extends Stats {
  onlineNow?: number;
  stale?: number;
  offline?: number;
  todaySignups?: number;
}

const API = (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:"http://localhost:3001");

import { Icons } from "../components/icons";

// ─── Icons (complete set) ──────────────────────────────────────────────────
const Ic = {
  Dashboard:   (p?:any) => <Icons.Dashboard {...p} />,
  Subscribers: (p?:any) => <Icons.Subscribers {...p} />,
  Payments:    (p?:any) => <Icons.Payments {...p} />,
  Invoices:    (p?:any) => <Icons.Invoices {...p} />,
  Packages:    (p?:any) => <Icons.Packages {...p} />,
  Pool:        (p?:any) => <Icons.Pool {...p} />,
  Vouchers:    (p?:any) => <Icons.Vouchers {...p} />,
  NAS:         (p?:any) => <Icons.NAS {...p} />,
  Areas:       (p?:any) => <Icons.Areas {...p} />,
  Complaints:  (p?:any) => <Icons.Complaints {...p} />,
  Reports:     (p?:any) => <Icons.Reports {...p} />,
  Users:       (p?:any) => <Icons.Users {...p} />,
  Logs:        (p?:any) => <Icons.Logs {...p} />,
  Settings:    (p?:any) => <Icons.Settings {...p} />,
  Menu:        (p?:any) => <Icons.Menu {...p} />,
  ChevronLeft: (p?:any) => <Icons.ChevronLeft {...p} />,
  Sun:         (p?:any) => <Icons.Sun {...p} />,
  Moon:        (p?:any) => <Icons.Moon {...p} />,
  Refresh:     (p?:any) => <Icons.Refresh {...p} />,
  Plus:        (p?:any) => <Icons.Plus {...p} />,
  Search:      (p?:any) => <Icons.Search {...p} />,
  Edit:        (p?:any) => <Icons.Edit {...p} />,
  Trash:       (p?:any) => <Icons.Trash {...p} />,
  Logout:      (p?:any) => <Icons.Logout {...p} />,
  X:           (p?:any) => <Icons.X {...p} />,
  Eye:         (p?:any) => <Icons.Eye {...p} />,
  Check:       (p?:any) => <Icons.Check {...p} />,
  Filter:      (p?:any) => <Icons.Filter {...p} />,
  /** Not in shared Icons — keep inline. */
  Shield:  () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Sync:    () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>,
  Network: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><line x1="12" y1="7" x2="5" y2="17"/><line x1="12" y1="7" x2="19" y2="17"/></svg>,
  PPPoE:   () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>,
  Wifi:    () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>,
  Clock:   () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Upload:  () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>,
  Download:() => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg>,
  IP:      () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  Activity:() => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
};

// ─── Helpers ────────────────────────────────────────────────────────────────
const fmtBytes = (b: number | null) => {
  if (!b || b === 0) return "0 B";
  const gb = b / 1073741824;
  if (gb >= 1) return gb.toFixed(2) + " GB";
  const mb = b / 1048576;
  if (mb >= 1) return mb.toFixed(2) + " MB";
  return (b / 1024).toFixed(1) + " KB";
};
const fmtDuration = (secs: number | null) => {
  if (secs === null || secs === undefined) return "—";
  // Never render a negative uptime (clock skew between the NAS and the server).
  const s = Math.max(0, Math.floor(Number(secs) || 0));
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d > 0 ? d + "d " : ""}${h > 0 ? h + "h " : ""}${m}m`;
};
const fmtDate = (s: string | null, full = false) => {
  if (!s) return "—";
  const dt = new Date(s);
  if (full) return dt.toLocaleString();
  return dt.toLocaleDateString();
};

const statusColor = (s: string) => ({
  ACTIVE:    { color: "#4ade80", bg: "#14532d" },
  EXPIRED:   { color: "#f87171", bg: "#450a0a" },
  SUSPENDED: { color: "#fbbf24", bg: "#422006" },
  INACTIVE:  { color: "var(--muted)", bg: "var(--border)" },
}[s] || { color: "var(--muted)", bg: "var(--border)" });

// ─── Main Page ──────────────────────────────────────────────────────────────
// Kept in its own file so a mistake here cannot take down the whole page.
import { SubscriberWizard } from "./subscriber-wizard";

const EMPTY_FORM = {
  fullName: "", phone: "", email: "", address: "", username: "",
  password: "", identity: "", connectionType: "FTTH",
  // How they authenticate — separate from the physical medium above,
  // and from Package.serviceType (the customer segment).
  authMethod: "PPPOE",
  packageId: "", areaId: "", nasId: "", salespersonId: "",
  documentUrl: "", installationDate: "", latitude: "", longitude: "",
  photoUrl: "", cnicFrontUrl: "", cnicBackUrl: "",
  sellPrice: "",
  // Static public IP sold as a monthly add-on. Blank = the customer takes an
  // address from the package pool as normal.
  staticIpAddress: "", staticIpPrice: "",
  status: "ACTIVE",
};

export default function SubscribersPage() {
  const router = useRouter();
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [time, setTime] = useState("");
  const [greeting, setGreeting] = useState("Welcome");

  // Data
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [stats, setStats] = useState<OverviewStats>({ total: 0, active: 0, expired: 0, suspended: 0, onlineNow: 0, offline: 0, todaySignups: 0 });
  const [packages, setPackages] = useState<Package[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [nasList, setNasList] = useState<NasEntry[]>([]);
  const [salespersons, setSalespersons] = useState<Salesperson[]>([]);
  const [loading, setLoading] = useState(true);

  // UI state
  const [searchQ, setSearchQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [connectionFilter, setConnectionFilter] = useState<string>("ALL");
  const [packageFilter, setPackageFilter] = useState<string>("ALL");
  const [salespersonFilter, setSalespersonFilter] = useState<string>("ALL");
  const [nasFilter, setNasFilter] = useState<string>("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  // Ownership transfer between accounts in the caller's own tree.
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferAccounts, setTransferAccounts] = useState<any[]>([]);
  const [transferTo, setTransferTo] = useState<string>("");
  const [transferReason, setTransferReason] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  /**
   * Charge the receiving account for the unserved days? On by default, because
   * a normal hand-over is a sale. Turned off when seeding an account that has
   * no wallet yet — otherwise the first transfer is blocked by its own
   * balance check and there is no way to get started.
   */
  const [transferSettle, setTransferSettle] = useState(true);
  /** Guards the delete confirm button against double submission. */
  const [deleteBusy, setDeleteBusy] = useState(false);
  /** Allow deleting a subscriber who has recorded payments. Off by default. */
  const [deleteForce, setDeleteForce] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [showActivationModal, setShowActivationModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showMassDeleteModal, setShowMassDeleteModal] = useState(false);
  const [showMassSettingsModal, setShowMassSettingsModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [activationForm, setActivationForm] = useState({
    subscriberId: "",
    packageId: "",
    // FULL | DAYS | DATE | BALANCE | CREDIT — see the mode buttons in the modal.
    mode: "FULL",
    days: "",
    payBy: "",
    customExpiryDate: false,
    expiryDateTime: "",
    addExtraFee: false,
    extraFeeAmount: "",
    paymentMethod: "CASH",
    notes: "",
  });
  /** Server-priced preview of the pending renewal. */
  const [quote, setQuote] = useState<any>(null);
  const [importType, setImportType] = useState<"CSV" | "EXCEL">("CSV");
  const [importRaw, setImportRaw] = useState("");
  const [importFileName, setImportFileName] = useState("");
  const importFileRef = useRef<HTMLInputElement>(null);
  // Per-VALUE mapping of a foreign panel's ids/names to THIS panel. Keyed by the
  // raw value found in the file ("1", "5MB Home", "10.10.10.10"), each maps to a
  // local id. Values that already match locally (by id, name or IP) auto-resolve;
  // only the genuine mismatches need a manual pick.
  const [nasMap, setNasMap] = useState<Record<string, string>>({});
  const [pkgMap, setPkgMap] = useState<Record<string, string>>({});
  const [importSalespersonId, setImportSalespersonId] = useState("");
  const [massSettingsForm, setMassSettingsForm] = useState<any>({ profileStatus: "ACTIVE", connectionType: "FTTH", discountAmountType: "PERCENTAGE" });
  const [exportType, setExportType] = useState<"CSV" | "EXCEL">("CSV");
  const [showForm, setShowForm] = useState(false);
  const [editSub, setEditSub] = useState<Subscriber | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [formSaving, setFormSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<Subscriber | null>(null);
  const [detailSub, setDetailSub] = useState<Subscriber | null>(null);
  const [radiusCheckMap, setRadiusCheckMap] = useState<Record<number, { existsInRadius: boolean; loading: boolean }>>({});
  const [bulkSyncing, setBulkSyncing] = useState(false);
  const [bulkResult, setBulkResult] = useState<RadiusSyncResult | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" | "warn" } | null>(null);
  const [showPw, setShowPw] = useState(false);

  // Detail modal tabs & RADIUS live data
  const [detailActiveTab, setDetailActiveTab] = useState("Profile");
  // The router's own log for the open subscriber, plus the panel's reading of
  // it. This is what answers "why can't this customer stay connected".
  const [routerLog, setRouterLog] = useState<any>(null);
  const [routerBusy, setRouterBusy] = useState(false);
  const [liveSession, setLiveSession] = useState<RadiusSession | null>(null);
  const [sessionLogs, setSessionLogs] = useState<RadiusSession[]>([]);
  const [authLogs, setAuthLogs] = useState<RadiusAuth[]>([]);
  const [radiusChecks, setRadiusChecks] = useState<RadiusCheck[]>([]);
  /** radreply rows — what address and speed the customer is actually given. */
  const [radiusReply, setRadiusReply] = useState<any[]>([]);
  const [radiusOnline, setRadiusOnline] = useState<boolean | null>(null);
  const [loadingLive, setLoadingLive] = useState(false);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  // RADIUS server info (live, from backend .env) + details popup
  const [radiusInfo, setRadiusInfo] = useState<any>(null);
  const [showRadiusDetail, setShowRadiusDetail] = useState(false);
  useEffect(() => {
    if (!token) return;
    fetch(`${API}/nas/radius/stats`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setRadiusInfo(d))
      .catch(silent("radiusStatsFetch"));
  }, [token]);

  // Theme
  const d = darkMode;
  const t = {
    bg: d ? "var(--bg)" : "#f0f4fa",
    sidebar: d ? "var(--surface)" : "var(--border)",
    card: d ? "var(--surface)" : "#ffffff",
    cardBorder: d ? "var(--border)" : "var(--text)",
    header: d ? "var(--surface)" : "var(--border)",
    text: d ? "var(--text)" : "var(--surface)",
    textMuted: d ? "var(--muted)" : "var(--muted)",
    textSub: d ? "var(--muted)" : "#475569",
    input: d ? "var(--bg)" : "#f8fafc",
    inputBorder: d ? "var(--border)" : "#cbd5e1",
    tableRow: d ? "var(--surface-2)" : "#f8fafc",
    tableRow2: d ? "#121d30" : "#ffffff",
    accent: "#0ea5e9",
    green: "#22c55e",
    red: "#ef4444",
    amber: "#f59e0b",
    purple: "#8b5cf6",
  };

  const showToast = (msg: string, type: "ok" | "err" | "warn" = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // ── Data fetching ─────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [subRes, statsRes, pkgRes, areaRes, nasRes, usersRes] = await Promise.all([
        fetch(`${API}/subscribers`, { headers }),
        fetch(`${API}/subscribers/overview`, { headers }),
        fetch(`${API}/packages`, { headers }),
        fetch(`${API}/areas`, { headers }),
        fetch(`${API}/nas`, { headers }),
        fetch(`${API}/users`, { headers }),
      ]);
      if (subRes.ok) setSubscribers(await subRes.json());
      if (statsRes.ok) setStats(await statsRes.json());
      if (pkgRes.ok) setPackages(await pkgRes.json());
      if (areaRes.ok) setAreas(await areaRes.json());
      if (nasRes.ok) setNasList(await nasRes.json());
      if (usersRes.ok) setSalespersons(await usersRes.json());
    } catch {
      showToast("Failed to load data", "err");
    }
    setLoading(false);
  }, []);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      loadAll();
      return;
    }
    try {
      const res = await fetch(`${API}/subscribers/search?q=${encodeURIComponent(q)}`, { headers });
      if (res.ok) setSubscribers(await res.json());
    } catch { /* ignore */ }
  }, [loadAll]);

  const searchRef = useRef<NodeJS.Timeout | null>(null);
  const onSearch = (q: string) => {
    setSearchQ(q);
    if (searchRef.current) clearTimeout(searchRef.current);
    searchRef.current = setTimeout(() => doSearch(q), 400);
  };

  // ── RADIUS helpers ────────────────────────────────────────────────────────
  const checkRadiusStatus = async (sub: Subscriber) => {
    if (!sub.username) return;
    setRadiusCheckMap((p) => ({ ...p, [sub.id]: { existsInRadius: false, loading: true } }));
    try {
      const res = await fetch(`${API}/subscribers/radius-status/${sub.username}`, { headers });
      if (res.ok) {
        const data = await res.json();
        setRadiusCheckMap((p) => ({ ...p, [sub.id]: { existsInRadius: data.existsInRadius, loading: false } }));
      } else {
        setRadiusCheckMap((p) => ({ ...p, [sub.id]: { existsInRadius: false, loading: false } }));
      }
    } catch {
      setRadiusCheckMap((p) => ({ ...p, [sub.id]: { existsInRadius: false, loading: false } }));
    }
  };

  const bulkSyncToRadius = async () => {
    setBulkSyncing(true);
    setBulkResult(null);
    try {
      const res = await fetch(`${API}/subscribers/sync-all-to-radius`, { method: "POST", headers });
      if (res.ok) {
        const data: RadiusSyncResult = await res.json();
        setBulkResult(data);
        showToast(`Bulk sync: ${data.success}/${data.total} synced`, data.failed > 0 ? "warn" : "ok");
      } else {
        showToast("Bulk sync failed", "err");
      }
    } catch (e: any) {
      showToast(e.message, "err");
    }
    setBulkSyncing(false);
  };

  // Load RADIUS live data for detail modal
  const loadRadiusLiveData = async (username: string) => {
    if (!username) return;
    setLoadingLive(true);
    try {
      const [sessionRes, authRes, checksRes, statusRes] = await Promise.all([
        fetch(`${API}/subscribers/radius-session/${username}`, { headers }),
        fetch(`${API}/subscribers/radius-auth-log/${username}`, { headers }),
        fetch(`${API}/subscribers/radius-checks/${username}`, { headers }),
        // Carries radreply — the address and speed actually being handed out.
        fetch(`${API}/subscribers/radius-status/${username}`, { headers }),
      ]);
      if (sessionRes.ok) {
        const data = await sessionRes.json();
        setLiveSession(data.session || null);
        setRadiusOnline(!!data.session);
        setSessionLogs(data.history || []);
      }
      if (authRes.ok) setAuthLogs(await authRes.json());
      if (checksRes.ok) setRadiusChecks(await checksRes.json());
      if (statusRes.ok) {
        const st = await statusRes.json();
        setRadiusReply(st?.profile?.radreply || []);
      }
    } catch (error) {
      // Usually just the backend restarting while the 20s auto-refresh fires —
      // not worth alarming the user or spamming the console.
      console.debug("RADIUS live data unavailable (backend restarting?)", error);
    }
    setLoadingLive(false);
  };

  const refreshDetailLive = async () => {
    if (detailSub?.username) {
      await loadRadiusLiveData(detailSub.username);
      showToast("Live data refreshed", "ok");
    }
  };

  // Auto-refresh the open subscriber's live session every 20s. The backend
  // pulls real counters from the router's interface stats on each poll, so this
  // shows genuine live usage without the user clicking Refresh.
  useEffect(() => {
    if (!detailSub?.username) return;
    const iv = setInterval(() => {
      loadRadiusLiveData(detailSub.username!);
    }, 20_000);
    return () => clearInterval(iv);
  }, [detailSub?.username]);

  // ── CRUD ──────────────────────────────────────────────────────────────────
  const saveSub = async () => {
    if (!form.fullName.trim()) { showToast("Full name is required", "err"); return; }
    if (!form.username.trim()) { showToast("Username is required for PPPoE", "err"); return; }
    if (!form.password.trim()) { showToast("Password is required for PPPoE", "err"); return; }
    setFormSaving(true);
    try {
      const url = editSub ? `${API}/subscribers/${editSub.id}` : `${API}/subscribers`;
      const method = editSub ? "PUT" : "POST";

      // DATA-LOSS GUARD (edit only): never send blank relation/date fields.
      // If a dropdown hasn't finished loading its options, React renders it
      // empty and we'd post "" — which the API used to store as NULL, silently
      // erasing the subscriber's package, area, NAS, salesperson and dates.
      // Omitting the key entirely tells the API to leave that column untouched.
      const payload: any = { ...form };
      if (editSub) {
        for (const k of ["packageId", "areaId", "nasId", "salespersonId",
                         "installationDate", "latitude", "longitude"]) {
          if (payload[k] === "" || payload[k] === null || payload[k] === undefined) {
            delete payload[k];
          }
        }
      }

      // The static IP lives in its own register with its own billing cycle, so
      // it is not part of the subscriber row. Strip it before saving and apply
      // it separately once we know the subscriber's id.
      const wantedIp = String(payload.staticIpAddress || "").trim();
      const wantedIpPrice = payload.staticIpPrice;
      delete payload.staticIpAddress;
      delete payload.staticIpPrice;

      const res = await fetch(url, { method, headers, body: JSON.stringify(payload) });
      if (!res.ok) {
        const e = await res.json().catch(() => ({} as any));
        const msg = Array.isArray(e?.message) ? e.message.join(" ") : e?.message;
        showToast(msg || "Save failed", "err");
        /**
         * THROW, don't just toast.
         *
         * The wizard needs to know the save failed so it can keep the dialog
         * open on the review step with every value intact. Swallowing the
         * failure here left the form looking as though nothing had happened —
         * or worse, closing as though it had worked.
         */
        throw new Error(msg || `Save failed (HTTP ${res.status})`);
      } else {
        const saved = await res.json().catch(() => null);
        const subId = editSub?.id ?? saved?.id ?? saved?.subscriber?.id;
        let ipNote = "";

        if (subId) {
          const currentIp = editSub ? (editSub as any).staticIp?.ipAddress || "" : "";
          try {
            if (wantedIp) {
              const r = await fetch(`${API}/static-ips/subscriber/${subId}`, {
                method: "POST", headers,
                body: JSON.stringify({
                  ipAddress: wantedIp,
                  monthlyPrice: wantedIpPrice ? Number(wantedIpPrice) : undefined,
                }),
              });
              const d = await r.json();
              if (!r.ok) throw new Error(d?.message || "Static IP could not be set");
              ipNote = d.reconnected
                ? ` · ${d.ipAddress} live now`
                : ` · ${d.ipAddress} applies on next connection`;
            } else if (currentIp && (editSub as any).staticIp?.id) {
              // Field cleared — release the address and stop the monthly charge.
              await fetch(`${API}/static-ips/${(editSub as any).staticIp.id}/release`, {
                method: "PATCH", headers,
                body: JSON.stringify({ reason: "Cleared on the subscriber form" }),
              });
              ipNote = " · static IP removed, billing stopped";
            }
          } catch (ipErr: any) {
            // The subscriber saved fine — say so, and be specific about the
            // part that didn't, rather than reporting a blanket failure.
            showToast(`Subscriber saved, but: ${ipErr.message}`, "warn");
            setShowForm(false);
            await loadAll();
            setFormSaving(false);
            return;
          }
        }

        // A subscriber saved without enough wallet balance exists but has NO
        // internet. Reporting that as a plain success is how someone walks
        // away believing a customer is connected when they are not.
        if (saved?.warning || saved?.activated === false) {
          showToast(saved.warning || "Saved, but not activated — no internet yet.", "warn");
        } else {
          showToast(
            (editSub ? "Subscriber updated & synced to RADIUS" : "Subscriber created – RADIUS access granted") + ipNote,
            "ok",
          );
        }
        setShowForm(false);
        await loadAll();
      }
    } catch (e: any) {
      showToast(e.message, "err");
      setFormSaving(false);
      // Re-throw so the wizard keeps the dialog open and shows the reason.
      throw e;
    }
    setFormSaving(false);
  };

  /**
   * Stop service and hand the addresses back, without deleting anything.
   * Invoices, payments and history survive, so the accounting still balances.
   */
  const deactivateSub = async (sub: Subscriber) => {
    if (!confirm(
      `Deactivate ${sub.fullName}?\n\n` +
      `• Their internet stops immediately (live session is cut)\n` +
      `• Any static IP goes back to the pool for reuse\n` +
      `• Invoices, payments and history are kept\n\n` +
      `This is reversible — you can reactivate them later.`
    )) return;
    try {
      const res = await fetch(`${API}/subscribers/${sub.id}/deactivate`, {
        method: "POST", headers, body: JSON.stringify({}),
      });
      const d = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        const msg = Array.isArray(d?.message) ? d.message.join(" ") : d?.message;
        showToast(msg || `Deactivate failed (HTTP ${res.status})`, "err");
        return;
      }
      showToast(d.message || `${sub.fullName} deactivated`, "ok");
      await loadAll();
    } catch (e: any) { showToast(e.message, "err"); }
  };

  const deleteSub = async (sub: Subscriber) => {
    /**
     * One request per click.
     *
     * The backend log showed each delete arriving TWICE, interleaved — the
     * confirm button had nothing stopping a second click while the first was
     * still in flight, so two deletes raced each other. With RADIUS removal
     * running first, that meant a live customer was disconnected twice over.
     */
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(
        `${API}/subscribers/${sub.id}${deleteForce ? "?force=true" : ""}`,
        { method: "DELETE", headers },
      );
      if (res.ok) {
        showToast(`"${sub.fullName}" removed from CRM, RADIUS and the router`, "ok");
        setDeleteConfirm(null);
        setDeleteForce(false);
        setDetailSub(null);
        await loadAll();
      } else {
        /**
         * Show WHY. This threw away the server's message and printed a bare
         * "Delete failed", so a foreign-key error, a permission refusal and a
         * payments guard all looked identical — leaving nothing to act on but
         * clicking Delete again, which is exactly what happened.
         */
        const d = await res.json().catch(() => ({} as any));
        const msg = Array.isArray(d?.message) ? d.message.join(" ") : d?.message;
        showToast(msg || `Delete failed (HTTP ${res.status})`, "err");
      }
    } catch (e: any) {
      showToast(e.message, "err");
    } finally {
      setDeleteBusy(false);
    }
  };

  // Price the renewal on the server as the operator changes the form. Doing
  // this client-side would duplicate the pro-rata rules and eventually
  // disagree with what actually gets charged.
  useEffect(() => {
    const f = activationForm;
    if (!showActivationModal || !f.subscriberId || !f.packageId) { setQuote(null); return; }
    if ((f.mode === "DAYS" || f.mode === "CREDIT") && !f.days) { setQuote(null); return; }
    if (f.mode === "DATE" && !f.expiryDateTime) { setQuote(null); return; }

    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/subscribers/renew/quote`, {
          method: "POST", headers,
          body: JSON.stringify({
            subscriberId: Number(f.subscriberId),
            packageId: Number(f.packageId),
            mode: f.mode,
            days: f.days ? Number(f.days) : undefined,
            expiryDate: f.expiryDateTime || undefined,
            extraFee: f.addExtraFee ? Number(f.extraFeeAmount || 0) : 0,
          }),
        });
        const d = await r.json();
        setQuote(r.ok ? d : { error: d?.message || "Cannot price this renewal" });
      } catch { setQuote(null); }
    }, 250); // debounce so typing a day count doesn't spam the API
    return () => clearTimeout(timer);
  }, [showActivationModal, activationForm]);

  const runActivation = async () => {
    if (!activationForm.subscriberId || !activationForm.packageId) {
      showToast("Select subscriber and package", "err");
      return;
    }
    const f = activationForm;
    const extra = f.addExtraFee ? Number(f.extraFeeAmount || 0) : 0;

    try {
      // Credit takes no money, so it goes down its own path — it records a
      // debt against whoever approved it rather than an invoice and payment.
      if (f.mode === "CREDIT") {
        const res = await fetch(`${API}/subscribers/renew/credit/${Number(f.subscriberId)}`, {
          method: "POST", headers,
          body: JSON.stringify({
            days: Number(f.days || 0),
            packageId: Number(f.packageId),
            reason: f.notes || null,
            payBy: f.payBy || null,
          }),
        });
        const d = await res.json();
        if (!res.ok) { showToast(d.message || "Could not grant credit", "err"); return; }

        // The credit is only the debt record — the service still has to be
        // switched on for the days granted.
        await fetch(`${API}/subscribers/activate-renewal`, {
          method: "POST", headers,
          body: JSON.stringify({
            subscriberId: Number(f.subscriberId),
            packageId: Number(f.packageId),
            mode: "DAYS",
            days: Number(f.days || 0),
            extraFeeAmount: extra,
            paymentMethod: "CASH",
            notes: `On credit — ${f.notes || "no reason given"}`,
            skipPayment: true,
          }),
        });

        showToast(`Activated on credit — ${money(d.quote?.total ?? 0)} owed`, "warn");
        setShowActivationModal(false);
        await loadAll();
        return;
      }

      const res = await fetch(`${API}/subscribers/activate-renewal`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          subscriberId: Number(f.subscriberId),
          packageId: Number(f.packageId),
          mode: f.mode,
          days: f.days ? Number(f.days) : undefined,
          expiryDateTime: f.expiryDateTime || null,
          customExpiryDate: f.mode === "DATE",
          addExtraFee: f.addExtraFee,
          extraFeeAmount: extra,
          paymentMethod: f.paymentMethod,
          notes: f.notes,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        showToast(err.message || "Activation failed", "err");
        return;
      }
      const d = await res.json();
      showToast(
        `Activated until ${new Date(d.expiryDate ?? quote?.newExpiry).toLocaleDateString()}`,
        "ok",
      );
      setShowActivationModal(false);
      await loadAll();
    } catch (error: any) {
      showToast(error.message || "Activation failed", "err");
    }
  };

  /**
   * Read an uploaded file into the import box. CSV/TXT/JSON are read as text;
   * Excel (.xlsx/.xls) is parsed to CSV in the browser (SheetJS) so the rest of
   * the import flow is unchanged. This is what "upload a file" should mean —
   * no copy-paste.
   */
  const onImportFile = async (file?: File | null) => {
    if (!file) return;
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
        const XLSX: any = await import("xlsx");
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        setImportRaw(XLSX.utils.sheet_to_csv(ws));
        setImportType("EXCEL");
      } else {
        setImportRaw(await file.text());
        setImportType("CSV");
      }
      setImportFileName(file.name);
      showToast(`Loaded "${file.name}"`, "ok");
    } catch (e: any) {
      showToast(`Could not read file: ${e?.message || e}`, "err");
    }
  };

  // ---- Foreign id/name → local id resolution -------------------------------
  const normVal = (v: any) => String(v ?? "").trim().toLowerCase();
  /** The NAS reference a row carries, whatever column the source panel used. */
  const rowNasVal = (r: any) => String(r.nasId ?? r.nas ?? r.nasName ?? r.nas_name ?? r.nasIp ?? r.nas_ip ?? "").trim();
  const rowPkgVal = (r: any) => String(r.packageId ?? r.package ?? r.packageName ?? r.package_name ?? r.plan ?? r.planName ?? "").trim();
  /** Auto-match a file value to a local NAS by id, name/shortname, or IP. */
  const autoNas = (val: string): string | null => {
    const v = normVal(val);
    if (!v) return null;
    const hit = nasList.find((n) =>
      String(n.id) === v || normVal(n.nasname) === v ||
      normVal((n as any).shortname) === v || normVal((n as any).nasIp) === v);
    return hit ? String(hit.id) : null;
  };
  const autoPkg = (val: string): string | null => {
    const v = normVal(val);
    if (!v) return null;
    const hit = packages.find((p) => String(p.id) === v || normVal(p.name) === v);
    return hit ? String(hit.id) : null;
  };
  /** Final resolution = manual pick if any, else auto-match. */
  const resolveNas = (val: string) => nasMap[val] || autoNas(val);
  const resolvePkg = (val: string) => pkgMap[val] || autoPkg(val);

  /** Map the many header spellings other panels use → our canonical fields. */
  const IMPORT_ALIAS: Record<string, string> = {
    full_name: "fullName", fullname: "fullName", name: "fullName", customer_name: "fullName",
    user_name: "username", login: "username", username: "username",
    connection_password: "password", connectionpassword: "password", connection_pass: "password", pass: "password", password: "password",
    cnic: "identity", cnic_number: "identity", nic: "identity", national_id: "identity", identity: "identity",
    mobile: "phone", contact: "phone", phone_number: "phone", phone: "phone",
    email: "email", e_mail: "email",
    nas_id: "nasId", nasid: "nasId", nas: "nasId", nas_name: "nasId", nas_ip: "nasId",
    package_id: "packageId", packageid: "packageId", plan_id: "packageId", plan: "packageId", package_name: "packageId", package: "packageId",
    connection_type: "connectionType", conn_type: "connectionType",
    profile_status: "status", profilestatus: "status", status: "status",
    static_ip: "staticIp", mac_address: "macAddress", previous_balance: "previousBalance",
    address: "address", expiration_date: "expiryDate", expiry_date: "expiryDate", join_date: "joinDate",
  };
  // Foreign panel tree/geo ids that mean nothing here — dropped so they can't
  // leak in. The salesperson chosen in the dialog anchors the tree instead.
  const IMPORT_DROP = new Set([
    "isp_id", "branch_id", "salesperson_id", "subarea_id", "area_id", "city_id",
    "province_id", "country_id", "department_id", "id", "subscriber_id",
  ]);

  /** RFC-ish CSV parser: handles quoted fields, escaped quotes and commas inside quotes. */
  const parseCsv = (text: string): string[][] => {
    const rows: string[][] = [];
    let row: string[] = [], field = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  };

  /** Parse the import box (JSON array or CSV) into canonical row objects. */
  const parseImportRows = (): any[] | null => {
    const raw = importRaw.trim();
    if (!raw) return [];
    try {
      const canon = (r: Record<string, any>) => {
        const obj: Record<string, any> = {};
        for (const k of Object.keys(r)) {
          const key = k.trim().toLowerCase();
          if (IMPORT_DROP.has(key)) continue;
          const dest = IMPORT_ALIAS[key] || k.trim();
          const v = typeof r[k] === "string" ? r[k].trim() : r[k];
          if (obj[dest] === undefined || obj[dest] === "") obj[dest] = v;
        }
        return obj;
      };
      if (raw.startsWith("[")) return (JSON.parse(raw) as any[]).map(canon);
      const grid = parseCsv(raw).filter((r) => r.some((c) => c.trim() !== ""));
      if (grid.length < 2) return [];
      const headers = grid[0].map((h) => h.trim());
      return grid.slice(1).map((cols) => {
        const o: Record<string, string> = {};
        headers.forEach((h, idx) => { o[h] = (cols[idx] ?? "").trim(); });
        return canon(o);
      });
    } catch {
      return null;
    }
  };

  const runImport = async () => {
    if (!importRaw.trim()) {
      showToast("Upload a file or paste CSV/JSON first", "warn");
      return;
    }

    let rows = parseImportRows();
    if (rows === null) {
      showToast("Invalid import payload. Use CSV or JSON array", "err");
      return;
    }
    if (rows.length === 0) { showToast("No rows found in the file", "warn"); return; }

    // Only the essentials are enforced. If any are missing, stop with a clear
    // pointer to the first offending spreadsheet row — otherwise proceed.
    const REQ = ["fullName", "username", "password"];
    const missing = rows
      .map((r, i) => ({ i, bad: REQ.filter((f) => !String(r[f] ?? "").trim()) }))
      .filter((x) => x.bad.length);
    if (missing.length) {
      showToast(`${missing.length} row(s) missing required fields — e.g. row ${missing[0].i + 2}: ${missing[0].bad.join(", ")}`, "err");
      return;
    }

    // Translate each row's NAS and package reference to THIS panel's id, using
    // the auto-match + any manual mapping. Rows whose value can't be resolved
    // are blocked below so nothing foreign reaches the database.
    const unresolved: string[] = [];
    rows = rows.map((r, i) => {
      const out = { ...r };
      const nv = rowNasVal(r);
      if (nv) {
        const id = resolveNas(nv);
        if (id) { out.nasId = Number(id); out.nas = Number(id); }
        else unresolved.push(`row ${i + 2}: NAS "${nv}"`);
      }
      const pv = rowPkgVal(r);
      if (pv) {
        const id = resolvePkg(pv);
        if (id) { out.packageId = Number(id); out.package = Number(id); }
        else unresolved.push(`row ${i + 2}: package "${pv}"`);
      }
      return out;
    });
    if (unresolved.length) {
      showToast(`Map these first: ${unresolved.slice(0, 4).join("; ")}${unresolved.length > 4 ? "…" : ""}`, "err");
      return;
    }

    try {
      const res = await fetch(`${API}/subscribers/import`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          rows,
          salespersonId: importSalespersonId ? Number(importSalespersonId) : null,
          importType,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.message || "Import failed", "err");
        return;
      }
      showToast(`Import done: ${data.success}/${data.total}`, data.failed > 0 ? "warn" : "ok");
      setShowImportModal(false);
      await loadAll();
    } catch (error: any) {
      showToast(error.message || "Import failed", "err");
    }
  };

  /**
   * Move selected subscribers to another account in your own tree.
   *
   * Nothing about the customer's service changes — same username, same package,
   * same expiry. What moves is who owns them commercially, and the money for
   * the days not yet served: the old owner is refunded pro-rata, the new owner
   * is charged pro-rata at THEIR buy price, which may differ.
   */
  const openTransfer = async () => {
    if (selectedIds.length === 0) return showToast("Select subscribers first", "warn");
    setTransferTo("");
    setTransferReason("");
    setShowTransferModal(true);
    try {
      const r = await fetch(`${API}/users`, { headers });
      const rows = r.ok ? await r.json() : [];
      setTransferAccounts(Array.isArray(rows) ? rows : rows?.data ?? []);
    } catch { setTransferAccounts([]); }
  };

  const runTransfer = async () => {
    if (!transferTo) return showToast("Choose the account to move them to", "warn");
    setTransferBusy(true);
    try {
      const res = await fetch(`${API}/subscribers/bulk-transfer`, {
        method: "POST", headers,
        body: JSON.stringify({
          ids: selectedIds,
          toUserId: Number(transferTo),
          reason: transferReason || undefined,
          settle: transferSettle,
        }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.message || "Transfer failed", "err"); return; }

      // Per-subscriber results: one can be refused (e.g. the receiving wallet
      // cannot cover the unserved days) while the rest succeed. Reporting only
      // a total would hide which customer did not move.
      const failed = (data.results || []).filter((r: any) => r.transferred === false);
      if (failed.length) {
        showToast(`Moved ${data.moved}/${data.total}. Not moved: ${failed[0].error}`, "warn");
      } else {
        showToast(`Moved ${data.moved} subscriber(s)`, "ok");
        setShowTransferModal(false);
        setSelectedIds([]);
      }
      await loadAll();
    } catch (e: any) { showToast(e.message || "Transfer failed", "err"); }
    finally { setTransferBusy(false); }
  };

  const runMassDelete = async () => {
    if (selectedIds.length === 0) {
      showToast("No subscribers selected", "warn");
      return;
    }
    try {
      const res = await fetch(`${API}/subscribers/bulk-delete`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ ids: selectedIds }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.message || "Mass delete failed", "err");
        return;
      }
      showToast(`Deleted: ${data.success}/${data.total}`, data.failed > 0 ? "warn" : "ok");
      setSelectedIds([]);
      setShowMassDeleteModal(false);
      await loadAll();
    } catch (error: any) {
      showToast(error.message || "Mass delete failed", "err");
    }
  };

  const runMassSettings = async () => {
    if (selectedIds.length === 0) {
      showToast("No subscribers selected", "warn");
      return;
    }
    try {
      const res = await fetch(`${API}/subscribers/bulk-service-settings`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ ids: selectedIds, payload: massSettingsForm }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.message || "Mass update failed", "err");
        return;
      }
      showToast(`Updated: ${data.success}/${data.total}`, data.failed > 0 ? "warn" : "ok");
      setShowMassSettingsModal(false);
      await loadAll();
    } catch (error: any) {
      showToast(error.message || "Mass update failed", "err");
    }
  };

  const runExport = async () => {
    try {
      const res = await fetch(`${API}/subscribers/export`, { headers });
      if (!res.ok) {
        showToast("Export failed", "err");
        return;
      }
      const rows = await res.json();
      const header = Object.keys(rows[0] || {});
      const csv = [
        header.join(","),
        ...rows.map((r: any) => header.map((k) => JSON.stringify(r[k] ?? "")).join(",")),
      ].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `subscribers-export.${exportType === "EXCEL" ? "csv" : "csv"}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setShowExportModal(false);
      showToast("Export file generated", "ok");
    } catch (error: any) {
      showToast(error.message || "Export failed", "err");
    }
  };

  const syncSubToRadius = async (sub: Subscriber) => {
    if (!sub.id) return;
    try {
      const res = await fetch(`${API}/subscribers/${sub.id}/sync-to-radius`, { method: "POST", headers });
      if (res.ok) {
        showToast(`Synced ${sub.username} to RADIUS`, "ok");
        if (detailSub?.id === sub.id) await loadRadiusLiveData(sub.username!);
        await checkRadiusStatus(sub);
      } else {
        showToast("Sync failed", "err");
      }
    } catch (e: any) {
      showToast(e.message, "err");
    }
  };

  const fixRadiusPassword = async (sub: Subscriber) => {
    if (!sub.id) return;
    try {
      const res = await fetch(`${API}/subscribers/${sub.id}/fix-radius-password`, { method: "POST", headers });
      if (res.ok) {
        showToast(`Fixed RADIUS password for ${sub.username}`, "ok");
        if (detailSub?.id === sub.id) await loadRadiusLiveData(sub.username!);
        await checkRadiusStatus(sub);
      } else {
        showToast("Fix failed", "err");
      }
    } catch (e: any) {
      showToast(e.message, "err");
    }
  };

  // ── Form handlers ─────────────────────────────────────────────────────────
  const openCreate = () => {
    setForm({ ...EMPTY_FORM });
    setEditSub(null);
    setShowForm(true);
  };

  // Deep-link: /subscribers?add=1 (from the command palette) opens the form.
  useEffect(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("add") === "1") {
      openCreate();
    }
  }, []);

  const openEdit = async (sub: Subscriber) => {
    setForm({
      fullName: sub.fullName || "",
      phone: sub.phone || "",
      email: sub.email || "",
      address: sub.address || "",
      username: sub.username || "",
      password: sub.password || "",
      identity: sub.identity || "",
      connectionType: sub.connectionType || "FTTH",
      authMethod: (sub as any).authMethod || "PPPOE",
      packageId: sub.packageId ? String(sub.packageId) : "",
      areaId: sub.areaId ? String(sub.areaId) : "",
      nasId: sub.nasId ? String(sub.nasId) : "",
      salespersonId: sub.salespersonId ? String(sub.salespersonId) : "",
      documentUrl: sub.documentUrl || "",
      photoUrl: (sub as any).photoUrl || "",
      cnicFrontUrl: (sub as any).cnicFrontUrl || "",
      cnicBackUrl: (sub as any).cnicBackUrl || "",
      installationDate: sub.installationDate ? sub.installationDate.split("T")[0] : "",
      latitude: sub.latitude ? String(sub.latitude) : "",
      longitude: sub.longitude ? String(sub.longitude) : "",
      staticIpAddress: "",
      staticIpPrice: "",
      sellPrice: (sub as any).sellPrice != null ? String((sub as any).sellPrice) : "",
      status: sub.status || "ACTIVE",
    });
    setEditSub(sub);
    setShowForm(true);

    // Fetched separately because the address is its own record, not a column
    // on the subscriber. Loads after the form opens so nothing is blocked on it.
    try {
      const r = await fetch(`${API}/static-ips/subscriber/${sub.id}`, { headers });
      const ip = r.ok ? await r.json() : null;
      if (ip?.ipAddress) {
        setForm((p) => ({
          ...p,
          staticIpAddress: ip.ipAddress,
          staticIpPrice: ip.monthlyPrice != null ? String(ip.monthlyPrice) : "",
        }));
        // Kept so clearing the field can release the right record.
        setEditSub({ ...sub, staticIp: ip } as any);
      }
    } catch { /* form still works without it */ }
  };

  // Reads the router live. Only called when the tab is opened, because it
  // opens an API session to the MikroTik.
  const loadRouterLog = async (subId: number) => {
    setRouterBusy(true);
    try {
      const r = await fetch(`${API}/logs/router/subscriber/${subId}?limit=250`, { headers });
      if (r.ok) setRouterLog(await r.json());
    } catch { /* keep whatever we had */ }
    setRouterBusy(false);
  };

  const openDetail = async (sub: Subscriber) => {
    setDetailSub(sub);
    setDetailActiveTab("Profile");
    setRouterLog(null); // belongs to the previous subscriber
    if (sub.username) {
      await loadRadiusLiveData(sub.username);
    } else {
      setLiveSession(null);
      setSessionLogs([]);
      setAuthLogs([]);
      setRadiusChecks([]);
      setRadiusReply([]);
      setRadiusOnline(null);
    }
  };

  // ── Filtering ─────────────────────────────────────────────────────────────
  const filtered = subscribers
    .filter((s) => {
      if (statusFilter === "ALL") return true;
      if (statusFilter === "STALE") return s.isStaleSession === true;
      return s.status === statusFilter;
    })
    .filter((s) => connectionFilter === "ALL" || s.connectionType === connectionFilter)
    .filter((s) => packageFilter === "ALL" || String(s.packageId || "") === packageFilter)
    .filter((s) => salespersonFilter === "ALL" || String(s.salespersonId || "") === salespersonFilter)
    .filter((s) => nasFilter === "ALL" || String(s.nasId || "") === nasFilter)
    .filter((s) => {
      if (!dateFrom && !dateTo) return true;
      const source = s.serviceSettings?.expiryDate || s.installationDate || s.createdAt;
      if (!source) return false;
      const dt = new Date(source).getTime();
      const from = dateFrom ? new Date(dateFrom).getTime() : -Infinity;
      const to = dateTo ? new Date(dateTo + "T23:59:59").getTime() : Infinity;
      return dt >= from && dt <= to;
    });

  // Shared style for drill-down cells (package / NAS / area / salesperson).
  const drillSt: React.CSSProperties = {
    cursor: "pointer",
    display: "inline-block",
    borderRadius: 4,
    transition: "opacity .12s",
  };

  const totalPages = Math.max(Math.ceil(filtered.length / pageSize), 1);
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleSelectAllCurrentPage = () => {
    const ids = paged.map((s) => s.id);
    const allSelected = ids.every((id) => selectedIds.includes(id));
    if (allSelected) {
      setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
    } else {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...ids])));
    }
  };

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const tk = localStorage.getItem("token");
    if (!tk) {
      router.push("/login");
      return;
    }
    fetch(`${API}/profile`, { headers })
      .then((r) => r.json())
      .then((d) => setUser(d.user))
      .catch(() => router.push("/login"));
    loadAll();
    const tick = () => {
      const h = new Date().getHours();
      setGreeting(h < 12 ? "Good Morning" : h < 18 ? "Good Afternoon" : "Good Evening");
      setTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Style helpers ─────────────────────────────────────────────────────────
  const inputSt: React.CSSProperties = {
    background: t.input,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    color: t.text,
    padding: "7px 10px",
    width: "100%",
    fontSize: 12,
    outline: "none",
  };
  const labelSt: React.CSSProperties = {
    fontSize: 11,
    color: t.textSub,
    marginBottom: 3,
    display: "block",
    fontWeight: 600,
  };

  const Btn = ({ onClick, children, variant = "default", size = "sm", disabled = false, title = "" }: any) => {
    const vs: Record<string, React.CSSProperties> = {
      default: { background: "var(--border)", color: t.textSub },
      primary: { background: t.accent, color: "#fff" },
      success: { background: "#14532d", color: "#4ade80" },
      danger: { background: "#450a0a", color: "#f87171" },
      warning: { background: "#422006", color: "#fbbf24" },
      ghost: { background: "transparent", color: t.textSub, border: `1px solid ${t.cardBorder}` },
      teal: { background: "#134e4a", color: "#2dd4bf" },
    };
    return (
      <button
        onClick={onClick}
        disabled={disabled}
        title={title}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: size === "xs" ? "3px 8px" : "5px 12px",
          borderRadius: 6,
          border: "none",
          cursor: disabled ? "not-allowed" : "pointer",
          fontSize: size === "xs" ? 11 : 12,
          fontWeight: 600,
          opacity: disabled ? 0.5 : 1,
          transition: "all .15s",
          ...vs[variant],
        }}
      >
        {children}
      </button>
    );
  };

  const Badge = ({ children, color, bg }: { children: React.ReactNode; color: string; bg: string }) => (
    <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, color, background: bg, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );

  const StatusDot = ({ online }: { online?: boolean }) => (
    <span
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: "50%",
        marginRight: 4,
        background: online === undefined ? "#475569" : online ? "#22c55e" : "#ef4444",
        boxShadow: online ? "0 0 6px #22c55e88" : online === false ? "0 0 6px #ef444488" : "none",
      }}
    />
  );

  const RadiusBadge = ({ sub }: { sub: Subscriber }) => {
    const rc = radiusCheckMap[sub.id];
    if (!sub.username) return <span style={{ fontSize: 10, color: t.textMuted }}>No user</span>;
    if (!rc)
      return (
        <button
          onClick={() => checkRadiusStatus(sub)}
          style={{ background: "transparent", border: `1px solid ${t.cardBorder}`, borderRadius: 4, padding: "1px 6px", cursor: "pointer", fontSize: 10, color: t.textMuted }}
        >
          Check
        </button>
      );
    if (rc.loading) return <span style={{ fontSize: 10, color: t.amber }}>Checking…</span>;
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
        <StatusDot online={rc.existsInRadius} />
        <span style={{ fontSize: 10, color: rc.existsInRadius ? "#4ade80" : "#f87171" }}>{rc.existsInRadius ? "In RADIUS" : "Not synced"}</span>
      </span>
    );
  };

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", minHeight: "100vh", background: t.bg, color: t.text, fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif", fontSize: 13 }}>
      {/* Toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 9999,
            background: toast.type === "ok" ? "#14532d" : toast.type === "err" ? "#450a0a" : "#422006",
            color: toast.type === "ok" ? "#4ade80" : toast.type === "err" ? "#f87171" : "#fbbf24",
            border: `1px solid ${toast.type === "ok" ? "#166534" : toast.type === "err" ? "#7f1d1d" : "#713f12"}`,
            borderRadius: 10,
            padding: "12px 18px",
            fontSize: 12,
            fontWeight: 600,
            maxWidth: 360,
            boxShadow: "0 4px 24px rgba(0,0,0,.5)",
          }}
        >
          {toast.msg}
        </div>
      )}

      {/* Main Content (unified shell) */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* Content */}
        <div style={{ flex: 1, padding: "16px 20px", overflowY: "auto" }}>
          <div style={{ marginBottom: 14 }}>
          </div>

          {/* Stat Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 10, marginBottom: 16 }}>
            {[
              { label: "Total Subscribers", value: stats.total, color: t.accent },
              { label: "Active Subscribers", value: stats.active, color: "#10B981" },
              { label: "Online Now", value: stats.onlineNow || 0, color: "#00C9FF" },
              { label: "Offline", value: stats.offline || 0, color: "rgba(255,255,255,0.7)" },
              { label: "Stale Sessions", value: stats.stale ?? 0, color: "#f59e0b" },
              { label: "Expired", value: stats.expired, color: "#ff7070" },
              { label: "Today's Signups", value: stats.todaySignups || 0, color: "#f0a500" },
            ].map((c) => (
              <div key={c.label} style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 10, padding: "12px 16px" }}>
                <div style={{ fontSize: 26, fontWeight: 800, color: c.color, lineHeight: 1 }}>{c.value}</div>
                <div style={{ fontSize: 10, color: t.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 4 }}>{c.label}</div>
              </div>
            ))}
            {bulkResult && (
              <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 10, padding: "12px 16px", gridColumn: "span 2" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#2dd4bf", marginBottom: 4 }}>Last RADIUS Bulk Sync</div>
                <div style={{ fontSize: 11, color: t.textSub }}>
                  <span style={{ color: "#4ade80" }}>✅ {bulkResult.success} synced</span>
                  {bulkResult.failed > 0 && (
                    <span style={{ color: "#f87171", marginLeft: 10 }}>❌ {bulkResult.failed} failed</span>
                  )}
                  <span style={{ color: t.textMuted, marginLeft: 10 }}>of {bulkResult.total} total</span>
                </div>
              </div>
            )}
          </div>

          {/* Toolbar */}
          <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ position: "relative", flex: 1, minWidth: 200 }}>
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: t.textMuted, pointerEvents: "none" }}>
                <Ic.Search />
              </span>
              <input
                placeholder="Search by name, phone, username, email, identity…"
                value={searchQ}
                onChange={(e) => onSearch(e.target.value)}
                style={{ ...inputSt, paddingLeft: 30, width: "100%" }}
              />
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {["ALL", "ACTIVE", "STALE", "EXPIRED", "SUSPENDED", "INACTIVE"].map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  style={{
                    padding: "5px 12px",
                    borderRadius: 6,
                    border: "none",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 600,
                    background: statusFilter === s
                      ? (s === "STALE" ? "#f59e0b" : t.accent)
                      : "transparent",
                    color: statusFilter === s ? "#fff" : t.textSub,
                    opacity: s === "STALE" && statusFilter !== "STALE" ? 0.6 : 1,
                  }}
                  title={s === "STALE" ? "Session active but no recent RADIUS activity (15+ min)" : undefined}
                >
                  {s === "STALE" ? "⚠ Stale" : s}
                </button>
              ))}
            </div>
            {/* Filters live behind a toggle so the four selects only occupy
                space when someone is actually narrowing the list. An active
                dot flags that a filter is on while the row is hidden. */}
            {(() => {
              const activeCount =
                (connectionFilter !== "ALL" ? 1 : 0) +
                (packageFilter !== "ALL" ? 1 : 0) +
                (salespersonFilter !== "ALL" ? 1 : 0) +
                (nasFilter !== "ALL" ? 1 : 0) +
                (dateFrom || dateTo ? 1 : 0);
              return (
                <Btn onClick={() => setShowFilters((v) => !v)} variant={activeCount ? "teal" : "ghost"}>
                  <Ic.Filter /> Filters{activeCount ? ` (${activeCount})` : ""}
                </Btn>
              );
            })()}

            {/* Everything that used to be a dozen buttons on this row now lives
                in one menu, giving the whole band back to the table. Primary,
                high-frequency actions (Add / Refresh) stay as buttons. */}
            <Menu
              label="Actions"
              items={[
                { label: "Add subscriber", onClick: openCreate },
                { label: "Activation", onClick: () => setShowActivationModal(true) },
                { label: "Import subscribers", onClick: () => setShowImportModal(true) },
                { label: "Export", onClick: () => setShowExportModal(true) },
                { label: "Sync all to RADIUS", onClick: bulkSyncToRadius, disabled: bulkSyncing },
                "divider",
                { label: "Mass delete", note: `${selectedIds.length} selected`, danger: true, disabled: selectedIds.length === 0, onClick: () => setShowMassDeleteModal(true) },
                { label: "Mass service settings", note: `${selectedIds.length} selected`, disabled: selectedIds.length === 0, onClick: () => setShowMassSettingsModal(true) },
                { label: "Move to another account", note: `${selectedIds.length} selected`, disabled: selectedIds.length === 0, onClick: () => openTransfer() },
              ]}
            />
            <Btn onClick={loadAll} variant="ghost">
              <Ic.Refresh /> Refresh
            </Btn>
            <Btn onClick={openCreate} variant="primary">
              <Ic.Plus /> Add Subscriber
            </Btn>
          </div>

          {showFilters && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 8, marginBottom: 14 }}>
              <select style={{ ...inputSt, cursor: "pointer" }} value={connectionFilter} onChange={(e) => { setConnectionFilter(e.target.value); setPage(1); }}>
                <option value="ALL">Connection Type: All</option>
                {["FTTH", "ADSL", "G4_LTE", "WIRELESS", "FIBER"].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select style={{ ...inputSt, cursor: "pointer" }} value={packageFilter} onChange={(e) => { setPackageFilter(e.target.value); setPage(1); }}>
                <option value="ALL">Package: All</option>
                {packages.map((pk) => <option key={pk.id} value={pk.id}>{pk.name}</option>)}
              </select>
              <select style={{ ...inputSt, cursor: "pointer" }} value={salespersonFilter} onChange={(e) => { setSalespersonFilter(e.target.value); setPage(1); }}>
                <option value="ALL">Salesperson: All</option>
                {salespersons.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
              </select>
              <select style={{ ...inputSt, cursor: "pointer" }} value={nasFilter} onChange={(e) => { setNasFilter(e.target.value); setPage(1); }}>
                <option value="ALL">NAS: All</option>
                {nasList.map((n) => <option key={n.id} value={n.id}>{n.nasname}</option>)}
              </select>
              <input type="date" style={inputSt} value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
              <input type="date" style={inputSt} value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
            </div>
          )}

          {/* WinBox toolbar strip */}
          <Expandable label="subscribers">
          <WinBoxToolbar
            selectedCount={selectedIds.length}
            find={searchQ}
            onFind={onSearch}
            findPlaceholder="Find subscriber…"
            groups={[
              [{ label: "Add", icon: "＋", tone: "primary", title: "Add subscriber (register)", onClick: openCreate }],
              [
                { label: "Remove", icon: "－", tone: "danger", selectionRequired: true, title: "Delete selected", onClick: () => setShowMassDeleteModal(true) },
                { label: "Disable", icon: "⊘", tone: "warn", selectionRequired: true, title: "Mass service settings for selected", onClick: () => setShowMassSettingsModal(true) },
                { label: "Move", icon: "⇄", selectionRequired: true, title: "Move selected to another account", onClick: openTransfer },
              ],
              [
                { label: "Import", icon: "⬆", onClick: () => setShowImportModal(true) },
                { label: "Export", icon: "⬇", onClick: () => setShowExportModal(true) },
                { label: "Sync RADIUS", icon: "⟲", title: "Sync all to FreeRADIUS", onClick: bulkSyncToRadius },
              ],
            ]}
          />

          {/* Subscriber Table */}
          <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderTop: "none", borderRadius: "0 0 10px 10px", overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 16px", borderBottom: `1px solid ${t.cardBorder}` }}>
              <span style={{ fontWeight: 800, fontSize: 14 }}>
                Subscriber List
                <span style={{ fontSize: 11, color: t.textMuted, fontWeight: 400, marginLeft: 8 }}>{filtered.length} shown</span>
              </span>
              <span style={{ fontSize: 11, color: t.textMuted }}>Username + Password → auto-synced to FreeRADIUS on save</span>
            </div>

            {loading ? (
              <div style={{ textAlign: "center", padding: 50, color: t.textMuted }}>⏳ Loading subscribers…</div>
            ) : filtered.length === 0 ? (
              <div style={{ textAlign: "center", padding: 50, color: t.textMuted }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>👥</div>
                No subscribers. Click <b>+ Add Subscriber</b> to register the first one.
              </div>
            ) : (
              <SubscriberTable
                rows={paged.map((s: any) => {
                  const expiryRaw = s.serviceSettings?.expiryDate || null;
                  const expiryDate = expiryRaw ? new Date(expiryRaw) : null;
                  const daysLeft = expiryDate
                    ? Math.ceil((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
                    : null;
                  // The composed table reads isOnline/daysLeft directly; this page
                  // tracks live state as liveStatus and computes days-left per render,
                  // so both are added here rather than changing the table's contract.
                  return { ...s, isOnline: s.liveStatus === "ONLINE", daysLeft };
                })}
                selectedIds={selectedIds}
                onToggle={toggleSelected}
                onToggleAll={toggleSelectAllCurrentPage}
                onOpen={openDetail}
                onEdit={openEdit}
                onMove={(r) => { setSelectedIds([r.id]); openTransfer(); }}
                onDeactivate={deactivateSub}
                onDelete={(r) => setDeleteConfirm(r)}
                money={money}
                onRefresh={loadAll}
              />
            )}

            {!loading && filtered.length > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderTop: `1px solid ${t.cardBorder}` }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select style={{ ...inputSt, width: 90, padding: "4px 6px" }} value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                    {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}/page</option>)}
                  </select>
                  <button onClick={toggleSelectAllCurrentPage} style={{ background: "transparent", border: `1px solid ${t.cardBorder}`, borderRadius: 6, color: t.textSub, fontSize: 11, padding: "5px 8px", cursor: "pointer" }}>
                    Toggle Page Selection
                  </button>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button onClick={() => setPage((p) => Math.max(p - 1, 1))} disabled={safePage <= 1} style={{ background: "transparent", border: `1px solid ${t.cardBorder}`, borderRadius: 6, color: t.textSub, fontSize: 11, padding: "5px 8px", cursor: "pointer", opacity: safePage <= 1 ? 0.5 : 1 }}>
                    Prev
                  </button>
                  <span style={{ fontSize: 11, color: t.textMuted }}>Page {safePage} of {totalPages}</span>
                  <button onClick={() => setPage((p) => Math.min(p + 1, totalPages))} disabled={safePage >= totalPages} style={{ background: "transparent", border: `1px solid ${t.cardBorder}`, borderRadius: 6, color: t.textSub, fontSize: 11, padding: "5px 8px", cursor: "pointer", opacity: safePage >= totalPages ? 0.5 : 1 }}>
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
          </Expandable>

          {/* Expired & Expiring Subscribers */}
          <div style={{ marginTop: 14, background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 10, padding: "12px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Expired & Expiring Subscribers</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[1, 3, 7, 14, 30].map((d2) => (
                  <button
                    key={d2}
                    onClick={() => {
                      const now = new Date();
                      const to = new Date();
                      to.setDate(now.getDate() + d2);
                      setDateFrom(now.toISOString().slice(0, 10));
                      setDateTo(to.toISOString().slice(0, 10));
                    }}
                    style={{ background: "transparent", border: `1px solid ${t.cardBorder}`, borderRadius: 6, color: t.textSub, fontSize: 11, padding: "4px 8px", cursor: "pointer" }}
                  >
                    Expiring {d2}d
                  </button>
                ))}
                <button
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                  style={{ background: "transparent", border: `1px solid ${t.cardBorder}`, borderRadius: 6, color: t.textSub, fontSize: 11, padding: "4px 8px", cursor: "pointer" }}
                >
                  Reset
                </button>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 8 }}>
              {filtered
                .filter((s) => !!s.serviceSettings?.expiryDate)
                .slice(0, 8)
                .map((s) => {
                  const expiry = new Date(s.serviceSettings?.expiryDate || "");
                  const left = Math.ceil((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                  const critical = left <= 1;
                  const warning = left > 1 && left <= 3;
                  const normal = left > 3;
                  return (
                    <div key={s.id} style={{ border: `1px solid ${critical ? "#7f1d1d" : warning ? "#7c2d12" : t.cardBorder}`, borderRadius: 8, padding: "10px", background: d ? "#0d1627" : "#f8fafc" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700 }}>{s.fullName}</div>
                          <div style={{ fontSize: 10, color: t.textMuted }}>{s.username} · {s.phone || "No phone"}</div>
                        </div>
                        <span style={{ fontSize: 10, fontWeight: 700, color: critical ? "#ff7070" : warning ? "#f0a500" : "#10B981" }}>
                          {left < 0 ? "Expired" : `${left}d`}
                        </span>
                      </div>
                      <div style={{ fontSize: 10, color: t.textMuted, marginTop: 6 }}>{s.package?.name || "No package"} · {fmtDate(expiry.toISOString())}</div>
                      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        <Btn size="xs" variant="success" onClick={() => { setActivationForm((p) => ({ ...p, subscriberId: String(s.id), packageId: String(s.packageId || "") })); setShowActivationModal(true); }}>
                          Renew
                        </Btn>
                        <Btn size="xs" variant="ghost" onClick={() => openDetail(s)}>
                          View
                        </Btn>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>

          {/* RADIUS Info Panel */}
          <div style={{ marginTop: 14, background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 10, padding: "12px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Ic.Shield />
              <span style={{ fontWeight: 700, fontSize: 12, color: t.textSub, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                RADIUS Integration Status
              </span>
            </div>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 11, color: t.textMuted }}>
              <span>
                <StatusDot online /> New subscriber → auto-written to <code style={{ color: "#38bdf8" }}>radcheck</code> + <code>radreply</code> (speed + pool)
              </span>
              <span>
                <StatusDot online /> Password change → auto-updated in RADIUS
              </span>
              <span>
                <StatusDot online /> Delete → auto-removed from RADIUS
              </span>
              <span>
                <StatusDot online={radiusInfo ? radiusInfo.alive : true} /> RADIUS Server:{" "}
                <b style={{ color: t.text }}>
                  {radiusInfo?.serverIp ?? "…"}:{radiusInfo?.radiusPort ?? 1812}
                </b>
                <button
                  onClick={() => setShowRadiusDetail(true)}
                  style={{ marginLeft: 8, fontSize: 10, padding: "2px 8px", borderRadius: 6, border: `1px solid ${t.cardBorder}`, background: "transparent", color: "#38bdf8", cursor: "pointer", fontWeight: 700 }}
                >
                  Details
                </button>
              </span>
              <span>
                Click <b style={{ color: "#2dd4bf" }}>Sync All to RADIUS</b> to fix any subscribers missing from RADIUS.
              </span>
            </div>
          </div>

          {/* RADIUS details popup */}
          {showRadiusDetail && (
            <div
              onClick={() => setShowRadiusDetail(false)}
              style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 14, padding: 22, width: 420, maxWidth: "90vw", color: t.text }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 800, fontSize: 15 }}>
                    <Ic.Shield /> RADIUS Server Details
                  </div>
                  <button onClick={() => setShowRadiusDetail(false)} style={{ background: "transparent", border: "none", color: t.textMuted, fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
                </div>
                {radiusInfo ? (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    {[
                      ["Status", radiusInfo.alive ? "● ALIVE" : "● DOWN"],
                      ["Server IP", radiusInfo.serverIp ?? "—"],
                      ["Auth Port", `${radiusInfo.radiusPort ?? 1812} / UDP`],
                      ["Acct Port", `${radiusInfo.acctPort ?? 1813} / UDP`],
                      ["NAS Registered", radiusInfo.nasCount ?? 0],
                      ["Active Sessions", radiusInfo.activeSessionCount ?? 0],
                      ["24h Accepts", radiusInfo.accepts ?? 0],
                      ["24h Rejects", radiusInfo.rejects ?? 0],
                    ].map(([k, v]) => (
                      <div key={String(k)} style={{ background: t.bg, border: `1px solid ${t.cardBorder}`, borderRadius: 8, padding: "8px 10px" }}>
                        <div style={{ fontSize: 10, color: t.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{k}</div>
                        <div style={{ fontSize: 14, fontWeight: 700, marginTop: 3, color: k === "Status" ? (radiusInfo.alive ? "#4ade80" : "#f87171") : t.text }}>{v}</div>
                      </div>
                    ))}
                    <div style={{ gridColumn: "1 / -1", fontSize: 11, color: t.textMuted, marginTop: 4 }}>
                      Per-router CPU, uptime and firmware appear on the <b style={{ color: "#38bdf8" }}>NAS / Routers</b> page → click a router → Reachability. Those come from the MikroTik API once a NAS is registered.
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: t.textMuted }}>Loading RADIUS status…</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* MODAL: Create / Edit Subscriber */}
      {showForm && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={() => setShowForm(false)}
        >
          <div
            // Wider and taller with less padding: the wizard shows four or
            // five fields at a time, and at this size they all fit without
            // scrolling — which was the actual complaint.
            style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 14, padding: 18, width: "100%", maxWidth: 860, maxHeight: "95vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 15 }}>{editSub ? "Edit Subscriber" : "Add New Subscriber"}</div>
                <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2 }}>
                  {editSub
                    ? "Changes to username/password will automatically update FreeRADIUS."
                    : "Credentials will be auto-synced to FreeRADIUS for PPPoE authentication."}
                </div>
              </div>
              <button onClick={() => setShowForm(false)} style={{ background: "transparent", border: "none", cursor: "pointer", color: t.textSub }}>
                <Ic.X />
              </button>
            </div>


            {/* Stepped form for NEW subscribers. Editing keeps the single
                page — when you are changing one field, steps are friction. */}
            {!editSub && (
              <SubscriberWizard
                form={form}
                setForm={setForm}
                saving={formSaving}
                onSave={saveSub}
                onCancel={() => setShowForm(false)}
                packages={packages.map((p: any) => ({
                  id: p.id,
                  label: `${p.name} — ${p.downloadSpeed}/${p.uploadSpeed} Mbps · ${money(p.price)}`,
                }))}
                nasOptions={nasList.map((n: any) => ({
                  id: n.id, label: `${n.nasname} (${n.nasIp ?? "no IP"})`,
                }))}
                areas={areas.map((a: any) => ({ id: a.id, label: a.name }))}
                salespeople={salespersons.map((s: any) => ({
                  id: s.id, label: s.role ? `${s.name} — ${s.role}` : s.name,
                }))}
                costFor={(pid) => {
                  const p: any = packages.find((x: any) => String(x.id) === String(pid));
                  return p ? Number(p.price) : null;
                }}
              />
            )}

            {/* Form */}
            {editSub && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div
                style={{
                  gridColumn: "span 2",
                  fontSize: 11,
                  fontWeight: 700,
                  color: t.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  borderBottom: `1px solid ${t.cardBorder}`,
                  paddingBottom: 4,
                }}
              >
                Personal Information
              </div>
              <div>
                <label style={labelSt}>Full Name *</label>
                <input style={inputSt} placeholder="e.g. Ahmad Khan" value={form.fullName} onChange={(e) => setForm((p) => ({ ...p, fullName: e.target.value }))} />
              </div>
              <div>
                <label style={labelSt}>Phone</label>
                <input style={inputSt} placeholder="+92 300 1234567" value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))} />
              </div>
              <div>
                <label style={labelSt}>Email</label>
                <input
                  style={inputSt}
                  type="email"
                  placeholder="user@example.com"
                  value={form.email}
                  onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                />
              </div>
              <div>
                <label style={labelSt}>CNIC / Identity</label>
                <input style={inputSt} placeholder="35202-1234567-1" value={form.identity} onChange={(e) => setForm((p) => ({ ...p, identity: e.target.value }))} />
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <label style={labelSt}>Address</label>
                <input style={inputSt} placeholder="Street, City" value={form.address} onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))} />
              </div>

              <div
                style={{
                  gridColumn: "span 2",
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#38bdf8",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  borderBottom: `1px solid #1e3a5f`,
                  paddingBottom: 4,
                  marginTop: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Ic.Shield /> PPPoE Credentials (RADIUS)
              </div>
              <div>
                <label style={labelSt}>
                  Username * <span style={{ color: t.textMuted, fontWeight: 400 }}>(used for PPPoE dial‑in)</span>
                </label>
                <input style={inputSt} placeholder="pppoe-username" value={form.username} onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))} />
              </div>
              <div>
                <label style={labelSt}>
                  Password * <span style={{ color: t.textMuted, fontWeight: 400 }}>(stored in RADIUS radcheck)</span>
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    style={{ ...inputSt, paddingRight: 36 }}
                    type={showPw ? "text" : "password"}
                    placeholder="PPPoE password"
                    value={form.password}
                    onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
                  />
                  <button
                    onClick={() => setShowPw((p) => !p)}
                    style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", color: t.textMuted }}
                  >
                    <Ic.Eye />
                  </button>
                </div>
              </div>
              <div>
                <label style={labelSt}>Connection Type</label>
                <select
                  style={{ ...inputSt, cursor: "pointer" }}
                  value={form.connectionType}
                  onChange={(e) => setForm((p) => ({ ...p, connectionType: e.target.value }))}
                >
                  {["FTTH", "ADSL", "G4_LTE", "WIRELESS", "FIBER"].map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>

              {/* Service type decides which RADIUS attributes are written —
                  a café on fibre is a hotspot, a home on the same fibre is PPPoE. */}
              <div>
                <label style={labelSt}>Authentication Method</label>
                <select
                  style={{ ...inputSt, cursor: "pointer" }}
                  value={form.authMethod}
                  onChange={(e) => setForm((p) => ({ ...p, authMethod: e.target.value }))}
                >
                  <option value="PPPOE">PPPoE — dial-up login (standard)</option>
                  <option value="HOTSPOT">Hotspot — captive portal</option>
                  <option value="STATIC">Static IP — fixed address</option>
                  <option value="DHCP">DHCP — MAC based</option>
                </select>
                <span style={{ fontSize: 10.5, color: "var(--muted)" }}>
                  {form.authMethod === "HOTSPOT"
                    ? "Idle timeout and address-list are applied automatically."
                    : "How the customer authenticates on the network."}
                </span>
              </div>

              {/* Static public IP — an add-on on any auth method, not just
                  STATIC. Plenty of PPPoE customers buy a fixed address, so
                  gating this behind the dropdown would hide it from the people
                  who actually need it. */}
              <div>
                <label style={labelSt}>Static public IP (optional)</label>
                <input
                  style={{ ...inputSt, fontFamily: "ui-monospace, monospace" }}
                  placeholder="blank = pool address"
                  value={form.staticIpAddress}
                  onChange={(e) => setForm((p) => ({ ...p, staticIpAddress: e.target.value }))}
                />
                <span style={{ fontSize: 10.5, color: "var(--muted)" }}>
                  Overrides the package pool — the customer gets exactly this
                  address. Routing is handled on the MikroTik.
                </span>
              </div>
              <div>
                <label style={labelSt}>Static IP monthly price</label>
                <input
                  style={inputSt}
                  type="number"
                  placeholder="0"
                  value={form.staticIpPrice}
                  onChange={(e) => setForm((p) => ({ ...p, staticIpPrice: e.target.value }))}
                />
                <span style={{ fontSize: 10.5, color: "var(--muted)" }}>
                  Charged monthly on its own cycle, separate from the package.
                </span>
              </div>
              <div>
                <label style={labelSt}>Retail price (what customer pays)</label>
                <input
                  style={inputSt}
                  type="number"
                  placeholder="blank = package price"
                  value={form.sellPrice}
                  onChange={(e) => setForm((p) => ({ ...p, sellPrice: e.target.value }))}
                />
              </div>
              <div>
                <label style={labelSt}>Status</label>
                <select
                  style={{ ...inputSt, cursor: "pointer" }}
                  value={form.status}
                  onChange={(e) => setForm((p) => ({ ...p, status: e.target.value }))}
                >
                  {["ACTIVE", "EXPIRED", "SUSPENDED", "INACTIVE"].map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>

              <div
                style={{
                  gridColumn: "span 2",
                  fontSize: 11,
                  fontWeight: 700,
                  color: t.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  borderBottom: `1px solid ${t.cardBorder}`,
                  paddingBottom: 4,
                  marginTop: 8,
                }}
              >
                Assignment
              </div>
              <div>
                <label style={labelSt}>Package</label>
                <select
                  style={{ ...inputSt, cursor: "pointer" }}
                  value={form.packageId}
                  onChange={(e) => setForm((p) => ({ ...p, packageId: e.target.value }))}
                >
                  <option value="">— Select Package —</option>
                  {packages.map((pk) => (
                    <option key={pk.id} value={pk.id}>
                      {pk.name}
                      {pk.price ? ` — PKR ${pk.price}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelSt}>
                  NAS / Router <span style={{ color: t.textMuted, fontWeight: 400 }}>(MikroTik that serves this subscriber)</span>
                </label>
                <select
                  style={{ ...inputSt, cursor: "pointer" }}
                  value={form.nasId}
                  onChange={(e) => setForm((p) => ({ ...p, nasId: e.target.value }))}
                >
                  <option value="">— Select NAS —</option>
                  {nasList.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.nasname}
                      {n.nasIp ? ` (${n.nasIp})` : ""}
                      {!n.isActive ? " [INACTIVE]" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelSt}>Area</label>
                <select
                  style={{ ...inputSt, cursor: "pointer" }}
                  value={form.areaId}
                  onChange={(e) => setForm((p) => ({ ...p, areaId: e.target.value }))}
                >
                  <option value="">— Select Area —</option>
                  {areas.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelSt}>Installation Date</label>
                <input
                  type="date"
                  style={inputSt}
                  value={form.installationDate}
                  onChange={(e) => setForm((p) => ({ ...p, installationDate: e.target.value }))}
                />
              </div>
              <div>
                <label style={labelSt}>Salesperson</label>
                <select
                  style={{ ...inputSt, cursor: "pointer" }}
                  value={form.salespersonId}
                  onChange={(e) => setForm((p) => ({ ...p, salespersonId: e.target.value }))}
                >
                  <option value="">— Select Salesperson —</option>
                  {salespersons.map((sp) => (
                    <option key={sp.id} value={sp.id}>
                      {sp.name}
                    </option>
                  ))}
                </select>
              </div>

              <div
                style={{
                  gridColumn: "span 2",
                  fontSize: 11,
                  fontWeight: 700,
                  color: t.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  borderBottom: `1px solid ${t.cardBorder}`,
                  paddingBottom: 4,
                  marginTop: 8,
                }}
              >
                Optional
              </div>
              <div>
                <label style={labelSt}>Latitude</label>
                <input
                  style={inputSt}
                  type="number"
                  step="any"
                  placeholder="33.7294"
                  value={form.latitude}
                  onChange={(e) => setForm((p) => ({ ...p, latitude: e.target.value }))}
                />
              </div>
              <div>
                <label style={labelSt}>Longitude</label>
                <input
                  style={inputSt}
                  type="number"
                  step="any"
                  placeholder="73.0931"
                  value={form.longitude}
                  onChange={(e) => setForm((p) => ({ ...p, longitude: e.target.value }))}
                />
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <label style={labelSt}>Document (scan or PDF)</label>
                <ImageUpload label="Upload identity document" allowPdf value={form.documentUrl}
                  onChange={(url) => setForm((p) => ({ ...p, documentUrl: url }))} />
              </div>
              <div style={{ gridColumn: "span 2", borderTop: "1px solid var(--border)", paddingTop: 14, marginTop: 4 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 10 }}>📷 Photo &amp; Identity (CNIC)</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
                  <ImageUpload label="Subscriber photo" shape="avatar" value={form.photoUrl} onChange={(url) => setForm((p) => ({ ...p, photoUrl: url }))} />
                  <ImageUpload label="CNIC — Front" value={form.cnicFrontUrl} onChange={(url) => setForm((p) => ({ ...p, cnicFrontUrl: url }))} />
                  <ImageUpload label="CNIC — Back" value={form.cnicBackUrl} onChange={(url) => setForm((p) => ({ ...p, cnicBackUrl: url }))} />
                </div>
              </div>
            </div>
            )}

            {/* The wizard carries its own Cancel/Finish, so these buttons
                belong to the edit form only. */}
            {editSub && (
            <div style={{ display: "flex", gap: 8, marginTop: 20, justifyContent: "flex-end" }}>
              <Btn onClick={() => setShowForm(false)} variant="ghost">
                Cancel
              </Btn>
              <Btn onClick={saveSub} variant="primary" disabled={formSaving}>
                <Ic.Shield /> {formSaving ? "Saving & Syncing…" : "Update + Sync RADIUS"}
              </Btn>
            </div>
            )}

            {/* RADIUS note, below the form. */}
            <div
              style={{
                background: d ? "var(--surface)" : "#eff6ff",
                border: `1px solid ${d ? "#1e3a5f" : "#bfdbfe"}`,
                borderRadius: 8, padding: "8px 12px", marginTop: 16,
                fontSize: 11, color: d ? "#93c5fd" : "#1d4ed8",
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              <Ic.Shield />
              <span>
                The username and password are written to FreeRADIUS <code>radcheck</code> on save,
                so the customer can dial in immediately — and to the router&apos;s PPP secrets if
                one is in use.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Subscriber Detail (Full Tabbed View) */}
      {detailSub && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={() => setDetailSub(null)}
        >
          <div
            style={{
              background: t.card,
              border: `1px solid ${t.cardBorder}`,
              borderRadius: 14,
              padding: 0,
              width: "100%",
              maxWidth: 1100,
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div
              style={{
                padding: "16px 20px",
                borderBottom: `1px solid ${t.cardBorder}`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: d ? "var(--surface)" : "#f8fafc",
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {(detailSub as any).photoUrl ? (
                  <img src={fileUrl((detailSub as any).photoUrl)} alt={detailSub.fullName} style={{ width: 46, height: 46, borderRadius: "50%", objectFit: "cover", border: `2px solid ${t.cardBorder}` }} />
                ) : (
                  <div style={{ width: 46, height: 46, borderRadius: "50%", background: "linear-gradient(135deg,#0ea5e9,#2563eb)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, fontWeight: 800, color: "#fff" }}>
                    {(detailSub.fullName || "S").split(" ").map((s: string) => s[0]).join("").slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div>
                  <div style={{ fontWeight: 800, fontSize: 16 }}>{detailSub.fullName}</div>
                  <div style={{ fontSize: 12, color: t.textMuted }}>Subscriber #{detailSub.id} · {fmtDate(detailSub.createdAt)}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Badge color={statusColor(detailSub.status).color} bg={statusColor(detailSub.status).bg}>
                  {detailSub.status}
                </Badge>
                {/* This modal is a quick look. The full profile has the router
                    log, diagnosis, static IP and billing — everything needed to
                    work out why a connection is failing. */}
                <Btn
                  size="xs"
                  variant="primary"
                  onClick={() => router.push(`/subscribers/${detailSub.id}`)}
                >
                  Open full profile
                </Btn>
                <Btn
                  size="xs"
                  variant="default"
                  onClick={() => {
                    setDetailSub(null);
                    openEdit(detailSub);
                  }}
                >
                  <Ic.Edit /> Edit
                </Btn>
                <button onClick={() => setDetailSub(null)} style={{ background: "transparent", border: "none", cursor: "pointer", color: t.textSub }}>
                  <Ic.X />
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div style={{ display: "flex", gap: 4, padding: "0 20px", borderBottom: `1px solid ${t.cardBorder}`, background: t.card }}>
              {["Profile", "Connection", "Router Log", "Session Log", "RADIUS", "Login Log", "Activities"].map((tab) => (
                <button
                  key={tab}
                  onClick={() => {
                    setDetailActiveTab(tab);
                    if (tab === "Router Log" && !routerLog && detailSub) loadRouterLog(detailSub.id);
                  }}
                  style={{
                    padding: "8px 16px",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                    color: detailActiveTab === tab ? t.accent : t.textMuted,
                    borderBottom: detailActiveTab === tab ? `2px solid ${t.accent}` : "2px solid transparent",
                  }}
                >
                  {tab}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div style={{ padding: "20px", overflowY: "auto", flex: 1 }}>
              {/* Profile */}
              {detailActiveTab === "Profile" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: 12, color: t.accent }}>Personal Information</div>
                    <InfoRow label="Full Name" value={detailSub.fullName} />
                    <InfoRow label="CNIC / Identity" value={detailSub.identity} />
                    <InfoRow label="Phone" value={detailSub.phone} />
                    <InfoRow label="Email" value={detailSub.email} />
                    <InfoRow label="Address" value={detailSub.address} />
                    <InfoRow label="Installation Date" value={fmtDate(detailSub.installationDate)} />
                    <InfoRow label="Created At" value={fmtDate(detailSub.createdAt, true)} />
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: 12, color: t.accent }}>Package & Network</div>
                    <InfoRow label="Package" value={detailSub.package?.name} />
                    <InfoRow label="Speed" value={detailSub.package ? `${detailSub.package.downloadSpeed}/${detailSub.package.uploadSpeed} Mbps` : "—"} />
                    <InfoRow label="IP Pool" value={detailSub.package?.pool?.name || "—"} />
                    <InfoRow label="NAS" value={detailSub.nas?.nasname} />
                    <InfoRow label="NAS IP" value={detailSub.nas?.nasIp} mono />
                    <InfoRow label="Area" value={detailSub.area?.name} />
                    <InfoRow label="Connection Type" value={detailSub.connectionType} />
                  </div>
                  <div style={{ gridColumn: "1 / -1" }}>
                    <div style={{ fontWeight: 700, marginBottom: 12, color: t.accent }}>Identity Documents (CNIC)</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                      {[["CNIC — Front", (detailSub as any).cnicFrontUrl], ["CNIC — Back", (detailSub as any).cnicBackUrl]].map(([lbl, url]: any) => (
                        <div key={lbl} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <span style={{ fontSize: 11, color: t.textMuted, textTransform: "uppercase" }}>{lbl}</span>
                          {url ? (
                            <a href={fileUrl(url)} target="_blank" rel="noreferrer">
                              <img src={fileUrl(url)} alt={lbl} style={{ width: 220, height: 140, objectFit: "cover", borderRadius: 8, border: `1px solid ${t.cardBorder}` }} />
                            </a>
                          ) : (
                            <div style={{ width: 220, height: 140, borderRadius: 8, border: `1px dashed ${t.cardBorder}`, background: "var(--surface-2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: t.textMuted }}>Not uploaded</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Connection Tab */}
              {detailActiveTab === "Connection" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: 12, color: "#4ade80" }}>Live Connection Status</div>
                    {loadingLive ? (
                      <div style={{ textAlign: "center", padding: 20, color: t.textMuted }}>Loading session data…</div>
                    ) : (
                      <div
                        style={{
                          background: radiusOnline ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                          borderRadius: 8,
                          padding: "12px",
                          border: `1px solid ${radiusOnline ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                          <StatusDot online={!!radiusOnline} />
                          <span style={{ fontWeight: 700, color: radiusOnline ? "#4ade80" : "#f87171" }}>{radiusOnline ? "Online" : "Offline"}</span>
                          {radiusOnline && liveSession && (
                            <span style={{ fontSize: 11, color: t.textMuted }}>Uptime: {fmtDuration(liveSession.duration_seconds)}</span>
                          )}
                        </div>
                        {liveSession ? (
                          <>
                            <InfoRow label="Leased IP" value={liveSession.framedipaddress} mono />
                            <InfoRow label="MAC Address" value={liveSession.callingstationid} mono />
                            <InfoRow label="NAS IP" value={liveSession.nasipaddress} mono />
                            <InfoRow label="NAS Port" value={liveSession.nasportid} />
                            <InfoRow label="Framed Protocol" value={liveSession.framedprotocol} />
                            <InfoRow label="Session Started" value={fmtDate(liveSession.acctstarttime, true)} />
                            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                              <div style={{ flex: 1, background: "rgba(74,222,128,0.1)", borderRadius: 8, padding: "8px", textAlign: "center" }}>
                                <div style={{ fontSize: 10, color: t.textMuted }}>Upload</div>
                                <div style={{ fontSize: 16, fontWeight: 700, color: "#4ade80" }}>{fmtBytes(liveSession.upload_bytes)}</div>
                              </div>
                              <div style={{ flex: 1, background: "rgba(96,165,250,0.1)", borderRadius: 8, padding: "8px", textAlign: "center" }}>
                                <div style={{ fontSize: 10, color: t.textMuted }}>Download</div>
                                <div style={{ fontSize: 16, fontWeight: 700, color: "#60a5fa" }}>{fmtBytes(liveSession.download_bytes)}</div>
                              </div>
                            </div>
                          </>
                        ) : (
                          (() => {
                            // Offline: show WHY, taken from the last closed
                            // session's RADIUS Acct-Terminate-Cause.
                            const last = sessionLogs?.[0];
                            const CAUSE: Record<string, string> = {
                              "User-Request": "User disconnected",
                              "Lost-Carrier": "ONU / cable down at client end",
                              "Lost-Service": "Service lost",
                              "Idle-Timeout": "Idle timeout",
                              "Session-Timeout": "Session time limit reached",
                              "Admin-Reset": "Disconnected by admin",
                              "Admin-Reboot": "Router rebooted (admin)",
                              "NAS-Reboot": "Router rebooted",
                              "NAS-Request": "Router closed the session",
                              "NAS-Error": "Router error",
                              "Port-Error": "Port error",
                              "User-Error": "Client configuration error",
                              "Stale-Session": "No response from router (stale)",
                              "Session-Gone-From-NAS": "Gone from router (no stop packet)",
                            };
                            const raw = last?.acctterminatecause || null;
                            return (
                              <div style={{ textAlign: "center", padding: "18px 12px" }}>
                                <div style={{ fontSize: 13, fontWeight: 700, color: t.textSub, marginBottom: 6 }}>Offline</div>
                                {raw ? (
                                  <>
                                    <div style={{ fontSize: 12, color: "#f59e0b", fontWeight: 600 }}>
                                      {CAUSE[raw] || raw}
                                    </div>
                                    <div style={{ fontSize: 10.5, color: t.textMuted, marginTop: 3 }}>
                                      RADIUS cause: {raw}
                                    </div>
                                    {last?.acctstoptime && (
                                      <div style={{ fontSize: 10.5, color: t.textMuted, marginTop: 3 }}>
                                        Disconnected {fmtDate(last.acctstoptime, true)}
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <div style={{ fontSize: 12, color: t.textMuted }}>No active session</div>
                                )}
                              </div>
                            );
                          })()
                        )}
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: 12, color: "#a78bfa" }}>All‑time Usage</div>
                    <div style={{ background: d ? "var(--surface)" : "#f8fafc", borderRadius: 8, padding: "12px" }}>
                      {/* Postgres returns BIGINT as a STRING. Without Number()
                          these reduces concatenate ("100"+"200" = "100200")
                          and produce absurd totals. Always coerce. */}
                      <InfoRow label="Total Upload" value={fmtBytes(
                        sessionLogs.reduce((a, s) => a + Number(s.upload_bytes || 0), 0)
                        + Number(liveSession?.upload_bytes || 0)
                      )} />
                      <InfoRow label="Total Download" value={fmtBytes(
                        sessionLogs.reduce((a, s) => a + Number(s.download_bytes || 0), 0)
                        + Number(liveSession?.download_bytes || 0)
                      )} />
                      <InfoRow label="Total Sessions" value={(sessionLogs.length + (liveSession ? 1 : 0)).toString()} />
                    </div>
                  </div>
                </div>
              )}

              {/* Session Log Tab */}
              {detailActiveTab === "Router Log" && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
                    <div style={{ fontWeight: 700, color: t.accent }}>What the router says</div>
                    <Btn size="xs" variant="primary" onClick={() => detailSub && loadRouterLog(detailSub.id)}>
                      {routerBusy ? "Reading router…" : "Refresh from router"}
                    </Btn>
                  </div>

                  {/* The diagnosis is the whole point — reading raw PPPoE lines
                      to work out the fault is what the panel should do for you. */}
                  {routerLog?.diagnosis ? (() => {
                    const dg = routerLog.diagnosis;
                    const c = dg.severity === "critical" ? "#ef4444" : "#f59e0b";
                    return (
                      <div style={{ background: dg.severity === "critical" ? "rgba(239,68,68,.10)" : "rgba(245,158,11,.10)", border: `1px solid ${c}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
                          <span style={{ width: 9, height: 9, borderRadius: "50%", background: c, flexShrink: 0 }} />
                          <span style={{ fontSize: 14, fontWeight: 800, color: c }}>{dg.title}</span>
                          {dg.occurrences > 0 && (
                            <span style={{ marginLeft: "auto", fontSize: 11, color: t.textMuted }}>
                              {dg.occurrences}× in the last 30 minutes
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 12.5, lineHeight: 1.65, marginBottom: 10 }}>{dg.detail}</div>
                        <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.6, marginBottom: 5 }}>
                          <b style={{ color: t.text }}>Why: </b>{dg.cause}
                        </div>
                        <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.6 }}>
                          <b style={{ color: "#22c55e" }}>Fix: </b>{dg.fix}
                        </div>
                      </div>
                    );
                  })() : routerLog ? (
                    <div style={{ background: "rgba(34,197,94,.08)", border: "1px solid #22c55e", borderRadius: 12, padding: 14, marginBottom: 16, fontSize: 12.5, color: "#22c55e", fontWeight: 600 }}>
                      No fault detected — the router reports nothing unusual for this connection.
                    </div>
                  ) : (
                    <div style={{ fontSize: 12.5, color: t.textMuted, marginBottom: 14 }}>
                      {routerBusy ? "Reading the router…" : "Press Refresh to read the router."}
                    </div>
                  )}

                  {routerLog?.lines?.length === 0 && (
                    <div style={{ fontSize: 12.5, color: t.textMuted, lineHeight: 1.7 }}>
                      Nothing recorded for this user yet. If this stays empty, the
                      router may be missing its API username and password under
                      Network → NAS / Routers.
                    </div>
                  )}

                  {routerLog?.lines?.length > 0 && (
                    <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: 12, maxHeight: 420, overflowY: "auto", fontFamily: "ui-monospace, monospace", fontSize: 11.5 }}>
                      {routerLog.lines.map((l: any) => {
                        const bad = /terminating|failed|error|reject|no more addresses/i.test(l.message);
                        const up = /logged in|authenticated|connected/i.test(l.message) && !bad;
                        return (
                          <div key={l.id} style={{ display: "flex", gap: 10, padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
                            <span style={{ color: "#64748b", flexShrink: 0, minWidth: 128 }}>
                              {new Date(l.loggedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                            </span>
                            <span style={{ color: bad ? "#f87171" : up ? "#4ade80" : "#94a3b8", wordBreak: "break-word" }}>
                              {l.message}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {detailActiveTab === "Session Log" && (
                <div>
                  {loadingLive ? (
                    <div style={{ textAlign: "center", padding: 30 }}>Loading session history…</div>
                  ) : sessionLogs.length === 0 && !liveSession ? (
                    <div style={{ textAlign: "center", padding: 30, color: t.textMuted }}>No session history found</div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr style={{ background: d ? "var(--surface)" : "#f1f5f9" }}>
                            {["Status", "Leased IP", "MAC", "NAS IP", "Started", "Duration", "Upload", "Download", "Terminated"].map((h) => (
                              <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: 10, color: t.textMuted }}>
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {[...(liveSession ? [liveSession] : []), ...sessionLogs].map((sess, i) => {
                            const active = !sess.acctstoptime && i === 0 && liveSession;
                            return (
                              <tr key={i} style={{ background: i % 2 === 0 ? t.tableRow : t.tableRow2, borderTop: `1px solid ${t.cardBorder}` }}>
                                <td style={{ padding: "8px 10px" }}>
                                  {active ? (
                                    <span style={{ color: "#4ade80", fontWeight: 700 }}>● Online</span>
                                  ) : (
                                    <span style={{ color: t.textMuted }}>Ended</span>
                                  )}
                                </td>
                                <td style={{ padding: "8px 10px" }}>
                                  <code style={{ fontSize: 11, color: "#34d399" }}>{sess.framedipaddress || "—"}</code>
                                </td>
                                <td style={{ padding: "8px 10px" }}>
                                  <code style={{ fontSize: 10, color: t.textMuted }}>{sess.callingstationid || "—"}</code>
                                </td>
                                <td style={{ padding: "8px 10px" }}>
                                  <code style={{ fontSize: 10, color: "#60a5fa" }}>{sess.nasipaddress || "—"}</code>
                                </td>
                                <td style={{ padding: "8px 10px", whiteSpace: "nowrap", fontSize: 11 }}>{fmtDate(sess.acctstarttime, true)}</td>
                                <td style={{ padding: "8px 10px", fontWeight: 600 }}>{fmtDuration(sess.duration_seconds)}</td>
                                <td style={{ padding: "8px 10px", color: "#4ade80" }}>{fmtBytes(sess.upload_bytes)}</td>
                                <td style={{ padding: "8px 10px", color: "#60a5fa" }}>{fmtBytes(sess.download_bytes)}</td>
                                <td style={{ padding: "8px 10px", fontSize: 10 }}>{sess.acctterminatecause || "—"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* RADIUS Tab */}
              {detailActiveTab === "RADIUS" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: 12, color: "#a78bfa" }}>radcheck (Credentials)</div>
                    {radiusChecks.length === 0 ? (
                      <div style={{ textAlign: "center", padding: 20, background: d ? "var(--surface)" : "#f8fafc", borderRadius: 8 }}>
                        No RADIUS entries. <Btn onClick={() => syncSubToRadius(detailSub)} variant="primary" size="xs">Sync now</Btn>
                      </div>
                    ) : (
                      <table style={{ width: "100%" }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: "left", fontSize: 10, padding: "4px" }}>Attribute</th>
                            <th style={{ textAlign: "left", fontSize: 10, padding: "4px" }}>Op</th>
                            <th style={{ textAlign: "left", fontSize: 10, padding: "4px" }}>Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {radiusChecks.map((rc) => (
                            <tr key={rc.id}>
                              <td style={{ padding: "4px", fontSize: 11, color: "#60a5fa" }}>{rc.attribute}</td>
                              <td style={{ padding: "4px", fontSize: 11 }}>{rc.op}</td>
                              <td style={{ padding: "4px", fontSize: 11 }}>
                                <code style={{ color: "#4ade80" }}>
                                  {rc.attribute.toLowerCase().includes("password") ? "••••••••" : rc.value}
                                </code>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                  <div>
                    {/* radreply decides the customer's ADDRESS and SPEED. This
                        is where addressing faults live, so it belongs on screen
                        rather than behind a psql session. */}
                    <div style={{ fontWeight: 700, marginBottom: 12, color: "#f59e0b" }}>
                      radreply (Address &amp; Speed)
                    </div>
                    {(() => {
                      const reply: any[] = radiusReply || [];
                      const pool = reply.find((r) => r.attribute === "Framed-Pool");
                      const fixed = reply.find((r) => r.attribute === "Framed-IP-Address");
                      // Both together is the fault that causes a reconnect loop:
                      // the router takes the literal address instead of the pool.
                      const conflict = !!pool && !!fixed;
                      const none = !pool && !fixed;

                      return (
                        <>
                          {conflict && (
                            <div style={{ background: "rgba(239,68,68,.12)", border: "1px solid #ef4444", borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 11.5, color: "#fca5a5", lineHeight: 1.6 }}>
                              <b>Conflicting addressing.</b> Both a pool and a fixed
                              address are being sent. The router uses the fixed value
                              and drops the session, so the customer reconnects in a
                              loop. Press Force Sync to rewrite this.
                            </div>
                          )}
                          {none && reply.length > 0 && (
                            <div style={{ background: "rgba(245,158,11,.12)", border: "1px solid #f59e0b", borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 11.5, color: "#fcd34d", lineHeight: 1.6 }}>
                              <b>No address source.</b> Neither a pool nor a fixed
                              address is set, so the router has nothing to give this
                              customer. Set an IP Pool on their package.
                            </div>
                          )}
                          {reply.length === 0 ? (
                            <div style={{ textAlign: "center", padding: 20, background: d ? "var(--surface)" : "#f8fafc", borderRadius: 8, fontSize: 12, color: t.textMuted }}>
                              Nothing in radreply — this customer has no speed or
                              address profile.
                            </div>
                          ) : (
                            <table style={{ width: "100%" }}>
                              <thead>
                                <tr>
                                  <th style={{ textAlign: "left", fontSize: 10, padding: "4px" }}>Attribute</th>
                                  <th style={{ textAlign: "left", fontSize: 10, padding: "4px" }}>Value</th>
                                </tr>
                              </thead>
                              <tbody>
                                {reply.map((r: any, i: number) => {
                                  const bad = conflict && r.attribute === "Framed-IP-Address";
                                  return (
                                    <tr key={i}>
                                      <td style={{ padding: "4px", fontSize: 11, color: bad ? "#f87171" : "#60a5fa" }}>
                                        {r.attribute}
                                      </td>
                                      <td style={{ padding: "4px", fontSize: 11 }}>
                                        <code style={{ color: bad ? "#f87171" : "#4ade80" }}>{r.value}</code>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          )}
                        </>
                      );
                    })()}

                    <div style={{ fontWeight: 700, margin: "16px 0 10px", color: "#2dd4bf" }}>Server</div>
                    <InfoRow label="Sync Status" value={radiusChecks.length > 0 ? "In RADIUS ✓" : "Not synced"} />
                    <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                      <Btn onClick={() => syncSubToRadius(detailSub)} variant="success" size="xs">
                        <Ic.Sync /> Force Sync
                      </Btn>
                      <Btn onClick={() => fixRadiusPassword(detailSub)} variant="warning" size="xs">
                        <Ic.Shield /> Fix Password
                      </Btn>
                    </div>
                  </div>
                </div>
              )}

              {/* Login Log Tab */}
              {detailActiveTab === "Login Log" && (
                <div>
                  {loadingLive ? (
                    <div style={{ textAlign: "center", padding: 30 }}>Loading auth logs…</div>
                  ) : authLogs.length === 0 ? (
                    <div style={{ textAlign: "center", padding: 30, color: t.textMuted }}>No authentication logs found</div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%" }}>
                        <thead>
                          <tr style={{ background: d ? "var(--surface)" : "#f1f5f9" }}>
                            <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 10 }}>Result</th>
                            <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 10 }}>Username</th>
                            <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 10 }}>Date / Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {authLogs.map((log, i) => {
                            const ok = log.reply === "Access-Accept";
                            return (
                              <tr key={i} style={{ borderTop: `1px solid ${t.cardBorder}` }}>
                                <td style={{ padding: "8px 10px" }}>
                                  <span style={{ color: ok ? "#4ade80" : "#f87171", fontWeight: 600 }}>{ok ? "✓ Accept" : "✗ Reject"}</span>
                                </td>
                                <td style={{ padding: "8px 10px" }}>
                                  <code>{log.username}</code>
                                </td>
                                <td style={{ padding: "8px 10px", fontSize: 11 }}>{fmtDate(log.authdate, true)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Activities Tab */}
              {detailActiveTab === "Activities" && (
                <div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 10 }}>
                    <StatCard label="Total Sessions" value={sessionLogs.length + (liveSession ? 1 : 0)} color="#c4b5fd" />
                    <StatCard label="Auth Accepts" value={authLogs.filter((a) => a.reply === "Access-Accept").length} color="#4ade80" />
                    <StatCard label="Auth Rejects" value={authLogs.filter((a) => a.reply !== "Access-Accept").length} color="#f87171" />
                    <StatCard label="RADIUS Records" value={radiusChecks.length} color="#fbbf24" />
                  </div>
                  <div style={{ marginTop: 14, fontSize: 11, color: t.textMuted, background: d ? "var(--surface)" : "#f8fafc", borderRadius: 8, padding: "12px" }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>Data Sources</div>
                    <div>• Session data – live from <code>radacct</code></div>
                    <div>• Auth logs – from <code>radpostauth</code></div>
                    <div>• RADIUS credentials – from <code>radcheck</code></div>
                    <div>• Online status – active session in radacct</div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer Actions */}
            <div style={{ padding: "12px 20px", borderTop: `1px solid ${t.cardBorder}`, display: "flex", justifyContent: "flex-end", gap: 8, background: t.card }}>
              <Btn onClick={refreshDetailLive} variant="teal" size="xs" disabled={loadingLive}>
                <Ic.Refresh /> Refresh Live Data
              </Btn>
              <Btn onClick={() => syncSubToRadius(detailSub)} variant="success" size="xs">
                <Ic.Sync /> Sync to RADIUS
              </Btn>
              <Btn variant="danger" size="xs" onClick={() => { setDeleteConfirm(detailSub); setDetailSub(null); }}>
                <Ic.Trash /> Delete
              </Btn>
              <Btn variant="ghost" onClick={() => setDetailSub(null)}>Close</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Activation / Renewal Modal */}
      {showActivationModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", zIndex: 110, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setShowActivationModal(false)}>
          <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, padding: 18, width: "100%", maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 12 }}>Activation / Renewal</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={labelSt}>Subscriber</label>
                <select style={{ ...inputSt, cursor: "pointer" }} value={activationForm.subscriberId} onChange={(e) => setActivationForm((p) => ({ ...p, subscriberId: e.target.value }))}>
                  <option value="">Select subscriber</option>
                  {subscribers.map((s) => <option key={s.id} value={s.id}>{s.fullName} ({s.username})</option>)}
                </select>
              </div>
              <div>
                <label style={labelSt}>Package</label>
                <select style={{ ...inputSt, cursor: "pointer" }} value={activationForm.packageId} onChange={(e) => setActivationForm((p) => ({ ...p, packageId: e.target.value }))}>
                  <option value="">Select package</option>
                  {packages.map((pk) => <option key={pk.id} value={pk.id}>{pk.name} - {pk.price}</option>)}
                </select>
              </div>
            </div>

            {/* How long to activate for. Months vary between 28 and 31 days and
                customers pay in parts, so a single "one month" button is not
                enough — each mode below is a real situation. */}
            <div style={{ marginTop: 14 }}>
              <label style={labelSt}>Renew for</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                {[
                  { id: "FULL",    label: "Full period",  hint: "One package cycle from the current expiry" },
                  { id: "DAYS",    label: "Set days",     hint: "Any number of days, priced pro-rata" },
                  { id: "DATE",    label: "Until a date", hint: "Exact expiry — use to align to month end" },
                  { id: "BALANCE", label: "Use balance",  hint: "Spend their wallet and grant the days it buys" },
                  { id: "CREDIT",  label: "On credit",    hint: "Activate now, record what they owe" },
                ].map((m) => (
                  <button key={m.id} title={m.hint}
                    onClick={() => setActivationForm((p) => ({ ...p, mode: m.id }))}
                    style={{
                      background: activationForm.mode === m.id ? (m.id === "CREDIT" ? "#f59e0b" : "#3b82f6") : "transparent",
                      color: activationForm.mode === m.id ? "#fff" : t.textMuted,
                      border: `1px solid ${activationForm.mode === m.id ? (m.id === "CREDIT" ? "#f59e0b" : "#3b82f6") : t.cardBorder}`,
                      borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                    }}>{m.label}</button>
                ))}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
              {(activationForm.mode === "DAYS" || activationForm.mode === "CREDIT") && (
                <div>
                  <label style={labelSt}>Number of days</label>
                  <input type="number" min={1} style={inputSt} placeholder="e.g. 5"
                    value={activationForm.days}
                    onChange={(e) => setActivationForm((p) => ({ ...p, days: e.target.value }))} />
                </div>
              )}
              {activationForm.mode === "DATE" && (
                <div>
                  <label style={labelSt}>Expires on</label>
                  <input type="datetime-local" style={inputSt} value={activationForm.expiryDateTime}
                    onChange={(e) => setActivationForm((p) => ({ ...p, expiryDateTime: e.target.value }))} />
                </div>
              )}
              {activationForm.mode === "CREDIT" && (
                <div>
                  <label style={labelSt}>Promised payment date</label>
                  <input type="date" style={inputSt} value={activationForm.payBy}
                    onChange={(e) => setActivationForm((p) => ({ ...p, payBy: e.target.value }))} />
                </div>
              )}

              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <input type="checkbox" checked={activationForm.addExtraFee}
                  onChange={(e) => setActivationForm((p) => ({ ...p, addExtraFee: e.target.checked }))} /> Add extra fee
              </label>
              <input type="number" disabled={!activationForm.addExtraFee} placeholder="Extra fee" style={inputSt}
                value={activationForm.extraFeeAmount}
                onChange={(e) => setActivationForm((p) => ({ ...p, extraFeeAmount: e.target.value }))} />

              {activationForm.mode !== "CREDIT" && activationForm.mode !== "BALANCE" && (
                <div>
                  <label style={labelSt}>Payment method</label>
                  <select style={{ ...inputSt, cursor: "pointer" }} value={activationForm.paymentMethod}
                    onChange={(e) => setActivationForm((p) => ({ ...p, paymentMethod: e.target.value }))}>
                    {["CASH", "BANK_TRANSFER", "CARD", "ONLINE"].map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label style={labelSt}>{activationForm.mode === "CREDIT" ? "Reason / who approved" : "Notes"}</label>
                <input style={inputSt} value={activationForm.notes}
                  onChange={(e) => setActivationForm((p) => ({ ...p, notes: e.target.value }))} />
              </div>
            </div>

            {/* Live preview. Nobody should have to guess what a renewal will
                cost or when it ends before committing to it. */}
            {quote && (
              <div style={{
                marginTop: 14, padding: "12px 14px", borderRadius: 10,
                background: quote.error ? "rgba(239,68,68,.10)" : "rgba(59,130,246,.10)",
                border: `1px solid ${quote.error ? "#ef4444" : "#3b82f6"}`,
                fontSize: 12.5, lineHeight: 1.7,
              }}>
                {quote.error ? (
                  <span style={{ color: "#f87171" }}>{quote.error}</span>
                ) : (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                      <span><b>{quote.days} day{quote.days === 1 ? "" : "s"}</b> · {quote.note}</span>
                      <b style={{ fontSize: 15, color: activationForm.mode === "CREDIT" ? "#f59e0b" : "#4ade80" }}>
                        {money(quote.total)}
                      </b>
                    </div>
                    <div style={{ color: t.textMuted, marginTop: 4 }}>
                      Expires {new Date(quote.newExpiry).toLocaleString()}
                      {activationForm.mode === "BALANCE" && ` · wallet left ${money(quote.balanceAfter)}`}
                      {activationForm.mode === "CREDIT" && " · recorded as owed, no payment taken"}
                    </div>
                  </>
                )}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <Btn variant="ghost" onClick={() => setShowActivationModal(false)}>Cancel</Btn>
              <Btn variant="primary" onClick={runActivation}>
                {activationForm.mode === "CREDIT" ? "Activate on credit" : "Activate"}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {showImportModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", zIndex: 110, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setShowImportModal(false)}>
          <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, padding: 18, width: "100%", maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 12 }}>Import Subscribers</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={labelSt}>Import Type</label>
                <select style={{ ...inputSt, cursor: "pointer" }} value={importType} onChange={(e) => setImportType(e.target.value as any)}>
                  <option value="CSV">CSV</option>
                  <option value="EXCEL">Excel</option>
                </select>
              </div>
              <div>
                <label style={labelSt}>Salesperson</label>
                <select style={{ ...inputSt, cursor: "pointer" }} value={importSalespersonId} onChange={(e) => setImportSalespersonId(e.target.value)}>
                  <option value="">Select salesperson</option>
                  {salespersons.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
                </select>
              </div>
            </div>
            {/* Upload a real file — the easy way. CSV/Excel/JSON all supported. */}
            <input ref={importFileRef} type="file" accept=".csv,.tsv,.txt,.json,.xlsx,.xls" style={{ display: "none" }}
              onChange={(e) => { onImportFile(e.target.files?.[0]); e.target.value = ""; }} />
            <div
              onClick={() => importFileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); onImportFile(e.dataTransfer.files?.[0]); }}
              style={{ marginTop: 12, border: `2px dashed ${t.cardBorder}`, borderRadius: 10, padding: "18px 14px", textAlign: "center", cursor: "pointer", background: d ? "var(--surface-2)" : "#f8fafc" }}>
              <div style={{ fontSize: 22, marginBottom: 4 }}>📄⬆️</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
                {importFileName ? `Selected: ${importFileName}` : "Click to upload, or drag a file here"}
              </div>
              <div style={{ fontSize: 11, color: t.textMuted, marginTop: 3 }}>CSV, Excel (.xlsx/.xls) or JSON — the file is read for you.</div>
            </div>

            <div style={{ marginTop: 10, fontSize: 11, color: t.textMuted }}>…or paste CSV / JSON below. Required fields: fullName/fullname, username, connectionPassword/password, identity, phone, email.</div>
            <textarea style={{ ...inputSt, marginTop: 8, minHeight: 140, resize: "vertical" }} value={importRaw} onChange={(e) => { setImportRaw(e.target.value); setImportFileName(""); }} placeholder="fullName,username,connectionPassword,identity,phone,email,packageId,nasId,connectionType" />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
              <span style={{ fontSize: 11, color: t.textMuted }}>Preview rows: {Math.max(importRaw.split("\n").filter(Boolean).length - 1, 0)}</span>
              <button onClick={() => setImportRaw("fullName,username,connectionPassword,identity,phone,email,packageId,nasId,connectionType\nJohn Doe,jdoe,jdoe123,123456789,+123456789,john@example.com,1,1,FTTH")}
                style={{ background: "transparent", border: `1px solid ${t.cardBorder}`, borderRadius: 6, color: t.textSub, fontSize: 11, padding: "5px 8px", cursor: "pointer" }}>
                Load Sample Template
              </button>
            </div>

            {/* ── Per-value mapping to THIS panel + pre-import checks ── */}
            {(() => {
              const rows = parseImportRows();
              if (rows === null) return <div style={{ marginTop: 12, fontSize: 12, color: "#ef4444" }}>⚠ Could not parse — check the CSV/JSON format.</div>;
              if (rows.length === 0) return null;
              const cols = Object.keys(rows[0] || {});
              const blanks = (f: string) => rows.filter((r) => !String(r[f] ?? "").trim()).length;
              // Required = enforced on import; recommended = nice to have, never blocks.
              const required = [
                { label: "fullName", f: "fullName" },
                { label: "username", f: "username" },
                { label: "password", f: "password" },
              ].map((x) => ({ ...x, miss: blanks(x.f) }));
              const recommended = [
                { label: "identity (CNIC)", f: "identity" },
                { label: "phone", f: "phone" },
                { label: "email", f: "email" },
              ].map((x) => ({ ...x, miss: blanks(x.f) }));
              // Distinct NAS / package values actually present in the file.
              const nasVals = [...new Set(rows.map(rowNasVal).filter(Boolean))];
              const pkgVals = [...new Set(rows.map(rowPkgVal).filter(Boolean))];
              const nasBad = nasVals.filter((v) => !resolveNas(v));
              const pkgBad = pkgVals.filter((v) => !resolvePkg(v));

              const MapRow = ({ val, kind }: { val: string; kind: "nas" | "pkg" }) => {
                const cur = kind === "nas" ? (nasMap[val] || "") : (pkgMap[val] || "");
                const set = (id: string) => kind === "nas"
                  ? setNasMap((m) => ({ ...m, [val]: id }))
                  : setPkgMap((m) => ({ ...m, [val]: id }));
                const opts = kind === "nas" ? nasList : packages;
                const count = rows.filter((r) => (kind === "nas" ? rowNasVal(r) : rowPkgVal(r)) === val).length;
                return (
                  <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <span style={{ fontSize: 12, color: t.text }} title={val}>
                      File&apos;s {kind === "nas" ? "NAS" : "package"} <b style={{ color: "#f59e0b" }}>{val}</b>
                      <span style={{ color: t.textMuted }}> ({count} row{count === 1 ? "" : "s"}) →</span>
                    </span>
                    <select style={{ ...inputSt, cursor: "pointer" }} value={cur} onChange={(e) => set(e.target.value)}>
                      <option value="">— choose the matching {kind === "nas" ? "NAS" : "package"} in this panel —</option>
                      {opts.map((o: any) => (
                        <option key={o.id} value={o.id}>
                          {kind === "nas" ? `${o.nasname}${o.nasIp ? ` (${o.nasIp})` : ""}` : `${o.name}`} — id {o.id}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              };

              return (
                <div style={{ marginTop: 12, border: `1px solid ${t.cardBorder}`, borderRadius: 10, padding: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Check &amp; map before import ({rows.length} row{rows.length === 1 ? "" : "s"})</div>

                  {(nasBad.length > 0 || pkgBad.length > 0) && (
                    <div style={{ fontSize: 11.5, color: t.textSub, background: "rgba(245,158,11,.10)", border: "1px solid rgba(245,158,11,.3)", borderRadius: 8, padding: "8px 10px", marginBottom: 6, lineHeight: 1.5 }}>
                      Your file came from another panel, so its NAS/package id numbers don&apos;t exist here.
                      For each old number below, pick the matching NAS or package <b>in this panel</b>. Every row using
                      that old number will be switched to your id automatically. (Tip: to skip this, set the correct
                      nas_id / package_id in the Excel before uploading.)
                    </div>
                  )}

                  {/* required (block) + recommended (info) field checks */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 4, alignItems: "center" }}>
                    <span style={{ fontSize: 10.5, color: t.textMuted, fontWeight: 700 }}>REQUIRED:</span>
                    {required.map((r) => (
                      <span key={r.label} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 999, background: r.miss === 0 ? "rgba(34,197,94,.14)" : "rgba(239,68,68,.14)", color: r.miss === 0 ? "#16a34a" : "#ef4444", fontWeight: 600 }}>
                        {r.miss === 0 ? "✓" : "✕"} {r.label}{r.miss > 0 ? ` (${r.miss} blank)` : ""}
                      </span>
                    ))}
                    <span style={{ fontSize: 10.5, color: t.textMuted, fontWeight: 700, marginLeft: 6 }}>OPTIONAL:</span>
                    {recommended.map((r) => (
                      <span key={r.label} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 999, background: r.miss === 0 ? "rgba(34,197,94,.14)" : "rgba(245,158,11,.14)", color: r.miss === 0 ? "#16a34a" : "#f59e0b", fontWeight: 600 }}>
                        {r.miss === 0 ? "✓" : "◦"} {r.label}{r.miss > 0 ? ` (${r.miss} blank)` : ""}
                      </span>
                    ))}
                  </div>

                  {/* NAS mapping — only the values that don't match this panel */}
                  {nasVals.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: t.text }}>
                        NAS/router: {nasVals.length - nasBad.length}/{nasVals.length} already match this panel
                        {nasBad.length > 0 && <span style={{ color: "#f59e0b" }}> · {nasBad.length} need you to pick below</span>}
                      </div>
                      {nasBad.map((v) => <MapRow key={`n${v}`} val={v} kind="nas" />)}
                    </div>
                  )}

                  {/* Package mapping — only mismatches */}
                  {pkgVals.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: t.text }}>
                        Package/plan: {pkgVals.length - pkgBad.length}/{pkgVals.length} already match this panel
                        {pkgBad.length > 0 && <span style={{ color: "#f59e0b" }}> · {pkgBad.length} need you to pick below</span>}
                      </div>
                      {pkgBad.map((v) => <MapRow key={`p${v}`} val={v} kind="pkg" />)}
                    </div>
                  )}

                  {nasBad.length === 0 && pkgBad.length === 0 && (nasVals.length > 0 || pkgVals.length > 0) && (
                    <div style={{ marginTop: 8, fontSize: 12, color: "#16a34a" }}>✓ All NAS and packages resolved to this panel.</div>
                  )}

                  {/* preview */}
                  <div style={{ overflowX: "auto", marginTop: 12 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead>
                        <tr>{cols.slice(0, 6).map((c) => <th key={c} style={{ textAlign: "left", padding: "4px 6px", color: t.textMuted, borderBottom: `1px solid ${t.cardBorder}` }}>{c}</th>)}</tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, 3).map((r, i) => (
                          <tr key={i}>{cols.slice(0, 6).map((c) => <td key={c} style={{ padding: "4px 6px", color: t.text, borderBottom: `1px solid ${t.cardBorder}` }}>{String(r[c] ?? "")}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                    {rows.length > 3 && <div style={{ fontSize: 10.5, color: t.textMuted, marginTop: 4 }}>…and {rows.length - 3} more</div>}
                  </div>
                </div>
              );
            })()}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <Btn variant="ghost" onClick={() => setShowImportModal(false)}>Cancel</Btn>
              <Btn variant="primary" onClick={runImport}>Import</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Move subscribers to another account */}
      {showTransferModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", zIndex: 110, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setShowTransferModal(false)}>
          <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, padding: 20, width: "100%", maxWidth: 560, maxHeight: "88vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>
              Move {selectedIds.length} subscriber(s) to another account
            </div>
            <div style={{ fontSize: 11.5, color: t.textSub, lineHeight: 1.7, marginBottom: 14 }}>
              The customer notices nothing — same username, package and expiry date. What changes is
              who owns them commercially.
            </div>

            <div style={{ maxHeight: 120, overflowY: "auto", border: `1px solid ${t.cardBorder}`, borderRadius: 8, padding: 8, fontSize: 11.5, marginBottom: 14 }}>
              {subscribers.filter((s) => selectedIds.includes(s.id)).map((s) => (
                <div key={s.id} style={{ padding: "2px 0" }}>
                  <b>{s.fullName}</b> <span style={{ color: t.textMuted }}>· {s.username}</span>
                </div>
              ))}
            </div>

            <label style={{ fontSize: 12, color: t.textSub, display: "block", marginBottom: 5 }}>Move to</label>
            <select value={transferTo} onChange={(e) => setTransferTo(e.target.value)}
              style={{ width: "100%", background: t.bg, border: `1px solid ${t.cardBorder}`, borderRadius: 8, padding: "9px 10px", color: t.text, fontSize: 13 }}>
              <option value="">Select an account…</option>
              {transferAccounts.map((u: any) => (
                <option key={u.id} value={u.id}>
                  {u.name} — {u.role} (wallet {Number(u.balance ?? 0).toFixed(0)})
                </option>
              ))}
            </select>

            <label style={{ fontSize: 12, color: t.textSub, display: "block", margin: "12px 0 5px" }}>
              Reason <span style={{ color: t.textMuted }}>(kept in the transfer history)</span>
            </label>
            <input value={transferReason} onChange={(e) => setTransferReason(e.target.value)}
              placeholder="e.g. area reassigned to Rwd"
              style={{ width: "100%", background: t.bg, border: `1px solid ${t.cardBorder}`, borderRadius: 8, padding: "9px 10px", color: t.text, fontSize: 13 }} />

            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, marginTop: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={transferSettle} style={{ marginTop: 3 }}
                onChange={(e) => setTransferSettle(e.target.checked)} />
              <span style={{ fontSize: 11.5, color: t.textSub, lineHeight: 1.7 }}>
                <b style={{ color: t.text }}>Settle the money for unserved days</b><br />
                The old owner is refunded pro-rata; the new owner is charged pro-rata at
                <b> their</b> buy price. Untick to hand the customer over without charging —
                use that when the receiving account has no wallet balance yet, or when you are
                just re-assigning your own records.
              </span>
            </label>

            {transferSettle && (
              <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 9, background: "rgba(245,158,11,.10)", border: "1px solid rgba(245,158,11,.4)", fontSize: 11.5, color: t.textSub, lineHeight: 1.7 }}>
                <b style={{ color: "#FCD34D" }}>If the receiving wallet cannot cover it, that subscriber is not moved.</b>{" "}
                The others still go through — the result will name any that were refused.
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <Btn variant="ghost" onClick={() => setShowTransferModal(false)}>Cancel</Btn>
              <Btn variant="primary" onClick={runTransfer} disabled={transferBusy || !transferTo}>
                {transferBusy ? "Moving…" : "Move"}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* Mass Delete Modal */}
      {showMassDeleteModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", zIndex: 110, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setShowMassDeleteModal(false)}>
          <div style={{ background: t.card, border: "1px solid #7f1d1d", borderRadius: 12, padding: 18, width: "100%", maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 800, fontSize: 15, color: "#f87171", marginBottom: 8 }}>Mass Delete Subscribers</div>
            <div style={{ fontSize: 12, color: t.textSub, marginBottom: 8 }}>Selected subscribers: {selectedIds.length}</div>
            <div style={{ maxHeight: 140, overflowY: "auto", border: `1px solid ${t.cardBorder}`, borderRadius: 8, padding: 8, fontSize: 11 }}>
              {subscribers.filter((s) => selectedIds.includes(s.id)).map((s) => <div key={s.id}>{s.fullName}</div>)}
            </div>
            <div style={{ fontSize: 11, color: "#ff7070", marginTop: 8 }}>This action cannot be undone.</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <Btn variant="ghost" onClick={() => setShowMassDeleteModal(false)}>Cancel</Btn>
              <Btn variant="danger" onClick={runMassDelete}>Delete All</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Mass Service Settings Modal */}
      {showMassSettingsModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", zIndex: 110, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setShowMassSettingsModal(false)}>
          <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, padding: 18, width: "100%", maxWidth: 760, maxHeight: "88vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 12 }}>Mass Service Settings ({selectedIds.length} selected)</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={labelSt}>Profile Status</label>
                <select style={{ ...inputSt, cursor: "pointer" }} value={massSettingsForm.profileStatus || "ACTIVE"} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, profileStatus: e.target.value }))}>
                  {["ACTIVE", "INACTIVE", "SUSPENDED", "EXPIRED"].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label style={labelSt}>Connection Type</label>
                <select style={{ ...inputSt, cursor: "pointer" }} value={massSettingsForm.connectionType || "FTTH"} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, connectionType: e.target.value }))}>
                  {["FTTH", "ADSL", "G4_LTE", "WIRELESS", "FIBER"].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label style={labelSt}>NAS</label>
                <select style={{ ...inputSt, cursor: "pointer" }} value={massSettingsForm.nasId || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, nasId: e.target.value }))}>
                  <option value="">No change</option>
                  {nasList.map((n) => <option key={n.id} value={n.id}>{n.nasname}</option>)}
                </select>
              </div>
              <div>
                <label style={labelSt}>Salesperson</label>
                <select style={{ ...inputSt, cursor: "pointer" }} value={massSettingsForm.salespersonId || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, salespersonId: e.target.value }))}>
                  <option value="">No change</option>
                  {salespersons.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
                </select>
              </div>
              <div>
                <label style={labelSt}>Package</label>
                <select style={{ ...inputSt, cursor: "pointer" }} value={massSettingsForm.packageId || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, packageId: e.target.value }))}>
                  <option value="">No change</option>
                  {packages.map((pk) => <option key={pk.id} value={pk.id}>{pk.name}</option>)}
                </select>
              </div>
              <div>
                <label style={labelSt}>Expiration Date</label>
                <input type="datetime-local" style={inputSt} value={massSettingsForm.expirationDate || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, expirationDate: e.target.value }))} />
              </div>
              <div><label style={labelSt}>Total Volume (GB)</label><input type="number" style={inputSt} value={massSettingsForm.totalVolumeGb || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, totalVolumeGb: e.target.value }))} /></div>
              <div><label style={labelSt}>Used Volume (GB)</label><input type="number" style={inputSt} value={massSettingsForm.usedVolumeGb || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, usedVolumeGb: e.target.value }))} /></div>
              <div><label style={labelSt}>Discount Amount Type</label><select style={{ ...inputSt, cursor: "pointer" }} value={massSettingsForm.discountAmountType || "PERCENTAGE"} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, discountAmountType: e.target.value }))}><option value="PERCENTAGE">Percentage</option><option value="FIXED">Fixed</option></select></div>
              <div><label style={labelSt}>Discount</label><input type="number" style={inputSt} value={massSettingsForm.discount || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, discount: e.target.value }))} /></div>
              <div><label style={labelSt}>Box/POP Number</label><input style={inputSt} value={massSettingsForm.boxPopNumber || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, boxPopNumber: e.target.value }))} /></div>
              <div><label style={labelSt}>Box/POP Address</label><input style={inputSt} value={massSettingsForm.boxPopAddress || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, boxPopAddress: e.target.value }))} /></div>
              <div><label style={labelSt}>MC/Switch/ONU Board</label><input style={inputSt} value={massSettingsForm.mcSwitchOnuBoard || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, mcSwitchOnuBoard: e.target.value }))} /></div>
              <div><label style={labelSt}>Electric Type/Socket</label><input style={inputSt} value={massSettingsForm.electricTypeSocket || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, electricTypeSocket: e.target.value }))} /></div>
              <div><label style={labelSt}>Cable Type</label><input style={inputSt} value={massSettingsForm.cableType || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, cableType: e.target.value }))} /></div>
              <div><label style={labelSt}>Uplink Port</label><input style={inputSt} value={massSettingsForm.uplinkPort || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, uplinkPort: e.target.value }))} /></div>
              <div><label style={labelSt}>Fiber Code/ID</label><input style={inputSt} value={massSettingsForm.fiberCodeId || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, fiberCodeId: e.target.value }))} /></div>
              <div><label style={labelSt}>Fiber Color</label><input style={inputSt} value={massSettingsForm.fiberColor || ""} onChange={(e) => setMassSettingsForm((p: any) => ({ ...p, fiberColor: e.target.value }))} /></div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <Btn variant="ghost" onClick={() => setShowMassSettingsModal(false)}>Cancel</Btn>
              <Btn variant="primary" onClick={runMassSettings}>Apply to All</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Export Modal */}
      {/* Replaced the old two-field modal, which could only filter by status
          and wrote a CSV whichever format you picked. */}
      <ExportDialog open={showExportModal} onClose={() => setShowExportModal(false)} />

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", zIndex: 110, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={() => setDeleteConfirm(null)}
        >
          <div style={{ background: t.card, border: "1px solid #7f1d1d", borderRadius: 14, padding: 24, width: 400 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div style={{ fontSize: 24 }}>⚠️</div>
              <div style={{ fontWeight: 800, fontSize: 15, color: "#f87171" }}>Delete Subscriber</div>
            </div>
            <p style={{ fontSize: 13, marginBottom: 14 }}>
              This will permanently delete <b>{deleteConfirm.fullName}</b> from the CRM, FreeRADIUS
              and the router's local PPP secrets. Their internet stops immediately.
            </p>

            {/*
              A subscriber with recorded payments is refused unless this is
              ticked. The refusal was invisible before — the request returned a
              clear 400 explaining that money history would be destroyed, and
              the dialog gave no way to act on it, so Delete simply appeared to
              do nothing however many times it was pressed.
            */}
            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, marginBottom: 16, cursor: "pointer" }}>
              <input type="checkbox" checked={deleteForce} style={{ marginTop: 3 }}
                onChange={(e) => setDeleteForce(e.target.checked)} />
              <span style={{ fontSize: 11.5, color: t.textSub, lineHeight: 1.7 }}>
                <b style={{ color: "#FCD34D" }}>Delete even if they have payment history</b><br />
                Invoices and payments are erased with them, so your income totals will change.
                For a real customer, <b>Deactivate</b> is usually the right action — it stops the
                service and keeps the accounting intact.
              </span>
            </label>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn onClick={() => setDeleteConfirm(null)} variant="ghost">
                Cancel
              </Btn>
              <Btn onClick={() => deleteSub(deleteConfirm)} variant="danger" disabled={deleteBusy}>
                {deleteBusy ? "Deleting…" : "Delete Permanently"}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Helper components for detail tabs
function InfoRow({ label, value, mono = false }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid rgba(148,163,184,0.2)" }}>
      <span style={{ fontSize: 11, color: "var(--muted)" }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 500, fontFamily: mono ? "monospace" : "inherit", color: mono ? "#34d399" : "inherit" }}>{value || "—"}</span>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: 8, padding: "12px", textAlign: "center", border: "1px solid rgba(148,163,184,0.2)" }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}