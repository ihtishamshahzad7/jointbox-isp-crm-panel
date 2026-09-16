"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import API_BASE from "../components/api";
import Portal from "../components/portal";
import {
  DataTable,
  type DtColumn,
  type DataTableFetchParams,
  type DataTableFetchResult,
} from "../components/data-table";

const API = API_BASE;

/** Theme tokens shared by the graph/stat cards. */
interface NetTheme {
  bg: string; card: string; border: string; row: string;
  text: string; muted: string; sub: string;
  accent: string; green: string; red: string; amber: string;
}

const T: NetTheme = {
  bg: "var(--bg)", card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)", sub: "var(--muted)",
  accent: "#0ea5e9", green: "#22c55e", red: "#ef4444", amber: "#f59e0b",
};

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(2)} GB`;
const rate = (bps: number) => (bps > 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${(bps / 1e3).toFixed(0)} kbps`);
const hms = (s: number) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
const mbps = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} Gbps` : `${m.toFixed(1)} Mbps`);

/**
 * Live throughput graph.
 *
 * The stat cards show CUMULATIVE bytes since each session began — that only
 * ever grows, so it can't answer "how much is flowing right now". This turns
 * the running totals into a real rate: (bytes now − bytes last sample) ÷ the
 * seconds between them, ×8 for bits, in Mbps. Two lines — download and upload —
 * over a rolling window. Drops (a session ending) clamp to zero rather than
 * drawing a negative spike.
 */
function LiveTraffic({ hist, T }: { hist: { d: number; u: number }[]; T: NetTheme }) {
  const W = 640, H = 150, P = 8;
  const max = Math.max(1, ...hist.map((p) => Math.max(p.d, p.u)));
  const top = max * 1.2;
  const n = Math.max(hist.length - 1, 1);
  const x = (i: number) => P + (i * (W - P * 2)) / Math.max(n, 1);
  const y = (v: number) => H - P - (v / top) * (H - P * 2);
  const path = (key: "d" | "u") => hist.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const last = hist[hist.length - 1] ?? { d: 0, u: 0 };

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 11, color: T.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Live throughput · all online users</span>
        <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
          <span style={{ color: "#38bdf8", fontWeight: 700 }}>▼ {mbps(last.d)} <span style={{ color: T.muted, fontWeight: 400 }}>down</span></span>
          <span style={{ color: "#f472b6", fontWeight: 700 }}>▲ {mbps(last.u)} <span style={{ color: T.muted, fontWeight: 400 }}>up</span></span>
        </div>
      </div>
      {hist.length < 2 ? (
        <div style={{ height: H, display: "grid", placeItems: "center", color: T.muted, fontSize: 12 }}>Sampling… the line fills in as live data arrives.</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H, display: "block" }}>
          {[0.5, 1].map((f) => (
            <line key={f} x1={P} x2={W - P} y1={y(top * f)} y2={y(top * f)} stroke="currentColor" strokeOpacity="0.08" strokeDasharray="3 5" />
          ))}
          <path d={`${path("d")} L${x(n)},${H - P} L${x(0)},${H - P} Z`} fill="#38bdf8" fillOpacity="0.10" />
          <path d={path("d")} fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={path("u")} fill="none" stroke="#f472b6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </div>
  );
}

/** One live session row — exactly the shape the backend /network/live returns. */
interface SessionRow {
  username: string;
  subscriberId: number | null;
  fullName: string | null;
  phone: string | null;
  package: string | null;
  nasIp: string;
  framedIp: string;
  mac: string;
  startTime: string;
  durationSeconds: number;
  uploadBytes: number;
  downloadBytes: number;
  rateBps: number;
}

/** Stat cards — /network/live/stats. BIGINT values arrive as strings. */
interface NetStats {
  online: number;
  knownSubscribers: number;
  totalDownloadBytes: string | number;
  totalUploadBytes: string | number;
}

/** MAC-binding modal payload — GET /network/mac/:username. */
interface MacBinding { boundMacs?: string[] }

/** DataTable column key → backend sortBy whitelist key (see ActiveSessionsOpts). */
const SORT_FIELDS: Record<string, string> = {
  username: "username",
  ip: "framedIp",
  mac: "mac",
  nas: "nasIp",
  uptime: "durationSeconds",
  rate: "rateBps",
};

export default function NetworkPage() {
  const router = useRouter();
  const [stats, setStats] = useState<NetStats | null>(null);
  const [auto, setAuto] = useState(true);
  const [msg, setMsg] = useState("");
  const [macFor, setMacFor] = useState<SessionRow | null>(null);
  const [macBinding, setMacBinding] = useState<MacBinding | null>(null);
  const [macInput, setMacInput] = useState("");
  const [rateHist, setRateHist] = useState<{ d: number; u: number }[]>([]);
  const prevSample = useRef<{ d: number; u: number; t: number } | null>(null);
  /** Bumped to re-fetch the CURRENT page only (5s Live, manual, post-action). */
  const [listToken, setListToken] = useState(0);
  /** NAS device filter — "" means every router. Fed from /nas (id → nasIp). */
  const [nasFilter, setNasFilter] = useState("");
  const [nasList, setNasList] = useState<{ id: number; nasname: string; nasIp: string }[]>([]);

  // Stable identity: changes only when the NAS filter VALUE changes, so the
  // DataTable's fetch effect isn't re-triggered by unrelated re-renders
  // (the 5s stat tick, toasts, modals).
  const tableFilters = useMemo(() => ({ nasIp: nasFilter }), [nasFilter]);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  // Memoized so get/loadStats stay referentially stable — otherwise every
  // render would recreate the fetch chain and re-run the mount effect.
  const headers = useCallback(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  const get = useCallback(async (path: string) => {
    const r = await fetch(`${API}${path}`, { headers: headers() });
    if (r.status === 401) { router.push("/login"); throw new Error("unauthorized"); }
    return r.json();
  }, [router, headers]);

  /** Stats + the throughput graph only. The LIST is paged server-side by the
   *  DataTable (fetchPage); the browser never holds the full session set. */
  const loadStats = useCallback(async () => {
    try {
      const st = await get("/network/live/stats");
      setStats(st);

      // Turn cumulative byte totals into a live rate: delta bytes ÷ delta time.
      // BIGINT arrives as a string, so coerce before subtracting.
      const d = Number(st?.totalDownloadBytes || 0);
      const u = Number(st?.totalUploadBytes || 0);
      const now = Date.now();
      const prev = prevSample.current;
      if (prev) {
        const dt = (now - prev.t) / 1000;
        if (dt > 0.5) {
          const down = Math.max(0, ((d - prev.d) * 8) / 1e6 / dt); // Mbps
          const up = Math.max(0, ((u - prev.u) * 8) / 1e6 / dt);
          setRateHist((h) => [...h, { d: down, u: up }].slice(-40));
        }
      }
      prevSample.current = { d, u, t: now };
    } catch {}
  }, [get]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    // Initial load: both fetches land their state AFTER await, so nothing is
    // set synchronously during this effect's own execution — no render cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadStats();
    get("/nas").then((d) => {
      const list = Array.isArray(d) ? d : d?.data ?? [];
      setNasList(list.map((n: { id: number; nasname: string; nasIp: string }) => ({ id: n.id, nasname: n.nasname, nasIp: n.nasIp }))
        .filter((n: { nasIp: string }) => n.nasIp));
    }).catch(() => {});
  }, [token, router, get, loadStats]);

  // 5s Live: refetch the CURRENT page (token bump) + the stat cards. The
  // DataTable's own stale-response guard means an older page response can
  // never overwrite a newer one.
  useEffect(() => {
    if (auto) {
      const iv = setInterval(() => { loadStats(); setListToken((t) => t + 1); }, 5000);
      return () => clearInterval(iv);
    }
  }, [auto, loadStats]);

  /** Server-mode list fetcher — the DataTable contract. Filters/sort/search
   *  ride along as query params; nasIp is the device filter. */
  const fetchPage = useCallback(async (p: DataTableFetchParams): Promise<DataTableFetchResult<SessionRow>> => {
    const qs = new URLSearchParams({ page: String(p.page), limit: String(p.pageSize) });
    const f = p.filters ?? {};
    if (p.search.trim()) qs.set("q", p.search.trim());
    if (f.nasIp) qs.set("nasIp", String(f.nasIp));
    if (p.sort) {
      const field = SORT_FIELDS[p.sort.key];
      if (field) {
        qs.set("sortBy", field);
        qs.set("sortOrder", p.sort.dir);
      }
    }
    const res = await fetch(`${API}/network/live?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: p.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items: SessionRow[] = Array.isArray(data.items) ? data.items : [];
    return { items, total: Number(data.total) || 0, page: p.page, pageSize: p.pageSize };
  }, [token]);

  const bump = () => setListToken((t) => t + 1);

  async function disconnect(username: string) {
    if (!confirm(`Disconnect ${username}? They'll be dropped from the network.`)) return;
    const r = await fetch(`${API}/network/disconnect/${username}`, { method: "POST", headers: headers() });
    const data = await r.json();
    setMsg(data?.disconnected ? `Disconnected ${username} (${data.method})` : data?.message || "Failed");
    loadStats();
    bump();
  }

  async function changeSpeed(s: SessionRow) {
    if (!s.subscriberId) { setMsg("This session isn't linked to a subscriber."); return; }
    const dl = prompt(`New DOWNLOAD speed (Mbps) for ${s.username}:`, "10");
    if (dl === null) return;
    const ul = prompt(`New UPLOAD speed (Mbps) for ${s.username}:`, "10");
    if (ul === null) return;
    const d = Number(dl), u = Number(ul);
    if (!(d > 0) || !(u > 0)) { setMsg("Enter valid speeds in Mbps."); return; }
    try {
      const r = await fetch(`${API}/network/bandwidth/${s.subscriberId}`, {
        method: "POST", headers: headers(), body: JSON.stringify({ downloadSpeed: d, uploadSpeed: u }),
      });
      const data = await r.json();
      setMsg(data?.message || (r.ok ? "Speed updated" : "Speed change failed"));
      bump();
    } catch { setMsg("Speed change failed"); }
  }

  const [syncing, setSyncing] = useState(false);
  async function syncSessions() {
    setSyncing(true);
    setMsg("Checking routers…");
    try {
      const r = await fetch(`${API}/subscribers/integrity/sessions`, { headers: headers() });
      const d = await r.json();
      if (!r.ok) { setMsg(d?.message || "Sync failed"); return; }
      setMsg(
        `Synced ${d.routers} router(s): closed ${d.closed} ghost session(s)` +
        (d.skipped ? `, skipped ${d.skipped} unreachable` : "") + ".",
      );
      loadStats();
      bump();
    } catch { setMsg("Sync failed — check router API credentials"); }
    finally { setSyncing(false); }
  }

  async function openMac(s: SessionRow) {
    setMacFor(s);
    setMacInput(s.mac || "");
    setMacBinding(await get(`/network/mac/${s.username}`));
  }
  async function bindMac() {
    if (!macFor) return;
    const r = await fetch(`${API}/network/mac/${macFor.username}`, { method: "POST", headers: headers(), body: JSON.stringify({ mac: macInput }) });
    const data = await r.json();
    if (data?.bound) { setMacBinding(await get(`/network/mac/${macFor.username}`)); setMsg("MAC bound"); }
    else setMsg(data?.message || "Failed");
  }
  async function autolearn() {
    if (!macFor) return;
    const r = await fetch(`${API}/network/mac/${macFor.username}/autolearn`, { method: "POST", headers: headers() });
    const data = await r.json();
    if (data?.bound) { setMacBinding(await get(`/network/mac/${macFor.username}`)); setMsg("MAC learned from live session"); }
    else setMsg(data?.message || "Failed");
  }
  async function unbind(mac: string) {
    if (!macFor) return;
    await fetch(`${API}/network/mac/${macFor.username}?mac=${encodeURIComponent(mac)}`, { method: "DELETE", headers: headers() });
    setMacBinding(await get(`/network/mac/${macFor.username}`));
  }

  const columns: DtColumn<SessionRow>[] = [
    {
      key: "subscriber",
      header: "Subscriber",
      width: 200,
      render: (s) => (
        <>
          <span style={{ fontWeight: 700 }}>{s.fullName || <span style={{ color: T.muted }}>unknown</span>}</span>
          <div style={{ fontSize: 11, color: T.muted }}>{s.package || ""}</div>
        </>
      ),
    },
    {
      key: "username",
      header: "Username",
      sortable: true,
      render: (s) => <span style={{ color: T.sub }}>{s.username}</span>,
    },
    {
      key: "ip",
      header: "IP",
      sortable: true,
      render: (s) => <span style={{ color: T.sub }}>{s.framedIp || "—"}</span>,
    },
    {
      key: "mac",
      header: "MAC",
      sortable: true,
      render: (s) => <span style={{ color: T.sub, fontSize: 11 }}>{s.mac || "—"}</span>,
    },
    {
      key: "nas",
      header: "NAS",
      defaultHidden: true,
      sortable: true,
      render: (s) => <code style={{ fontSize: 11 }}>{s.nasIp}</code>,
    },
    {
      key: "uptime",
      header: "Uptime",
      sortable: true,
      sortValue: (s) => s.durationSeconds,
      render: (s) => hms(s.durationSeconds),
    },
    {
      key: "traffic",
      header: "↓ / ↑",
      align: "right",
      sortValue: (s) => s.downloadBytes + s.uploadBytes,
      render: (s) => (
        <span style={{ fontSize: 12, whiteSpace: "nowrap" }}>{gb(s.downloadBytes)} / {gb(s.uploadBytes)}</span>
      ),
    },
    {
      key: "rate",
      header: "Rate",
      align: "right",
      sortable: true,
      sortValue: (s) => s.rateBps,
      render: (s) => <span style={{ color: T.green }}>{rate(s.rateBps)}</span>,
    },
    {
      key: "actions",
      header: "",
      exportable: false,
      width: 210,
      render: (s) => (
        <span style={{ display: "inline-flex", gap: 6, whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
          {s.subscriberId && (
            <button
              title="Manage MAC bindings for this user"
              onClick={() => openMac(s)}
              style={{ ...btn(T.card), border: `1px solid ${T.border}`, color: T.sub }}
            >MAC</button>
          )}
          {s.subscriberId && (
            <button
              title="Change this customer's speed live via RADIUS CoA (no reconnect)"
              onClick={() => changeSpeed(s)}
              style={{ ...btn(T.card), border: `1px solid ${T.border}`, color: T.sub }}
            >Speed</button>
          )}
          <button style={btn(T.red)} onClick={() => disconnect(s.username)}>Disconnect</button>
        </span>
      ),
    },
  ];

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 };
  const input: React.CSSProperties = { background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px", color: T.text, fontSize: 13 };
  const btn = (bg: string): React.CSSProperties => ({ background: bg, color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" });

  return (
    <div style={{ padding: "10px 20px 20px", color: T.text }}>
      {/* One compact control strip instead of a full-height band: the
          auto-refresh toggle and manual refresh sit inline as a single pill so
          the online stats below rise into view. */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        {msg && <span style={{ fontSize: 12, color: T.accent, cursor: "pointer", marginRight: "auto" }} onClick={() => setMsg("")}>{msg} ✕</span>}
        <select
          value={nasFilter}
          onChange={(e) => setNasFilter(e.target.value)}
          title="Show sessions from one router only"
          style={{ ...input, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}
        >
          <option value="">All routers</option>
          {nasList.map((n) => <option key={n.id} value={n.nasIp}>{n.nasname}</option>)}
        </select>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 2, background: T.card, border: `1px solid ${T.border}`, borderRadius: 999, padding: 3 }}>
          <button
            onClick={() => setAuto(!auto)}
            title={auto ? "Auto-refresh every 5 seconds — on" : "Auto-refresh off"}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "none", cursor: "pointer", borderRadius: 999, padding: "5px 11px", fontSize: 12, fontWeight: 600, background: auto ? "var(--g-primary,#6C3CE1)" : "transparent", color: auto ? "#fff" : T.sub }}
          >
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: auto ? "#6EE7B7" : T.sub, boxShadow: auto ? "0 0 6px #6EE7B7" : "none" }} />
            Live 5s
          </button>
          <button style={{ border: "none", background: "transparent", color: T.sub, cursor: "pointer", borderRadius: 999, padding: "5px 11px", fontSize: 12, fontWeight: 600 }} onClick={() => { loadStats(); bump(); }}>Refresh</button>
        </div>
        <button
          onClick={syncSessions}
          disabled={syncing}
          title="Ask the routers who is really connected and close any ghost sessions the panel still shows as online"
          style={{ border: `1px solid ${T.border}`, background: T.card, color: T.sub, cursor: syncing ? "default" : "pointer", borderRadius: 999, padding: "5px 12px", fontSize: 12, fontWeight: 600, opacity: syncing ? 0.6 : 1 }}
        >
          {syncing ? "Syncing…" : "⟳ Sync sessions"}
        </button>
      </div>

      <LiveTraffic hist={rateHist} T={T} />

      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
          {[
            ["Online now", stats.online, T.green],
            ["Known subscribers", stats.knownSubscribers, T.accent],
            // BIGINT totals arrive as strings (JSON-safe); coerce for display.
            ["Total download", gb(Number(stats.totalDownloadBytes)), T.text],
            ["Total upload", gb(Number(stats.totalUploadBytes)), T.text],
          ].map(([label, val, color]) => (
            <div key={label as string} style={card}>
              <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase" }}>{label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: color as string }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Active sessions — SERVER MODE: one page at a time from /network/live.
          The 5-second Live toggle above only refetches the current page. */}
      <DataTable
        columns={columns}
        rowKey={(s) => `${s.username}::${s.nasIp}::${s.framedIp}::${s.startTime}`}
        fetchPage={fetchPage}
        filters={tableFilters}
        refreshToken={listToken}
        searchable
        searchPlaceholder="Search username, IP, MAC or NAS…"
        storageKey="jb_netlive"
        defaultPageSize={50}
        pageSizes={[25, 50, 100]}
        exportName="live-sessions"
        emptySlot={
          <>
            <b>No active sessions right now.</b>
            <span>Sessions appear here when subscribers are online via RADIUS. If the routers are up and the people are connected, check RADIUS accounting (logs → RADIUS diagnostics).</span>
          </>
        }
      />

      {macFor && (
        <Portal><div style={{ position: "fixed", inset: 0, background: "#000a", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000 }} onClick={() => setMacFor(null)}>
          <div style={{ ...card, width: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>MAC binding — {macFor.username}</h3>
            <div style={{ fontSize: 12, color: T.muted, marginBottom: 10 }}>Bound MACs restrict this user to only authenticate from those devices.</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input style={{ ...input, flex: 1 }} placeholder="AA:BB:CC:DD:EE:FF" value={macInput} onChange={(e) => setMacInput(e.target.value)} />
              <button style={btn(T.accent)} onClick={bindMac}>Bind</button>
              <button style={btn(T.green)} onClick={autolearn} title="Bind the MAC from the current live session">Auto-learn</button>
            </div>
            {macBinding?.boundMacs?.length ? macBinding.boundMacs.map((m: string) => (
              <div key={m} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${T.border}`, fontSize: 13 }}>
                <span style={{ fontFamily: "monospace" }}>{m}</span>
                <button style={btn(T.red)} onClick={() => unbind(m)}>Remove</button>
              </div>
            )) : <div style={{ fontSize: 12, color: T.muted }}>No MAC bound — user can connect from any device.</div>}
          </div>
        </div></Portal>
      )}
    </div>
  );
}