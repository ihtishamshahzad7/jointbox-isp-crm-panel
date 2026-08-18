"use client";
import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Wizard, Field } from "../components/wizard";
import ImportWizard from "../components/import-wizard";
import { downloadCsv } from "../components/csv-export";
import { DeviceHealth } from './device-health';
import { WinBoxToolbar } from "../components/winbox-toolbar";
import { Expandable } from "../components/expandable";
import { GroupPanel } from "../components/group-panel";
import { NasTraffic } from "./nas-traffic";
import { SkeletonTable } from "../components/skeleton";
import { NasTable } from "../components/network-tables";
import { RecordNotes } from "../components/record-notes";
import { silent } from "../components/silent";

// ─── Types ─────────────────────────────────────────────────────────
interface NasEntry {
  id: number; nasname: string; shortname?: string | null; nasIp: string | null; secret: string | null;
  type: string; apiPort: number; incomingPort: number;
  apiUsername: string | null; apiPassword: string | null;
  isActive: boolean; description: string | null;
  _count?: { subscribers: number };
  /** Who registered this router. Null for legacy rows predating ownership. */
  ownerId?: number | null;
  owner?: { id: number; name: string; role: string } | null;
  /** Accounts this router has been shared down to. */
  assignments?: { userId: number; user?: { id: number; name: string } }[];
}

interface NasOverview {
  totalNas: number;
  onlineNas: number;
  offlineNas: number;
  activeSessions: number;
  radiusAlive: boolean;
  radiusNasCount: number;
}

// Matches what nas.service.ts checkReachability() actually returns:
interface Reachability {
  apiPortOpen: boolean;       // TCP check to MikroTik API port
  radiusPortOpen: boolean;    // UDP check to FreeRADIUS :1812
  incomingPortOpen: boolean;  // UDP check to CoA port
  nasRegistered: boolean;     // NAS IP found in RADIUS DB
  activeSessionCount: number; // from radacct WHERE acctstoptime IS NULL
  radiusNasCount: number;     // total NAS rows in RADIUS DB
  // MikroTik quickCheck fields (empty string '' = not available, NOT undefined)
  identity: string;
  version: string;
  cpuLoad: string;
  uptime: string;
  activeConnections: number;  // from /ppp/active/print count-only
  // meta
  radiusIp: string;
  radiusPort: number;
  coaPort: number;
  responseTimeMs: number | null;
  lastChecked: Date | null;
}

// Matches MikrotikDetails from mikrotik-sync.service.ts syncDetails()
interface MikrotikDetails {
  identity: string; version: string; board: string; uptime: string;
  cpuLoad: string; totalMemory: string; freeMemory: string;
  totalHdd: string; freeHdd: string; activeConnections: number;
  interfaces: MikrotikInterface[];
  pppoeServer: PppoeServerInfo | null;
  pppoeProfiles: PppoeProfile[];
  radiusClients: RadiusClient[];
  apiService: ApiServiceInfo | null;
  ipAddresses: IpAddress[];
  apiErrors?: string[];
}
interface MikrotikInterface {
  name: string; type: string; mtu: string; macAddress: string;
  running: string; disabled: string; comment: string;
}
interface PppoeServerInfo {
  enabled: boolean; interface: string; serviceName: string;
  maxMtu: string; maxMru: string; authentication: string;
  keepaliveTimeout: string; defaultProfile: string;
}
interface PppoeProfile {
  name: string; localAddress: string; remoteAddress: string;
  rateLimit: string; sessionTimeout: string; comment: string;
}
interface RadiusClient {
  service: string; address: string; secret: string;
  authPort: string; acctPort: string; timeout: string; disabled: string;
}
interface ApiServiceInfo { enabled: boolean; port: string; tlsPort: string; disabled: string; }
interface IpAddress { address: string; network: string; interface: string; disabled: string; }

interface NasLog { id: string; level: 'info'|'warn'|'error'; message: string; time: Date; }

interface ViewDetail {
  nas: NasEntry;
  reachability: Reachability | null;
  details: MikrotikDetails | null;   // full sync result
  sessions: any[];
  loadingReach: boolean;
  loadingDetails: boolean;
  loadingSessions: boolean;
  detailsError: string | null;
}

const API = API_BASE;

/** ISP-level roles bypass every reseller permission gate. */
const isAdminRole = (role?: string) => role === 'ADMIN' || role === 'SUPER_ADMIN';

// ─── SVG Icons ──────────────────────────────────────────────────────
import { Icons as SharedIcons } from "../components/icons";
import API_BASE from "../components/api";
import Portal from "../components/portal";

/** NAS-specific diagnostics icons not in the shared set. */
const __nasIcons = {
  Router: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="1" y="13" width="22" height="8" rx="2"/><path d="M8 21V13"/><path d="M16 21V13"/><path d="M12 4v5M8.5 7.5L12 4l3.5 3.5"/></svg>,
  CPU: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>,
  Clock: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Network: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><line x1="12" y1="7" x2="5" y2="17"/><line x1="12" y1="7" x2="19" y2="17"/></svg>,
  Memory: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M8 6V4M12 6V4M16 6V4M8 18v2M12 18v2M16 18v2"/></svg>,
  Board: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>,
  PPPoE: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>,
  Shield: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  IP: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
};

/** Merged — shared Icons + NAS-specific inline icons, preserving original per-icon sizing. */
const Icons = {
  ...SharedIcons,
  ChevronLeft: () => <SharedIcons.ChevronLeft width={14} height={14} />,
  Sun:         () => <SharedIcons.Sun width={15} height={15} />,
  Moon:        () => <SharedIcons.Moon width={15} height={15} />,
  Refresh:     () => <SharedIcons.Refresh width={14} height={14} />,
  Plus:        () => <SharedIcons.Plus width={14} height={14} />,
  Logs:        () => <SharedIcons.Logs width={14} height={14} />,
  Signal:      () => <SharedIcons.Signal width={14} height={14} />,
  Eye:         () => <SharedIcons.Eye width={13} height={13} />,
  Edit:        () => <SharedIcons.Edit width={13} height={13} />,
  Trash:       () => <SharedIcons.Trash width={13} height={13} />,
  Toggle:      () => <SharedIcons.Toggle width={13} height={13} />,
  X:           () => <SharedIcons.X width={14} height={14} />,
  Logout:      () => <SharedIcons.Logout width={14} height={14} />,
  ...__nasIcons,
};

// ─── Helpers ────────────────────────────────────────────────────────
/** Format bytes to human-readable */
const fmtBytes = (b: number): string => {
  if (!b || isNaN(b)) return '—';
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
  if (b >= 1048576)    return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
};

/** Parse MikroTik CPU load string "45%" -> 45 */
const parseCpu = (s: string): number => parseFloat(s?.replace('%','') || '0');

/** Display a value or dash */
const val = (v: any) => (v !== undefined && v !== null && v !== '') ? String(v) : '—';

export default function NasPage() {
  const router = useRouter();
  const [user, setUser]   = useState<any>(null);
  const [time, setTime]   = useState('');
  const [greeting, setGreeting] = useState('Welcome');
  const [darkMode, setDarkMode] = useState(true);
  const [nasList, setNasList] = useState<NasEntry[]>([]);
  const [stats, setStats] = useState({ total:0, active:0, inactive:0, mikrotik:0, cisco:0, other:0 });
  const [overview, setOverview] = useState<NasOverview | null>(null);
  const [radiusStats, setRadiusStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [searchQ, setSearchQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL'|'ACTIVE'|'INACTIVE'>('ALL');
  const [typeFilter, setTypeFilter] = useState<'ALL'|'MIKROTIK'|'CISCO'|'HUAWEI'|'OTHER'>('ALL');
  const [siteFilter, setSiteFilter] = useState('ALL');
  const [groupFilter, setGroupFilter] = useState('ALL');
  const [groupOptions, setGroupOptions] = useState<Array<{ id: number; name: string; color: string | null }>>([]);
  const [showRadiusSecret, setShowRadiusSecret] = useState(false);
  const [showApiPassword, setShowApiPassword] = useState(false);

  // reachMap: keyed by NAS id, holds real-time status from /reachability
  const [reachMap, setReachMap] = useState<Record<number, Reachability>>({});
  const [checkingIds, setCheckingIds] = useState<Set<number>>(new Set());

  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editItem, setEditItem] = useState<NasEntry|null>(null);
  const [viewDetail, setViewDetail] = useState<ViewDetail|null>(null);
  const [logs, setLogs] = useState<NasLog[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<number|null>(null);
  const [activeTab, setActiveTab] = useState<'overview'|'health'|'interfaces'|'pppoe'|'radius'|'ips'|'sessions'>('overview');

  // Auto-refresh intervals
  const pollIntervalRef = useRef<NodeJS.Timeout|null>(null);
  const sessionPollRef  = useRef<NodeJS.Timeout|null>(null);

  const [form, setForm] = useState({
    nasName:'', shortname:'', nasIp:'', radiusSecret:'', nasType:'MIKROTIK', nasIdentifier:'',
    apiPort:8728, incomingPort:3799, apiUsername:'', apiPassword:'', description:'', isActive:true,
    // Link-tracing collectors (each optional, independent per NAS)
    deviceType:'MIKROTIK',
    apiEnabled:true,
    snmpEnabled:false, snmpPort:161, snmpCommunity:'public', snmpVersion:'V2C', snmpPollSec:30,
    syslogEnabled:false, syslogPort:514,
  });

  /** The signed-in account — decides whether router registration is offered. */
  const [me, setMe] = useState<any>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : '';
  const headers = useMemo(() => ({ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }), [token]);

  /** Router-sharing dialog: which NAS, and the downline accounts to offer. */
  const [shareFor, setShareFor] = useState<NasEntry|null>(null);
  const [shareAccounts, setShareAccounts] = useState<any[]>([]);
  const [shareBusy, setShareBusy] = useState(false);
  // When true a share reaches the account's whole downline; when false only
  // that exact account gets the router — so one dealer can have it while a
  // sibling dealer under the same franchise never sees it.
  const [sharePropagate, setSharePropagate] = useState(true);

  const openShare = async (nas: NasEntry) => {
    setShareFor(nas);
    try {
      const r = await fetch(`${API}/users`, { headers });
      const rows = r.ok ? await r.json() : [];
      // /users already returns only the caller's downline, excluding themselves.
      setShareAccounts(Array.isArray(rows) ? rows : rows?.data ?? []);
    } catch { setShareAccounts([]); }
  };

  const toggleShare = async (userId: number, on: boolean) => {
    if (!shareFor) return;
    setShareBusy(true);
    try {
      const r = await fetch(`${API}/nas/${shareFor.id}/assign/${userId}`, {
        method: on ? 'POST' : 'DELETE', headers,
        ...(on ? { body: JSON.stringify({ propagate: sharePropagate }) } : {}),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        addLog('error', `Share failed: ${e.message || 'Unknown error'}`);
      } else {
        addLog('info', `Router ${on ? 'shared with' : 'withdrawn from'} account #${userId}`);
        await loadData();
        // Re-read the row so the assignment list in the dialog stays truthful.
        setShareFor(prev => prev ? { ...prev, assignments: on
          ? [...(prev.assignments ?? []), { userId }]
          : (prev.assignments ?? []).filter(a => a.userId !== userId) } : prev);
      }
    } catch (e: any) { addLog('error', `Network error: ${e.message}`); }
    finally { setShareBusy(false); }
  };

  const addLog = useCallback((level: NasLog['level'], message: string) => {
    setLogs(p => [{ id: `${Date.now()}-${Math.random()}`, level, message, time: new Date() }, ...p].slice(0, 200));
  }, []);

  const [healthMap, setHealthMap] = useState<Record<number, any>>({});

  // ── Load all NAS + stats ───────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true);
    const query = groupFilter && groupFilter !== 'ALL' ? `?group=${encodeURIComponent(groupFilter)}` : '';

    // Fetch with a hard timeout so one slow/hanging endpoint (RADIUS/SNMP stats
    // can block) never freezes the whole page on "Loading…".
    const get = async (path: string, ms = 12000) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      try {
        const r = await fetch(`${API}${path}`, { headers, signal: ctrl.signal });
        return r.ok ? await r.json() : null;
      } catch { return null; }
      finally { clearTimeout(timer); }
    };

    // The NAS list is the essential one — clear "Loading" as soon as it lands.
    const nas = await get(`/nas${query}`);
    if (nas != null) setNasList(nas);
    else addLog('error', 'Failed to load NAS devices');
    setLoading(false);

    // Stats/overview are secondary — load in the background, never block the list.
    get('/nas/stats').then(v => v != null && setStats(v));
    get('/nas/radius/stats').then(v => v != null && setRadiusStats(v));
    get('/nas/overview').then(v => v != null && setOverview(v));
    get('/telemetry/nas-health').then(v => {
      if (v?.nas) setHealthMap(Object.fromEntries(v.nas.map((n: any) => [n.id, { inBps: n.inBps, outBps: n.outBps }])));
    });
  }, [groupFilter, headers, addLog]);

  useEffect(() => {
    if (!token) return;
    fetch(`${API}/auth/profile`, { headers })
      .then(r => (r.ok ? r.json() : null))
      // /auth/profile answers { user: {...} }, not the user itself.
      .then(d => setMe(d?.user ?? d))
      .catch(silent("authProfileFetch"));
  }, [token, headers]);

  useEffect(() => {
    if (!token) return;
    fetch(`${API}/groups/options`, { headers })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setGroupOptions(Array.isArray(data) ? data : []))
      .catch(silent("groupsFetch"));
  }, [token, headers]);

  useEffect(() => {
    if (!token) return;
    loadData();
  }, [token, loadData]);

  // ── Theme ──────────────────────────────────────────────────────────
  const d = darkMode;
  const t = {
    bg:          d ? 'var(--bg)' : '#f0f4fa',
    sidebar:     d ? 'var(--surface)' : 'var(--border)',
    card:        d ? 'var(--surface)' : '#ffffff',
    cardBorder:  d ? 'var(--border)' : 'var(--text)',
    header:      d ? 'var(--surface)' : 'var(--border)',
    text:        d ? 'var(--text)' : 'var(--surface)',
    textMuted:   d ? 'var(--muted)' : 'var(--muted)',
    textSub:     d ? 'var(--muted)' : '#475569',
    input:       d ? 'var(--bg)' : '#f8fafc',
    inputBorder: d ? 'var(--border)' : '#cbd5e1',
    tableRow:    d ? 'var(--surface-2)' : '#f8fafc',
    tableRow2:   d ? '#121d30' : '#ffffff',
    accent:    '#0ea5e9',
    green:     '#22c55e',
    red:       '#ef4444',
    amber:     '#f59e0b',
    purple:    '#8b5cf6',
    teal:      '#14b8a6',
  };

  // ── Check one NAS reachability (NON-DISRUPTIVE: read-only API calls) ─
  // The backend /reachability calls quickCheck (read-only) + RADIUS DB queries.
  // Zero risk to PPPoE sessions — no write commands issued.
  const checkNas = useCallback(async (id: number, silent = false) => {
    setCheckingIds(p => new Set([...p, id]));
    try {
      const res = await fetch(`${API}/nas/${id}/reachability`, { headers });
      if (res.ok) {
        const data: Reachability = await res.json();
        // Normalise: backend may return empty string or null for API fields
        data.identity  = data.identity  || '';
        data.version   = data.version   || '';
        data.cpuLoad   = data.cpuLoad   || '';
        data.uptime    = data.uptime    || '';
        data.activeConnections = data.activeConnections ?? 0;
        setReachMap(p => ({ ...p, [id]: data }));
        if (!silent) addLog(
          data.apiPortOpen ? 'info' : 'warn',
          `NAS #${id} — RADIUS:${data.radiusPortOpen?'UP':'DOWN'} ` +
          `API:${data.apiPortOpen?'UP':'DOWN'} ` +
          (data.identity  ? `Identity:${data.identity} ` : '') +
          (data.cpuLoad   ? `CPU:${data.cpuLoad} `        : '') +
          `Sessions:${data.activeSessionCount}`
        );
      } else {
        if (!silent) addLog('error', `Reachability check failed for NAS #${id} (HTTP ${res.status})`);
      }
    } catch (e: any) {
      if (!silent) addLog('error', `Reachability check error for NAS #${id}: ${e.message}`);
    }
    setCheckingIds(p => { const s = new Set(p); s.delete(id); return s; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Full sync (read-only on MikroTik — no writes) ─────────────────
  // Fetches system/resource, interfaces, ppp/active, etc.
  // Safe to call in production — does NOT disconnect any PPPoE user.
  const fetchDetails = useCallback(async (nasId: number): Promise<MikrotikDetails | null> => {
    try {
      const res = await fetch(`${API}/nas/${nasId}/sync`, { headers });
      if (!res.ok) { addLog('warn', `Sync returned ${res.status} for NAS #${nasId}`); return null; }
      return await res.json() as MikrotikDetails;
    } catch (e: any) {
      addLog('error', `Sync error NAS #${nasId}: ${e.message}`);
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Fetch sessions for a NAS ───────────────────────────────────────
  const fetchSessions = useCallback(async (nasId: number): Promise<any[]> => {
    try {
      const res = await fetch(`${API}/nas/${nasId}/sessions`, { headers });
      if (!res.ok) return [];
      const raw = await res.json();
      return Array.isArray(raw) ? raw : (raw.sessions || []);
    } catch { return []; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Open NAS detail — loads sections independently so partial data shows ─
  const openView = useCallback(async (nas: NasEntry) => {
    // Reset to loading state — keep previous data if re-opening same NAS
    setActiveTab('overview');
    setViewDetail({
      nas, reachability: null, details: null, sessions: [],
      loadingReach: true, loadingDetails: !!(nas.apiUsername && nas.apiPassword),
      loadingSessions: true, detailsError: null,
    });

    // 1) Reachability (fast: ~5s) — loads first
    fetch(`${API}/nas/${nas.id}/reachability`, { headers })
      .then(r => r.ok ? r.json() : null)
      .then((reach: Reachability | null) => {
        if (reach) {
          reach.identity  = reach.identity  || '';
          reach.version   = reach.version   || '';
          reach.cpuLoad   = reach.cpuLoad   || '';
          reach.uptime    = reach.uptime    || '';
          reach.activeConnections = reach.activeConnections ?? 0;
          setReachMap(p => ({ ...p, [nas.id]: reach }));
        }
        setViewDetail(p => p ? { ...p, reachability: reach, loadingReach: false } : null);
      })
      .catch(() => setViewDetail(p => p ? { ...p, loadingReach: false } : null));

    // 2) Sessions (fast: DB query only)
    fetchSessions(nas.id).then(sessions => {
      setViewDetail(p => p ? { ...p, sessions, loadingSessions: false } : null);
    });

    // 3) Full MikroTik sync — only if credentials exist
    if (nas.apiUsername && nas.apiPassword) {
      fetchDetails(nas.id).then(details => {
        if (details) {
          // Also update reachMap with fresh data from sync
          setReachMap(p => {
            const existing = p[nas.id];
            if (!existing) return p;
            return {
              ...p, [nas.id]: {
                ...existing,
                identity: details.identity || existing.identity,
                version:  details.version  || existing.version,
                cpuLoad:  details.cpuLoad  || existing.cpuLoad,
                uptime:   details.uptime   || existing.uptime,
                activeConnections: details.activeConnections ?? existing.activeConnections,
              }
            };
          });
        }
        setViewDetail(p => p ? {
          ...p, details,
          loadingDetails: false,
          detailsError: details ? null : 'Could not connect to MikroTik API',
        } : null);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchDetails, fetchSessions]);

  // ── Refresh detail view (updates all sections) ─────────────────────
  const refreshView = useCallback(async () => {
    if (!viewDetail) return;
    const nas = viewDetail.nas;
    setViewDetail(p => p ? { ...p, loadingReach: true, loadingSessions: true } : null);

    const [reachRes, sessions] = await Promise.all([
      fetch(`${API}/nas/${nas.id}/reachability`, { headers })
        .then(r => r.ok ? r.json() : null).catch(() => null),
      fetchSessions(nas.id),
    ]);

    const reach = reachRes as Reachability | null;
    if (reach) {
      reach.identity  = reach.identity  || '';
      reach.version   = reach.version   || '';
      reach.cpuLoad   = reach.cpuLoad   || '';
      reach.uptime    = reach.uptime    || '';
      reach.activeConnections = reach.activeConnections ?? 0;
      setReachMap(p => ({ ...p, [nas.id]: reach }));
    }
    setViewDetail(p => p ? { ...p, reachability: reach, sessions, loadingReach: false, loadingSessions: false } : null);

    // Re-sync details too
    if (nas.apiUsername && nas.apiPassword) {
      setViewDetail(p => p ? { ...p, loadingDetails: true } : null);
      fetchDetails(nas.id).then(details => {
        setViewDetail(p => p ? { ...p, details, loadingDetails: false, detailsError: details ? null : 'API unreachable' } : null);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewDetail, fetchDetails, fetchSessions]);

  // ── Save NAS ───────────────────────────────────────────────────────
  const saveNas = async () => {
    if (!form.nasName.trim()) { addLog('error', 'NAS Name is required'); return; }
    if (!form.nasIp.trim())   { addLog('error', 'NAS IP is required'); return; }
    if (!form.radiusSecret.trim()) { addLog('error', 'RADIUS Secret is required'); return; }
    const ipOk = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(form.nasIp.trim());
    if (!ipOk) { addLog('error', 'NAS IP must be a valid IP address'); return; }
    const url    = editItem ? `${API}/nas/${editItem.id}` : `${API}/nas`;
    const method = editItem ? 'PUT' : 'POST';
    const body = {
      nasName: form.nasName.trim(),
      shortname: (form.shortname.trim() || form.nasName.trim()),
      nasIp:   form.nasIp.trim(),
      secret:  form.radiusSecret.trim(),
      nasType: form.nasType,
      // FIX: send the actual ports from the form, not hardcoded values
      apiPort:      Number(form.apiPort),
      incomingPort: Number(form.incomingPort),
      nasIdentifier: form.nasIdentifier.trim(),
      apiUsername:  form.apiUsername.trim() || undefined,
      apiPassword:  form.apiPassword.trim() || undefined,
      description:  form.description.trim() || undefined,
      isActive:     form.isActive,
      deviceType:    form.deviceType,
      apiEnabled:    form.apiEnabled,
      snmpEnabled:   form.snmpEnabled,
      snmpPort:      Number(form.snmpPort),
      snmpCommunity: form.snmpCommunity.trim() || 'public',
      snmpVersion:   form.snmpVersion,
      snmpPollSec:   Number(form.snmpPollSec),
      syslogEnabled: form.syslogEnabled,
      syslogPort:    Number(form.syslogPort),
    };
    try {
      const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
      if (res.ok) {
        addLog('info', `NAS "${form.nasName}" ${editItem ? 'updated' : 'created'} — apiPort=${form.apiPort}`);
        setShowForm(false); setEditItem(null); resetForm(); await loadData();
      } else {
        const e: any = await res.json().catch(() => ({}));
        const msg = Array.isArray(e?.message) ? e.message.join(' ') : e?.message;
        addLog('error', `Save failed: ${msg || 'Unknown error'}`);
        // Throw so the wizard keeps the dialog open and shows the reason,
        // instead of closing as though the router had been added.
        throw new Error(msg || `Save failed (HTTP ${res.status})`);
      }
    } catch (e: any) {
      addLog('error', `Network error: ${e.message}`);
      throw e;
    }
  };

  const deleteNas = async (id: number) => {
    try {
      const res = await fetch(`${API}/nas/${id}`, { method:'DELETE', headers });
      if (res.ok) { addLog('info', `NAS #${id} deleted`); await loadData(); }
      else addLog('error', `Delete failed for NAS #${id}`);
    } catch (e: any) { addLog('error', `Delete error: ${e.message}`); }
    setDeleteConfirm(null);
  };

  const [coaTesting, setCoaTesting] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<{ ok: boolean; text: string } | null>(null);
  // ICMP ping from the server — is the router even reachable on the network?
  const pingNas = async (id: number) => {
    setPinging(true); setPingResult(null);
    addLog('info', `Pinging NAS #${id}…`);
    try {
      const res = await fetch(`${API}/nas/${id}/ping`, { headers });
      const data = await res.json();
      setPingResult({ ok: !!data?.reachable, text: data?.message || (res.ok ? 'done' : 'failed') });
      addLog(data?.reachable ? 'info' : 'error', `Ping: ${data?.message || 'failed'}`);
    } catch (e: any) {
      setPingResult({ ok: false, text: e.message });
      addLog('error', `Ping error: ${e.message}`);
    }
    setPinging(false);
  };

  // Probe whether this NAS accepts RADIUS CoA — harmless, changes nothing.
  const testCoa = async (id: number) => {
    setCoaTesting(true);
    addLog('info', `Testing CoA reachability for NAS #${id}…`);
    try {
      const res = await fetch(`${API}/network/nas/${id}/test-coa`, { headers });
      const data = await res.json();
      addLog(data?.reachable ? 'info' : 'error', `CoA test: ${data?.message || (res.ok ? 'ok' : 'failed')}`);
    } catch (e: any) { addLog('error', `CoA test error: ${e.message}`); }
    setCoaTesting(false);
  };

  const toggleNas = async (id: number) => {
    try {
      const res = await fetch(`${API}/nas/${id}/toggle`, { method:'PATCH', headers });
      if (res.ok) await loadData();
      else addLog('error', `Toggle failed for NAS #${id}`);
    } catch (e: any) { addLog('error', `Toggle error: ${e.message}`); }
  };

  const resetForm = () => setForm({
    nasName:'', shortname:'', nasIp:'', radiusSecret:'', nasType:'MIKROTIK', nasIdentifier:'',
    apiPort:8728, incomingPort:3799, apiUsername:'', apiPassword:'', description:'', isActive:true,
    deviceType:'MIKROTIK', apiEnabled:true,
    snmpEnabled:false, snmpPort:161, snmpCommunity:'public', snmpVersion:'V2C', snmpPollSec:30,
    syslogEnabled:false, syslogPort:514,
  });

  // FIX: populate form with actual stored ports from the NAS record
  const openEdit = (nas: NasEntry) => {
    setForm({
      nasName:     nas.nasname,
      shortname:   nas.shortname || nas.nasname,
      nasIp:       nas.nasIp       || '',
      radiusSecret:nas.secret      || '',
      nasType:     nas.type        || 'MIKROTIK',
      nasIdentifier: (nas as any).nasIdentifier || '',
      apiPort:     nas.apiPort     || 8728,   // use actual stored port
      incomingPort:nas.incomingPort|| 3799,   // use actual stored port
      apiUsername: nas.apiUsername || '',
      apiPassword: nas.apiPassword || '',
      description: nas.description || '',
      isActive:    nas.isActive,
      deviceType:    (nas as any).deviceType    ?? 'MIKROTIK',
      apiEnabled:    (nas as any).apiEnabled    ?? true,
      snmpEnabled:   (nas as any).snmpEnabled   ?? false,
      snmpPort:      (nas as any).snmpPort       ?? 161,
      snmpCommunity: (nas as any).snmpCommunity ?? 'public',
      snmpVersion:   (nas as any).snmpVersion   ?? 'V2C',
      snmpPollSec:   (nas as any).snmpPollSec   ?? 30,
      syslogEnabled: (nas as any).syslogEnabled ?? false,
      syslogPort:    (nas as any).syslogPort     ?? 514,
    });
    setEditItem(nas); setShowForm(true);
  };

  // ── Lifecycle ──────────────────────────────────────────────────────
  useEffect(() => {
    const tk = localStorage.getItem('token');
    if (!tk) { router.push('/login'); return; }
    fetch(`${API}/profile`, { headers })
      .then(r => r.json()).then(d => setUser(d.user))
      .catch(() => router.push('/login'));
    loadData();
    const tick = () => {
      const h = new Date().getHours();
      setGreeting(h < 12 ? 'Good Morning' : h < 18 ? 'Good Afternoon' : 'Good Evening');
      setTime(new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }));
    };
    tick();
    const clockId = setInterval(tick, 1000);
    return () => clearInterval(clockId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-poll reachability every 30s for all NAS devices
  useEffect(() => {
    if (nasList.length === 0) return;
    // Initial check
    nasList.forEach(n => checkNas(n.id, true));
    // Stagger polls to avoid hammering the server
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(() => {
      nasList.forEach((n, i) => {
        setTimeout(() => checkNas(n.id, true), i * 500); // 500ms stagger
      });
    }, 30_000);
    return () => { if (pollIntervalRef.current) clearInterval(pollIntervalRef.current); };
  }, [nasList.length, checkNas]);

  // Auto-refresh sessions in detail view every 15s (PPPoE session tracking)
  useEffect(() => {
    if (!viewDetail) { if (sessionPollRef.current) clearInterval(sessionPollRef.current); return; }
    if (sessionPollRef.current) clearInterval(sessionPollRef.current);
    sessionPollRef.current = setInterval(async () => {
      if (!viewDetail) return;
      const sessions = await fetchSessions(viewDetail.nas.id);
      setViewDetail(p => p ? { ...p, sessions } : null);
    }, 15_000);
    return () => { if (sessionPollRef.current) clearInterval(sessionPollRef.current); };
  }, [viewDetail?.nas?.id, fetchSessions]);

  // ── Component helpers ──────────────────────────────────────────────
  const reach = (id: number) => reachMap[id];
  const isChecking = (id: number) => checkingIds.has(id);

  const StatusDot = ({ online, size = 8 }: { online?: boolean; size?: number }) => (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: online === undefined ? '#475569' : online ? '#22c55e' : '#ef4444',
      boxShadow:  online ? `0 0 ${size}px #22c55e88` : online === false ? `0 0 ${size}px #ef444488` : 'none',
      marginRight: 5,
    }} />
  );

  const Badge = ({ children, color, bg }: { children: React.ReactNode; color: string; bg: string }) => (
    <span style={{ padding:'2px 8px', borderRadius:4, fontSize:10, fontWeight:700, color, background:bg, letterSpacing:'0.04em', whiteSpace:'nowrap' }}>
      {children}
    </span>
  );

  const Btn = ({ onClick, children, variant = 'default', size = 'sm', disabled = false, style: ext = {}, title = '' }: any) => {
    const vs: Record<string, React.CSSProperties> = {
      default: { background:'var(--border)',    color:t.textSub },
      primary: { background:t.accent,     color:'#fff' },
      success: { background:'#14532d',    color:'#4ade80' },
      danger:  { background:'#450a0a',    color:'#f87171' },
      warning: { background:'#422006',    color:'#fbbf24' },
      ghost:   { background:'transparent',color:t.textSub, border:`1px solid ${t.cardBorder}` },
      teal:    { background:'#134e4a',    color:'#2dd4bf' },
    };
    return (
      <button onClick={onClick} disabled={disabled} title={title} style={{
        display:'inline-flex', alignItems:'center', gap:5,
        padding: size === 'xs' ? '3px 8px' : '5px 12px',
        borderRadius:6, border:'none', cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: size === 'xs' ? 11 : 12, fontWeight:600, opacity: disabled ? 0.5 : 1,
        transition:'all .15s', ...vs[variant], ...ext,
      }}>
        {children}
      </button>
    );
  };

  const inputSt: React.CSSProperties = {
    background: t.input, border:`1px solid ${t.inputBorder}`, borderRadius:6,
    color: t.text, padding:'7px 10px', width:'100%', fontSize:12, outline:'none', fontFamily:'inherit',
  };
  const labelSt: React.CSSProperties = {
    fontSize:11, color:t.textSub, marginBottom:3, display:'block', fontWeight:600,
  };

  const Tab = ({ id, label, icon }: { id: typeof activeTab; label: string; icon?: React.ReactNode }) => (
    <button onClick={() => setActiveTab(id)} style={{
      padding:'6px 14px', borderRadius:6, border:'none', cursor:'pointer', fontSize:11, fontWeight:600,
      background: activeTab === id ? t.accent : 'transparent',
      color:      activeTab === id ? '#fff' : t.textSub,
      display:'inline-flex', alignItems:'center', gap:5,
    }}>
      {icon}{label}
    </button>
  );

  // ── CPU color helper ───────────────────────────────────────────────
  const cpuColor = (s: string) => {
    const n = parseCpu(s);
    return n > 80 ? '#f87171' : n > 50 ? '#fbbf24' : '#4ade80';
  };

  const filteredNasList = nasList.filter((nas) => {
    const query = searchQ.trim().toLowerCase();
    const matchesQuery = !query
      || nas.nasname.toLowerCase().includes(query)
      || (nas.shortname || '').toLowerCase().includes(query)
      || (nas.nasIp || '').toLowerCase().includes(query);
    const matchesStatus = statusFilter === 'ALL' || (statusFilter === 'ACTIVE' ? nas.isActive : !nas.isActive);
    const matchesType = typeFilter === 'ALL' || (nas.type || 'MIKROTIK').toUpperCase() === typeFilter;
    const site = (nas.description || nas.shortname || '').trim();
    const matchesSite = siteFilter === 'ALL' || site === siteFilter;
    return matchesQuery && matchesStatus && matchesType && matchesSite;
  });

  // ─────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', minHeight:'100vh', background:t.bg, color:t.text, fontFamily:"'DM Sans','Segoe UI',system-ui,sans-serif", fontSize:13 }}>

      {/* ══════════ MAIN ══════════ */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>

        {/* ── CONTENT ── */}
        <div style={{ flex:1, padding:'16px 20px', overflowY:'auto' }}>

          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:16, flexWrap:'wrap', marginBottom:16 }}>
            <div>
              {/* Say up front where this account's routers come from. Without
                  it, an account that can only use routers handed down to it
                  saw an "Add NAS" button that always failed at save time. */}
              {me && !isAdminRole(me.role) && (
                <div style={{ fontSize:12, color:t.textMuted, lineHeight:1.7, maxWidth:520 }}>
                  {me.canAddNas
                    ? <>You may <b style={{color:t.text}}>register your own routers</b>, and you can also use any assigned to you by your parent.</>
                    : <>You use routers <b style={{color:t.text}}>assigned to you by your parent</b>. Registering your own is switched off for this account — ask them to enable “can add router”, or to assign you a NAS.</>}
                </div>
              )}
            </div>
            {/* Add / Import / Export live in the toolbar docked to the table
                below — the same place as on Subscribers, Packages and IP Pools.
                They used to ALSO sit here, so every action appeared twice and
                the buttons floated beside an explanatory paragraph. */}
            {showImport && (
              <ImportWizard
                onClose={() => setShowImport(false)}
                onDone={() => { loadData(); }}
                config={{
                  title: "Import NAS / Routers",
                  endpoint: "/nas/import",
                  required: [{ label: "NAS IP", field: "nasIp" }, { label: "Name", field: "nasName" }, { label: "RADIUS secret", field: "secret" }],
                  optional: [{ label: "API port", field: "apiPort" }, { label: "API user", field: "apiUsername" }],
                  alias: {
                    nas_ip: "nasIp", ip: "nasIp", nasip: "nasIp",
                    nas_name: "nasName", name: "nasName", shortname: "shortname",
                    radius_secret: "secret", secret: "secret",
                    api_port: "apiPort", api_username: "apiUsername", api_user: "apiUsername", api_password: "apiPassword",
                    nas_type: "nasType", type: "nasType", device_type: "deviceType", description: "description",
                  },
                  drop: ["id", "isp_id", "branch_id"],
                  sample: "nasName,nasIp,secret,apiPort,nasType\nMain-MikroTik,192.168.1.1,mysecret,8728,MIKROTIK",
                }}
              />
            )}
          </div>

          {/* Stat Cards */}
          <div className="jb-kpi-row" style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))', gap:10, marginBottom:16 }}>
            {[
              { label:'Total NAS',       value: overview?.totalNas ?? stats.total,    color: t.accent,  icon:<Icons.Router /> },
              { label:'Online NAS',      value: overview?.onlineNas ?? '—',   color: t.green,   icon:<Icons.Signal /> },
              { label:'Offline NAS',     value: overview?.offlineNas ?? '—', color: t.red,     icon:<Icons.Signal /> },
              { label:'Active Sessions', value: overview?.activeSessions ?? radiusStats?.activeSessionCount ?? '—', color: t.purple, icon:<Icons.PPPoE /> },
              { label:'MikroTik',        value: stats.mikrotik, color: t.amber,   icon:<Icons.CPU /> },
              { label:'RADIUS',          value: radiusStats?.alive ? 'ALIVE':'DOWN', color: radiusStats?.alive ? t.green : t.red, icon:<Icons.Shield /> },
              { label:'24h Accepts',     value: radiusStats?.accepts ?? '—', color: t.green, icon:null },
              { label:'24h Rejects',     value: radiusStats?.rejects ?? '—', color: t.red,   icon:null },
            ].map((c, i) => (
              <div key={i} style={{ background:t.card, border:`1px solid ${t.cardBorder}`, borderRadius:10, padding:'12px 14px', display:'flex', flexDirection:'column', gap:4 }}>
                <div style={{ color:t.textMuted, opacity:0.7, marginBottom:2 }}>{c.icon}</div>
                <div style={{ fontSize:22, fontWeight:800, color:c.color, lineHeight:1 }}>{c.value}</div>
                <div style={{ fontSize:10, color:t.textMuted, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>{c.label}</div>
              </div>
            ))}
          </div>

          {/* RADIUS status bar */}
          {radiusStats && (
            <div style={{ background:t.card, border:`1px solid ${t.cardBorder}`, borderRadius:10, padding:'10px 16px', marginBottom:16, display:'flex', gap:16, flexWrap:'wrap', alignItems:'center' }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <Icons.Signal />
                <span style={{ fontSize:12, color:t.textSub, fontWeight:700, letterSpacing:'0.04em' }}>RADIUS SERVER</span>
              </div>
              <Badge color={radiusStats.alive?'#4ade80':'#f87171'} bg={radiusStats.alive?'#14532d':'#450a0a'}>
                {radiusStats.alive ? '● ALIVE' : '● DOWN'}
              </Badge>
              {[
                ['IP', radiusStats.serverIp || '—'], ['Port', `${radiusStats.radiusPort ?? 1812} / ${radiusStats.acctPort ?? 1813} UDP`],
                ['NAS Registered', radiusStats.nasCount ?? '—'],
                ['Active Sessions', radiusStats.activeSessionCount ?? '—'],
                ['24h Accepts', radiusStats.accepts ?? '—'],
                ['24h Rejects', radiusStats.rejects ?? '—'],
              ].map(([k, v]) => (
                <span key={String(k)} style={{ fontSize:11, color:t.textMuted }}>
                  {k}: <b style={{color:t.text}}>{v}</b>
                </span>
              ))}
              <div style={{ marginLeft:'auto' }}>
                <Btn onClick={loadData} variant="ghost" size="xs"><Icons.Refresh /> Refresh</Btn>
              </div>
            </div>
          )}

          <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap', alignItems:'center' }}>
            <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Search by NAS name or IP address" style={{ ...inputSt, maxWidth:320 }} />
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)} style={{ ...inputSt, width:'auto', cursor:'pointer' }}>
              <option value="ALL">All Status</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as any)} style={{ ...inputSt, width:'auto', cursor:'pointer' }}>
              <option value="ALL">All Types</option>
              <option value="MIKROTIK">MikroTik</option>
              <option value="CISCO">Cisco</option>
              <option value="HUAWEI">Huawei</option>
              <option value="OTHER">Other</option>
            </select>
            <select value={groupFilter} onChange={e => setGroupFilter(e.target.value)} style={{ ...inputSt, width:'auto', cursor:'pointer' }}>
              <option value="ALL">All Groups</option>
              <option value="UNGROUPED">Ungrouped</option>
              {groupOptions.map((g) => (
                <option key={g.id} value={String(g.id)}>{g.name}</option>
              ))}
            </select>
            <select value={siteFilter} onChange={e => setSiteFilter(e.target.value)} style={{ ...inputSt, width:'auto', cursor:'pointer' }}>
              <option value="ALL">All Sites</option>
              {[...new Set(nasList.map(n => n.description || n.shortname || '').filter(Boolean))].map(s => (
                <option key={s} value={s}>{s.slice(0, 30)}</option>
              ))}
            </select>
            <span style={{ fontSize:11, color:t.textMuted }}>{filteredNasList.length} result{filteredNasList.length !== 1 ? 's' : ''}</span>
          </div>

          {/* Grouping / classification panel */}
          <GroupPanel
            endpoint="/nas/grouped"
            title="Group NAS"
            dims={[{ id: "owner", label: "Owner" }, { id: "type", label: "Type" }, { id: "site", label: "Site" }]}
            onPick={(dim, key, label) => { if (dim === "type") setTypeFilter(String(key) as any); else setSearchQ(String(label || "")); }}
          />

          {/* WinBox toolbar strip */}
          <Expandable label="NAS list">
          <WinBoxToolbar
            find={searchQ}
            onFind={setSearchQ}
            findPlaceholder="Find NAS name or IP…"
            groups={[
              // Add/Import are hidden for an account that may only use routers
              // handed down to it — showing them would offer an action that
              // always fails at save time.
              ...((!me || isAdminRole(me.role) || me.canAddNas)
                ? [[{ label: "Add", icon: "＋", tone: "primary" as const, title: "Add NAS / router", onClick: () => { resetForm(); setEditItem(null); setShowForm(true); } }]]
                : []),
              [
                ...((!me || isAdminRole(me.role) || me.canAddNas)
                  ? [{ label: "Import", icon: "⬆", onClick: () => setShowImport(true) }]
                  : []),
                { label: "Export", icon: "⬇", onClick: () => downloadCsv("nas.csv", nasList.map((n:any)=>({ nasName:n.shortname||n.nasname, nasIp:n.nasIp||n.nasname, secret:n.secret, apiPort:n.apiPort, nasType:n.type, deviceType:(n as any).deviceType })), [
                  { key:"nasName", label:"NAS Name" }, { key:"nasIp", label:"NAS IP" }, { key:"secret", label:"Secret" }, { key:"apiPort", label:"API Port" }, { key:"nasType", label:"Type" }, { key:"deviceType", label:"Device" },
                ]) },
              ],
              [{ label: "Refresh", icon: "⟳", onClick: loadData }],
            ]}
          />

          {/* NAS Table */}
          <div style={{ background:t.card, border:`1px solid ${t.cardBorder}`, borderTop:'none', borderRadius:'0 0 10px 10px', overflow:'hidden' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 16px', borderBottom:`1px solid ${t.cardBorder}` }}>
              <div>
                <span style={{ fontWeight:800, fontSize:14 }}>Registered NAS Devices</span>
                <span style={{ fontSize:11, color:t.textMuted, marginLeft:10 }}>{filteredNasList.length} device{filteredNasList.length !== 1 ? 's' : ''}</span>
              </div>
              <span style={{ fontSize:11, color:t.textMuted }}>
                Auto-refresh 30s &nbsp;·&nbsp;
                <span style={{ color: checkingIds.size > 0 ? t.amber : t.green }}>
                  {checkingIds.size > 0 ? `Checking ${checkingIds.size}…` : 'Idle'}
                </span>
              </span>
            </div>
            {loading ? (
              <SkeletonTable rows={6} cols={6} />
            ) : filteredNasList.length === 0 ? (
              <div style={{ textAlign:'center', padding:40, color:t.textMuted }}>
                <div style={{ fontSize:32, marginBottom:8 }}>📡</div>
                No NAS devices match the current search or filters.
              </div>
            ) : (
              <NasTable
                rows={filteredNasList}
                me={me}
                onView={(nas) => { router.push(`/nas/${nas.id}`); }}
                onEdit={openEdit}
                onShare={openShare}
                onCheck={checkNas}
                onDelete={(nas) => setDeleteConfirm(nas.id)}
                onMessageSubs={async (nas) => {
                  const message = prompt(`Send SMS to all subscribers on "${nas.shortname || nas.nasname}":`, "Maintenance notice: brief downtime expected tonight.");
                  if (!message) return;
                  try {
                    const r = await fetch(`${API}/subscribers/group-action`, { method: "POST", headers, body: JSON.stringify({ by: "nas", key: nas.id, action: "message", message }) });
                    const d = await r.json();
                    alert(r.ok ? `Sent to ${d.success} subscriber(s)${d.failed ? `, ${d.failed} failed` : ""}` : (d?.message || "Failed"));
                  } catch (e: any) { alert(e.message); }
                }}
                checkingIds={checkingIds}
                healthOf={(id) => healthMap[id]}
                reachOf={(id) => {
                  const r = reach(id);
                  return r ? { apiPortOpen: r.apiPortOpen, activeSessionCount: r.activeSessionCount, identity: r.identity } : undefined;
                }}
              />
            )}
          </div>
          </Expandable>
        </div>
      </div>

      {/* ══════════════════════════════════════
          MODAL: VIEW NAS DETAIL
      ══════════════════════════════════════ */}
      {viewDetail && (
        <Portal><div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.8)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
          onClick={() => setViewDetail(null)}>
          <div style={{ background:t.card, border:`1px solid ${t.cardBorder}`, borderRadius:12, padding:24, width:'100%', maxWidth:820, maxHeight:'92vh', overflowY:'auto', display:'flex', flexDirection:'column', gap:0 }}
            onClick={e => e.stopPropagation()}>

            {/* ── Modal header ── */}
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                <div style={{ width:42, height:42, background:'linear-gradient(135deg,#0ea5e9,#6366f1)', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <Icons.NAS />
                </div>
                <div>
                  <div style={{ fontWeight:800, fontSize:17, color:'#1C2434' }}>{viewDetail.nas.nasname}</div>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:2 }}>
                    <code style={{ fontSize:12, color:'#0B76A8' }}>{viewDetail.nas.nasIp}</code>
                    <Badge color='#60a5fa' bg='rgba(96,165,250,0.1)'>{viewDetail.nas.type}</Badge>
                    {/* Show actual configured port */}
                    <Badge color='var(--muted)' bg='rgba(148,163,184,0.1)'>
                      API :{viewDetail.nas.apiPort || 8728}
                    </Badge>
                    <Badge color='var(--muted)' bg='rgba(148,163,184,0.1)'>
                      CoA :{viewDetail.nas.incomingPort || 3799}
                    </Badge>
                  </div>
                </div>
              </div>
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                <Btn onClick={refreshView} variant="ghost" size="xs"><Icons.Refresh /> Refresh</Btn>
                <button onClick={() => setViewDetail(null)} style={{ background:'transparent', border:`1px solid ${t.cardBorder}`, borderRadius:6, padding:'5px 8px', cursor:'pointer', color:t.textSub }}>
                  <Icons.X />
                </button>
              </div>
            </div>

            {/* ── Registered ports to monitor ── */}
            <div style={{ border:`1px solid ${t.cardBorder}`, borderRadius:10, padding:'11px 14px', marginBottom:12, display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
              <span style={{ fontSize:12, fontWeight:700 }}>Monitored ports</span>
              <input
                defaultValue={(() => { try { const a = JSON.parse((viewDetail.nas as any).monitoredPorts || "[]"); return Array.isArray(a) ? a.join(", ") : ""; } catch { return ""; } })()}
                id={`mp-${viewDetail.nas.id}`}
                placeholder="e.g. ether1-wan, vlan100  (blank = all interfaces)"
                style={{ ...inputSt, flex:1, minWidth:220 }} />
              <Btn variant="ghost" size="xs" onClick={async ()=>{
                const r = await fetch(`${API}/telemetry/nas/${viewDetail.nas.id}/discover-interfaces`, { headers });
                const d = await r.json();
                if (!d?.ok) { alert(d?.error || "Discovery failed"); return; }
                const el = document.getElementById(`mp-${viewDetail.nas.id}`) as HTMLInputElement;
                const current = new Set((el?.value||"").split(",").map(s=>s.trim()).filter(Boolean));
                const pick = d.interfaces.map((i:any)=>`${i.name}${i.up?"":" (down)"}`).join("\n");
                const chosen = prompt(`Discovered ${d.interfaces.length} interface(s). Type the ones to monitor (comma-separated), or copy from this list:\n\n${pick}`, (el?.value)|| d.interfaces.filter((i:any)=>i.up).map((i:any)=>i.name).join(", "));
                if (chosen != null && el) el.value = chosen;
              }}>Discover</Btn>
              <Btn variant="primary" size="xs" onClick={async ()=>{
                const el = document.getElementById(`mp-${viewDetail.nas.id}`) as HTMLInputElement;
                const ports = (el?.value || "").split(",").map(s=>s.trim()).filter(Boolean);
                const r = await fetch(`${API}/nas/${viewDetail.nas.id}/monitored-ports`, { method:"PATCH", headers, body: JSON.stringify({ ports }) });
                alert(r.ok ? (ports.length ? `Monitoring ${ports.length} registered port(s)` : "Monitoring all interfaces") : "Save failed");
              }}>Save</Btn>
              <span style={{ fontSize:10.5, color:t.textMuted, width:'100%' }}>Only these interfaces/ports are polled. Leave blank to monitor every interface.</span>
            </div>

            {/* ── Traffic graph + VLAN breakdown (MRTG-style) ── */}
            <NasTraffic nasId={viewDetail.nas.id} />

            {/* ── Notes (transmission, device, install details) ── */}
            <div style={{ border:`1px solid ${t.cardBorder}`, borderRadius:10, padding:'12px 14px', marginBottom:14 }}>
              <RecordNotes entityType="NAS" entityId={viewDetail.nas.id} title="Notes — device, transmission, site" />
            </div>

            {/* ── Sessions live ticker ── */}
            {!viewDetail.loadingSessions && (
              <div style={{ background: d ? 'var(--surface)' : '#eff6ff', border:`1px solid ${d?'#1e3a5f':'#bfdbfe'}`, borderRadius:8, padding:'7px 14px', marginBottom:14, display:'flex', alignItems:'center', gap:12 }}>
                <StatusDot online={viewDetail.reachability?.radiusPortOpen} size={10} />
                <span style={{ fontSize:12, fontWeight:700, color:t.text }}>
                  PPPoE Sessions: <span style={{ color:'#a78bfa', fontSize:15 }}>{viewDetail.sessions.length}</span>
                </span>
                <span style={{ fontSize:11, color:t.textMuted }}>
                  (auto-refreshes every 15s)
                </span>
                {viewDetail.loadingSessions && <span style={{ fontSize:11, color:t.amber }}>Updating…</span>}
                <span style={{ marginLeft:'auto', fontSize:10, color:t.textMuted }}>
                  RADIUS: {viewDetail.reachability?.radiusNasCount ?? '—'} registered NAS
                </span>
              </div>
            )}

            {/* ── Port / RADIUS status ── */}
            {viewDetail.loadingReach ? (
              <div style={{ textAlign:'center', padding:16, color:t.textMuted, fontSize:12 }}>⏳ Checking reachability…</div>
            ) : viewDetail.reachability && (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:14 }}>
                {[
                  { label:'RADIUS Auth',    val: viewDetail.reachability.radiusPortOpen,  note:'UDP :1812' },
                  { label:'API Port',       val: viewDetail.reachability.apiPortOpen,      note:`TCP :${viewDetail.nas.apiPort || 8728}` },
                  { label:'NAS Registered', val: viewDetail.reachability.nasRegistered,   note:'In RADIUS DB' },
                ].map(c => (
                  <div key={c.label} style={{
                    background: c.val ? (d?'#14532d':'#f0fdf4') : (d?'#450a0a':'#fef2f2'),
                    borderRadius:8, padding:'11px', textAlign:'center',
                    border:`1px solid ${c.val ? (d?'#166534':'#bbf7d0') : (d?'#7f1d1d':'#fecaca')}`,
                  }}>
                    <div style={{ fontSize:18, marginBottom:4 }}>{c.val ? '✅' : '❌'}</div>
                    <div style={{ fontSize:11, fontWeight:700, color: c.val?'#4ade80':'#f87171' }}>{c.label}</div>
                    <div style={{ fontSize:10, color:t.textMuted, marginTop:2 }}>{c.note}</div>
                  </div>
                ))}
              </div>
            )}

            {/* ── MikroTik device stats ── */}
            {(viewDetail.reachability || viewDetail.details) && (
              (() => {
                // Merge: prefer full details if available, fallback to reachability quickCheck
                const r  = viewDetail.reachability;
                const dt = viewDetail.details;
                const identity     = dt?.identity  || r?.identity  || '';
                const version      = dt?.version   || r?.version   || '';
                const cpuLoad      = dt?.cpuLoad   || r?.cpuLoad   || '';
                const uptime       = dt?.uptime    || r?.uptime    || '';
                const board        = dt?.board     || '';
                const totalMemory  = dt?.totalMemory  || '';
                const freeMemory   = dt?.freeMemory   || '';
                const activeConns  = dt?.activeConnections ?? r?.activeConnections ?? 0;
                const hasData      = identity.length > 0 || version.length > 0;
                if (!hasData && !viewDetail.loadingDetails) return null;
                return (
                  <div style={{ background: d?'var(--surface)':'#eff6ff', border:`1px solid ${d?'#1e3a5f':'#bfdbfe'}`, borderRadius:10, padding:14, marginBottom:14 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:'#0B76A8', marginBottom:10, display:'flex', alignItems:'center', gap:6 }}>
                      <Icons.Router /> MikroTik Device Details
                      {viewDetail.loadingDetails && <span style={{ color:t.amber, fontWeight:400 }}>— syncing…</span>}
                    </div>
                    {/* If the router returned data but the API user couldn't read
                        it, say so instead of showing a wall of "Unknown". */}
                    {viewDetail.details?.apiErrors?.length ? (
                      <div style={{ background:'rgba(239,68,68,.10)', border:'1px solid rgba(239,68,68,.35)', borderRadius:8, padding:'8px 10px', marginBottom:10, fontSize:11, color:'#f87171', lineHeight:1.6 }}>
                        ⚠️ The router API rejected {viewDetail.details.apiErrors.length} command(s), so the details below are blank.
                        This is usually the API user (<b>{(viewDetail as any).apiUsername || 'test'}</b>) missing the <b>read</b>/<b>api</b> permission on the MikroTik, or wrong credentials.
                        <div style={{ marginTop:4, opacity:.85, fontFamily:'monospace', fontSize:10 }}>{viewDetail.details.apiErrors.slice(0,4).join(' · ')}</div>
                      </div>
                    ) : null}
                    {/* Row 1: identity/version/cpu/uptime */}
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:8 }}>
                      {[
                        { label:'Identity', value: identity,  icon:<Icons.NAS />,   color: t.text },
                        { label:'Version',  value: version ? `v${version}` : '',    icon:<Icons.Board />, color:'#a78bfa' },
                        { label:'CPU Load', value: cpuLoad,  icon:<Icons.CPU />,    color: cpuLoad ? cpuColor(cpuLoad) : t.text },
                        { label:'Uptime',   value: uptime,   icon:<Icons.Clock />,  color: t.text },
                      ].map(item => (
                        <div key={item.label} style={{ background: d?'var(--surface)':'#fff', borderRadius:8, padding:'10px 12px', border:`1px solid ${d?'var(--border)':'var(--text)'}` }}>
                          <div style={{ color:'var(--muted)', marginBottom:4 }}>{item.icon}</div>
                          <div style={{ fontSize:10, color:t.textMuted, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:3 }}>{item.label}</div>
                          <div style={{ fontSize:13, color: item.value ? item.color : t.textMuted, fontWeight:700 }}>{item.value || '—'}</div>
                        </div>
                      ))}
                    </div>
                    {/* Row 2: board/memory/sessions */}
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
                      {[
                        { label:'Board Model',    value: board,        color: t.text },
                        { label:'Memory (Free/Total)', value: (freeMemory && totalMemory) ? `${fmtBytes(+freeMemory)} / ${fmtBytes(+totalMemory)}` : '', color: t.text },
                        { label:'PPPoE Connections', value: String(activeConns), color:'#4ade80' },
                      ].map(item => (
                        <div key={item.label} style={{ background: d?'var(--surface)':'#fff', borderRadius:8, padding:'10px 12px', border:`1px solid ${d?'var(--border)':'var(--text)'}`, textAlign:'center' }}>
                          <div style={{ fontSize:16, fontWeight:800, color: item.value ? item.color : t.textMuted }}>{item.value || '—'}</div>
                          <div style={{ fontSize:10, color:t.textMuted, marginTop:2, fontWeight:600 }}>{item.label}</div>
                        </div>
                      ))}
                    </div>
                    {/* API service details */}
                    {dt?.apiService && (
                      <div style={{ marginTop:8, fontSize:11, color:t.textMuted }}>
                        API service on router: port <b style={{color:t.text}}>{dt.apiService.port}</b>
                        {dt.apiService.tlsPort && <> &nbsp;·&nbsp; API-SSL port <b style={{color:t.text}}>{dt.apiService.tlsPort}</b></>}
                        &nbsp;·&nbsp; Status: <b style={{ color: dt.apiService.enabled ? '#4ade80':'#f87171' }}>{dt.apiService.enabled ? 'Enabled' : 'Disabled'}</b>
                      </div>
                    )}
                    {/* Error */}
                    {viewDetail.detailsError && !viewDetail.loadingDetails && (
                      <div style={{ marginTop:8, fontSize:11, color:'#f87171', background:'#450a0a', padding:'6px 10px', borderRadius:6 }}>
                        ⚠️ {viewDetail.detailsError}
                      </div>
                    )}
                  </div>
                );
              })()
            )}

            {/* ── Tabs ── */}
            <div style={{ display:'flex', gap:4, marginBottom:12, flexWrap:'wrap' }}>
              <Tab id="overview"    label="Overview"    icon={<Icons.NAS />} />
              <Tab id="health"      label="Health & Graphs" icon={<Icons.CPU />} />
              <Tab id="interfaces"  label={`Interfaces${viewDetail.details?.interfaces?.length ? ` (${viewDetail.details.interfaces.length})` : ''}`} icon={<Icons.Network />} />
              <Tab id="pppoe"       label="PPPoE Server" icon={<Icons.PPPoE />} />
              <Tab id="radius"      label="RADIUS Clients" icon={<Icons.Shield />} />
              <Tab id="ips"         label="IP Addresses" icon={<Icons.IP />} />
              <Tab id="sessions"    label={`Sessions (${viewDetail.sessions.length})`} icon={<Icons.Subscribers />} />
            </div>

            {/* ── Tab: Health & Graphs — real SNMP history ── */}
            {activeTab === 'health' && (
              <DeviceHealth nasId={viewDetail.nas.id} nasName={viewDetail.nas.nasname} />
            )}

            {/* ── Tab: Overview ── */}
            {activeTab === 'overview' && (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8 }}>
                {[
                  ['NAS IP',       viewDetail.nas.nasIp || '—'],
                  ['API Port',     String(viewDetail.nas.apiPort || 8728)],   // actual port
                  ['CoA Port',     String(viewDetail.nas.incomingPort || 3799)],
                  ['API Username', viewDetail.nas.apiUsername || '—'],
                  ['Subscribers',  String(viewDetail.nas._count?.subscribers ?? 0)],
                  ['Status',       viewDetail.nas.isActive ? 'Active' : 'Inactive'],
                  ['Description',  viewDetail.nas.description || '—'],
                  ['RADIUS IP',    viewDetail.reachability?.radiusIp || '127.0.0.1'],
                ].map(([k, v]) => (
                  <div key={k} style={{ background: d?'var(--bg)':'#f8fafc', borderRadius:8, padding:'9px 11px', border:`1px solid ${t.cardBorder}` }}>
                    <div style={{ fontSize:10, color:t.textMuted, marginBottom:3, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>{k}</div>
                    <div style={{ fontSize:12, color:t.text, fontWeight:700, wordBreak:'break-all' }}>{v}</div>
                  </div>
                ))}
                <div style={{ gridColumn:'1/-1', marginTop:6, display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                  <button onClick={() => pingNas(viewDetail.nas.id)} disabled={pinging}
                    title="ICMP ping from this server to the router's IP — the quickest way to see if the router is reachable on the network at all."
                    style={{ background:'transparent', color:t.accent, border:`1px solid ${t.cardBorder}`, borderRadius:8, padding:'7px 13px', fontSize:12, fontWeight:600, cursor:'pointer' }}>
                    {pinging ? 'Pinging…' : '📡 Ping'}
                  </button>
                  <button onClick={() => testCoa(viewDetail.nas.id)} disabled={coaTesting}
                    title="Send a harmless RADIUS CoA probe to confirm this router/BNG accepts session control (disconnect & live speed change). Changes nothing."
                    style={{ background:'transparent', color:t.accent, border:`1px solid ${t.cardBorder}`, borderRadius:8, padding:'7px 13px', fontSize:12, fontWeight:600, cursor:'pointer' }}>
                    {coaTesting ? 'Testing CoA…' : '⚡ Test CoA'}
                  </button>
                  {pingResult && <span style={{ fontSize:11.5, fontWeight:600, color: pingResult.ok ? '#16a34a' : '#ef4444' }}>{pingResult.text}</span>}
                  {!pingResult && <span style={{ fontSize:11, color:t.textMuted }}>Confirms disconnect &amp; live speed-change will work on this NAS.</span>}
                </div>
              </div>
            )}

            {/* ── Tab: Interfaces ── */}
            {activeTab === 'interfaces' && (
              viewDetail.loadingDetails ? (
                <div style={{ textAlign:'center', padding:20, color:t.textMuted }}>⏳ Loading interface data…</div>
              ) : !viewDetail.details?.interfaces?.length ? (
                <div style={{ textAlign:'center', padding:20, color:t.textMuted }}>
                  {viewDetail.detailsError ? `⚠️ ${viewDetail.detailsError}` : 'No interface data — add API credentials to enable.'}
                </div>
              ) : (
                <div style={{ overflowX:'auto', borderRadius:8, border:`1px solid ${t.cardBorder}` }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                    <thead>
                      <tr style={{ background: d?'var(--bg)':'#f1f5f9' }}>
                        {['Name','Type','MAC Address','MTU','Running','Disabled','Comment'].map(h => (
                          <th key={h} style={{ padding:'7px 10px', textAlign:'left', fontSize:10, color:t.textMuted, fontWeight:700, textTransform:'uppercase' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {viewDetail.details.interfaces.map((iface, i) => (
                        <tr key={i} style={{ background: i%2===0?(d?'var(--bg)':'#f8fafc'):t.card }}>
                          <td style={{ padding:'7px 10px' }}><code style={{ color:'#0B76A8' }}>{iface.name}</code></td>
                          <td style={{ padding:'7px 10px', color:t.textSub }}>{iface.type || '—'}</td>
                          {/* FIX: use normalized field name macAddress not mac-address */}
                          <td style={{ padding:'7px 10px' }}><code style={{ fontSize:10, color:t.textMuted }}>{iface.macAddress || '—'}</code></td>
                          <td style={{ padding:'7px 10px', color:t.textSub }}>{iface.mtu || '—'}</td>
                          <td style={{ padding:'7px 10px' }}>
                            {/* FIX: 'running' is a string "true"/"false" from MikroTik */}
                            <Badge color={iface.running==='true'?'#4ade80':'#f87171'} bg={iface.running==='true'?'#14532d':'#450a0a'}>
                              {iface.running==='true' ? 'Yes' : 'No'}
                            </Badge>
                          </td>
                          <td style={{ padding:'7px 10px' }}>
                            <Badge color={iface.disabled==='true'?'#f87171':'#4ade80'} bg={iface.disabled==='true'?'#450a0a':'#14532d'}>
                              {iface.disabled==='true' ? 'Yes' : 'No'}
                            </Badge>
                          </td>
                          <td style={{ padding:'7px 10px', color:t.textMuted }}>{iface.comment || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}

            {/* ── Tab: PPPoE Server ── */}
            {activeTab === 'pppoe' && (
              viewDetail.loadingDetails ? (
                <div style={{ textAlign:'center', padding:20, color:t.textMuted }}>⏳ Loading PPPoE data…</div>
              ) : (
                <div>
                  {viewDetail.details?.pppoeServer ? (
                    <div style={{ marginBottom:16 }}>
                      <div style={{ fontSize:12, fontWeight:700, color:t.textSub, marginBottom:8 }}>PPPoE Server Config</div>
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
                        {[
                          ['Enabled',          viewDetail.details.pppoeServer.enabled ? 'Yes' : 'No'],
                          ['Interface',        viewDetail.details.pppoeServer.interface],
                          ['Service Name',     viewDetail.details.pppoeServer.serviceName || '—'],
                          ['Max MTU',          viewDetail.details.pppoeServer.maxMtu      || '—'],
                          ['Max MRU',          viewDetail.details.pppoeServer.maxMru      || '—'],
                          ['Authentication',   viewDetail.details.pppoeServer.authentication || '—'],
                          ['Keepalive',        viewDetail.details.pppoeServer.keepaliveTimeout || '—'],
                          ['Default Profile',  viewDetail.details.pppoeServer.defaultProfile  || '—'],
                        ].map(([k, v]) => (
                          <div key={k} style={{ background:d?'var(--bg)':'#f8fafc', borderRadius:8, padding:'9px 11px', border:`1px solid ${t.cardBorder}` }}>
                            <div style={{ fontSize:10, color:t.textMuted, marginBottom:2, fontWeight:600, textTransform:'uppercase' }}>{k}</div>
                            <div style={{ fontSize:12, color:t.text, fontWeight:700 }}>{v}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div style={{ color:t.textMuted, padding:12 }}>No PPPoE server configured on this NAS.</div>
                  )}
                  {viewDetail.details?.pppoeProfiles && viewDetail.details.pppoeProfiles.length > 0 && (
                    <div>
                      <div style={{ fontSize:12, fontWeight:700, color:t.textSub, marginBottom:8 }}>PPPoE Profiles ({viewDetail.details.pppoeProfiles.length})</div>
                      <div style={{ overflowX:'auto', borderRadius:8, border:`1px solid ${t.cardBorder}` }}>
                        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                          <thead>
                            <tr style={{ background:d?'var(--bg)':'#f1f5f9' }}>
                              {['Name','Local IP','Remote Pool','Rate Limit','Session Timeout','Comment'].map(h => (
                                <th key={h} style={{ padding:'7px 10px', textAlign:'left', fontSize:10, color:t.textMuted, fontWeight:700 }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {viewDetail.details.pppoeProfiles.map((p, i) => (
                              <tr key={i} style={{ background: i%2===0?(d?'var(--bg)':'#f8fafc'):t.card }}>
                                <td style={{ padding:'7px 10px' }}><b style={{ color:'#60a5fa' }}>{p.name}</b></td>
                                <td style={{ padding:'7px 10px', color:t.textSub }}><code style={{ fontSize:10 }}>{val(p.localAddress)}</code></td>
                                <td style={{ padding:'7px 10px', color:t.textSub }}>{val(p.remoteAddress)}</td>
                                <td style={{ padding:'7px 10px', color:'#fbbf24' }}>{val(p.rateLimit)}</td>
                                <td style={{ padding:'7px 10px', color:t.textSub }}>{val(p.sessionTimeout)}</td>
                                <td style={{ padding:'7px 10px', color:t.textMuted }}>{val(p.comment)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )
            )}

            {/* ── Tab: RADIUS Clients (on MikroTik) ── */}
            {activeTab === 'radius' && (
              viewDetail.loadingDetails ? (
                <div style={{ textAlign:'center', padding:20, color:t.textMuted }}>⏳ Loading RADIUS config…</div>
              ) : !viewDetail.details?.radiusClients?.length ? (
                <div style={{ color:t.textMuted, padding:12 }}>No RADIUS clients configured on this MikroTik.</div>
              ) : (
                <div style={{ overflowX:'auto', borderRadius:8, border:`1px solid ${t.cardBorder}` }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                    <thead>
                      <tr style={{ background:d?'var(--bg)':'#f1f5f9' }}>
                        {['Service','Server Address','Auth Port','Acct Port','Timeout','Enabled'].map(h => (
                          <th key={h} style={{ padding:'7px 10px', textAlign:'left', fontSize:10, color:t.textMuted, fontWeight:700 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {viewDetail.details.radiusClients.map((rc, i) => (
                        <tr key={i} style={{ background: i%2===0?(d?'var(--bg)':'#f8fafc'):t.card }}>
                          <td style={{ padding:'7px 10px' }}><Badge color='#60a5fa' bg='rgba(96,165,250,0.1)'>{rc.service}</Badge></td>
                          <td style={{ padding:'7px 10px' }}><code style={{ color:'#0B76A8', fontSize:10 }}>{rc.address}</code></td>
                          <td style={{ padding:'7px 10px', color:t.textSub }}>{rc.authPort}</td>
                          <td style={{ padding:'7px 10px', color:t.textSub }}>{rc.acctPort}</td>
                          <td style={{ padding:'7px 10px', color:t.textSub }}>{rc.timeout}</td>
                          <td style={{ padding:'7px 10px' }}>
                            <Badge color={rc.disabled==='false'?'#4ade80':'#f87171'} bg={rc.disabled==='false'?'#14532d':'#450a0a'}>
                              {rc.disabled === 'false' ? 'Yes' : 'No'}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}

            {/* ── Tab: IP Addresses ── */}
            {activeTab === 'ips' && (
              viewDetail.loadingDetails ? (
                <div style={{ textAlign:'center', padding:20, color:t.textMuted }}>⏳ Loading IP addresses…</div>
              ) : !viewDetail.details?.ipAddresses?.length ? (
                <div style={{ color:t.textMuted, padding:12 }}>No IP addresses found.</div>
              ) : (
                <div style={{ overflowX:'auto', borderRadius:8, border:`1px solid ${t.cardBorder}` }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                    <thead>
                      <tr style={{ background:d?'var(--bg)':'#f1f5f9' }}>
                        {['IP / Prefix','Network','Interface','Disabled'].map(h => (
                          <th key={h} style={{ padding:'7px 10px', textAlign:'left', fontSize:10, color:t.textMuted, fontWeight:700 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {viewDetail.details.ipAddresses.map((ip, i) => (
                        <tr key={i} style={{ background: i%2===0?(d?'var(--bg)':'#f8fafc'):t.card }}>
                          <td style={{ padding:'7px 10px' }}><code style={{ color:'#0B76A8' }}>{ip.address}</code></td>
                          <td style={{ padding:'7px 10px' }}><code style={{ color:t.textSub, fontSize:10 }}>{ip.network}</code></td>
                          <td style={{ padding:'7px 10px', color:t.textSub }}>{ip.interface}</td>
                          <td style={{ padding:'7px 10px' }}>
                            <Badge color={ip.disabled==='true'?'#f87171':'#4ade80'} bg={ip.disabled==='true'?'#450a0a':'#14532d'}>
                              {ip.disabled==='true' ? 'Yes' : 'No'}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}

            {/* ── Tab: Sessions ── */}
            {activeTab === 'sessions' && (
              <div>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                  <span style={{ fontSize:12, color:t.textSub, fontWeight:700 }}>
                    Active PPPoE Sessions — {viewDetail.sessions.length} online
                  </span>
                  <Btn onClick={() => fetchSessions(viewDetail.nas.id).then(s => setViewDetail(p => p ? {...p, sessions:s} : null))} variant="ghost" size="xs">
                    <Icons.Refresh /> Refresh
                  </Btn>
                </div>
                {viewDetail.loadingSessions ? (
                  <div style={{ textAlign:'center', padding:20, color:t.textMuted }}>⏳ Loading sessions…</div>
                ) : viewDetail.sessions.length === 0 ? (
                  <div style={{ color:t.textMuted, fontSize:12, padding:12, background:d?'var(--bg)':'#f8fafc', borderRadius:8, border:`1px solid ${t.cardBorder}`, textAlign:'center' }}>
                    No active PPPoE sessions for this NAS
                  </div>
                ) : (
                  <div style={{ overflowX:'auto', maxHeight:320, overflowY:'auto', borderRadius:8, border:`1px solid ${t.cardBorder}` }}>
                    <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                      <thead style={{ position:'sticky', top:0 }}>
                        <tr style={{ background:d?'var(--bg)':'#f1f5f9' }}>
                          {['Username','Framed IP','MAC','Session Start','Duration','↑ Upload','↓ Download'].map(h => (
                            <th key={h} style={{ padding:'7px 10px', textAlign:'left', fontSize:10, color:t.textMuted, fontWeight:700 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {viewDetail.sessions.map((sess: any, i: number) => {
                          const dur = sess.duration_seconds;
                          const h = Math.floor(dur / 3600);
                          const m = Math.floor((dur % 3600) / 60);
                          const durFmt = dur ? `${h}h ${m}m` : '—';
                          const mbUp   = sess.upload_bytes   ? fmtBytes(+sess.upload_bytes)   : '—';
                          const mbDown = sess.download_bytes ? fmtBytes(+sess.download_bytes) : '—';
                          return (
                            <tr key={i} style={{ background: i%2===0?(d?'var(--bg)':'#f8fafc'):t.card }}>
                              <td style={{ padding:'7px 10px' }}><b style={{ color:'#60a5fa' }}>{sess.username}</b></td>
                              <td style={{ padding:'7px 10px' }}><code style={{ fontSize:10 }}>{sess.framedipaddress || '—'}</code></td>
                              <td style={{ padding:'7px 10px' }}><code style={{ fontSize:10, color:t.textMuted }}>{sess.callingstationid || '—'}</code></td>
                              <td style={{ padding:'7px 10px', color:t.textSub }}>
                                {sess.acctstarttime ? new Date(sess.acctstarttime).toLocaleString() : '—'}
                              </td>
                              <td style={{ padding:'7px 10px', color:t.textSub }}>{durFmt}</td>
                              <td style={{ padding:'7px 10px', color:'#4ade80', fontWeight:600 }}>{mbUp}</td>
                              <td style={{ padding:'7px 10px', color:'#60a5fa', fontWeight:600 }}>{mbDown}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* ── Footer buttons ── */}
            <div style={{ marginTop:16, display:'flex', gap:8, paddingTop:12, borderTop:`1px solid ${t.cardBorder}` }}>
              <Btn onClick={() => { openEdit(viewDetail.nas); setViewDetail(null); }} variant="warning"><Icons.Edit /> Edit</Btn>
              <Btn onClick={refreshView} variant="success"><Icons.Refresh /> Refresh All</Btn>
              <Btn onClick={() => setViewDetail(null)} variant="ghost" style={{ marginLeft:'auto' }}><Icons.X /> Close</Btn>
            </div>
          </div>
        </div></Portal>
      )}

      {/* ══════════════════════════════════════
          MODAL: ADD / EDIT
      ══════════════════════════════════════ */}
      {/* ══════════ SHARE ROUTER WITH A DOWNSTREAM ACCOUNT ══════════ */}
      {shareFor && (
        <Portal><div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.8)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
          onClick={() => setShareFor(null)}>
          <div style={{ background:t.card, border:`1px solid ${t.cardBorder}`, borderRadius:12, padding:24, width:'100%', maxWidth:520, maxHeight:'85vh', overflowY:'auto' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight:800, fontSize:16, color:'#1C2434' }}>Share “{shareFor.nasname}”</div>
            <div style={{ fontSize:11.5, color:t.textMuted, marginTop:4, lineHeight:1.7 }}>
              Ticked accounts can put their subscribers on this router. You keep ownership —
              they cannot edit or delete it. Untick to withdraw access.
            </div>

            {/* Reach of the share. "Whole downline" is the old behaviour — the
                account and every dealer below it. "Only this account" restricts
                it, so you can give a router to one dealer without a sibling
                dealer under the same franchise ever seeing it. */}
            <div style={{ marginTop:14 }}>
              <div style={{ fontSize:10.5, color:t.textMuted, textTransform:'uppercase', letterSpacing:'.06em', fontWeight:700, marginBottom:6 }}>Who gets it</div>
              <div style={{ display:'inline-flex', gap:2, background:t.input, border:`1px solid ${t.cardBorder}`, borderRadius:999, padding:3 }}>
                {[
                  { v:true,  label:'Account + its downline' },
                  { v:false, label:'Only this account' },
                ].map(o => (
                  <button key={String(o.v)} onClick={() => setSharePropagate(o.v)}
                    style={{ border:'none', cursor:'pointer', borderRadius:999, padding:'5px 12px', fontSize:11.5, fontWeight:600,
                      background: sharePropagate === o.v ? t.accent : 'transparent',
                      color: sharePropagate === o.v ? '#fff' : t.textSub }}>
                    {o.label}
                  </button>
                ))}
              </div>
              <div style={{ fontSize:10.5, color:t.textMuted, marginTop:6, lineHeight:1.6 }}>
                Applies to accounts you tick from here on. Set it before ticking.
              </div>
            </div>

            <div style={{ marginTop:16, display:'flex', flexDirection:'column', gap:6 }}>
              {shareAccounts.map((u:any) => {
                const on = !!shareFor.assignments?.some(a => a.userId === u.id);
                return (
                  <label key={u.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 11px',
                    borderRadius:9, cursor:shareBusy?'wait':'pointer',
                    background: on ? 'rgba(45,212,191,.10)' : 'transparent',
                    border:`1px solid ${on ? 'rgba(45,212,191,.4)' : t.cardBorder}` }}>
                    <input type="checkbox" checked={on} disabled={shareBusy}
                      onChange={(e) => toggleShare(u.id, e.target.checked)} />
                    <span style={{ flex:1 }}>
                      <b style={{ fontSize:13, color:'#1C2434' }}>{u.name}</b>
                      <span style={{ display:'block', fontSize:10.5, color:t.textMuted }}>{u.role} · {u.email}</span>
                    </span>
                  </label>
                );
              })}
              {shareAccounts.length === 0 && (
                <div style={{ fontSize:12, color:t.textMuted, padding:'14px 0', lineHeight:1.7 }}>
                  No downstream accounts yet. Create a franchise or dealer under
                  <b style={{color:t.text}}> Administration → Organization</b> first.
                </div>
              )}
            </div>
            <div style={{ marginTop:18, display:'flex', justifyContent:'flex-end' }}>
              <Btn onClick={() => setShareFor(null)} variant="default">Done</Btn>
            </div>
          </div>
        </div></Portal>
      )}

      {showForm && (
        <Portal><div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.8)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
          onClick={() => setShowForm(false)}>
          <div style={{ background:t.card, border:`1px solid ${t.cardBorder}`, borderRadius:12, padding:18, width:'100%', maxWidth:700, maxHeight:'95vh', overflowY:'auto' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <div>
                <div style={{ fontWeight:800, fontSize:16, color:'#1C2434' }}>{editItem ? 'Edit NAS Device' : 'Add New NAS Device'}</div>
                <div style={{ fontSize:11, color:t.textMuted, marginTop:2 }}>Configure router, API access, and RADIUS authentication</div>
              </div>
              <button onClick={() => setShowForm(false)} style={{ background:'transparent', border:`1px solid ${t.cardBorder}`, borderRadius:6, padding:'5px 8px', cursor:'pointer', color:t.textSub }}>
                <Icons.X />
              </button>
            </div>


            {/* Stepped form. The old version put connection details, the
                RADIUS secret and API credentials in one grid — three unrelated
                concerns, and no indication that the secret is the field that
                decides whether authentication works at all. */}
            {!editItem ? (
              <Wizard
                busy={false}
                onCancel={() => setShowForm(false)}
                finishLabel="Add router"
                onFinish={saveNas}
                steps={[
                  {
                    id: 'identify',
                    title: 'Identify',
                    hint: 'Where the router is on your network, and what to call it here.',
                    validate: () => {
                      if (!form.nasIp.trim()) return 'NAS IP is required — RADIUS matches requests by this address.';
                      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(form.nasIp.trim())) return 'That does not look like an IPv4 address (e.g. 192.168.1.127).';
                      if (!form.nasName.trim()) return 'Give the router a name so you can recognise it later.';
                      return null;
                    },
                    summary: () => [
                      ['NAS IP', form.nasIp],
                      ['Name', form.nasName],
                      ['Shortname', form.shortname || form.nasName],
                      ['Type', form.nasType],
                    ],
                    render: () => (
                      <>
                        <Field label="NAS IP" required hint="The router's address, with no subnet suffix.">
                          <input value={form.nasIp} placeholder="192.168.1.127"
                            onChange={e => setForm(p => ({ ...p, nasIp: e.target.value }))} />
                        </Field>
                        <Field label="Name" required hint="Shown throughout the panel.">
                          <input value={form.nasName} placeholder="Main-MikroTik"
                            onChange={e => setForm(p => ({ ...p, nasName: e.target.value }))} />
                        </Field>
                        <Field label="Shortname" hint="Optional. Defaults to the name.">
                          <input value={form.shortname} placeholder="Main-MT"
                            onChange={e => setForm(p => ({ ...p, shortname: e.target.value }))} />
                        </Field>
                        <Field label="Vendor" required>
                          <select value={form.nasType} onChange={e => setForm(p => ({ ...p, nasType: e.target.value }))}>
                            {['MIKROTIK','CISCO','HUAWEI','OTHER'].map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                        </Field>
                      </>
                    ),
                  },
                  {
                    id: 'radius',
                    title: 'RADIUS',
                    hint: 'The shared secret is the single most common cause of authentication failing. It must match the router exactly.',
                    validate: () => {
                      if (!form.radiusSecret.trim()) return 'The RADIUS secret is required — without it every login is rejected.';
                      if (form.radiusSecret !== form.radiusSecret.trim()) return 'The secret has leading or trailing spaces. Those are invisible here and break authentication on the router.';
                      return null;
                    },
                    summary: () => [
                      ['RADIUS secret', form.radiusSecret ? '•'.repeat(Math.min(form.radiusSecret.length, 12)) : ''],
                      ['CoA port', String(form.incomingPort || 3799)],
                    ],
                    render: () => (
                      <>
                        <Field label="RADIUS secret" required
                          hint="Must be identical to the secret configured on the router.">
                          <input type={showRadiusSecret ? 'text' : 'password'} value={form.radiusSecret}
                            onChange={e => setForm(p => ({ ...p, radiusSecret: e.target.value }))} />
                        </Field>
                        <Field label="CoA / Incoming port"
                          hint="3799 by default. Used to disconnect a live session — leave it unless your router differs.">
                          <input type="number" value={form.incomingPort}
                            onChange={e => setForm(p => ({ ...p, incomingPort: +e.target.value }))} />
                        </Field>
                        <Field label="NAS Identifier (optional)"
                          hint="Only for BNGs that identify by NAS-Identifier (vBNG/BiSON, etc.). Must match the value the BNG sends. Leave blank for MikroTik.">
                          <input value={form.nasIdentifier} placeholder="e.g. zalultra-bng-01"
                            onChange={e => setForm(p => ({ ...p, nasIdentifier: e.target.value }))} />
                        </Field>
                      </>
                    ),
                  },
                  {
                    id: 'api',
                    title: 'API access',
                    hint: 'Optional, but without it the panel cannot read live sessions, pull router logs or disconnect a customer.',
                    summary: () => [
                      ['API port', String(form.apiPort || 8728)],
                      ['API username', form.apiUsername],
                      ['API password', form.apiPassword ? 'set' : ''],
                      ['Status', form.isActive ? 'Active' : 'Inactive'],
                      ['Description', form.description],
                    ],
                    render: () => (
                      <>
                        <Field label="API port" hint="8728 for MikroTik.">
                          <input type="number" value={form.apiPort}
                            onChange={e => setForm(p => ({ ...p, apiPort: +e.target.value }))} />
                        </Field>
                        <Field label="API username" hint="Needs read access, plus write to disconnect sessions.">
                          <input value={form.apiUsername} placeholder="admin"
                            onChange={e => setForm(p => ({ ...p, apiUsername: e.target.value }))} />
                        </Field>
                        <Field label="API password">
                          <input type={showApiPassword ? 'text' : 'password'} value={form.apiPassword}
                            onChange={e => setForm(p => ({ ...p, apiPassword: e.target.value }))} />
                        </Field>
                        <Field label="Description" hint="Optional note — location, site, anything useful.">
                          <input value={form.description}
                            onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
                        </Field>

                        {/* ── Link tracing — each method optional & independent ── */}
                        <Field label="Device type" hint="Selects the right SNMP OIDs / syslog parser. VSOL for your OLTs.">
                          <select value={form.deviceType}
                            onChange={e => setForm(p => ({ ...p, deviceType: e.target.value }))}>
                            <option value="MIKROTIK">MikroTik</option>
                            <option value="OLT_VSOL">OLT — VSOL</option>
                            <option value="OLT_ZTE">OLT — ZTE</option>
                            <option value="OLT_HUAWEI">OLT — Huawei</option>
                            <option value="OLT_FIBERHOME">OLT — FiberHome</option>
                            <option value="OLT_BDCOM">OLT — BDCOM</option>
                            <option value="SWITCH">Switch</option>
                            <option value="OTHER">Other</option>
                          </select>
                        </Field>
                        <Field label="MikroTik API polling" hint="Uses the API above for PPPoE sessions & interfaces.">
                          <label style={{ display:'flex', gap:8, alignItems:'center' }}>
                            <input type="checkbox" checked={form.apiEnabled}
                              onChange={e => setForm(p => ({ ...p, apiEnabled: e.target.checked }))} />
                            <span>Enable API polling</span>
                          </label>
                        </Field>
                        <Field label="SNMP" hint="Works on ANY device — port status, errors, traffic, OLT ONT signal.">
                          <label style={{ display:'flex', gap:8, alignItems:'center' }}>
                            <input type="checkbox" checked={form.snmpEnabled}
                              onChange={e => setForm(p => ({ ...p, snmpEnabled: e.target.checked }))} />
                            <span>Enable SNMP polling</span>
                          </label>
                        </Field>
                        {form.snmpEnabled && (
                          <>
                            <Field label="SNMP community"><input value={form.snmpCommunity}
                              onChange={e => setForm(p => ({ ...p, snmpCommunity: e.target.value }))} /></Field>
                            <Field label="SNMP port"><input type="number" value={form.snmpPort}
                              onChange={e => setForm(p => ({ ...p, snmpPort: +e.target.value }))} /></Field>
                            <Field label="SNMP version">
                              <select value={form.snmpVersion}
                                onChange={e => setForm(p => ({ ...p, snmpVersion: e.target.value }))}>
                                <option value="V1">v1</option>
                                <option value="V2C">v2c</option>
                                <option value="V3">v3</option>
                              </select>
                            </Field>
                            <Field label="SNMP poll interval (s)"><input type="number" value={form.snmpPollSec}
                              onChange={e => setForm(p => ({ ...p, snmpPollSec: +e.target.value }))} /></Field>
                          </>
                        )}
                        <Field label="Syslog" hint={`Point the device's syslog at this panel (UDP ${form.syslogPort}) for real-time events.`}>
                          <label style={{ display:'flex', gap:8, alignItems:'center' }}>
                            <input type="checkbox" checked={form.syslogEnabled}
                              onChange={e => setForm(p => ({ ...p, syslogEnabled: e.target.checked }))} />
                            <span>Receive syslog from this device</span>
                          </label>
                        </Field>
                      </>
                    ),
                  },
                ]}
              />
            ) : (
            <>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              {([
                { label:'NAS IP *',        key:'nasIp',        type:'text',     ph:'e.g., 192.168.0.100', desc:'Insert NAS/Router IP address here without any block' },
                { label:'NAS Name / Shortname *', key:'nasName', type:'text', ph:'e.g., Main-MikroTik', desc:'Give a name to your router for easy identification' },
                { label:'Shortname',       key:'shortname',    type:'text',     ph:'e.g., Main-MT', desc:'Optional short router label for listings' },
                { label:'NAS Type *',      key:'nasType',      type:'select',   opts:['MIKROTIK','CISCO','HUAWEI','OTHER'], desc:'Router vendor / NAS type' },
                { label:'API Port',        key:'apiPort',      type:'number',   ph:'8728', desc:'API port for router communication' },
                { label:'Incoming Port',   key:'incomingPort', type:'number',   ph:'3799', desc:'Must be enabled for CoA requests and user graph data' },
                { label:'API Username',    key:'apiUsername',  type:'text',     ph:'admin', desc:'Router API username with necessary permissions' },
              ] as const).map(f => (
                <div key={f.key}>
                  <label style={labelSt}>{f.label}</label>
                  {'desc' in f && f.desc && <div style={{ fontSize:10, color:t.textMuted, marginBottom:5 }}>{f.desc}</div>}
                  {f.type === 'select' ? (
                    <select value={(form as any)[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                      style={{ ...inputSt, cursor:'pointer' }}>
                      {(f as any).opts?.map((o: string) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input type={f.type} placeholder={f.ph} value={(form as any)[f.key]}
                      onChange={e => setForm(p => ({ ...p, [f.key]: f.type==='number' ? +e.target.value : e.target.value }))}
                      style={inputSt} />
                  )}
                </div>
              ))}

              <div>
                <label style={labelSt}>RADIUS Secret *</label>
                <div style={{ fontSize:10, color:t.textMuted, marginBottom:5 }}>Insert your radius secret here, it acts like a password. Must match the secret in router&apos;s RADIUS configuration</div>
                <div style={{ display:'flex', gap:8 }}>
                  <input type={showRadiusSecret ? 'text' : 'password'} placeholder="Enter RADIUS secret" value={form.radiusSecret}
                    onChange={e => setForm(p => ({ ...p, radiusSecret:e.target.value }))} style={inputSt} />
                  <Btn onClick={() => setShowRadiusSecret(v => !v)} variant="ghost" size="xs">{showRadiusSecret ? 'Hide' : 'Show'}</Btn>
                </div>
              </div>

              <div>
                <label style={labelSt}>API Password</label>
                <div style={{ fontSize:10, color:t.textMuted, marginBottom:5 }}>Router API password</div>
                <div style={{ display:'flex', gap:8 }}>
                  <input type={showApiPassword ? 'text' : 'password'} placeholder="Router API password" value={form.apiPassword}
                    onChange={e => setForm(p => ({ ...p, apiPassword:e.target.value }))} style={inputSt} />
                  <Btn onClick={() => setShowApiPassword(v => !v)} variant="ghost" size="xs">{showApiPassword ? 'Hide' : 'Show'}</Btn>
                </div>
              </div>
            </div>
            <div style={{ marginTop:12 }}>
              <label style={labelSt}>Description</label>
              <input value={form.description} onChange={e => setForm(p=>({...p,description:e.target.value}))}
                placeholder="Optional notes" style={inputSt} />
            </div>

            {/* ── Link tracing — optional & independent per NAS ── */}
            <div style={{ marginTop:16, paddingTop:14, borderTop:`1px solid ${t.inputBorder}` }}>
              <div style={{ fontWeight:800, color:t.text, fontSize:13, marginBottom:2 }}>📡 Link tracing (optional)</div>
              <div style={{ fontSize:10.5, color:t.textMuted, marginBottom:12 }}>Turn on only what this device supports. Each method works on its own.</div>

              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                <div>
                  <label style={labelSt}>Device type</label>
                  <div style={{ fontSize:10, color:t.textMuted, marginBottom:5 }}>Selects the right SNMP OIDs / syslog parser. VSOL for your OLTs.</div>
                  <select value={form.deviceType} onChange={e => setForm(p => ({ ...p, deviceType: e.target.value }))} style={{ ...inputSt, cursor:'pointer' }}>
                    <option value="MIKROTIK">MikroTik</option>
                    <option value="OLT_VSOL">OLT — VSOL</option>
                    <option value="OLT_ZTE">OLT — ZTE</option>
                    <option value="OLT_HUAWEI">OLT — Huawei</option>
                    <option value="OLT_FIBERHOME">OLT — FiberHome</option>
                    <option value="OLT_BDCOM">OLT — BDCOM</option>
                    <option value="SWITCH">Switch</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <div>
                  <label style={labelSt}>MikroTik API polling</label>
                  <div style={{ fontSize:10, color:t.textMuted, marginBottom:5 }}>PPPoE sessions & interface status via the API above.</div>
                  <Btn onClick={() => setForm(p => ({ ...p, apiEnabled: !p.apiEnabled }))} variant={form.apiEnabled ? 'success' : 'ghost'} size="xs">
                    {form.apiEnabled ? '✓ Enabled' : 'Disabled'}
                  </Btn>
                </div>
              </div>

              {/* SNMP */}
              <div style={{ marginTop:14, background:d?'var(--surface-2)':'#f8fafc', border:`1px solid ${t.inputBorder}`, borderRadius:8, padding:'10px 12px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <div>
                    <div style={{ fontWeight:700, color:t.text, fontSize:12 }}>SNMP</div>
                    <div style={{ fontSize:10.5, color:t.textMuted }}>Works on ANY device — port status, errors, traffic, OLT ONT signal.</div>
                  </div>
                  <Btn onClick={() => setForm(p => ({ ...p, snmpEnabled: !p.snmpEnabled }))} variant={form.snmpEnabled ? 'success' : 'ghost'} size="xs">
                    {form.snmpEnabled ? '✓ Enabled' : 'Enable'}
                  </Btn>
                </div>
                {form.snmpEnabled && (
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:10, marginTop:10 }}>
                    <div><label style={labelSt}>Community</label>
                      <input value={form.snmpCommunity} onChange={e => setForm(p => ({ ...p, snmpCommunity: e.target.value }))} style={inputSt} /></div>
                    <div><label style={labelSt}>Port</label>
                      <input type="number" value={form.snmpPort} onChange={e => setForm(p => ({ ...p, snmpPort: +e.target.value }))} style={inputSt} /></div>
                    <div><label style={labelSt}>Version</label>
                      <select value={form.snmpVersion} onChange={e => setForm(p => ({ ...p, snmpVersion: e.target.value }))} style={{ ...inputSt, cursor:'pointer' }}>
                        <option value="V1">v1</option><option value="V2C">v2c</option><option value="V3">v3</option>
                      </select></div>
                    <div><label style={labelSt}>Poll (s)</label>
                      <input type="number" value={form.snmpPollSec} onChange={e => setForm(p => ({ ...p, snmpPollSec: +e.target.value }))} style={inputSt} /></div>
                  </div>
                )}
              </div>

              {/* Syslog */}
              <div style={{ marginTop:10, background:d?'var(--surface-2)':'#f8fafc', border:`1px solid ${t.inputBorder}`, borderRadius:8, padding:'10px 12px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <div>
                    <div style={{ fontWeight:700, color:t.text, fontSize:12 }}>Syslog</div>
                    <div style={{ fontSize:10.5, color:t.textMuted }}>Real-time events. Point the device's syslog target at this panel on UDP {form.syslogPort}.</div>
                  </div>
                  <Btn onClick={() => setForm(p => ({ ...p, syslogEnabled: !p.syslogEnabled }))} variant={form.syslogEnabled ? 'success' : 'ghost'} size="xs">
                    {form.syslogEnabled ? '✓ Enabled' : 'Enable'}
                  </Btn>
                </div>
              </div>
            </div>

            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, background:d?'var(--bg)':'#f8fafc', borderRadius:8, padding:'10px 12px', marginTop:14, fontSize:11, color:t.textMuted, border:`1px solid ${t.inputBorder}` }}>
              <div>
                <div style={{ fontWeight:700, color:t.text, marginBottom:2 }}>Status</div>
                <div>Control whether this NAS is active in the panel and monitoring cycle.</div>
              </div>
              <Btn onClick={() => setForm(p => ({ ...p, isActive: !p.isActive }))} variant={form.isActive ? 'success' : 'danger'} size="xs">
                <Icons.Toggle /> {form.isActive ? 'Active' : 'Inactive'}
              </Btn>
            </div>
            <div style={{ display:'flex', gap:8, marginTop:16, justifyContent:'flex-end' }}>
              <Btn onClick={() => setShowForm(false)} variant="ghost">Cancel</Btn>
              <Btn onClick={saveNas} variant="primary"><Icons.Plus /> {editItem ? 'Update NAS' : 'Add NAS'}</Btn>
            </div>
            </>
            )}{/* end: edit keeps the single-page form — when you are changing
                   one field, steps are friction rather than guidance */}

            {/* Reference notes, BELOW the form.
                At the top they pushed the first input off the screen and were
                read once and never again. Underneath they are still there when
                a value is questioned, without standing between you and the
                field you came to fill in. */}
            <div style={{ background:d?'var(--surface-2)':'#fff7ed', border:`1px solid ${d?'var(--border)':'#fdba74'}`, borderRadius:10, padding:'11px 13px', marginTop:16 }}>
              <div style={{ fontSize:10.5, fontWeight:800, color:d ? '#fbbf24' : '#c2410c', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:5 }}>Things that commonly go wrong</div>
              <div style={{ fontSize:11.5, color:t.textSub, lineHeight:1.65 }}>
                <div>NAS IP must be the plain address, with no subnet suffix.</div>
                <div>RADIUS secret must match the router&apos;s RADIUS configuration exactly.</div>
                <div>Incoming port (CoA) must be open, or sessions cannot be disconnected.</div>
                <div>API user needs read access, plus write to kick a live session.</div>
              </div>
            </div>
          </div>
        </div></Portal>
      )}

      {/* ══════════════════════════════════════
          MODAL: LOGS
      ══════════════════════════════════════ */}
      {showLogs && (
        <Portal><div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.8)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
          onClick={() => setShowLogs(false)}>
          <div style={{ background:t.card, border:`1px solid ${t.cardBorder}`, borderRadius:12, padding:24, width:'100%', maxWidth:640, maxHeight:'80vh', display:'flex', flexDirection:'column' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
              <span style={{ fontWeight:800, fontSize:15 }}>Activity Logs ({logs.length})</span>
              <div style={{ display:'flex', gap:8 }}>
                <Btn onClick={() => setLogs([])} variant="danger" size="xs">Clear</Btn>
                <button onClick={() => setShowLogs(false)} style={{ background:'transparent', border:`1px solid ${t.cardBorder}`, borderRadius:6, padding:'5px 8px', cursor:'pointer', color:t.textSub }}>
                  <Icons.X />
                </button>
              </div>
            </div>
            <div style={{ overflowY:'auto', flex:1 }}>
              {logs.length === 0 ? (
                <div style={{ textAlign:'center', padding:30, color:t.textMuted }}>No activity logs yet</div>
              ) : logs.map(log => (
                <div key={log.id} style={{ display:'flex', gap:10, padding:'5px 0', borderBottom:`1px solid ${t.cardBorder}`, fontSize:11 }}>
                  <span style={{ flexShrink:0 }}>{log.level==='error'?'❌':log.level==='warn'?'⚠️':'✅'}</span>
                  <span style={{ color:t.textMuted, flexShrink:0, whiteSpace:'nowrap' }}>{new Date(log.time).toLocaleTimeString()}</span>
                  <span style={{ color:t.text, wordBreak:'break-all' }}>{log.message}</span>
                </div>
              ))}
            </div>
          </div>
        </div></Portal>
      )}

      {/* ══════════════════════════════════════
          MODAL: DELETE CONFIRM
      ══════════════════════════════════════ */}
      {deleteConfirm !== null && (
        <Portal><div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.8)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
          onClick={() => setDeleteConfirm(null)}>
          <div style={{ background:t.card, border:'1px solid #7f1d1d', borderRadius:12, padding:24, width:'100%', maxWidth:380 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
              <div style={{ fontSize:24 }}>⚠️</div>
              <div style={{ fontWeight:800, fontSize:15, color:'#f87171' }}>Delete NAS Device</div>
            </div>
            <p style={{ fontSize:13, color:t.textSub, marginBottom:20, lineHeight:1.6 }}>
              This will permanently remove the NAS from the CRM <b>and</b> from FreeRADIUS.
              Subscribers using this NAS for authentication will be unable to reconnect until you re-register it.
            </p>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <Btn onClick={() => setDeleteConfirm(null)} variant="ghost">Cancel</Btn>
              <Btn onClick={() => deleteNas(deleteConfirm!)} variant="danger"><Icons.Trash /> Delete Permanently</Btn>
            </div>
          </div>
        </div></Portal>
      )}
    </div>
  );
}
