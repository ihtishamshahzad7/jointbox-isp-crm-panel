"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const API = process.env.NEXT_PUBLIC_BACKEND_URL || (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:"http://localhost:3001");

const T = {
  bg: "var(--bg)", card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)", sub: "var(--muted)",
  accent: "#0ea5e9", green: "#22c55e", red: "#ef4444", amber: "#f59e0b", purple: "#8b5cf6",
};
const COLOR: Record<string, string> = { accent: T.accent, green: T.green, red: T.red, amber: T.amber, purple: T.purple, muted: T.muted };
const fdt = (d: string) => new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export default function TracePage() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [timeline, setTimeline] = useState<any>(null);
  const debounce = useRef<any>(null);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const get = useCallback(async (path: string) => {
    const r = await fetch(`${API}${path}`, { headers });
    if (r.status === 401) { router.push("/login"); throw new Error("unauthorized"); }
    return r.json();
  }, [token]);

  useEffect(() => { if (!token) router.push("/login"); }, []);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (q.trim().length < 2) { setRes(null); return; }
    debounce.current = setTimeout(async () => {
      setLoading(true);
      try { setRes(await get(`/insights/search?q=${encodeURIComponent(q.trim())}`)); }
      finally { setLoading(false); }
    }, 300);
  }, [q]);

  async function openTimeline(subscriberId: number) {
    setTimeline({ loading: true });
    setTimeline(await get(`/insights/timeline/${subscriberId}`));
  }

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 };
  const input: React.CSSProperties = { background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 16px", color: T.text, fontSize: 15, width: "100%" };
  const secTitle: React.CSSProperties = { fontSize: 11, color: T.muted, textTransform: "uppercase", letterSpacing: 0.5, margin: "0 0 6px" };
  const item: React.CSSProperties = { padding: "8px 10px", borderRadius: 8, fontSize: 13, cursor: "pointer" };

  const hasResults = res && (res.subscribers?.length || res.invoices?.length || res.payments?.length || res.users?.length || res.tickets?.length);

  return (
    <div style={{ padding: 20, color: T.text }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 4px" }}>Global Trace Search</h1>
      <div style={{ fontSize: 13, color: T.sub, marginBottom: 14 }}>
        Paste anything — phone, username, name, invoice #, payment #, or ID — and jump straight to the full story.
      </div>

      <input style={input} placeholder="e.g. 017xxxxxxxx · ehtisham · INV-2026-00042 · PAY-..." value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {loading && <div style={{ fontSize: 12, color: T.muted, marginTop: 8 }}>Searching…</div>}

      {res && !hasResults && !loading && (
        <div style={{ ...card, marginTop: 14, color: T.muted }}>No matches for “{res.query}”.</div>
      )}

      {hasResults && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginTop: 14 }}>
          {res.subscribers?.length > 0 && (
            <div style={card}>
              <p style={secTitle}>Subscribers ({res.subscribers.length})</p>
              {res.subscribers.map((s: any) => (
                <div key={s.id} style={{ ...item, background: T.row, marginBottom: 6 }} onClick={() => openTimeline(s.id)}>
                  <div style={{ fontWeight: 600 }}>{s.fullName} <span style={{ color: T.muted, fontWeight: 400 }}>@{s.username}</span></div>
                  <div style={{ fontSize: 12, color: T.sub }}>{s.phone} · {s.package?.name || "no package"} · {s.status} · <span style={{ color: T.accent }}>view timeline →</span></div>
                </div>
              ))}
            </div>
          )}
          {res.invoices?.length > 0 && (
            <div style={card}>
              <p style={secTitle}>Invoices ({res.invoices.length})</p>
              {res.invoices.map((i: any) => (
                <div key={i.id} style={{ ...item, background: T.row, marginBottom: 6 }} onClick={() => openTimeline(i.subscriberId)}>
                  <div style={{ fontWeight: 600 }}>{i.invoiceNo}</div>
                  <div style={{ fontSize: 12, color: T.sub }}>{i.total} · {i.status} · {fdt(i.invoiceDate)}</div>
                </div>
              ))}
            </div>
          )}
          {res.payments?.length > 0 && (
            <div style={card}>
              <p style={secTitle}>Payments ({res.payments.length})</p>
              {res.payments.map((p: any) => (
                <div key={p.id} style={{ ...item, background: T.row, marginBottom: 6 }} onClick={() => openTimeline(p.subscriberId)}>
                  <div style={{ fontWeight: 600 }}>{p.paymentNo}</div>
                  <div style={{ fontSize: 12, color: T.sub }}>{p.amount} · {p.method} · {fdt(p.paymentDate)}</div>
                </div>
              ))}
            </div>
          )}
          {res.tickets?.length > 0 && (
            <div style={card}>
              <p style={secTitle}>Tickets ({res.tickets.length})</p>
              {res.tickets.map((t: any) => (
                <div key={t.id} style={{ ...item, background: T.row, marginBottom: 6 }} onClick={() => t.subscriberId && openTimeline(t.subscriberId)}>
                  <div style={{ fontWeight: 600 }}>{t.ticketNo}</div>
                  <div style={{ fontSize: 12, color: T.sub }}>{t.subject} · {t.status}</div>
                </div>
              ))}
            </div>
          )}
          {res.users?.length > 0 && (
            <div style={card}>
              <p style={secTitle}>Staff / Resellers ({res.users.length})</p>
              {res.users.map((u: any) => (
                <div key={u.id} style={{ ...item, background: T.row, marginBottom: 6 }}>
                  <div style={{ fontWeight: 600 }}>{u.name}</div>
                  <div style={{ fontSize: 12, color: T.sub }}>{u.email} · {u.role}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Timeline drawer */}
      {timeline && (
        <div style={{ position: "fixed", inset: 0, background: "#000a", display: "flex", justifyContent: "flex-end", zIndex: 60 }} onClick={() => setTimeline(null)}>
          <div style={{ width: 520, maxWidth: "100%", height: "100%", background: T.card, borderLeft: `1px solid ${T.border}`, overflowY: "auto", padding: 20 }} onClick={(e) => e.stopPropagation()}>
            {timeline.loading ? <div style={{ color: T.muted }}>Loading timeline…</div> : timeline.subscriber ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>{timeline.subscriber.fullName}</div>
                    <div style={{ fontSize: 13, color: T.sub }}>@{timeline.subscriber.username} · {timeline.subscriber.phone}</div>
                    <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>
                      {timeline.subscriber.package || "no package"} · {timeline.subscriber.status} · wallet {timeline.subscriber.balance}
                      {timeline.subscriber.expiryDate ? ` · expires ${new Date(timeline.subscriber.expiryDate).toLocaleDateString()}` : ""}
                    </div>
                  </div>
                  <button onClick={() => setTimeline(null)} style={{ background: "transparent", border: "none", color: T.muted, fontSize: 22, cursor: "pointer" }}>✕</button>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, fontSize: 11, color: T.muted }}>
                  {Object.entries(timeline.counts).map(([k, v]) => <span key={k} style={{ background: T.row, padding: "3px 8px", borderRadius: 20 }}>{v as any} {k}</span>)}
                </div>
                <div style={{ position: "relative", paddingLeft: 18, borderLeft: `2px solid ${T.border}` }}>
                  {timeline.events.map((e: any, i: number) => (
                    <div key={i} style={{ position: "relative", marginBottom: 14 }}>
                      <div style={{ position: "absolute", left: -25, top: 0, width: 16, textAlign: "center" }}>{e.icon}</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: COLOR[e.color] || T.text }}>{e.title}</div>
                      {e.detail && <div style={{ fontSize: 12, color: T.sub }}>{e.detail}</div>}
                      <div style={{ fontSize: 11, color: T.muted }}>{e.at ? fdt(e.at) : ""}</div>
                    </div>
                  ))}
                  {!timeline.events.length && <div style={{ color: T.muted, fontSize: 13 }}>No events yet.</div>}
                </div>
              </>
            ) : <div style={{ color: T.muted }}>Subscriber not found.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
