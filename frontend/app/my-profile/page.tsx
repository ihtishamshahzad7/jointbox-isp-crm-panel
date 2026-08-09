"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fileUrl } from "../components/image-upload";
import ImageUpload from "../components/image-upload";
import Avatar from "../components/avatar";
import API_BASE from "../components/api";

const API = API_BASE;

const T = {
  bg: "var(--bg)", card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)", sub: "var(--muted)",
  accent: "#0ea5e9", green: "#22c55e", amber: "#f59e0b", purple: "#8b5cf6",
};

const money = (n: number) => new Intl.NumberFormat().format(Math.round((n || 0) * 100) / 100);
const fdt = (d?: string | null) => (d ? new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");

export default function MyProfilePage() {
  const router = useRouter();
  const [p, setP] = useState<any>(null);
  const [editingPhoto, setEditingPhoto] = useState(false);
  const [saving, setSaving] = useState(false);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const load = useCallback(async () => {
    const r = await fetch(`${API}/users/me/profile`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401) { router.push("/login"); return; }
    if (r.ok) setP(await r.json());
  }, [token]);
  useEffect(() => { if (!token) { router.push("/login"); return; } load(); }, []);

  /**
   * Save the new photo, then refresh both this page AND the header avatar.
   * The header reads its own /auth/profile, so we fire a window event it
   * listens for rather than reloading the whole app.
   */
  const savePhoto = useCallback(async (url: string) => {
    setSaving(true);
    try {
      await fetch(`${API}/users/me/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ photoUrl: url }),
      });
      setP((prev: any) => ({ ...prev, photoUrl: url }));
      setEditingPhoto(false);
      window.dispatchEvent(new Event("profile-photo-changed"));
    } finally { setSaving(false); }
  }, [token]);

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 };
  const rowLabel: React.CSSProperties = { color: T.muted, fontSize: 12 };
  const rowVal: React.CSSProperties = { color: T.text, fontSize: 13, fontWeight: 600 };

  const Row = ({ k, v }: { k: string; v: any }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${T.border}` }}>
      <span style={rowLabel}>{k}</span><span style={rowVal}>{v ?? "—"}</span>
    </div>
  );

  if (!p) return <div style={{ padding: 24, color: T.muted }}>Loading your profile…</div>;

  const counts = [
    ["Packages", p.counts?.packages, T.accent],
    ["Subscribers", p.counts?.subscribers, T.green],
    ["Staff", p.counts?.staff, T.sub],
    ["Resellers", p.counts?.resellers, T.purple],
    ["Subresellers", p.counts?.subResellers, T.accent],
    ["Retailers", p.counts?.retailers, T.amber],
    ["Balance", money(p.balance), T.green],
  ];

  return (
    <div style={{ padding: 20, color: T.text }}>
      {/* Header */}
      <div style={{ ...card, marginBottom: 16, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        {/* Avatar with a hover "change" affordance. */}
        <div style={{ position: "relative", flex: "none" }}>
          <Avatar name={p.name} photoUrl={p.photoUrl} size={56} />
          <button
            onClick={() => setEditingPhoto((v) => !v)}
            title="Change profile picture"
            aria-label="Change profile picture"
            style={{
              position: "absolute", right: -2, bottom: -2, width: 22, height: 22,
              borderRadius: "50%", border: "2px solid var(--surface)", background: "#3C50E0",
              color: "#fff", cursor: "pointer", display: "flex", alignItems: "center",
              justifyContent: "center", padding: 0, fontSize: 11,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        </div>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>{p.name}</div>
          <div style={{ fontSize: 12, color: T.muted }}>{p.role} · created by {p.createdBy}</div>
        </div>
        <div style={{ marginLeft: "auto", fontSize: 12, color: p.isActive ? T.green : T.amber, fontWeight: 700 }}>
          {p.isActive ? "● Active" : "○ Inactive"}
        </div>
      </div>

      {/* Photo editor — appears under the header when the pencil is clicked. */}
      {editingPhoto && (
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Profile picture</div>
          <ImageUpload
            label="Upload a photo"
            shape="avatar"
            value={p.photoUrl || ""}
            onChange={(url) => savePhoto(url)}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            {p.photoUrl && (
              <button onClick={() => savePhoto("")} disabled={saving}
                style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.muted, borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer" }}>
                Remove photo
              </button>
            )}
            <button onClick={() => setEditingPhoto(false)}
              style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.muted, borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer" }}>
              Done
            </button>
            {saving && <span style={{ fontSize: 12, color: T.muted, alignSelf: "center" }}>Saving…</span>}
          </div>
        </div>
      )}

      {/* Count tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 12, marginBottom: 16 }}>
        {counts.map(([label, val, color]) => (
          <div key={label as string} style={card}>
            <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4, color: color as string }}>{val ?? 0}</div>
          </div>
        ))}
      </div>

      {/* Detail grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16 }}>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Organization</div>
          <Row k="ISP" v={p.isp} />
          <Row k="Branch" v={p.branchName} />
          <Row k="Created By" v={p.createdBy} />
        </div>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Profile details</div>
          <Row k="Full name" v={p.name} />
          <Row k="Role" v={p.role} />
          <Row k="Status" v={p.isActive ? "Active" : "Inactive"} />
          <Row k="Commission %" v={p.commissionPercent} />
        </div>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Contact</div>
          <Row k="Phone" v={p.phone} />
          <Row k="Email" v={p.email} />
          <Row k="Address" v={p.address} />
        </div>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Permissions &amp; wallet</div>
          <Row k="Wallet balance" v={money(p.balance)} />
          <Row k="Can add balance to downline" v={p.canTopupDownline ? "Yes" : "No"} />
        </div>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Activity</div>
          <Row k="Join date" v={fdt(p.createdAt)} />
          <Row k="Last login" v={fdt(p.lastLogin)} />
          <Row k="Last login IP" v={p.lastLoginIp} />
        </div>
        <div style={{ ...card, gridColumn: "1 / -1" }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Identity documents (CNIC)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            {[["CNIC — Front", p.cnicFrontUrl], ["CNIC — Back", p.cnicBackUrl]].map(([lbl, url]: any) => (
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
      </div>
    </div>
  );
}
