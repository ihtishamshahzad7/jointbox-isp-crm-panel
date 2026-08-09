"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { money } from "../components/currency";
import API_BASE from "../components/api";

const API =
  API_BASE;

const T = {
  card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)",
  accent: "#0ea5e9", green: "#22c55e", amber: "#f59e0b", red: "#ef4444", purple: "#8b5cf6",
};

const ST: Record<string, { c: string; bg: string; dot: string; label: string }> = {
  AVAILABLE: { c: "#4ade80", bg: "rgba(34,197,94,.12)",  dot: "#22c55e", label: "Available" },
  ASSIGNED:  { c: "#38bdf8", bg: "rgba(14,165,233,.12)", dot: "#0ea5e9", label: "Assigned" },
  RESERVED:  { c: "#a78bfa", bg: "rgba(139,92,246,.12)", dot: "#8b5cf6", label: "Reserved" },
  BLOCKED:   { c: "#94a3b8", bg: "rgba(148,163,184,.12)",dot: "#64748b", label: "Blocked" },
  EXPIRED:   { c: "#f87171", bg: "rgba(239,68,68,.12)",  dot: "#ef4444", label: "Expired" },
};

const fdate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString([], { dateStyle: "medium" }) : "—";

export default function StaticIpsPage() {
  const router = useRouter();
  const [ips, setIps] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [subs, setSubs] = useState<any[]>([]);
  const [nasList, setNasList] = useState<any[]>([]);
  const [filter, setFilter] = useState({ status: "ALL", q: "" });
  const [view, setView] = useState<"grid" | "table">("grid");
  const [panel, setPanel] = useState<null | "add" | "range">(null);
  const [assigning, setAssigning] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const [single, setSingle] = useState({ ipAddress: "", gateway: "", monthlyPrice: "", nasId: "", notes: "" });
  const [range, setRange] = useState({ startIp: "", endIp: "", gateway: "", monthlyPrice: "", nasId: "", reserveFirst: true });
  const [assign, setAssign] = useState({ subscriberId: "", monthlyPrice: "", expiresAt: "", notes: "" });

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (filter.status !== "ALL") qs.set("status", filter.status);
    if (filter.q) qs.set("q", filter.q);
    try {
      const [i, s, sb, n] = await Promise.all([
        fetch(`${API}/static-ips?${qs}`, { headers }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/static-ips/stats`, { headers }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API}/subscribers?limit=300`, { headers }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/nas`, { headers }).then((r) => (r.ok ? r.json() : [])),
      ]);
      setIps(Array.isArray(i) ? i : []);
      setStats(s);
      setSubs(Array.isArray(sb) ? sb : sb?.data || []);
      setNasList(Array.isArray(n) ? n : []);
    } catch { /* ignore */ }
  }, [filter, token]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    load();
  }, [filter, token]);

  const note = (msg: string, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3500); };

  async function call(path: string, method: string, body?: any, okMsg = "Done") {
    setBusy(true);
    try {
      const r = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Request failed");
      note(okMsg);
      load();
      return d;
    } catch (e: any) { note(e.message, false); return null; } finally { setBusy(false); }
  }

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 16 };
  const input: React.CSSProperties = {
    background: T.row, border: `1px solid ${T.border}`, borderRadius: 9,
    padding: "9px 11px", color: T.text, fontSize: 12.5, width: "100%",
  };
  const btn = (bg: string, ghost = false): React.CSSProperties => ({
    background: ghost ? "transparent" : bg, color: ghost ? bg : "#fff",
    border: ghost ? `1px solid ${bg}` : "none", borderRadius: 9,
    padding: "8px 15px", fontSize: 12, fontWeight: 600, cursor: "pointer",
    opacity: busy ? 0.6 : 1, transition: "transform .12s",
  });

  /** Gradient KPI tile — the pool's health at a glance. */
  const Tile = ({ label, value, sub, from, to }: any) => (
    <div style={{
      borderRadius: 14, padding: "14px 16px",
      background: `linear-gradient(135deg, ${from}, ${to})`,
      color: "#fff", boxShadow: "0 6px 18px rgba(0,0,0,.18)",
    }}>
      <div style={{ fontSize: 10.5, opacity: 0.85, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, marginTop: 3, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, opacity: 0.85, marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ padding: 20, color: T.text }}>
      {toast && (
        <div style={{ ...card, marginBottom: 12, padding: "10px 14px",
          borderColor: toast.ok ? T.green : T.red, color: toast.ok ? T.green : T.red,
          fontSize: 12.5, fontWeight: 600 }}>{toast.msg}</div>
      )}

      {/* Pool health */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(165px,1fr))", gap: 12, marginBottom: 16 }}>
        <Tile label="Pool utilisation" value={`${stats?.utilisationPercent ?? 0}%`}
          sub={`${stats?.assigned ?? 0} of ${stats?.total ?? 0} in use`} from="#0ea5e9" to="#2563eb" />
        <Tile label="Available" value={stats?.available ?? 0}
          sub="ready to allocate" from="#22c55e" to="#15803d" />
        <Tile label="Monthly revenue" value={money(stats?.monthlyRevenue ?? 0)}
          sub="from static IPs" from="#8b5cf6" to="#6d28d9" />
        <Tile label="Expiring 30d" value={stats?.expiringIn30Days ?? 0}
          sub="renew or release" from="#f59e0b" to="#b45309" />
        <Tile label="Overdue" value={stats?.overdue ?? 0}
          sub="past end date, still active" from="#ef4444" to="#b91c1c" />
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
        <input style={{ ...input, flex: "1 1 200px", maxWidth: 280 }} placeholder="Search address or note…"
          value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
        <select style={{ ...input, width: 150 }} value={filter.status}
          onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          <option value="ALL">All statuses</option>
          {Object.keys(ST).map((s) => <option key={s} value={s}>{ST[s].label}</option>)}
        </select>

        <div style={{ display: "flex", background: T.row, borderRadius: 9, padding: 3, gap: 2 }}>
          {(["grid", "table"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} style={{
              background: view === v ? T.accent : "transparent", color: view === v ? "#fff" : T.muted,
              border: "none", borderRadius: 7, padding: "6px 14px", fontSize: 11.5, fontWeight: 600, cursor: "pointer",
            }}>{v === "grid" ? "▦ Grid" : "☰ Table"}</button>
          ))}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button style={btn(T.accent, true)} onClick={() => setPanel(panel === "add" ? null : "add")}>+ Address</button>
          <button style={btn(T.accent)} onClick={() => setPanel(panel === "range" ? null : "range")}>+ Add range</button>
        </div>
      </div>

      {/* Add single */}
      {panel === "add" && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Add one address</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 10 }}>
            <input style={input} placeholder="IP address *" value={single.ipAddress}
              onChange={(e) => setSingle({ ...single, ipAddress: e.target.value })} />
            <input style={input} placeholder="Gateway" value={single.gateway}
              onChange={(e) => setSingle({ ...single, gateway: e.target.value })} />
            <input style={input} type="number" placeholder="Monthly price" value={single.monthlyPrice}
              onChange={(e) => setSingle({ ...single, monthlyPrice: e.target.value })} />
            <select style={input} value={single.nasId} onChange={(e) => setSingle({ ...single, nasId: e.target.value })}>
              <option value="">— any router —</option>
              {nasList.map((n) => <option key={n.id} value={n.id}>{n.shortname || n.nasname}</option>)}
            </select>
          </div>
          <button style={{ ...btn(T.green), marginTop: 10 }} disabled={busy}
            onClick={async () => {
              const d = await call("/static-ips", "POST", single, `Added ${single.ipAddress}`);
              if (d) { setSingle({ ipAddress: "", gateway: "", monthlyPrice: "", nasId: "", notes: "" }); setPanel(null); }
            }}>Add</button>
        </div>
      )}

      {/* Add range */}
      {panel === "range" && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Add a block</div>
          <div style={{ fontSize: 11, color: T.muted, marginBottom: 10 }}>
            Address space is bought in blocks. Existing addresses are skipped, so this is safe to re-run.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10 }}>
            <input style={input} placeholder="Start IP *" value={range.startIp}
              onChange={(e) => setRange({ ...range, startIp: e.target.value })} />
            <input style={input} placeholder="End IP *" value={range.endIp}
              onChange={(e) => setRange({ ...range, endIp: e.target.value })} />
            <input style={input} placeholder="Gateway" value={range.gateway}
              onChange={(e) => setRange({ ...range, gateway: e.target.value })} />
            <input style={input} type="number" placeholder="Monthly price each" value={range.monthlyPrice}
              onChange={(e) => setRange({ ...range, monthlyPrice: e.target.value })} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: T.muted, marginTop: 10 }}>
            <input type="checkbox" checked={range.reserveFirst}
              onChange={(e) => setRange({ ...range, reserveFirst: e.target.checked })} />
            Reserve the first address (it is usually the gateway)
          </label>
          <button style={{ ...btn(T.green), marginTop: 10 }} disabled={busy}
            onClick={async () => {
              const d = await call("/static-ips/range", "POST", range);
              if (d) { note(`Added ${d.added}, skipped ${d.skipped} existing`); setPanel(null); }
            }}>Add block</button>
        </div>
      )}

      {/* ── GRID: the whole pool at a glance ── */}
      {view === "grid" && (
        <div style={{ ...card }}>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12, fontSize: 11, color: T.muted }}>
            {Object.entries(ST).map(([k, v]) => (
              <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: v.dot }} /> {v.label}
              </span>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(122px,1fr))", gap: 7 }}>
            {ips.map((ip) => {
              const s = ST[ip.status] || ST.AVAILABLE;
              return (
                <div key={ip.id} onClick={() => setDetail(ip)} title={ip.subscriber?.fullName || s.label}
                  style={{
                    background: s.bg, border: `1px solid ${s.dot}44`, borderRadius: 9,
                    padding: "8px 9px", cursor: "pointer", transition: "transform .12s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(-2px)")}
                  onMouseLeave={(e) => (e.currentTarget.style.transform = "")}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 2, background: s.dot, flexShrink: 0 }} />
                    <code style={{ fontSize: 11, color: s.c, fontWeight: 700 }}>{ip.ipAddress}</code>
                  </div>
                  <div style={{ fontSize: 9.5, color: T.muted, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {ip.subscriber?.fullName || s.label}
                  </div>
                </div>
              );
            })}
          </div>
          {!ips.length && (
            <div style={{ padding: 24, textAlign: "center", color: T.muted, fontSize: 12.5 }}>
              No addresses yet — add a block to get started.
            </div>
          )}
        </div>
      )}

      {/* ── TABLE: full tracking detail ── */}
      {view === "table" && (
        <div style={{ ...card, padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
              <thead>
                <tr style={{ background: T.row }}>
                  {["Address", "Status", "Customer", "Price/mo", "Assigned", "Expires", "Router", "Actions"].map((h) => (
                    <th key={h} style={{ padding: "10px 11px", textAlign: "left", fontSize: 10, color: T.muted, textTransform: "uppercase", letterSpacing: ".05em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ips.map((ip) => {
                  const s = ST[ip.status] || ST.AVAILABLE;
                  const daysLeft = ip.expiresAt
                    ? Math.ceil((new Date(ip.expiresAt).getTime() - Date.now()) / 86400000) : null;
                  return (
                    <tr key={ip.id} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: "10px 11px" }}>
                        <code style={{ fontSize: 12, color: T.accent, fontWeight: 700, cursor: "pointer" }}
                          onClick={() => setDetail(ip)}>{ip.ipAddress}</code>
                      </td>
                      <td style={{ padding: "10px 11px" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: s.c, background: s.bg, padding: "3px 9px", borderRadius: 20 }}>
                          {s.label}
                        </span>
                      </td>
                      <td style={{ padding: "10px 11px", fontSize: 12 }}>
                        {ip.subscriber ? (
                          <span style={{ color: T.accent, cursor: "pointer" }}
                            onClick={() => router.push(`/subscribers?focus=${ip.subscriber.id}`)}>
                            {ip.subscriber.fullName}
                            <div style={{ fontSize: 10, color: T.muted }}>{ip.subscriber.username}</div>
                          </span>
                        ) : <span style={{ color: T.muted }}>—</span>}
                      </td>
                      <td style={{ padding: "10px 11px", fontSize: 12, color: ip.monthlyPrice ? T.green : T.muted, fontWeight: 600 }}>
                        {ip.monthlyPrice ? money(ip.monthlyPrice) : "—"}
                      </td>
                      <td style={{ padding: "10px 11px", fontSize: 11.5, color: T.muted }}>{fdate(ip.assignedAt)}</td>
                      <td style={{ padding: "10px 11px", fontSize: 11.5 }}>
                        {ip.expiresAt ? (
                          <span style={{ color: daysLeft !== null && daysLeft < 0 ? T.red : daysLeft !== null && daysLeft < 30 ? T.amber : T.muted }}>
                            {fdate(ip.expiresAt)}
                            <div style={{ fontSize: 10 }}>
                              {daysLeft !== null && (daysLeft < 0 ? `${-daysLeft}d overdue` : `${daysLeft}d left`)}
                            </div>
                          </span>
                        ) : <span style={{ color: T.muted }}>No end date</span>}
                      </td>
                      <td style={{ padding: "10px 11px", fontSize: 11, color: T.muted }}>{ip.nas?.shortname || ip.nas?.nasname || "—"}</td>
                      <td style={{ padding: "10px 11px" }}>
                        {ip.subscriberId ? (
                          <button style={{ ...btn(T.amber, true), padding: "5px 11px", fontSize: 11 }}
                            onClick={() => call(`/static-ips/${ip.id}/release`, "PATCH", { reason: "Released by staff" }, "Released")}>
                            Release
                          </button>
                        ) : (
                          <button style={{ ...btn(T.green), padding: "5px 11px", fontSize: 11 }}
                            onClick={() => { setAssigning(ip); setAssign({ subscriberId: "", monthlyPrice: String(ip.monthlyPrice ?? ""), expiresAt: "", notes: "" }); }}>
                            Assign
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!ips.length && (
                  <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: T.muted, fontSize: 12.5 }}>
                    No addresses yet.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Assign modal */}
      {assigning && (
        <div onClick={() => setAssigning(null)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", display: "flex",
          alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: 420, maxWidth: "100%" }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 3 }}>
              Assign <code style={{ color: T.accent }}>{assigning.ipAddress}</code>
            </div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 12 }}>
              The address is pushed to RADIUS immediately, so it applies on the next connection.
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: T.muted }}>Customer *</label>
                <select style={input} value={assign.subscriberId}
                  onChange={(e) => setAssign({ ...assign, subscriberId: e.target.value })}>
                  <option value="">— select —</option>
                  {subs.map((s) => <option key={s.id} value={s.id}>{s.fullName} ({s.username})</option>)}
                </select>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11, color: T.muted }}>Monthly price</label>
                  <input style={input} type="number" value={assign.monthlyPrice}
                    onChange={(e) => setAssign({ ...assign, monthlyPrice: e.target.value })} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: T.muted }}>Expires</label>
                  <input style={input} type="date" value={assign.expiresAt}
                    onChange={(e) => setAssign({ ...assign, expiresAt: e.target.value })} />
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button style={{ ...btn(T.green), flex: 1 }} disabled={busy || !assign.subscriberId}
                onClick={async () => {
                  const d = await call(`/static-ips/${assigning.id}/assign`, "PATCH", assign, "Assigned");
                  if (d) {
                    setAssigning(null);
                    // Say plainly whether the address is live yet — an online
                    // customer is reconnected, an offline one picks it up when
                    // they next dial in.
                    note(
                      d.reconnected
                        ? `${d.ipAddress} is live — session reconnected`
                        : `${d.ipAddress} saved — applies on their next connection`,
                    );
                  }
                }}>Assign address</button>
              <button style={{ ...btn(T.muted, true), flex: 1 }} onClick={() => setAssigning(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Detail + history */}
      {detail && (
        <div onClick={() => setDetail(null)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", display: "flex",
          alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: 480, maxWidth: "100%", maxHeight: "80vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <code style={{ fontSize: 18, fontWeight: 800, color: T.accent }}>{detail.ipAddress}</code>
              <span style={{ fontSize: 10, fontWeight: 700, color: ST[detail.status]?.c, background: ST[detail.status]?.bg, padding: "3px 10px", borderRadius: 20 }}>
                {ST[detail.status]?.label}
              </span>
            </div>
            {[
              ["Customer", detail.subscriber?.fullName || "—"],
              ["Username", detail.subscriber?.username || "—"],
              ["Monthly price", detail.monthlyPrice ? money(detail.monthlyPrice) : "—"],
              ["Assigned", fdate(detail.assignedAt)],
              ["Expires", detail.expiresAt ? fdate(detail.expiresAt) : "No end date"],
              ["Gateway", detail.gateway || "—"],
              ["Router", detail.nas?.nasname || "—"],
            ].map(([k, v]: any) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${T.border}`, fontSize: 12.5 }}>
                <span style={{ color: T.muted }}>{k}</span>
                <span style={{ fontWeight: 600 }}>{v}</span>
              </div>
            ))}
            <button style={{ ...btn(T.accent, true), width: "100%", marginTop: 14 }}
              onClick={() => setDetail(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
