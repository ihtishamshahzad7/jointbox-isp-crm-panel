"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { NovaArea, NovaBars, NovaDonut, dailySeries } from "../components/nova-charts";
import useSWR from "swr";
import { money, currencySymbol } from "../components/currency";
import { useSSE } from "../components/use-sse";
import OverviewCharts from "./overview-charts";
import API_BASE from "../components/api";
import Portal from "../components/portal";
import { BRAND } from "../../lib/brand";

type SubscriberStatus = "ACTIVE" | "INACTIVE" | "EXPIRED" | "SUSPENDED" | string;
type InvoiceStatus = "PAID" | "UNPAID" | "PARTIAL" | "OVERDUE" | "CANCELLED" | string;

type Subscriber = {
  id: number;
  fullName: string;
  phone?: string | null;
  email?: string | null;
  username?: string | null;
  status: SubscriberStatus;
  package?: { id: number; name: string } | null;
  packageId?: number | null;
  area?: { id: number; name: string } | null;
  createdAt?: string;
  installationDate?: string | null;
  expiryDate?: string | null;
  expirationDate?: string | null;
  expiresAt?: string | null;
};

type Invoice = {
  id: number;
  invoiceNo?: string;
  amount?: number;
  total?: number;
  paidAmount?: number;
  dueAmount?: number;
  dueDate?: string;
  status: InvoiceStatus;
  createdAt?: string;
  subscriber?: { id: number; fullName: string };
};

type Payment = {
  id: number;
  paymentNo?: string;
  amount: number;
  method?: string;
  paymentDate?: string;
  createdAt?: string;
  invoice?: { id: number; invoiceNo?: string; status?: string };
  subscriber?: { id: number; fullName: string };
};

type User = {
  id: number;
  name: string;
  email: string;
  role?: string;
  isActive?: boolean;
  lastLoginAt?: string | null;
  updatedAt?: string;
  createdAt?: string;
};

type NasDevice = {
  id: number;
  nasname?: string;
  isActive?: boolean;
};

type DashboardTab = "home" | "reports" | "subscribers" | "accounting" | "users" | "expiring";

const API = API_BASE;

const sectionTabs: Array<{ id: DashboardTab; label: string; caption: string }> = [
  { id: "home", label: "Home", caption: "Overview" },
  { id: "reports", label: "Reports", caption: "Statistics" },
  { id: "subscribers", label: "Subscribers", caption: "Details" },
  { id: "accounting", label: "Accounting", caption: "Billing" },
  { id: "users", label: "Users", caption: "Management" },
  { id: "expiring", label: "Expiring", caption: "Renewals" },
];

function toCurrency(n: number): string {
  // Uses the operator's configured currency — never a hard-coded symbol.
  return money(Math.round(n || 0));
}

function toDate(v?: string | null): string {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString();
}

function toDateTime(v?: string | null): string {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function startOfDay(dt: Date): Date {
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, 0, 0, 0);
}

function statusStyle(status: string): React.CSSProperties {
  const s = status.toUpperCase();
  if (s === "ACTIVE" || s === "PAID") return { color: "#4ade80", background: "rgba(34,197,94,0.18)" };
  if (s === "SUSPENDED" || s === "PARTIAL") return { color: "#fbbf24", background: "rgba(245,158,11,0.2)" };
  if (s === "EXPIRED" || s === "OVERDUE") return { color: "#f97316", background: "rgba(249,115,22,0.2)" };
  if (s === "INACTIVE" || s === "UNPAID" || s === "CANCELLED") return { color: "#f87171", background: "rgba(239,68,68,0.2)" };
  return { color: "#93c5fd", background: "rgba(14,165,233,0.15)" };
}

function extractArray<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.data)) return p.data as T[];
    if (Array.isArray(p.items)) return p.items as T[];
  }
  return [];
}

function csvDownload(filename: string, rows: Record<string, string | number | null | undefined>[]) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const lines = [keys.join(",")];
  for (const row of rows) {
    const vals = keys.map((k) => {
      const v = row[k] ?? "";
      const s = String(v).replaceAll('"', '""');
      return `"${s}"`;
    });
    lines.push(vals.join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function simplePdfPrint(title: string, rows: Record<string, string | number | null | undefined>[]) {
  const htmlRows = rows
    .map((r) => `<tr>${Object.values(r).map((v) => `<td style=\"padding:8px;border:1px solid #ddd\">${String(v ?? "")}</td>`).join("")}</tr>`)
    .join("");
  const head = rows[0] ? `<tr>${Object.keys(rows[0]).map((h) => `<th style=\"padding:8px;border:1px solid #ddd;background:#f5f5f5\">${h}</th>`).join("")}</tr>` : "";
  const w = window.open("", "_blank", "width=980,height=720");
  if (!w) return;
  w.document.write(`<html><head><title>${title}</title></head><body><h2>${title}</h2><table style=\"border-collapse:collapse;width:100%\">${head}${htmlRows}</table></body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

/** Nova: alternating purple→cyan gradient bars that grow in with a stagger. */
function SparkBars({ values }: { values: number[]; color?: string }) {
  const max = Math.max(1, ...values);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 120 }}>
      <style>{`
        @keyframes nvGrow { from { transform: scaleY(0); } }
        .nv-bar { transform-origin: bottom; animation: nvGrow .7s cubic-bezier(.2,.8,.2,1) both;
          transition: filter .2s, transform .2s; cursor: default; }
        .nv-bar:hover { filter: brightness(1.3) saturate(1.2); transform: scaleY(1.03); }
      `}</style>
      {values.map((v, idx) => (
        <div key={idx} className="nv-bar" style={{
          flex: 1,
          height: `${Math.max(6, (v / max) * 100)}%`,
          borderRadius: "8px 8px 4px 4px",
          background: idx % 2 === 0
            ? "linear-gradient(180deg,#6C3CE1,#00C9FF)"
            : "linear-gradient(180deg,#E9408B,#6C3CE1)",
          animationDelay: `${idx * 0.06}s`,
        }} />
      ))}
    </div>
  );
}

function LineChartMini({ values, stroke = "#10B981" }: { values: number[]; stroke?: string }) {
  const w = 380;
  const h = 120;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values
    .map((v, i) => {
      const x = i * step;
      const y = h - (v / max) * (h - 10) - 5;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="130" style={{ background: "rgba(255,255,255,0.02)", borderRadius: 12 }}>
      <defs>
        {/* Nova: the line is a gradient stroke with a soft area fill under it. */}
        <linearGradient id="nvLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#6C3CE1" /><stop offset="55%" stopColor="#E9408B" /><stop offset="100%" stopColor="#F27121" />
        </linearGradient>
        <linearGradient id="nvFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(140,90,255,.28)" /><stop offset="100%" stopColor="rgba(140,90,255,0)" />
        </linearGradient>
      </defs>
      <polygon fill="url(#nvFill)" points={`0,${h} ${pts} ${w},${h}`} />
      <polyline fill="none" stroke="url(#nvLine)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" points={pts} />
      {values.map((v, i) => {
        const x = i * step;
        const y = h - (v / max) * (h - 10) - 5;
        return <circle key={i} cx={x} cy={y} r="3.4" fill="#E9408B" stroke="rgba(255,255,255,.85)" strokeWidth="1.2" />;
      })}
    </svg>
  );
}

function DonutBreakdown({ data }: { data: Array<{ label: string; value: number; color: string }> }) {
  const total = data.reduce((a, b) => a + b.value, 0) || 1;
  const r = 52;
  const c = 2 * Math.PI * r;
  let acc = 0;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
      <svg width="160" height="160" viewBox="0 0 160 160" style={{ overflow: "visible" }}>
        <defs>
          {/* Nova gradient segments — each slice picks one of the four families. */}
          <linearGradient id="nvDg0" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#6C3CE1" /><stop offset="100%" stopColor="#E9408B" /></linearGradient>
          <linearGradient id="nvDg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#00C9FF" /><stop offset="100%" stopColor="#92FE9D" /></linearGradient>
          <linearGradient id="nvDg2" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#F7971E" /><stop offset="100%" stopColor="#FFD200" /></linearGradient>
          <linearGradient id="nvDg3" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#E9408B" /><stop offset="100%" stopColor="#F27121" /></linearGradient>
        </defs>
        <style>{`
          .nv-seg { animation: nvSweep 1s .2s cubic-bezier(.2,.8,.2,1) both;
            transition: stroke-width .22s, filter .22s; cursor: default; }
          .nv-seg:hover { stroke-width: 23; filter: brightness(1.25) drop-shadow(0 0 8px rgba(233,64,139,.5)); }
          @keyframes nvSweep { from { stroke-dashoffset: ${c}; } }
        `}</style>
        <g transform="translate(80,80)">
          <circle cx="0" cy="0" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="18" />
          {data.map((d, i) => {
            const frac = d.value / total;
            const len = c * frac;
            const node = (
              <circle
                key={i}
                className="nv-seg"
                cx="0"
                cy="0"
                r={r}
                fill="none"
                stroke={`url(#nvDg${i % 4})`}
                strokeWidth="18"
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-acc}
                transform="rotate(-90)"
              />
            );
            acc += len;
            return node;
          })}
          <text x="0" y="4" textAnchor="middle" fill="var(--text)" fontSize="16" fontWeight="800">{total}</text>
        </g>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 180 }}>
        {data.map((d, i) => {
          // Swatches mirror the gradient family of their slice, not the old flat colour.
          const grads = [
            "linear-gradient(135deg,#6C3CE1,#E9408B)",
            "linear-gradient(135deg,#00C9FF,#92FE9D)",
            "linear-gradient(135deg,#F7971E,#FFD200)",
            "linear-gradient(135deg,#E9408B,#F27121)",
          ];
          return (
            <div key={d.label} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
              <span style={{ color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: grads[i % 4], display: "inline-block" }} />
                {d.label}
              </span>
              <b style={{ color: "var(--text)" }}>{d.value}</b>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();

  const [mounted, setMounted] = useState(false);
  // Mobile detection — inline styles beat CSS media queries, so multi-column
  // grids are collapsed to one column in JS on narrow screens. `cols(desktop)`
  // returns "1fr" on phones so nothing is squeezed.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  const cols = (desktop: string) => (isMobile ? "1fr" : desktop);
  const fmtUptime = (secs?: number) => {
    if (!secs || secs <= 0) return "—";
    const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  };
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState<DashboardTab>("home");
  const [busyAction, setBusyAction] = useState<string>("");
  const [toast, setToast] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

  const [rangeStart, setRangeStart] = useState<string>("");
  const [rangeEnd, setRangeEnd] = useState<string>("");

  const [subscriberQ, setSubscriberQ] = useState("");
  const [subscriberStatus, setSubscriberStatus] = useState("ALL");
  const [subscriberPage, setSubscriberPage] = useState(1);
  const [perPage, setPerPage] = useState(10);
  const [selectedSubscriber, setSelectedSubscriber] = useState<Subscriber | null>(null);

  const [invoiceStatus, setInvoiceStatus] = useState("ALL");
  const [paymentMethod, setPaymentMethod] = useState("ALL");

  const [showInvoiceQuick, setShowInvoiceQuick] = useState(false);
  const [quickInvoice, setQuickInvoice] = useState({ subscriberId: "", amount: "", dueDate: "", notes: "" });

  const [showUserForm, setShowUserForm] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [userForm, setUserForm] = useState({ name: "", email: "", password: "", role: "ADMIN" });

  const [token, setToken] = useState("");
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  useEffect(() => {
    setMounted(true);
    setToken(localStorage.getItem("token") || "");
    setRangeStart(new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 10));
    setRangeEnd(new Date().toISOString().slice(0, 10));
  }, []);

  const swrFetcher = async <T,>(url: string): Promise<T[]> => {
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    return extractArray<T>(data);
  };

  // Scoped headline counts (server-computed per login account, cached 30s):
  // total / active / expired / expiring / onlineNow / offline / todaySignups.
  // This is the authoritative source for the KPI row — the raw /subscribers
  // list is capped, so counting from it silently under-reports on larger bases.
  type SubscriberOverview = {
    total?: number; active?: number; inactive?: number; suspended?: number;
    expired?: number; expiring?: number; onlineNow?: number; stale?: number;
    offline?: number; todaySignups?: number;
    // Cumulative renewal windows (1d ⊂ 3d ⊂ 1w ⊂ 2w) — a short window is a
    // call list, a long one is a forecast.
    expiring1d?: number; expiring3d?: number; expiring1w?: number; expiring2w?: number;
    // Connected with no active subscription: unbilled usage.
    expiredOnline?: number;
    pppoe?: number; hotspot?: number;
  };
  const overviewFetcher = async (url: string): Promise<SubscriberOverview | null> => {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return (await res.json()) as SubscriberOverview;
  };

  // Server CPU/RAM (ISP roles only — the endpoint returns visible:false for
  // resellers, and the UI then hides the two cards).
  type SystemStats = {
    visible?: boolean;
    cpu?: number;
    ramPct?: number;
    ramUsedGb?: number;
    ramTotalGb?: number;
    uptimeSecs?: number;
  };
  const systemFetcher = async (url: string): Promise<SystemStats | null> => {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return (await res.json()) as SystemStats;
  };

  const subscribersKey = mounted && token ? `${API}/subscribers` : null;
  const invoicesKey = mounted && token ? `${API}/invoices` : null;
  const paymentsKey = mounted && token ? `${API}/payments` : null;
  const usersKey = mounted && token ? `${API}/users` : null;
  const nasKey = mounted && token ? `${API}/nas` : null;
  const overviewKey = mounted && token ? `${API}/subscribers/overview` : null;
  const systemKey = mounted && token ? `${API}/system/stats` : null;

  const { data: subscribersData, isLoading: subLoading, mutate: mutateSubscribers } = useSWR<Subscriber[]>(subscribersKey, swrFetcher, { refreshInterval: 30000, revalidateOnFocus: true });
  const { data: invoicesData, isLoading: invLoading, mutate: mutateInvoices } = useSWR<Invoice[]>(invoicesKey, swrFetcher, { refreshInterval: 30000, revalidateOnFocus: true });
  const { data: paymentsData, isLoading: payLoading, mutate: mutatePayments } = useSWR<Payment[]>(paymentsKey, swrFetcher, { refreshInterval: 30000, revalidateOnFocus: true });
  const { data: usersData, isLoading: usrLoading, mutate: mutateUsers } = useSWR<User[]>(usersKey, swrFetcher, { refreshInterval: 30000, revalidateOnFocus: true });
  const { data: nasData, isLoading: nasLoading, mutate: mutateNas } = useSWR<NasDevice[]>(nasKey, swrFetcher, { refreshInterval: 30000, revalidateOnFocus: true });
  const { data: overviewData, isLoading: ovLoading, mutate: mutateOverview } = useSWR<SubscriberOverview | null>(overviewKey, overviewFetcher, { refreshInterval: 60000, revalidateOnFocus: true });
  const { data: sysData, isLoading: sysLoading, mutate: mutateSystem } = useSWR<SystemStats | null>(systemKey, systemFetcher, { refreshInterval: 30000, revalidateOnFocus: true });

  // ── Real-time SSE — instantly revalidate SWR caches on backend events ──
  useSSE({
    onEvent: (type) => {
      if (type === 'payment') {
        // A payment was recorded — refresh payments + invoices to update KPIs
        mutatePayments();
        mutateInvoices();
      }
    },
  });

  const subscribers = subscribersData || [];
  const invoices = invoicesData || [];
  const payments = paymentsData || [];
  const users = usersData || [];
  const nas = nasData || [];
  const loading = subLoading || invLoading || payLoading || usrLoading || nasLoading || ovLoading || sysLoading;
  const systemStats = sysData && sysData.visible ? (sysData as SystemStats) : null;

  const systemStatus = useMemo(
    () => ({
      radius: subscribers.length > 0,
      nas: nas.length > 0,
      db: subscribers.length + invoices.length + users.length > 0,
    }),
    [subscribers.length, nas.length, invoices.length, users.length]
  );

  const notify = (msg: string, type: "ok" | "err" = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3200);
  };

  const refreshAll = async () => {
    await Promise.all([mutateSubscribers(), mutateInvoices(), mutatePayments(), mutateUsers(), mutateNas(), mutateOverview(), mutateSystem()]);
    setRefreshKey((k) => k + 1);
  };

  useEffect(() => {
    if (!mounted) {
      return;
    }
    if (!token) {
      router.replace("/login");
    }
  }, [mounted, token, router]);

  const today = startOfDay(new Date());

  const homeStats = useMemo(() => {
    // Headline counts come from the scoped server-side overview when loaded —
    // they are exact for THIS login account even when the subscriber list is
    // paginated/capped. Fall back to the client-side list while loading.
    const totalSubscribers = overviewData?.total ?? subscribers.length;
    const activeSubscribers = overviewData?.active ?? subscribers.filter((s) => String(s.status).toUpperCase() === "ACTIVE").length;
    const todaySignups = overviewData?.todaySignups ?? subscribers.filter((s) => s.createdAt && new Date(s.createdAt) >= today).length;
    const onlineNow = overviewData?.onlineNow ?? subscribers.filter((s) => (s as any).liveStatus === "ONLINE").length;
    const expired = overviewData?.expired ?? subscribers.filter((s) => String(s.status).toUpperCase() === "EXPIRED").length;
    const expiringSoon = overviewData?.expiring ?? subscribers.filter((s) => {
      const raw = s.expiryDate || s.expirationDate || s.expiresAt;
      if (!raw) return false;
      const dt = new Date(raw).getTime();
      return dt >= today.getTime() && dt <= today.getTime() + 7 * 86400_000;
    }).length;
    // Renewal windows. Only the server can count these accurately (the list is
    // paginated), so they show as null rather than a wrong number when the
    // overview has not loaded — a fabricated collections figure is worse than
    // no figure.
    const expiring1d = overviewData?.expiring1d ?? null;
    const expiring3d = overviewData?.expiring3d ?? null;
    const expiring2w = overviewData?.expiring2w ?? null;
    // Connected but not ACTIVE — service being given away right now.
    const expiredOnline = overviewData?.expiredOnline ?? null;
    const totalNas = nas.length;
    const revenueToday = payments
      .filter((p) => {
        const dt = p.paymentDate || p.createdAt;
        return dt ? new Date(dt) >= today : false;
      })
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    return {
      totalSubscribers, activeSubscribers, todaySignups, revenueToday, onlineNow,
      expired, expiringSoon, totalNas,
      expiring1d, expiring3d, expiring2w, expiredOnline,
    };
  }, [subscribers, payments, overviewData, nas.length]);

  const activityFeed = useMemo(() => {
    const acts: Array<{ at: Date; text: string; type: string }> = [];
    subscribers.slice(0, 25).forEach((s) => {
      if (s.createdAt) acts.push({ at: new Date(s.createdAt), text: `New subscriber: ${s.fullName}`, type: "subscriber" });
    });
    payments.slice(0, 25).forEach((p) => {
      const at = p.paymentDate || p.createdAt;
      if (at) acts.push({ at: new Date(at), text: `Payment received: ${toCurrency(p.amount)}${p.subscriber?.fullName ? ` (${p.subscriber.fullName})` : ""}`, type: "payment" });
    });
    invoices.slice(0, 25).forEach((i) => {
      if (i.createdAt) acts.push({ at: new Date(i.createdAt), text: `Invoice generated: ${i.invoiceNo || `#${i.id}`}`, type: "invoice" });
    });
    return acts.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 5);
  }, [subscribers, payments, invoices]);

  const inRangePayments = useMemo(() => {
    const s = new Date(rangeStart + "T00:00:00");
    const e = new Date(rangeEnd + "T23:59:59");
    return payments.filter((p) => {
      const d = p.paymentDate || p.createdAt;
      if (!d) return false;
      const dt = new Date(d);
      return dt >= s && dt <= e;
    });
  }, [payments, rangeStart, rangeEnd]);

  const inRangeSubscribers = useMemo(() => {
    const s = new Date(rangeStart + "T00:00:00");
    const e = new Date(rangeEnd + "T23:59:59");
    return subscribers.filter((p) => {
      if (!p.createdAt) return false;
      const dt = new Date(p.createdAt);
      return dt >= s && dt <= e;
    });
  }, [subscribers, rangeStart, rangeEnd]);

  // Zero-filled across a continuous 14-day axis.
  //
  // These used to bucket only the days that HAD activity, so two payments in a
  // month produced a two-point chart with no dates on it — which is why the
  // charts looked like they held no data. Every day now appears, and a quiet
  // day reads as a quiet day instead of disappearing.
  const reportRevenueSeries = useMemo(
    () => dailySeries(inRangePayments, (p) => p.paymentDate || p.createdAt, (p) => Number(p.amount) || 0, 14),
    [inRangePayments],
  );

  const reportGrowthSeries = useMemo(
    () => dailySeries(inRangeSubscribers, (s) => s.createdAt, () => 1, 14),
    [inRangeSubscribers],
  );

  const packageBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    subscribers.forEach((s) => {
      const k = s.package?.name || "No Package";
      map.set(k, (map.get(k) || 0) + 1);
    });
    return Array.from(map.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }, [subscribers]);

  const paymentBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    payments.forEach((p) => {
      const m = (p.method || "UNKNOWN").replaceAll("_", " ");
      map.set(m, (map.get(m) || 0) + 1);
    });
    return Array.from(map.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }, [payments]);

  const filteredSubscribers = useMemo(() => {
    return subscribers.filter((s) => {
      const q = subscriberQ.trim().toLowerCase();
      const statusOk = subscriberStatus === "ALL" || String(s.status).toUpperCase() === subscriberStatus;
      const qOk =
        !q ||
        s.fullName?.toLowerCase().includes(q) ||
        s.phone?.toLowerCase().includes(q) ||
        s.username?.toLowerCase().includes(q) ||
        s.email?.toLowerCase().includes(q);
      return statusOk && qOk;
    });
  }, [subscribers, subscriberQ, subscriberStatus]);

  const totalPages = Math.max(1, Math.ceil(filteredSubscribers.length / perPage));
  const pagedSubscribers = filteredSubscribers.slice((subscriberPage - 1) * perPage, subscriberPage * perPage);

  useEffect(() => {
    if (subscriberPage > totalPages) setSubscriberPage(totalPages);
  }, [totalPages, subscriberPage]);

  const accountingInvoices = useMemo(() => {
    return invoices.filter((i) => invoiceStatus === "ALL" || String(i.status).toUpperCase() === invoiceStatus);
  }, [invoices, invoiceStatus]);

  const accountingPayments = useMemo(() => {
    return payments.filter((p) => paymentMethod === "ALL" || (p.method || "").toUpperCase() === paymentMethod);
  }, [payments, paymentMethod]);

  const paymentMethodRevenue = useMemo(() => {
    const m = new Map<string, number>();
    payments.forEach((p) => {
      const method = (p.method || "UNKNOWN").replaceAll("_", " ");
      m.set(method, (m.get(method) || 0) + (Number(p.amount) || 0));
    });
    return Array.from(m.entries());
  }, [payments]);

  const expiredGroups = useMemo(() => {
    const now = new Date();

    const withExpiry = subscribers
      .map((s) => {
        const raw = s.expiryDate || s.expirationDate || s.expiresAt;
        if (!raw) return null;
        const dt = new Date(raw);
        if (Number.isNaN(dt.getTime())) return null;
        const diffDays = Math.ceil((dt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        return { ...s, expiry: dt, diffDays };
      })
      .filter(Boolean) as Array<Subscriber & { expiry: Date; diffDays: number }>;

    const pick = (min: number, max: number) => withExpiry.filter((s) => s.diffDays >= min && s.diffDays <= max);

    return {
      expired: withExpiry.filter((s) => s.diffDays < 0),
      d1: pick(0, 1),
      d3: pick(2, 3),
      d7: pick(4, 7),
      d14: pick(8, 14),
      d30: pick(15, 30),
    };
  }, [subscribers]);

  const callSubscriberStatus = async (id: number, status: SubscriberStatus) => {
    setBusyAction(`sub-${id}`);
    try {
      const res = await fetch(`${API}/subscribers/${id}`, { method: "PUT", headers, body: JSON.stringify({ status }) });
      if (!res.ok) throw new Error("failed");
      notify(`Subscriber marked ${status}`, "ok");
      await refreshAll();
    } catch {
      notify("Failed to update subscriber", "err");
    }
    setBusyAction("");
  };

  const deleteSubscriber = async (id: number) => {
    if (!confirm("Delete this subscriber?")) return;
    setBusyAction(`sub-del-${id}`);
    try {
      const res = await fetch(`${API}/subscribers/${id}`, { method: "DELETE", headers });
      if (!res.ok) throw new Error("failed");
      notify("Subscriber deleted", "ok");
      await refreshAll();
    } catch {
      notify("Delete failed", "err");
    }
    setBusyAction("");
  };

  const submitQuickInvoice = async () => {
    if (!quickInvoice.subscriberId || !quickInvoice.amount || !quickInvoice.dueDate) {
      notify("Subscriber, amount and due date are required", "err");
      return;
    }
    setBusyAction("invoice");
    try {
      const payload = {
        subscriberId: Number(quickInvoice.subscriberId),
        amount: Number(quickInvoice.amount),
        total: Number(quickInvoice.amount),
        tax: 0,
        discount: 0,
        dueDate: quickInvoice.dueDate,
        notes: quickInvoice.notes,
      };
      const res = await fetch(`${API}/invoices`, { method: "POST", headers, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error("failed");
      notify("Invoice generated", "ok");
      setShowInvoiceQuick(false);
      setQuickInvoice({ subscriberId: "", amount: "", dueDate: "", notes: "" });
      await refreshAll();
    } catch {
      notify("Failed to generate invoice", "err");
    }
    setBusyAction("");
  };

  const submitUserForm = async () => {
    if (!userForm.name || !userForm.email || (!editingUser && !userForm.password)) {
      notify("Name, email and password are required for new user", "err");
      return;
    }
    setBusyAction("user-form");
    try {
      const payload: Record<string, string> = {
        name: userForm.name,
        email: userForm.email,
        role: userForm.role,
      };
      if (userForm.password) payload.password = userForm.password;

      const url = editingUser ? `${API}/users/${editingUser.id}` : `${API}/users`;
      const method = editingUser ? "PUT" : "POST";
      const res = await fetch(url, { method, headers, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error("failed");
      notify(editingUser ? "User updated" : "User created", "ok");
      setShowUserForm(false);
      setEditingUser(null);
      setUserForm({ name: "", email: "", password: "", role: "ADMIN" });
      await refreshAll();
    } catch {
      notify("Failed to save user", "err");
    }
    setBusyAction("");
  };

  const toggleUser = async (id: number) => {
    setBusyAction(`user-${id}`);
    try {
      const res = await fetch(`${API}/users/${id}/toggle`, { method: "PATCH", headers });
      if (!res.ok) throw new Error("failed");
      await refreshAll();
      notify("User status updated", "ok");
    } catch {
      notify("Failed to toggle user", "err");
    }
    setBusyAction("");
  };

  const cardStyle: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    padding: 18,
    boxShadow: "0 1px 2px rgba(15,23,42,.04)",
  };

  // Nova primary action — gradient fill with glow. The shell's delegated
  // ripple handler picks these up automatically.
  const btnStyle: React.CSSProperties = {
    border: "none",
    background: "var(--g-primary)",
    color: "#fff",
    borderRadius: 12,
    padding: "9px 14px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 5px 18px rgba(233,64,139,0.26)",
    transition: "transform .2s cubic-bezier(.34,1.56,.64,1), box-shadow .2s",
  };

  const ghostBtn: React.CSSProperties = {
    border: "1px solid rgba(255,255,255,0.18)",
    background: "transparent",
    color: "#cbd5e1",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  };

  const tabRailStyle: React.CSSProperties = {
    display: "flex",
    gap: 10,
    padding: 8,
    background: "#FFFFFF",
    border: "1px solid #E2E8F0",
    borderRadius: 12,
    boxShadow: "0 1px 3px rgba(0,0,0,.05)",
    // On phones the section tabs scroll sideways instead of overflowing the page.
    overflowX: "auto",
    maxWidth: "100%",
    flexWrap: "nowrap",
    WebkitOverflowScrolling: "touch",
  };

  const tabButtonStyle = (active: boolean): React.CSSProperties => ({
    minWidth: 138,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 3,
    padding: "10px 14px",
    borderRadius: 10,
    border: active ? "1px solid #3C50E0" : "1px solid #E2E8F0",
    background: active ? "#EEF1FE" : "#F7F9FC",
    color: active ? "#3C50E0" : "#64748B",
    cursor: "pointer",
    textAlign: "left",
    transition: "all 0.18s ease",
  });

  return (
    <div style={{ minHeight: "100%", background: "var(--bg)", color: "var(--text)", padding: isMobile ? 10 : 18, display: "flex", flexDirection: "column", gap: 14 }}>
      {!mounted ? (
        <div style={{ minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: "100%", maxWidth: 420, background: "var(--surface)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 18 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Loading dashboard...</div>
            <div style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
              <div style={{ width: "55%", height: "100%", background: "linear-gradient(90deg,#6C3CE1,#E9408B)" }} />
            </div>
          </div>
        </div>
      ) : (
        <>
      {toast && (
        <div style={{ position: "fixed", right: 20, bottom: 20, zIndex: 1200, background: toast.type === "ok" ? "#14532d" : "#450a0a", color: toast.type === "ok" ? "#4ade80" : "#f87171", border: `1px solid ${toast.type === "ok" ? "#166534" : "#7f1d1d"}`, borderRadius: 10, padding: "10px 14px", fontSize: 12, fontWeight: 700 }}>
          {toast.msg}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "stretch" }}>
        <div className="jb-dash-rail" style={tabRailStyle}>
          {sectionTabs.map((t) => {
            const active = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} style={tabButtonStyle(active)}>
                <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-0.01em", fontStyle: "normal" }}>{t.label}</span>
                <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: "0.01em", color: active ? "#3C50E0" : "#64748B", fontStyle: "normal" }}>{t.caption}</span>
              </button>
            );
          })}
        </div>
        <button onClick={refreshAll} style={{ ...btnStyle, marginLeft: "auto", alignSelf: "center" }}>{loading ? "Refreshing..." : "Refresh Data"}</button>
      </div>

      {tab === "home" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* KPI cards — icon chip, big figure, plain-English caption, trend
              badge and a mini sparkline. Uses only homeStats (already loaded);
              no new data fetch, component or route. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 12 }}>
            {(() => {
              const activePct = homeStats.totalSubscribers ? Math.round((homeStats.activeSubscribers / homeStats.totalSubscribers) * 100) : 0;
              const onlinePct = homeStats.activeSubscribers ? Math.round((homeStats.onlineNow / homeStats.activeSubscribers) * 100) : 0;
              const expiredPct = homeStats.totalSubscribers ? Math.round((homeStats.expired / homeStats.totalSubscribers) * 100) : 0;
              const expiringPct = homeStats.totalSubscribers ? Math.round((homeStats.expiringSoon / homeStats.totalSubscribers) * 100) : 0;
              const sys = systemStats;
              // Lifecycle metrics (online → expired → expiring) are grouped one
              // after another; signups + revenue move to the very end.
              return [
                { icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8", label: "Total subscribers", value: homeStats.totalSubscribers, cap: "All customers on record", grad: "linear-gradient(135deg,#6C3CE1,#E9408B)", glow: "rgba(233,64,139,.30)", scolor: "#8B5CF6", tag: "base", good: true, spark: "0,24 25,20 50,15 75,10 100,6" },
                { icon: "M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4 12 14.01l-3-3", label: "Active subscribers", value: homeStats.activeSubscribers, cap: `${activePct}% of your total base`, grad: "linear-gradient(135deg,#00C9FF,#22c55e)", glow: "rgba(34,197,94,.26)", scolor: "#22c55e", tag: `${activePct}%`, good: activePct >= 70, spark: "0,16 25,18 50,12 75,10 100,13" },
                { icon: "M5 12.55a11 11 0 0 1 14.08 0 M1.42 9a16 16 0 0 1 21.16 0 M8.53 16.11a6 6 0 0 1 6.95 0 M12 20h.01", label: "Online now", value: homeStats.onlineNow, cap: "Users connected right now in your account", grad: "linear-gradient(135deg,#06b6d4,#3b82f6)", glow: "rgba(59,130,246,.28)", scolor: "#38bdf8", tag: `${onlinePct}% of active`, good: homeStats.onlineNow > 0, spark: "0,16 25,10 50,18 75,9 100,15" },
                { icon: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2", label: "Expired", value: homeStats.expired, cap: "Accounts past their expiry date", grad: "linear-gradient(135deg,#f97316,#ef4444)", glow: "rgba(239,68,68,.28)", scolor: "#ef4444", tag: `${expiredPct}% of base`, good: homeStats.expired === 0, spark: "0,14 25,16 50,12 75,15 100,10" },
                // Connected but past expiry: service being given away right now.
                // The nightly integrity job cuts these; this tile is how you
                // know it is working, and shows the leak between runs.
                ...(homeStats.expiredOnline !== null
                  ? [{ icon: "M18.36 6.64A9 9 0 1 1 5.64 6.64 M12 2v10", label: "Expired but online", value: homeStats.expiredOnline, cap: "Connected right now with no active subscription — unbilled usage", grad: "linear-gradient(135deg,#dc2626,#7f1d1d)", glow: "rgba(220,38,38,.30)", scolor: "#ef4444", tag: homeStats.expiredOnline === 0 ? "clean" : "leaking", good: homeStats.expiredOnline === 0, spark: "0,10 25,14 50,11 75,15 100,9" }]
                  : []),
                // Renewal windows, shortest first — a 1-day list is today's
                // phone calls, a 2-week list is a forecast.
                ...(homeStats.expiring1d !== null
                  ? [{ icon: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2", label: "Expiring tomorrow", value: homeStats.expiring1d, cap: "Call these first — service stops within 24 hours", grad: "linear-gradient(135deg,#f97316,#dc2626)", glow: "rgba(249,115,22,.30)", scolor: "#f97316", tag: "call today", good: homeStats.expiring1d === 0, spark: "0,12 25,15 50,11 75,14 100,9" }]
                  : []),
                ...(homeStats.expiring3d !== null
                  ? [{ icon: "M8 2v4 M16 2v4 M3 10h18 M8 14h.01 M12 14h.01 M16 14h.01", label: "Expiring in 3 days", value: homeStats.expiring3d, cap: "This week's collections queue", grad: "linear-gradient(135deg,#f59e0b,#ea580c)", glow: "rgba(245,158,11,.28)", scolor: "#f59e0b", tag: "this week", good: homeStats.expiring3d === 0, spark: "0,13 25,16 50,12 75,15 100,10" }]
                  : []),
                { icon: "M8 2v4 M16 2v4 M3 10h18 M9 16l2 2 4-4", label: "Expiring in 1 week", value: homeStats.expiringSoon, cap: "ACTIVE accounts expiring within 7 days", grad: "linear-gradient(135deg,#fbbf24,#f59e0b)", glow: "rgba(245,158,11,.28)", scolor: "#fbbf24", tag: `${expiringPct}% of base`, good: homeStats.expiringSoon === 0, spark: "0,14 25,18 50,13 75,16 100,11" },
                ...(homeStats.expiring2w !== null
                  ? [{ icon: "M8 2v4 M16 2v4 M3 10h18 M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", label: "Expiring in 2 weeks", value: homeStats.expiring2w, cap: "Renewal forecast — plan capacity and cash", grad: "linear-gradient(135deg,#eab308,#ca8a04)", glow: "rgba(234,179,8,.24)", scolor: "#eab308", tag: "forecast", good: true, spark: "0,16 25,19 50,15 75,17 100,13" }]
                  : []),
                { icon: "M5 3h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M5 14h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z M9 6h.01 M9 15h.01", label: "Total NAS", value: homeStats.totalNas, cap: "Routers visible to your account", grad: "linear-gradient(135deg,#0ea5e9,#6366f1)", glow: "rgba(14,165,233,.28)", scolor: "#0ea5e9", tag: "routers", good: homeStats.totalNas > 0, spark: "0,18 25,14 50,10 75,12 100,8" },
                ...(sys
                  ? [
                      { icon: "M9 9h6v6H9z M9 1v4 M15 1v4 M9 19v4 M15 19v4 M1 9h4 M1 15h4 M19 9h4 M19 15h4", label: "CPU usage", value: `${sys.cpu ?? 0}%`, cap: "Server processor load", grad: "linear-gradient(135deg,#8b5cf6,#6366f1)", glow: "rgba(99,102,241,.28)", scolor: "#8b5cf6", tag: (sys.cpu ?? 0) < 60 ? "healthy" : "busy", good: (sys.cpu ?? 0) < 60, spark: "0,16 25,18 50,15 75,17 100,14" },
                      { icon: "M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z M9 10h6v4H9z M2 10v4 M22 10v4", label: "RAM usage", value: `${sys.ramPct ?? 0}%`, cap: sys.ramTotalGb ? `${sys.ramUsedGb ?? 0} / ${sys.ramTotalGb} GB used` : "Server memory load", grad: "linear-gradient(135deg,#f59e0b,#f97316)", glow: "rgba(249,115,22,.28)", scolor: "#f59e0b", tag: "server", good: (sys.ramPct ?? 0) < 80, spark: "0,15 25,17 50,13 75,15 100,12" },
                    ]
                  : []),
                { icon: "M23 6l-9.5 9.5-5-5L1 18 M17 6h6v6", label: "Signups today", value: homeStats.todaySignups, cap: "New activations since midnight", grad: "linear-gradient(135deg,#F7971E,#FFD200)", glow: "rgba(247,151,30,.28)", scolor: "#F7971E", tag: "today", good: true, spark: "0,20 25,22 50,17 75,18 100,12" },
                { icon: "M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6", label: "Revenue today", value: toCurrency(homeStats.revenueToday), cap: "Payments received today", grad: "linear-gradient(135deg,#E9408B,#F27121)", glow: "rgba(242,113,33,.28)", scolor: "#E9408B", tag: "today", good: true, spark: "0,24 25,20 50,17 75,12 100,7" },
              ];
            })().map((c) => (
              <div key={c.label} className="kpi-card" style={{ ...cardStyle, position: "relative", overflow: "hidden", display: "flex", flexDirection: "column", gap: 10, transition: "border-color .18s ease, box-shadow .18s ease, transform .18s ease" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ width: 42, height: 42, borderRadius: 12, background: c.grad, boxShadow: `0 8px 22px ${c.glow}`, display: "grid", placeItems: "center" }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={c.icon} /></svg>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 800, padding: "3px 9px", borderRadius: 999, color: c.good ? "#22c55e" : "#f59e0b", background: c.good ? "rgba(34,197,94,.14)" : "rgba(245,158,11,.14)" }}>{c.tag}</span>
                </div>
                <div>
                  <div style={{ fontSize: 28, fontWeight: 850, letterSpacing: "-0.03em", lineHeight: 1, color: "var(--text)" }}>{c.value}</div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 5, fontWeight: 600 }}>{c.label}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)", opacity: 0.75, marginTop: 7 }}>{c.cap}</div>
                </div>
                {/* Sparkline removed — it was a hardcoded decorative polyline, not
                    real per-metric history, so it implied a trend that didn't exist. */}
              </div>
            ))}
          </div>

          {/* Pie + goal rings: status split, online/offline, and franchise tiers */}
          <OverviewCharts refreshKey={refreshKey} />

          <div style={{ ...cardStyle }} className="panel-card">
            <div style={{ fontWeight: 800, marginBottom: 12 }}>Quick Actions</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10 }}>
              {[
                { label: "Add Subscriber", hint: "Create a new customer", grad: "linear-gradient(135deg,#6C3CE1,#E9408B)", onClick: () => router.push("/subscribers"), icon: "M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M20 8v6 M23 11h-6" },
                { label: "Generate Invoice", hint: "Bill a customer", grad: "linear-gradient(135deg,#00C9FF,#22c55e)", onClick: () => setShowInvoiceQuick(true), icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M12 18v-6 M9 15h6" },
                { label: "View Reports", hint: "Revenue & growth", grad: "linear-gradient(135deg,#F7971E,#FFD200)", onClick: () => setTab("reports"), icon: "M12 20V10 M18 20V4 M6 20v-4" },
                { label: "Manage NAS", hint: "Routers & pools", grad: "linear-gradient(135deg,#E9408B,#F27121)", onClick: () => router.push("/nas"), icon: "M5 3h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M5 14h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z" },
              ].map((t) => (
                <button key={t.label} type="button" className="task-tile" onClick={t.onClick}>
                  <span className="tt-ico" style={{ background: t.grad }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "relative", zIndex: 1 }}>
                      <path d={t.icon} />
                    </svg>
                  </span>
                  <span className="tt-body">
                    <b>{t.label}</b>
                    <em>{t.hint}</em>
                  </span>
                  <svg className="tt-arrow" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: cols("1.1fr .9fr"), gap: 12 }}>
            <div style={cardStyle} className="panel-card">
              <div style={{ fontWeight: 800, marginBottom: 10 }}>Recent Activity (Latest 5)</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {activityFeed.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--muted)", padding: "10px 0" }}>No recent activity yet.</div>
                ) : (
                  activityFeed.map((a, i) => (
                    <div key={i} className="feed-row">
                      <span className={`feed-dot ${a.type}`} />
                      <div className="feed-body">
                        <div className="feed-text">{a.text}</div>
                        <div className="feed-time">{a.at.toLocaleString()}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div style={cardStyle} className="panel-card">
              <div style={{ fontWeight: 800, marginBottom: 10 }}>System Status</div>
              {[
                // Real signals, not placeholders:
                //  • Database — proven reachable because the API returned data.
                //  • RADIUS  — live online count from the scoped overview (radacct + router presence).
                //  • Routers — how many NAS are configured for this account.
                { label: "Database", ok: !loading && systemStatus.db, value: (!loading && systemStatus.db) ? "Reachable" : "No data" },
                { label: "RADIUS sessions online", ok: homeStats.onlineNow > 0, value: `${homeStats.onlineNow} online` },
                { label: "NAS / routers", ok: homeStats.totalNas > 0, value: `${homeStats.totalNas} configured` },
                ...(systemStats ? [{ label: "Server uptime", ok: true, value: fmtUptime(systemStats.uptimeSecs) }] : []),
              ].map((s) => (
                <div key={s.label} className="sys-row">
                  <span className="sys-label">
                    <span className={`sys-dot ${s.ok ? "ok" : "bad"}`} />
                    {s.label}
                  </span>
                  <span className={`sys-status ${s.ok ? "ok" : "bad"}`}>{s.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "reports" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ ...cardStyle, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 800 }}>Date Range</div>
            <input type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} style={{ ...ghostBtn, padding: "6px 10px" }} />
            <input type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} style={{ ...ghostBtn, padding: "6px 10px" }} />
            <button
              style={btnStyle}
              onClick={() => csvDownload("reports-summary.csv", [
                { metric: "Revenue", value: inRangePayments.reduce((a, b) => a + (b.amount || 0), 0) },
                { metric: "Payments", value: inRangePayments.length },
                { metric: "New Subscribers", value: inRangeSubscribers.length },
              ])}
            >
              Export CSV
            </button>
            <button
              style={btnStyle}
              onClick={() => simplePdfPrint(`${BRAND.name} Report`, [
                { metric: "Revenue", value: toCurrency(inRangePayments.reduce((a, b) => a + (b.amount || 0), 0)) },
                { metric: "Payments", value: inRangePayments.length },
                { metric: "New Subscribers", value: inRangeSubscribers.length },
              ])}
            >
              Export PDF
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: cols("1fr 1fr"), gap: 12 }}>
            <div style={cardStyle}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>Revenue</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 14 }}>Collected per day, last 14 days</div>
              <NovaArea data={reportRevenueSeries} prefix={currencySymbol()}
                emptyHint="Payments recorded in this range will plot here, one point per day." />
            </div>
            <div style={cardStyle}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>Subscriber growth</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 14 }}>New connections per day, last 14 days</div>
              <NovaBars data={reportGrowthSeries}
                emptyHint="Each new subscriber added appears on the day they joined." />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: cols("1fr 1fr"), gap: 12 }}>
            <div style={cardStyle}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>Package distribution</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 14 }}>How your customers split across plans</div>
              <NovaDonut data={packageBreakdown.slice(0, 6)} unit="subscribers"
                emptyHint="Assign packages to subscribers and the split appears here." />
            </div>
            <div style={cardStyle}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>Payments by method</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 14 }}>How customers are paying you</div>
              <NovaDonut data={paymentBreakdown.slice(0, 6)} unit="payments"
                emptyHint="Recorded payments are grouped by method — cash, bank, card or online." />
            </div>
          </div>
        </div>
      )}

      {tab === "subscribers" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ ...cardStyle, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              placeholder="Search by name, phone, username, status"
              value={subscriberQ}
              onChange={(e) => setSubscriberQ(e.target.value)}
              style={{ flex: 1, minWidth: 220, background: "var(--bg)", border: "1px solid rgba(255,255,255,0.15)", color: "var(--text)", borderRadius: 8, padding: "9px 10px" }}
            />
            <select value={subscriberStatus} onChange={(e) => setSubscriberStatus(e.target.value)} style={{ ...ghostBtn, padding: "8px 10px" }}>
              {"ALL,ACTIVE,INACTIVE,EXPIRED,SUSPENDED".split(",").map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={String(perPage)} onChange={(e) => setPerPage(Number(e.target.value))} style={{ ...ghostBtn, padding: "8px 10px" }}>
              {[10, 25, 50].map((n) => <option key={n} value={n}>{n} / page</option>)}
            </select>
            <button
              style={btnStyle}
              onClick={() => csvDownload("subscribers.csv", filteredSubscribers.map((s) => ({ id: s.id, name: s.fullName, phone: s.phone || "", username: s.username || "", status: s.status, package: s.package?.name || "" })))}
            >
              Export CSV
            </button>
          </div>

          <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
            <div style={{ maxHeight: 560, overflow: "auto", WebkitOverflowScrolling: "touch" }}>
              <table style={{ width: "100%", minWidth: isMobile ? 640 : undefined, borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ position: "sticky", top: 0, background: "var(--surface)" }}>
                    {[
                      "Subscriber",
                      "Phone",
                      "Username",
                      "Status",
                      "Package",
                      "Actions",
                    ].map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.1)", color: "var(--muted)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pagedSubscribers.map((s) => {
                    const st = statusStyle(String(s.status));
                    return (
                      <tr key={s.id}>
                        <td style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>{s.fullName}</td>
                        <td style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>{s.phone || "-"}</td>
                        <td style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>{s.username || "-"}</td>
                        <td style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}><span style={{ ...st, fontSize: 11, fontWeight: 700, borderRadius: 6, padding: "3px 8px" }}>{String(s.status).toUpperCase()}</span></td>
                        <td style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>{s.package?.name || "-"}</td>
                        <td style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button style={ghostBtn} onClick={() => setSelectedSubscriber(s)}>View</button>
                          <button style={ghostBtn} onClick={() => router.push(`/subscribers`)}>Edit</button>
                          <button style={ghostBtn} disabled={busyAction === `sub-${s.id}`} onClick={() => callSubscriberStatus(s.id, "SUSPENDED")}>Suspend</button>
                          <button style={ghostBtn} disabled={busyAction === `sub-${s.id}`} onClick={() => callSubscriberStatus(s.id, "ACTIVE")}>Activate</button>
                          <button style={{ ...ghostBtn, color: "#f87171", borderColor: "rgba(248,113,113,0.4)" }} disabled={busyAction === `sub-del-${s.id}`} onClick={() => deleteSubscriber(s.id)}>Delete</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 12, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>Page {subscriberPage} / {totalPages}</span>
              <div style={{ display: "flex", gap: 6 }}>
                <button style={ghostBtn} disabled={subscriberPage <= 1} onClick={() => setSubscriberPage((p) => Math.max(1, p - 1))}>Prev</button>
                <button style={ghostBtn} disabled={subscriberPage >= totalPages} onClick={() => setSubscriberPage((p) => Math.min(totalPages, p + 1))}>Next</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "accounting" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
            <div style={cardStyle}>
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8, textTransform: "uppercase" }}>Income</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: "#4ade80" }}>{toCurrency(payments.reduce((a, b) => a + (b.amount || 0), 0))}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8, textTransform: "uppercase" }}>Expense</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: "#f87171" }}>{toCurrency(0)}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8, textTransform: "uppercase" }}>Net</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: "#38bdf8" }}>{toCurrency(payments.reduce((a, b) => a + (b.amount || 0), 0))}</div>
            </div>
          </div>

          <div style={{ ...cardStyle, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select value={invoiceStatus} onChange={(e) => setInvoiceStatus(e.target.value)} style={{ ...ghostBtn, padding: "8px 10px" }}>
              {"ALL,PAID,UNPAID,PARTIAL,OVERDUE,CANCELLED".split(",").map((s) => <option key={s}>{s}</option>)}
            </select>
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} style={{ ...ghostBtn, padding: "8px 10px" }}>
              {["ALL", "CASH", "BANK_TRANSFER", "CARD", "ONLINE", "VOUCHER"].map((m) => <option key={m}>{m}</option>)}
            </select>
            <button style={btnStyle} onClick={() => setShowInvoiceQuick(true)}>Quick Invoice Generation</button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: cols("1fr 1fr"), gap: 12 }}>
            <div style={{ ...cardStyle, maxHeight: 380, overflow: "auto" }}>
              <div style={{ fontWeight: 800, marginBottom: 10 }}>Invoice List</div>
              {accountingInvoices.map((i) => {
                const st = statusStyle(String(i.status));
                return (
                  <div key={i.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "8px 0" }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{i.invoiceNo || `#${i.id}`}</div>
                      <div style={{ color: "var(--muted)", fontSize: 11 }}>{i.subscriber?.fullName || "-"} · Due {toDate(i.dueDate)}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontWeight: 700 }}>{toCurrency(Number(i.total || i.amount || 0))}</div>
                      <span style={{ ...st, fontSize: 10, fontWeight: 700, borderRadius: 5, padding: "2px 7px" }}>{String(i.status).toUpperCase()}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ ...cardStyle, maxHeight: 380, overflow: "auto" }}>
              <div style={{ fontWeight: 800, marginBottom: 10 }}>Payment History</div>
              {accountingPayments.map((p) => (
                <div key={p.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "8px 0", display: "grid", gridTemplateColumns: "1fr auto" }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{p.subscriber?.fullName || "Unknown Subscriber"}</div>
                    <div style={{ color: "var(--muted)", fontSize: 11 }}>{(p.method || "UNKNOWN").replaceAll("_", " ")} · {toDateTime(p.paymentDate || p.createdAt)}</div>
                  </div>
                  <div style={{ color: "#4ade80", fontWeight: 800 }}>{toCurrency(p.amount || 0)}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontWeight: 800, marginBottom: 10 }}>Revenue by Payment Method</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10 }}>
              {paymentMethodRevenue.map(([method, amount]) => (
                <div key={method} style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase" }}>{method}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#38bdf8" }}>{toCurrency(amount)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "users" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 800 }}>System Users</div>
            <button
              style={btnStyle}
              onClick={() => {
                setEditingUser(null);
                setUserForm({ name: "", email: "", password: "", role: "ADMIN" });
                setShowUserForm(true);
              }}
            >
              Create User
            </button>
          </div>

          <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
            <div style={{ maxHeight: 520, overflow: "auto", WebkitOverflowScrolling: "touch" }}>
              <table style={{ width: "100%", minWidth: isMobile ? 640 : undefined, borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "var(--surface)", position: "sticky", top: 0 }}>
                    {"Name,Email,Role,Permissions,Last Login,Status,Actions".split(",").map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "10px 12px", color: "var(--muted)", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const role = (u.role || "ADMIN").toUpperCase();
                    const roleLabel =
                      role === "SUPER_ADMIN" ? "Super Admin" : role === "ADMIN" ? "Admin" : role === "SALES" ? "Sales" : role === "RESELLER" ? "Reseller" : role;

                    const perms = role === "SUPER_ADMIN" ? "All Modules" : role === "ADMIN" ? "Ops + Billing" : role === "SALES" ? "Subscribers + Payments" : "Reseller Panel";

                    return (
                      <tr key={u.id}>
                        <td style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>{u.name}</td>
                        <td style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>{u.email}</td>
                        <td style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>{roleLabel}</td>
                        <td style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)", color: "var(--muted)" }}>{perms}</td>
                        <td style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>{toDateTime(u.lastLoginAt || u.updatedAt || u.createdAt)}</td>
                        <td style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                          <span style={{ ...(u.isActive === false ? statusStyle("INACTIVE") : statusStyle("ACTIVE")), borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 700 }}>
                            {u.isActive === false ? "INACTIVE" : "ACTIVE"}
                          </span>
                        </td>
                        <td style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 6 }}>
                          <button
                            style={ghostBtn}
                            onClick={() => {
                              setEditingUser(u);
                              setUserForm({ name: u.name, email: u.email, password: "", role: u.role || "ADMIN" });
                              setShowUserForm(true);
                            }}
                          >
                            Edit
                          </button>
                          <button style={ghostBtn} disabled={busyAction === `user-${u.id}`} onClick={() => toggleUser(u.id)}>
                            {u.isActive === false ? "Activate" : "Deactivate"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>User Activity Logs</div>
            <div style={{ display: "grid", gap: 8 }}>
              {users.slice(0, 8).map((u) => (
                <div key={u.id} style={{ padding: "8px 10px", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12 }}>{u.name} ({(u.role || "ADMIN").toUpperCase()})</span>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>Last event: {toDateTime(u.lastLoginAt || u.updatedAt || u.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "expiring" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[
            { label: "All Expired Subscribers", list: expiredGroups.expired, color: "#ef4444" },
            { label: "Expiring (1 Day)", list: expiredGroups.d1, color: "#ef4444" },
            { label: "Expiring (3 Days)", list: expiredGroups.d3, color: "#f97316" },
            { label: "Expiring (1 Week)", list: expiredGroups.d7, color: "#f59e0b" },
            { label: "Expiring (2 Weeks)", list: expiredGroups.d14, color: "#eab308" },
            { label: "Expiring (4 Weeks)", list: expiredGroups.d30, color: "#84cc16" },
          ].map((g) => (
            <div key={g.label} style={cardStyle}>
              <div style={{ fontWeight: 800, marginBottom: 10 }}>{g.label} ({g.list.length})</div>
              {g.list.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--muted)" }}>No subscribers in this bucket.</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {g.list.slice(0, 30).map((s) => (
                    <div key={s.id} style={{ display: "grid", gridTemplateColumns: "1.2fr .8fr .8fr .8fr auto", gap: 8, alignItems: "center", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "8px 10px" }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{s.fullName}</div>
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>{s.phone || "-"} · {s.username || "-"}</div>
                      </div>
                      <div style={{ fontSize: 12 }}>{s.package?.name || "No Package"}</div>
                      <div style={{ fontSize: 12 }}>{toDate((s as any).expiry?.toISOString?.() || s.expiryDate || s.expirationDate || s.expiresAt)}</div>
                      <div>
                        <span style={{ borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 800, color: g.color, background: "rgba(255,255,255,0.06)" }}>{(s as any).diffDays} day(s)</span>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button style={ghostBtn} onClick={() => router.push("/subscribers")}>Renew</button>
                        <button style={ghostBtn} onClick={() => notify("Reminder queued", "ok")}>Send reminder</button>
                        <button style={ghostBtn} onClick={() => setSelectedSubscriber(s)}>View</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {selectedSubscriber && (
        <Portal><div onClick={() => setSelectedSubscriber(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 2000 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(900px, 100%)", maxHeight: "88vh", overflow: "auto", ...cardStyle }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 18 }}>{selectedSubscriber.fullName}</div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>{selectedSubscriber.email || "-"} · {selectedSubscriber.phone || "-"}</div>
              </div>
              <button style={ghostBtn} onClick={() => setSelectedSubscriber(null)}>Close</button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: cols("1fr 1fr"), gap: 12 }}>
              <div style={{ ...cardStyle, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Personal Info</div>
                <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.8 }}>
                  <div>Name: {selectedSubscriber.fullName}</div>
                  <div>Phone: {selectedSubscriber.phone || "-"}</div>
                  <div>Username: {selectedSubscriber.username || "-"}</div>
                  <div>Status: {selectedSubscriber.status}</div>
                </div>
              </div>
              <div style={{ ...cardStyle, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Package</div>
                <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.8 }}>
                  <div>Package: {selectedSubscriber.package?.name || "No Package"}</div>
                  <div>Area: {selectedSubscriber.area?.name || "-"}</div>
                  <div>Installed: {toDate(selectedSubscriber.installationDate)}</div>
                  <div>Expiry: {toDate(selectedSubscriber.expiryDate || selectedSubscriber.expirationDate || selectedSubscriber.expiresAt)}</div>
                </div>
              </div>

              <div style={{ ...cardStyle, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Payment History</div>
                <div style={{ display: "grid", gap: 6 }}>
                  {payments.filter((p) => p.subscriber?.id === selectedSubscriber.id).slice(0, 8).map((p) => (
                    <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span>{toDate(p.paymentDate || p.createdAt)} · {(p.method || "-").replaceAll("_", " ")}</span>
                      <b style={{ color: "#4ade80" }}>{toCurrency(p.amount || 0)}</b>
                    </div>
                  ))}
                  {payments.filter((p) => p.subscriber?.id === selectedSubscriber.id).length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>No payments found.</div>}
                </div>
              </div>

              <div style={{ ...cardStyle, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Usage Stats</div>
                <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.8 }}>
                  <div>Invoices: {invoices.filter((i) => i.subscriber?.id === selectedSubscriber.id).length}</div>
                  <div>Payments: {payments.filter((p) => p.subscriber?.id === selectedSubscriber.id).length}</div>
                  <div>Total Paid: {toCurrency(payments.filter((p) => p.subscriber?.id === selectedSubscriber.id).reduce((a, b) => a + (b.amount || 0), 0))}</div>
                </div>
              </div>
            </div>
          </div>
        </div></Portal>
      )}

      {showInvoiceQuick && (
        <Portal><div onClick={() => setShowInvoiceQuick(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 2000 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(520px, 100%)", ...cardStyle }}>
            <div style={{ fontWeight: 800, marginBottom: 10 }}>Quick Invoice Generation</div>
            <div style={{ display: "grid", gap: 10 }}>
              <select value={quickInvoice.subscriberId} onChange={(e) => setQuickInvoice((p) => ({ ...p, subscriberId: e.target.value }))} style={{ ...ghostBtn, padding: "9px 10px" }}>
                <option value="">Select Subscriber</option>
                {subscribers.slice(0, 500).map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
              </select>
              <input value={quickInvoice.amount} onChange={(e) => setQuickInvoice((p) => ({ ...p, amount: e.target.value }))} placeholder="Amount" type="number" style={{ background: "var(--bg)", border: "1px solid rgba(255,255,255,0.15)", color: "var(--text)", borderRadius: 8, padding: "10px" }} />
              <input value={quickInvoice.dueDate} onChange={(e) => setQuickInvoice((p) => ({ ...p, dueDate: e.target.value }))} type="date" style={{ background: "var(--bg)", border: "1px solid rgba(255,255,255,0.15)", color: "var(--text)", borderRadius: 8, padding: "10px" }} />
              <textarea value={quickInvoice.notes} onChange={(e) => setQuickInvoice((p) => ({ ...p, notes: e.target.value }))} rows={3} placeholder="Notes" style={{ background: "var(--bg)", border: "1px solid rgba(255,255,255,0.15)", color: "var(--text)", borderRadius: 8, padding: "10px" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
              <button style={ghostBtn} onClick={() => setShowInvoiceQuick(false)}>Cancel</button>
              <button style={btnStyle} disabled={busyAction === "invoice"} onClick={submitQuickInvoice}>{busyAction === "invoice" ? "Generating..." : "Generate"}</button>
            </div>
          </div>
        </div></Portal>
      )}

      {showUserForm && (
        <Portal><div onClick={() => setShowUserForm(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 2000 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(520px, 100%)", ...cardStyle }}>
            <div style={{ fontWeight: 800, marginBottom: 10 }}>{editingUser ? "Edit User" : "Create User"}</div>
            <div style={{ display: "grid", gap: 10 }}>
              <input value={userForm.name} onChange={(e) => setUserForm((p) => ({ ...p, name: e.target.value }))} placeholder="Name" style={{ background: "var(--bg)", border: "1px solid rgba(255,255,255,0.15)", color: "var(--text)", borderRadius: 8, padding: "10px" }} />
              <input value={userForm.email} onChange={(e) => setUserForm((p) => ({ ...p, email: e.target.value }))} placeholder="Email" style={{ background: "var(--bg)", border: "1px solid rgba(255,255,255,0.15)", color: "var(--text)", borderRadius: 8, padding: "10px" }} />
              <input type="password" value={userForm.password} onChange={(e) => setUserForm((p) => ({ ...p, password: e.target.value }))} placeholder={editingUser ? "Password (optional)" : "Password"} style={{ background: "var(--bg)", border: "1px solid rgba(255,255,255,0.15)", color: "var(--text)", borderRadius: 8, padding: "10px" }} />
              <select value={userForm.role} onChange={(e) => setUserForm((p) => ({ ...p, role: e.target.value }))} style={{ ...ghostBtn, padding: "9px 10px" }}>
                <option value="SUPER_ADMIN">Super Admin</option>
                <option value="ADMIN">Admin</option>
                <option value="SALES">Sales</option>
                <option value="RESELLER">Reseller</option>
              </select>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
              <button style={ghostBtn} onClick={() => setShowUserForm(false)}>Cancel</button>
              <button style={btnStyle} disabled={busyAction === "user-form"} onClick={submitUserForm}>{busyAction === "user-form" ? "Saving..." : "Save"}</button>
            </div>
          </div>
        </div></Portal>
      )}

      <style>{`
        @media (max-width: 980px) {
          .db-two-col { grid-template-columns: 1fr !important; }
        }
      `}</style>
        </>
      )}
    </div>
  );
}
