"use client";

import { useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_BACKEND_URL || (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:"http://localhost:3001");

const T = {
  bg: "var(--bg)", card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)", sub: "var(--muted)",
  accent: "#0ea5e9", green: "#22c55e", red: "#ef4444", amber: "#f59e0b",
};

const TABS = ["Overview", "Usage", "Invoices", "Support", "My Account"] as const;
type Tab = (typeof TABS)[number];

const fmt = (n: number) => new Intl.NumberFormat().format(Math.round((n || 0) * 100) / 100);
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const fdate = (d?: string | null) => (d ? new Date(d).toLocaleDateString([], { dateStyle: "medium" }) : "—");
const fdt = (d?: string | null) => (d ? new Date(d).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—");
const hms = (s: number) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

export default function PortalPage() {
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<any>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [login, setLogin] = useState({ username: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<any>(null);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [gateways, setGateways] = useState<string[]>([]);
  const [tickets, setTickets] = useState<any[]>([]);
  const [ticketForm, setTicketForm] = useState({ subject: "", description: "" });
  const [paidBanner, setPaidBanner] = useState<string>("");
  // Self-service: recharge by voucher, change password, connection history.
  const [sessions, setSessions] = useState<any[]>([]);
  const [voucher, setVoucher] = useState({ code: "", pin: "" });
  const [pwForm, setPwForm] = useState({ currentPassword: "", newPassword: "" });
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  const headers = (tk = token) => ({ "Content-Type": "application/json", Authorization: `Bearer ${tk}` });

  const get = useCallback(async (path: string, tk = token) => {
    const r = await fetch(`${API}${path}`, { headers: headers(tk) });
    if (r.status === 401) { localStorage.removeItem("portal_token"); setToken(null); setMe(null); throw new Error("unauthorized"); }
    return r.json();
  }, [token]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("paid") === "1") setPaidBanner("✅ Payment received — your service has been renewed.");
    if (params.get("paid") === "0") setPaidBanner("Payment was cancelled or failed.");
    const saved = localStorage.getItem("portal_token");
    if (saved) {
      setToken(saved);
      get("/portal/me", saved).then(setMe).catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!token || !me) return;
    if (tab === "Usage") get("/portal/usage").then(setUsage).catch(() => {});
    if (tab === "Invoices") {
      get("/portal/invoices").then(setInvoices).catch(() => {});
      get("/portal/gateways").then(setGateways).catch(() => {});
    }
    if (tab === "Support") get("/portal/tickets").then(setTickets).catch(() => {});
    if (tab === "My Account") get("/portal/sessions?limit=20").then(setSessions).catch(() => {});
  }, [tab, token, me]);

  /** Redeem a prepaid scratch card into the wallet. */
  async function redeem() {
    if (!voucher.code.trim()) return setNote({ text: "Enter the voucher code.", ok: false });
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`${API}/portal/recharge`, {
        method: "POST", headers: headers(), body: JSON.stringify(voucher),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.message || "Could not redeem this voucher");
      setVoucher({ code: "", pin: "" });
      setNote({ text: `Recharged. New balance: ${fmt(data.newBalance ?? 0)}`, ok: true });
      // Refresh the header balance.
      get("/portal/me").then(setMe).catch(() => {});
    } catch (e: any) {
      setNote({ text: e.message, ok: false });
    } finally { setBusy(false); }
  }

  /** Change the PPPoE password (applies on next reconnect). */
  async function changePassword() {
    if (!pwForm.currentPassword || !pwForm.newPassword) {
      return setNote({ text: "Enter both your current and new password.", ok: false });
    }
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`${API}/portal/change-password`, {
        method: "POST", headers: headers(), body: JSON.stringify(pwForm),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.message || "Could not change password");
      setPwForm({ currentPassword: "", newPassword: "" });
      setNote({ text: data.note || "Password changed.", ok: true });
    } catch (e: any) {
      setNote({ text: e.message, ok: false });
    } finally { setBusy(false); }
  }

  async function doLogin() {
    setErr(""); setBusy(true);
    try {
      const r = await fetch(`${API}/portal/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(login) });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.message || "Login failed");
      localStorage.setItem("portal_token", data.token);
      setToken(data.token);
      setMe(data.subscriber);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  function logout() {
    localStorage.removeItem("portal_token");
    setToken(null); setMe(null);
  }

  async function payNow(invoiceId: number, gateway: string) {
    setBusy(true);
    try {
      const r = await fetch(`${API}/portal/invoices/${invoiceId}/pay/${gateway}`, { method: "POST", headers: headers() });
      const data = await r.json();
      if (data?.paymentUrl) window.location.href = data.paymentUrl;
      else setErr(data?.message || "Could not start payment");
    } finally { setBusy(false); }
  }

  async function submitTicket() {
    if (!ticketForm.subject || !ticketForm.description) return setErr("Subject and description required");
    setBusy(true);
    try {
      await fetch(`${API}/portal/tickets`, { method: "POST", headers: headers(), body: JSON.stringify(ticketForm) });
      setTicketForm({ subject: "", description: "" });
      setTickets(await get("/portal/tickets"));
    } finally { setBusy(false); }
  }

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18 };
  const input: React.CSSProperties = { background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 12px", color: T.text, fontSize: 14, width: "100%" };
  const btn = (bg: string): React.CSSProperties => ({ background: bg, color: "#fff", border: "none", borderRadius: 8, padding: "10px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.6 : 1 });
  const chip = (color: string, bg: string): React.CSSProperties => ({ fontSize: 11, padding: "2px 10px", borderRadius: 20, background: bg, color, fontWeight: 600 });

  // ── LOGIN VIEW ──
  if (!token || !me) {
    return (
      <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, color: T.text, fontFamily: "system-ui" }}>
        <div style={{ ...card, width: 360 }}>
          <div style={{ textAlign: "center", marginBottom: 18 }}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>JointBox</div>
            <div style={{ fontSize: 13, color: T.sub }}>Subscriber Portal</div>
          </div>
          {paidBanner && <div style={{ fontSize: 13, color: T.green, marginBottom: 10, textAlign: "center" }}>{paidBanner}</div>}
          <div style={{ display: "grid", gap: 10 }}>
            <input style={input} placeholder="Username" value={login.username} onChange={(e) => setLogin({ ...login, username: e.target.value })} />
            <input style={input} placeholder="Password" type="password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} onKeyDown={(e) => e.key === "Enter" && doLogin()} />
            {err && <div style={{ fontSize: 12, color: T.red }}>{err}</div>}
            <button style={btn(T.accent)} disabled={busy} onClick={doLogin}>{busy ? "Signing in…" : "Sign in"}</button>
            <div style={{ fontSize: 11, color: T.muted, textAlign: "center" }}>Use your internet connection username & password</div>
          </div>
        </div>
      </div>
    );
  }

  // ── PORTAL VIEW ──
  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "system-ui", padding: 16 }}>
      <div style={{ maxWidth: 860, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>JointBox <span style={{ color: T.sub, fontWeight: 400, fontSize: 13 }}>Portal</span></div>
            <div style={{ fontSize: 13, color: T.sub }}>Hi, {me.fullName}</div>
          </div>
          <button style={{ ...btn(T.card), border: `1px solid ${T.border}`, color: T.sub }} onClick={logout}>Log out</button>
        </div>

        {paidBanner && (
          <div style={{ ...card, marginBottom: 12, color: paidBanner.startsWith("✅") ? T.green : T.amber, cursor: "pointer" }} onClick={() => setPaidBanner("")}>
            {paidBanner} ✕
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          {TABS.map((name) => (
            <button key={name} onClick={() => setTab(name)}
              style={{ ...btn(tab === name ? T.accent : T.card), border: `1px solid ${tab === name ? T.accent : T.border}`, color: tab === name ? "#fff" : T.sub }}>
              {name}
            </button>
          ))}
        </div>

        {tab === "Overview" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            <div style={card}>
              <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase" }}>Status</div>
              <div style={{ marginTop: 6 }}>
                <span style={chip(me.status === "ACTIVE" ? T.green : T.red, me.status === "ACTIVE" ? "#22c55e22" : "#ef444422")}>{me.status}</span>
              </div>
            </div>
            <div style={card}>
              <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase" }}>Package</div>
              <div style={{ fontSize: 17, fontWeight: 700, marginTop: 6 }}>{me.package?.name || "—"}</div>
              <div style={{ fontSize: 12, color: T.sub }}>{me.package ? `${me.package.downloadSpeed}↓ / ${me.package.uploadSpeed}↑ Mbps` : ""}</div>
            </div>
            <div style={card}>
              <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase" }}>Expires</div>
              <div style={{ fontSize: 17, fontWeight: 700, marginTop: 6 }}>{fdate(me.expiryDate)}</div>
            </div>
            <div style={card}>
              <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase" }}>Wallet balance</div>
              <div style={{ fontSize: 17, fontWeight: 700, marginTop: 6, color: T.green }}>{fmt(me.balance)}</div>
            </div>
          </div>
        )}

        {tab === "Usage" && (
          <div style={card}>
            {usage ? (
              <>
                <div style={{ display: "flex", gap: 16, marginBottom: 14, flexWrap: "wrap" }}>
                  <span style={chip(usage.online ? T.green : T.muted, usage.online ? "#22c55e22" : "var(--muted)22")}>{usage.online ? "● ONLINE NOW" : "○ OFFLINE"}</span>
                  <span style={{ fontSize: 13, color: T.sub }}>↓ {gb(usage.totals.download)} · ↑ {gb(usage.totals.upload)} · {hms(usage.totals.seconds)} (last {usage.sessions.length} sessions)</span>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead><tr style={{ color: T.muted, fontSize: 11, textAlign: "left" }}>
                      <th style={{ padding: 6 }}>Started</th><th style={{ padding: 6 }}>Ended</th><th style={{ padding: 6 }}>Time</th>
                      <th style={{ padding: 6 }}>Download</th><th style={{ padding: 6 }}>Upload</th><th style={{ padding: 6 }}>IP</th>
                    </tr></thead>
                    <tbody>
                      {usage.sessions.map((s: any, i: number) => (
                        <tr key={i} style={{ background: i % 2 ? "transparent" : T.row }}>
                          <td style={{ padding: 6 }}>{fdt(s.start)}</td>
                          <td style={{ padding: 6 }}>{s.stop ? fdt(s.stop) : <span style={{ color: T.green }}>active</span>}</td>
                          <td style={{ padding: 6 }}>{hms(s.seconds || 0)}</td>
                          <td style={{ padding: 6 }}>{gb(s.download)}</td>
                          <td style={{ padding: 6 }}>{gb(s.upload)}</td>
                          <td style={{ padding: 6, color: T.sub }}>{s.ip || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : <div style={{ color: T.muted }}>Loading usage…</div>}
          </div>
        )}

        {tab === "Invoices" && (
          <div style={card}>
            {invoices.map((inv, i) => (
              <div key={inv.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 8px", background: i % 2 ? "transparent" : T.row, borderRadius: 8, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{inv.invoiceNo}</div>
                  <div style={{ fontSize: 12, color: T.sub }}>Due {fdate(inv.dueDate)}</div>
                </div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{fmt(inv.total)}</div>
                <span style={chip(
                  inv.status === "PAID" ? T.green : inv.status === "CANCELLED" ? T.muted : T.amber,
                  inv.status === "PAID" ? "#22c55e22" : inv.status === "CANCELLED" ? "var(--muted)22" : "#f59e0b22")}>
                  {inv.status}
                </span>
                {["UNPAID", "PARTIAL", "OVERDUE"].includes(inv.status) && gateways.map((g) => (
                  <button key={g} style={{ ...btn(T.green), padding: "6px 12px", fontSize: 12 }} disabled={busy} onClick={() => payNow(inv.id, g)}>
                    Pay {g === "SANDBOX" ? "(test)" : `via ${g}`}
                  </button>
                ))}
              </div>
            ))}
            {!invoices.length && <div style={{ color: T.muted, fontSize: 13 }}>No invoices yet.</div>}
          </div>
        )}

        {tab === "Support" && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={card}>
              <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Open a ticket</h3>
              <div style={{ display: "grid", gap: 8 }}>
                <input style={input} placeholder="Subject" value={ticketForm.subject} onChange={(e) => setTicketForm({ ...ticketForm, subject: e.target.value })} />
                <textarea style={{ ...input, minHeight: 80 }} placeholder="Describe the problem" value={ticketForm.description} onChange={(e) => setTicketForm({ ...ticketForm, description: e.target.value })} />
                <button style={{ ...btn(T.accent), width: 140 }} disabled={busy} onClick={submitTicket}>Submit</button>
              </div>
            </div>
            {tickets.map((t) => (
              <div key={t.id} style={card}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                  <div style={{ fontWeight: 600 }}>{t.subject} <span style={{ color: T.muted, fontWeight: 400, fontSize: 12 }}>({t.ticketNo})</span></div>
                  <span style={chip(t.status === "OPEN" ? T.amber : t.status === "RESOLVED" || t.status === "CLOSED" ? T.green : T.accent,
                    t.status === "OPEN" ? "#f59e0b22" : t.status === "RESOLVED" || t.status === "CLOSED" ? "#22c55e22" : "#0ea5e922")}>{t.status}</span>
                </div>
                <div style={{ fontSize: 13, color: T.sub, marginTop: 6 }}>{t.description}</div>
                {t.messages?.map((m: any) => (
                  <div key={m.id} style={{ fontSize: 13, marginTop: 8, padding: 8, background: T.row, borderRadius: 8 }}>
                    <span style={{ color: m.sentByType === "STAFF" ? T.accent : T.green, fontSize: 11, fontWeight: 700 }}>{m.sentByType === "STAFF" ? "SUPPORT" : "YOU"}</span>
                    <div style={{ color: T.sub }}>{m.message}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* ── MY ACCOUNT — recharge, password, connection history ── */}
        {tab === "My Account" && (
          <div style={{ display: "grid", gap: 14 }}>
            {note && (
              <div style={{
                ...card,
                borderColor: note.ok ? T.green : T.red,
                color: note.ok ? T.green : T.red,
                fontSize: 13, fontWeight: 600,
              }}>
                {note.text}
              </div>
            )}

            {/* Recharge — the dominant top-up method here: a scratch card
                bought from a shop, no bank or card needed. */}
            <div style={card}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Recharge with a voucher</div>
              <div style={{ fontSize: 12, color: T.muted, marginBottom: 10 }}>
                Enter the code from your scratch card. Credit is added to your balance and
                your service renews automatically when it expires.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  style={{ ...input, flex: "1 1 180px" }}
                  placeholder="Voucher code"
                  value={voucher.code}
                  onChange={(e) => setVoucher({ ...voucher, code: e.target.value })}
                />
                <input
                  style={{ ...input, flex: "0 1 120px" }}
                  placeholder="PIN (if any)"
                  value={voucher.pin}
                  onChange={(e) => setVoucher({ ...voucher, pin: e.target.value })}
                />
                <button style={btn(T.green)} disabled={busy} onClick={redeem}>
                  {busy ? "Please wait…" : "Recharge"}
                </button>
              </div>
            </div>

            {/* Password — pushed to RADIUS so it applies on reconnect. */}
            <div style={card}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Change your internet password</div>
              <div style={{ fontSize: 12, color: T.muted, marginBottom: 10 }}>
                This is the password your router uses to connect. It takes effect the next
                time you reconnect.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  style={{ ...input, flex: "1 1 160px" }}
                  type="password"
                  placeholder="Current password"
                  value={pwForm.currentPassword}
                  onChange={(e) => setPwForm({ ...pwForm, currentPassword: e.target.value })}
                />
                <input
                  style={{ ...input, flex: "1 1 160px" }}
                  type="password"
                  placeholder="New password"
                  value={pwForm.newPassword}
                  onChange={(e) => setPwForm({ ...pwForm, newPassword: e.target.value })}
                />
                <button style={btn(T.accent)} disabled={busy} onClick={changePassword}>
                  Update
                </button>
              </div>
            </div>

            {/* Connection history — answers "was I really offline last night?" */}
            <div style={card}>
              <div style={{ fontWeight: 700, marginBottom: 10 }}>Recent connections</div>
              {!sessions.length && (
                <div style={{ fontSize: 13, color: T.muted }}>No connection history yet.</div>
              )}
              {sessions.map((s, i) => (
                <div key={i} style={{
                  display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6,
                  padding: "8px 0", borderBottom: `1px solid ${T.row}`, fontSize: 13,
                }}>
                  <div>
                    <span style={{ color: s.online ? T.green : T.sub, fontWeight: 600 }}>
                      {s.online ? "● Online now" : fdt(s.startedAt)}
                    </span>
                    <div style={{ fontSize: 11, color: T.muted }}>
                      {s.ipAddress || "—"} · {hms(s.durationSeconds)}
                      {s.reason ? ` · ${s.reason}` : ""}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: T.sub, textAlign: "right" }}>
                    ↑ {gb(s.uploadBytes)}<br />↓ {gb(s.downloadBytes)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
