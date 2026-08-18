"use client";

/**
 * NasDetailContext — single source of truth for the device detail page.
 *
 * Loads ONLY cheap, frequently-changing endpoints here (device record,
 * reachability, live sessions, RADIUS stats, telemetry events, network logs).
 * Heavy data (full MikroTik sync, health-history, traffic series) is fetched
 * per-tab, lazily, so opening the page never loads every graph at once.
 *
 * Auto-refresh modes (Live/30s/1m/5m/Off) control the poll interval for the
 * cheap endpoints. Nothing reloads the page; each domain refreshes on its own.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  apiGet, apiSend, authHeaders, API_BASE,
  NasRecord, Reachability, MikrotikDetails, Session, RadiusStats, TelemetryEvent, NetworkLogRow,
} from "./lib";

export type RefreshMode = "live" | "30s" | "1m" | "5m" | "off";

export interface TestResult {
  key: string;
  label: string;
  status: "running" | "ok" | "fail" | "warn";
  latencyMs?: number | null;
  message?: string;
  ts: string;
  raw?: any;
}

export interface NasDetailState {
  nasId: number;
  nas: NasRecord | null;
  reach: Reachability | null;
  details: MikrotikDetails | null;
  sessions: Session[];
  radiusStats: RadiusStats | null;
  events: TelemetryEvent[];
  networkLogs: NetworkLogRow[];
  timeline: any[];
  loading: { nas: boolean; reach: boolean; details: boolean; sessions: boolean };
  loadNas: () => Promise<void>;
  refreshReach: (opts?: { silent?: boolean }) => Promise<Reachability | null>;
  loadDetails: (opts?: { silent?: boolean }) => Promise<MikrotikDetails | null>;
  refreshSessions: () => Promise<Session[]>;
  refreshEvents: () => Promise<TelemetryEvent[]>;
  loadNetworkLogs: () => Promise<void>;
  loadTimeline: () => Promise<void>;
  refreshRadius: () => Promise<void>;
  refreshAll: () => Promise<void>;
  mode: RefreshMode;
  setMode: (m: RefreshMode) => void;
  liveConnected: boolean;
  lastUpdate: Date | null;
  coaTest: TestResult | null;
  runCoaTest: () => Promise<TestResult | null>;
  pingResult: TestResult | null;
  runPing: () => Promise<TestResult | null>;
  snmpTest: TestResult | null;
  runSnmpTest: () => Promise<TestResult | null>;
  apiRoundTrip: TestResult | null;
  runApiTest: () => Promise<TestResult | null>;
  runAllTests: () => Promise<void>;
  clearTests: () => void;
  sessionsVersion: number;
  bumpSessions: () => void;
}

const Ctx = createContext<NasDetailState | null>(null);

const MODE_MS: Record<Exclude<RefreshMode, "off">, number> = {
  live: 10000,
  "30s": 30000,
  "1m": 60000,
  "5m": 300000,
};

export function NasDetailProvider({ nasId, children }: { nasId: number; children: React.ReactNode }) {
  const [nas, setNas] = useState<NasRecord | null>(null);
  const [reach, setReach] = useState<Reachability | null>(null);
  const [details, setDetails] = useState<MikrotikDetails | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [radiusStats, setRadiusStats] = useState<RadiusStats | null>(null);
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [networkLogs, setNetworkLogs] = useState<NetworkLogRow[]>([]);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [loading, setLoading] = useState({ nas: true, reach: true, details: false, sessions: true });
  const [mode, setMode] = useState<RefreshMode>("live");
  const [liveConnected, setLiveConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [coaTest, setCoaTest] = useState<TestResult | null>(null);
  const [pingResult, setPingResult] = useState<TestResult | null>(null);
  const [snmpTest, setSnmpTest] = useState<TestResult | null>(null);
  const [apiRoundTrip, setApiRoundTrip] = useState<TestResult | null>(null);
  const [sessionsVersion, setSessionsVersion] = useState(0);
  const nasRef = useRef<NasRecord | null>(null);
  useEffect(() => { nasRef.current = nas; }, [nas]);

  const bumpSessions = useCallback(() => setSessionsVersion((v) => v + 1), []);

  // ── Loaders (each domain independent so partial data still renders) ──
  const loadNas = useCallback(async () => {
    const rec = await apiGet<NasRecord>(`/nas/${nasId}`);
    if (rec) setNas(rec);
    setLoading((p) => ({ ...p, nas: false }));
  }, [nasId]);

  const refreshReach = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading((p) => ({ ...p, reach: true }));
    const r = await apiGet<Reachability>(`/nas/${nasId}/reachability`, 15000);
    if (r) {
      setReach(r);
      setLastUpdate(new Date());
    }
    setLoading((p) => ({ ...p, reach: false }));
    return r;
  }, [nasId]);

  const loadDetails = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading((p) => ({ ...p, details: true }));
    const d = await apiGet<MikrotikDetails>(`/nas/${nasId}/sync`, 20000);
    if (d) setDetails(d);
    setLoading((p) => ({ ...p, details: false }));
    return d;
  }, [nasId]);

  const refreshSessions = useCallback(async () => {
    const rows = await apiGet<Session[] | { sessions: Session[] }>(`/nas/${nasId}/sessions`);
    const list = Array.isArray(rows) ? rows : (rows?.sessions ?? []);
    setSessions(list);
    return list;
  }, [nasId]);

  const refreshEvents = useCallback(async () => {
    const d = await apiGet<{ events?: TelemetryEvent[] } | TelemetryEvent[]>(`/telemetry/events?nasId=${nasId}&limit=120`);
    const list = Array.isArray(d) ? d : (d?.events ?? []);
    setEvents(list);
    return list;
  }, [nasId]);

  const refreshRadius = useCallback(async () => {
    const s = await apiGet<RadiusStats>(`/nas/radius/stats`);
    if (s) setRadiusStats(s);
  }, []);

  const loadNetworkLogs = useCallback(async () => {
    const d = await apiGet<{ logs?: NetworkLogRow[] }>(`/logs/network?limit=300`);
    const rows = d?.logs ?? [];
    // The Logs tab is per-device; filter server data to this NAS.
    setNetworkLogs(rows.filter((r) => r.nasId === nasId));
  }, [nasId]);

  const loadTimeline = useCallback(async () => {
    const d = await apiGet<any>(`/logs/timeline?limit=300`);
    const rows = Array.isArray(d) ? d : (d?.logs ?? []);
    // Keep entries that reference this device (by nasId / nas name / nasIp).
    const nasName = nasRef.current?.nasname?.toLowerCase() ?? "";
    const nasIp = nasRef.current?.nasIp?.toLowerCase() ?? "";
    setTimeline(rows.filter((r: any) => {
      if (r.nasId === nasId) return true;
      const hay = [r.nas?.nasname, r.nas?.nasIp, r.nasname, r.nasIp, r.details, r.message].filter(Boolean).join(" ").toLowerCase();
      return (nasName && hay.includes(nasName)) || (nasIp && hay.includes(nasIp));
    }));
  }, [nasId]);

  // ── Tests (all real backend calls; latency measured client-side) ──
  const runPing = useCallback(async () => {
    const t0 = performance.now();
    setPingResult({ key: "ping", label: "Ping", status: "running", ts: new Date().toISOString() });
    try {
      const r = await apiGet<any>(`/nas/${nasId}/ping`, 15000);
      const latency = Math.round(performance.now() - t0);
      setPingResult({
        key: "ping", label: "Ping", status: r?.reachable ? "ok" : "fail",
        latencyMs: r?.avgMs ?? latency,
        message: r?.message ?? "Ping failed",
        ts: new Date().toISOString(), raw: r,
      });
      return r;
    } catch (e: any) {
      setPingResult({ key: "ping", label: "Ping", status: "fail", message: e?.message, ts: new Date().toISOString() });
      return null;
    }
  }, [nasId]);

  const runCoaTest = useCallback(async () => {
    const t0 = performance.now();
    setCoaTest({ key: "coa", label: "CoA", status: "running", ts: new Date().toISOString() });
    try {
      const r = await apiGet<any>(`/network/nas/${nasId}/test-coa`, 15000);
      const latency = Math.round(performance.now() - t0);
      setCoaTest({
        key: "coa", label: "CoA", status: r?.reachable ? "ok" : "warn",
        latencyMs: latency,
        message: r?.message ?? (r?.reachable ? "CoA reachable" : "CoA not reachable"),
        ts: new Date().toISOString(), raw: r,
      });
      return r;
    } catch (e: any) {
      setCoaTest({ key: "coa", label: "CoA", status: "fail", message: e?.message, ts: new Date().toISOString() });
      return null;
    }
  }, [nasId]);

  const runSnmpTest = useCallback(async () => {
    const t0 = performance.now();
    setSnmpTest({ key: "snmp", label: "SNMP", status: "running", ts: new Date().toISOString() });
    try {
      const r = await apiSend<any>(`/telemetry/nas/${nasId}/snmp-test`, "POST");
      const latency = Math.round(performance.now() - t0);
      setSnmpTest({
        key: "snmp", label: "SNMP", status: r?.ok ? "ok" : "fail",
        latencyMs: r?.responseMs ?? latency,
        message: r?.ok ? `SNMP ${r.version ?? ""} — ${r.uptimeText ?? "connected"}` : (r?.error ?? "SNMP test failed"),
        ts: new Date().toISOString(), raw: r,
      });
      return r;
    } catch (e: any) {
      setSnmpTest({ key: "snmp", label: "SNMP", status: "fail", message: e?.message, ts: new Date().toISOString() });
      return null;
    }
  }, [nasId]);

  const runApiTest = useCallback(async () => {
    const t0 = performance.now();
    setApiRoundTrip({ key: "api", label: "API", status: "running", ts: new Date().toISOString() });
    try {
      const r = await apiGet<any>(`/nas/${nasId}/quick-check`, 15000);
      const latency = Math.round(performance.now() - t0);
      const ok = !!r?.online;
      setApiRoundTrip({
        key: "api", label: "API", status: ok ? "ok" : "fail",
        latencyMs: latency,
        message: ok
          ? `Authenticated — ${r.identity || "identity"}${r.version ? `, v${r.version}` : ""}`
          : "API login or reachability failed",
        ts: new Date().toISOString(), raw: r,
      });
      return r;
    } catch (e: any) {
      setApiRoundTrip({ key: "api", label: "API", status: "fail", message: e?.message, ts: new Date().toISOString() });
      return null;
    }
  }, [nasId]);

  const runAllTests = useCallback(async () => {
    await Promise.allSettled([runPing(), runCoaTest(), runSnmpTest(), runApiTest()]);
  }, [runPing, runCoaTest, runSnmpTest, runApiTest]);

  const clearTests = useCallback(() => {
    setCoaTest(null); setPingResult(null); setSnmpTest(null); setApiRoundTrip(null);
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.allSettled([refreshReach({ silent: true }), refreshSessions(), refreshEvents(), refreshRadius()]);
  }, [refreshReach, refreshSessions, refreshEvents, refreshRadius]);

  // ── Initial load (parallel, independent) ──
  useEffect(() => {
    loadNas();
    refreshReach();
    refreshSessions();
    refreshEvents();
    refreshRadius();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nasId]);

  // ── Auto-refresh loop for cheap endpoints, driven by the mode ──
  useEffect(() => {
    if (mode === "off") return;
    const ms = MODE_MS[mode];
    const t = setInterval(() => {
      refreshAll();
    }, ms);
    return () => clearInterval(t);
  }, [mode, refreshAll]);

  // ── Live indicator: reuse the app's global SSE stream (real backend push) ──
  useEffect(() => {
    if (!nasId) return;
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
  }, [nasId]);

  const value = useMemo<NasDetailState>(() => ({
    nasId, nas, reach, details, sessions, radiusStats, events, networkLogs, timeline,
    loading,
    loadNas, refreshReach, loadDetails, refreshSessions, refreshEvents, loadNetworkLogs, loadTimeline,
    refreshRadius, refreshAll,
    mode, setMode, liveConnected,
    lastUpdate,
    coaTest, runCoaTest, pingResult, runPing, snmpTest, runSnmpTest,
    apiRoundTrip, runApiTest, runAllTests, clearTests,
    sessionsVersion, bumpSessions,
  }), [
    nasId, nas, reach, details, sessions, radiusStats, events, networkLogs, timeline, loading,
    loadNas, refreshReach, loadDetails, refreshSessions, refreshEvents, loadNetworkLogs, loadTimeline,
    refreshRadius, refreshAll, mode, liveConnected, lastUpdate,
    coaTest, runCoaTest, pingResult, runPing, snmpTest, runSnmpTest, apiRoundTrip, runApiTest, runAllTests, clearTests,
    sessionsVersion, bumpSessions,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNasDetail(): NasDetailState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNasDetail must be used inside NasDetailProvider");
  return v;
}

export { authHeaders };
