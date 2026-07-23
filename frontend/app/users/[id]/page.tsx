"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { fileUrl } from "../../components/image-upload";
import { RecordNotes } from "../../components/record-notes";

const API = process.env.NEXT_PUBLIC_BACKEND_URL || (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

const T = {
  bg: "var(--bg)", card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)", sub: "var(--muted)",
  accent: "#0ea5e9", green: "#22c55e", amber: "#f59e0b", purple: "#8b5cf6", red: "#ef4444",
};
const money = (n: number) => new Intl.NumberFormat().format(Math.round((n || 0) * 100) / 100);
const fdt = (d?: string | null) => (d ? new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");

export default function UserProfilePage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [u, setU] = useState<any>(null);
  const [err, setErr] = useState("");

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const load = useCallback(async () => {
    const r = await fetch(`${API}/users/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401) { router.push("/login"); return; }
    if (!r.ok) { setErr((await r.json())?.message || "Not allowed or not found"); return; }
    setU(await r.json());
  }, [id, token]);
  useEffect(() => { if (!token) { router.push("/login"); return; } load(); }, [id]);

  // Act as this account — same impersonation flow as the top-bar switcher, but
  // reachable straight from the profile you're looking at. The backend enforces
  // that the target is inside your own downline.
  const switchAs = async () => {
    if (!confirm(`View the panel as ${u.name}? You'll see exactly what they see. Use "Stop acting as" to return.`)) return;
    setErr("");
    const r = await fetch(`${API}/auth/impersonate/${id}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const data = await r.json();
      localStorage.setItem("token", data.token);
      window.location.href = "/dashboard";
    } else {
      setErr((await r.json().catch(() => ({})))?.message || "Cannot switch into this account.");
    }
  };

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 };
  const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", color: T.muted, fontSize: 11, textTransform: "uppercase" };
  const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, color: T.text };
  const Row = ({ k, v }: { k: string; v: any }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${T.border}` }}>
      <span style={{ color: T.muted, fontSize: 12 }}>{k}</span><span style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>{v ?? "—"}</span>
    </div>
  );

  if (err) return <div style={{ padding: 24, color: T.amber }}>{err}</div>;
  if (!u) return <div style={{ padding: 24, color: T.muted }}>Loading profile…</div>;

  const counts = [
    ["Subscribers", u._count?.ownedSubscribers ?? 0, T.green],
    ["Downline", u._count?.children ?? 0, T.purple],
    ["Payments", u._count?.payments ?? 0, T.accent],
    ["Tickets", u._count?.assignedTickets ?? 0, T.amber],
    ["Balance", money(u.balance), T.green],
  ];

  return (
    <div style={{ padding: 20, color: T.text }}>
      <button onClick={() => router.push("/users")} style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.sub, borderRadius: 8, padding: "5px 12px", fontSize: 12, cursor: "pointer", marginBottom: 14 }}>← Back to Users</button>

      <div style={{ ...card, marginBottom: 16, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        {u.photoUrl ? (
          <img src={fileUrl(u.photoUrl)} alt={u.name} style={{ width: 56, height: 56, borderRadius: "50%", objectFit: "cover", border: `2px solid ${T.border}` }} />
        ) : (
          <div style={{ width: 56, height: 56, borderRadius: "50%", background: "linear-gradient(135deg,#0ea5e9,#2563eb)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 800, color: "#fff" }}>
            {(u.name || "U").split(" ").map((s: string) => s[0]).join("").slice(0, 2).toUpperCase()}
          </div>
        )}
        <div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>{u.name}</div>
          <div style={{ fontSize: 12, color: T.muted }}>{u.role} · created by {u.parent?.name || "—"}</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 12, color: u.isActive ? T.green : T.amber, fontWeight: 700 }}>{u.isActive ? "● Active" : "○ Inactive"}</span>
          {/* Jump straight into this account's view (impersonation). */}
          <button onClick={switchAs}
            style={{ display: "inline-flex", alignItems: "center", gap: 7, border: "none", cursor: "pointer", borderRadius: 9, padding: "8px 14px", fontSize: 12.5, fontWeight: 700, color: "#fff", background: "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)", boxShadow: "0 4px 14px rgba(233,64,139,0.3)" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
            Switch as
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 12, marginBottom: 16 }}>
        {counts.map(([label, val, color]) => (
          <div key={label as string} style={card}>
            <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase" }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4, color: color as string }}>{val}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16, marginBottom: 16 }}>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Profile details</div>
          <Row k="Full name" v={u.name} />
          <Row k="Role" v={u.role} />
          <Row k="Status" v={u.isActive ? "Active" : "Inactive"} />
          <Row k="Created by" v={u.parent?.name} />
        </div>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Contact</div>
          <Row k="Phone" v={u.phone} />
          <Row k="Email" v={u.email} />
          <Row k="Address" v={u.address} />
        </div>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Wallet</div>
          <Row k="Balance" v={money(u.balance)} />
          <Row k="Commission %" v={u.commissionPercent} />
          <Row k="Joined" v={fdt(u.createdAt)} />
        </div>
      </div>

      {/* Notes */}
      <div style={{ ...card, marginBottom: 16 }}>
        <RecordNotes entityType="USER" entityId={u.id} title="Notes" />
      </div>

      {/* Identity documents */}
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Identity documents (CNIC)</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          {[["CNIC — Front", u.cnicFrontUrl], ["CNIC — Back", u.cnicBackUrl]].map(([lbl, url]: any) => (
            <div key={lbl} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 11, color: T.muted, textTransform: "uppercase" }}>{lbl}</span>
              {url ? (
                <a href={fileUrl(url)} target="_blank" rel="noreferrer">
                  <img src={fileUrl(url)} alt={lbl} style={{ width: 200, height: 126, objectFit: "cover", borderRadius: 8, border: `1px solid ${T.border}` }} />
                </a>
              ) : (
                <div style={{ width: 200, height: 126, borderRadius: 8, border: `1px dashed ${T.border}`, background: T.row, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: T.muted }}>Not uploaded</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Downline */}
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Downline accounts ({u.children?.length ?? 0})</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: `1px solid ${T.border}` }}><th style={th}>Name</th><th style={th}>Role</th><th style={{ ...th, textAlign: "right" }}>Balance</th><th style={{ ...th, textAlign: "right" }}>Subs</th></tr></thead>
          <tbody>
            {(u.children || []).map((c: any) => (
              <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => router.push(`/users/${c.id}`)}>
                <td style={{ ...td, color: T.accent }}>{c.name}</td>
                <td style={{ ...td, color: T.sub }}>{c.role}</td>
                <td style={{ ...td, textAlign: "right" }}>{money(c.balance)}</td>
                <td style={{ ...td, textAlign: "right" }}>{c._count?.ownedSubscribers ?? 0}</td>
              </tr>
            ))}
            {(!u.children || u.children.length === 0) && <tr><td style={{ ...td, color: T.muted }} colSpan={4}>No downline accounts.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Recent subscribers */}
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Recent subscribers</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: `1px solid ${T.border}` }}><th style={th}>Name</th><th style={th}>Phone</th><th style={th}>Status</th><th style={th}>Package</th></tr></thead>
          <tbody>
            {(u.subscribers || []).map((s: any) => (
              <tr key={s.id}><td style={td}>{s.fullName}</td><td style={{ ...td, color: T.sub }}>{s.phone}</td><td style={{ ...td, color: T.sub }}>{s.status}</td><td style={{ ...td, color: T.sub }}>{s.package?.name || "—"}</td></tr>
            ))}
            {(!u.subscribers || u.subscribers.length === 0) && <tr><td style={{ ...td, color: T.muted }} colSpan={4}>No subscribers.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
