"use client";

/**
 * SubscriberDetailContext — single source of truth for the Subscriber 360 page.
 *
 * Loads the cheap, frequently-changing endpoints once here (profile bundle,
 * live RADIUS session + history, auth log, radcheck, data allowance, static IP
 * + health, router log). Heavy or slow data (bandwidth series, daily usage,
 * session pagination) is fetched per-tab, lazily.
 *
 * Auto-refresh modes (Live/30s/1m/5m/Off) drive the poll interval for the live
 * endpoints only. Every number comes from a real backend endpoint — nothing is
 * fabricated, and "no data" is shown as "—" not as a fake zero.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  apiGet, apiSend, API_BASE,
  Subscriber, ProfileBundle, ServiceSettings,
  RadiusSessionResponse, RadiusSession, RadiusAuth, RadiusCheck,
  StaticIp, StaticIpHealth, FupUsage, RouterLogResponse,
} from "./lib";

export type RefreshMode = "live" | "30s" | "1m" | "5m" | "off";

export interface TestResult {
  key: string;
  label: string;
  status: "running" | "ok" | "fail" | "warn" | "skip";
  message?: string;
  ts: string;
  raw?: any;
}

export interface ToastMsg {
  msg: string;
  type: "ok" | "err" | "warn";
}

export interface SubscriberDetailState {
  subscriberId: number;
  sub: Subscriber | null;
  serviceSettings: ServiceSettings | null;
  invoices: any[];
  payments: any[];
  tickets: any[];
  loading: { bundle: boolean; live: boolean };
  loadBundle: () => Promise<void>;
  refreshLive: () => Promise<void>;
  sessionChecked: boolean;
  liveSession: RadiusSession | null;
  sessionLogs: RadiusSession[];
  openSessions: number;
  duplicate: boolean;
  authLogs: RadiusAuth[];
  radiusChecks: RadiusCheck[];
  usage: FupUsage | null;
  staticIp: StaticIp | null;
  staticHealth: StaticIpHealth | null;
  setStaticIp: (v: StaticIp | null) => void;
  setStaticHealth: (v: StaticIpHealth | null) => void;
  ipv6: any;
  routerLog: RouterLogResponse | null;
  routerBusy: boolean;
  loadRouterLog: () => Promise<RouterLogResponse | null>;
  loadUsage: () => Promise<void>;
  loadStatic: () => Promise<void>;
  mode: RefreshMode;
  setMode: (m: RefreshMode) => void;
  liveConnected: boolean;
  lastUpdate: Date | null;
  toast: ToastMsg | null;
  showToast: (msg: string, type?: ToastMsg["type"]) => void;
  user: any;
  busies: Record<string, boolean>;
  setBusy: (k: string, v: boolean) => void;
}

const Ctx = createContext<SubscriberDetailState | null>(null);

const MODE_MS: Record<Exclude<RefreshMode, "off">, number> = {
  live: 10000,
  "30s": 30000,
  "1m": 60000,
  "5m": 300000,
};

export function SubscriberDetailProvider({ subscriberId, children }: { subscriberId: number; children: React.ReactNode }) {
  const router = useRouter();
  const [sub, setSub] = useState<Subscriber | null>(null);
  const [serviceSettings, setServiceSettings] = useState<ServiceSettings | null>(null);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [tickets, setTickets] = useState<any[]>([]);
  const [loading, setLoading] = useState({ bundle: true, live: false });

  // RADIUS live
  const [liveSession, setLiveSession] = useState<RadiusSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [sessionLogs, setSessionLogs] = useState<RadiusSession[]>([]);
  const [openSessions, setOpenSessions] = useState(0);
  const [duplicate, setDuplicate] = useState(false);
  const [authLogs, setAuthLogs] = useState<RadiusAuth[]>([]);
  const [radiusChecks, setRadiusChecks] = useState<RadiusCheck[]>([]);

  const [usage, setUsage] = useState<FupUsage | null>(null);
  const [staticIp, setStaticIp] = useState<StaticIp | null>(null);
  const [staticHealth, setStaticHealth] = useState<StaticIpHealth | null>(null);
  const [ipv6, setIpv6] = useState<any>(null);
  const [routerLog, setRouterLog] = useState<RouterLogResponse | null>(null);
  const [routerBusy, setRouterBusy] = useState(false);

  const [mode, setMode] = useState<RefreshMode>("live");
  const [liveConnected, setLiveConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [user, setUser] = useState<any>(null);
  const [busies, setBusies] = useState<Record<string, boolean>>({});

  const liveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setBusy = useCallback((k: string, v: boolean) => {
    setBusies((p) => ({ ...p, [k]: v }));
  }, []);

  const showToast = useCallback((msg: string, type: ToastMsg["type"] = "ok") => {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Auth / theme: reuse the app's existing auth, no local darkMode state ──
  useEffect(() => {
    const tk = typeof window !== "undefined" ? localStorage.getItem("token") : "";
    if (!tk) { router.push("/login"); return; }
    apiGet<any>("/profile").then((d) => {
      if (!d?.user) { router.push("/login"); return; }
      setUser(d.user);
    }).catch(() => router.push("/login"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Profile bundle (subscriber + settings + invoices/payments/tickets) ──
  const loadBundle = useCallback(async () => {
    const b = await apiGet<ProfileBundle>(`/subscribers/${subscriberId}/profile-bundle`);
    if (!b?.subscriber) {
      setSub(null);
      setLoading((p) => ({ ...p, bundle: false }));
      return;
    }
    setSub(b.subscriber);
    setServiceSettings(b.serviceSettings ?? null);
    setInvoices(b.invoices ?? []);
    setPayments(b.payments ?? []);
    setTickets(b.tickets ?? []);
    setLoading((p) => ({ ...p, bundle: false }));
    // IPv6 (cheap, independent)
    apiGet<any>(`/service-settings/subscriber/${subscriberId}/ipv6`)
      .then((v) => v && setIpv6(v)).catch(() => {});
  }, [subscriberId]);

  // ── Live RADIUS data ──
  const loadLive = useCallback(async (username?: string) => {
    const uname = username ?? sub?.username ?? "";
    if (!uname) return;
    setLoading((p) => ({ ...p, live: true }));
    try {
      const ses = await apiGet<RadiusSessionResponse>(`/subscribers/radius-session/${encodeURIComponent(uname)}`);
      if (ses) {
        setLiveSession(ses.session ?? null);
        setSessionChecked(true);
        setSessionLogs(ses.history ?? []);
        setOpenSessions(Number(ses.openCount ?? 0));
        setDuplicate(!!ses.duplicate);
      }
      const auth = await apiGet<RadiusAuth[]>(`/subscribers/radius-auth-log/${encodeURIComponent(uname)}`);
      if (auth) setAuthLogs(auth);
      const checks = await apiGet<RadiusCheck[]>(`/subscribers/radius-checks/${encodeURIComponent(uname)}`);
      if (checks) setRadiusChecks(checks);
      setLastUpdate(new Date());
    } catch {
      /* keep whatever we had */
    }
    setLoading((p) => ({ ...p, live: false }));
  }, [sub?.username]);

  // ── Data allowance from FUP ──
  const loadUsage = useCallback(async () => {
    const u = await apiGet<FupUsage>(`/compliance/fup/${subscriberId}`);
    if (u) setUsage(u);
  }, [subscriberId]);

  // ── Static IP + health ──
  const loadStatic = useCallback(async () => {
    const ip = await apiGet<any>(`/static-ips/subscriber/${subscriberId}`);
    if (ip) {
      setStaticIp({
        ...ip,
        ipAddress: ip.ipAddress ?? "",
        monthlyPrice: ip.monthlyPrice ?? null,
        gateway: ip.gateway ?? null,
        assignedAt: ip.assignedAt ?? null,
        nextBillingDate: ip.nextBillingDate ?? null,
      });
    } else {
      setStaticIp(null);
      setStaticHealth(null);
    }
    const h = await apiGet<StaticIpHealth>(`/static-ips/subscriber/${subscriberId}/health`);
    setStaticHealth(h);
  }, [subscriberId]);

  // ── Router log (on demand — hits the router) ──
  const loadRouterLog = useCallback(async () => {
    setRouterBusy(true);
    const r = await apiGet<RouterLogResponse>(`/logs/router/subscriber/${subscriberId}?limit=250`);
    if (r) setRouterLog(r);
    setRouterBusy(false);
    return r;
  }, [subscriberId]);

  // ── Refresh everything relevant ──
  const refreshLive = useCallback(async () => {
    await Promise.allSettled([loadLive(), loadUsage(), loadStatic()]);
  }, [loadLive, loadUsage, loadStatic]);

  // ── Initial load (parallel, independent) ──
  useEffect(() => {
    loadBundle();
    if (sub?.username) loadLive(sub.username);
    loadUsage();
    loadStatic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriberId]);

  // Live data starts once we know the username (bundle may arrive after)
  useEffect(() => {
    if (sub?.username && !sessionChecked) {
      loadLive(sub.username);
    }
    if (sub?.username) {
      loadUsage();
      loadStatic();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub?.username]);

  // ── Auto-refresh loop ──
  useEffect(() => {
    if (mode === "off") return;
    const ms = MODE_MS[mode];
    if (liveRef.current) clearInterval(liveRef.current);
    liveRef.current = setInterval(() => {
      loadLive();
      loadUsage();
    }, ms);
    return () => { if (liveRef.current) clearInterval(liveRef.current); };
  }, [mode, loadLive, loadUsage]);

  // ── Live indicator: app's global SSE stream ──
  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token) return;
    let es: EventSource | null = null;
    let retry = 0;
    let alive = true;
    const connect = () => {
      if (!alive) return;
      es = new EventSource(`${API_BASE}/events?token=${encodeURIComponent(token)}`);
      es.addEventListener("connected", () => { setLiveConnected(true); retry = 0; });
      es.onerror = () => {
        setLiveConnected(false);
        es?.close();
        retry++;
        setTimeout(connect, Math.min(1000 * 2 ** retry, 30000));
      };
    };
    connect();
    return () => { alive = false; es?.close(); setLiveConnected(false); };
  }, []);

  const value = useMemo<SubscriberDetailState>(() => ({
    subscriberId,
    sub, serviceSettings, invoices, payments, tickets, loading,
    loadBundle, refreshLive,
    sessionChecked, liveSession, sessionLogs, openSessions, duplicate,
    authLogs, radiusChecks,
    usage, staticIp, staticHealth, setStaticIp, setStaticHealth,
    ipv6, routerLog, routerBusy, loadRouterLog, loadUsage, loadStatic,
    mode, setMode, liveConnected, lastUpdate,
    toast, showToast, user, busies, setBusy,
  }), [
    subscriberId, sub, serviceSettings, invoices, payments, tickets, loading,
    loadBundle, refreshLive, sessionChecked, liveSession, sessionLogs,
    openSessions, duplicate, authLogs, radiusChecks, usage, staticIp,
    staticHealth, ipv6, routerLog, routerBusy, loadRouterLog, loadUsage,
    loadStatic, mode, liveConnected, lastUpdate, toast, showToast, user,
    busies, setBusy,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSubscriberDetail(): SubscriberDetailState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSubscriberDetail must be used inside SubscriberDetailProvider");
  return v;
}