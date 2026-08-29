"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { fileUrl } from "../../components/image-upload";
import { RecordNotes } from "../../components/record-notes";
import { silent } from "../../components/silent";
import API_BASE from "../../components/api";
import { money as moneyWithCurrency } from "../../components/currency";
import Portal from "../../components/portal";

const API = API_BASE;

const T = {
  bg: "var(--bg)", card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)", sub: "var(--muted)",
  accent: "#0ea5e9", green: "#22c55e", amber: "#f59e0b", purple: "#8b5cf6", red: "#ef4444",
};
const money = (n: number) => new Intl.NumberFormat().format(Math.round((n || 0) * 100) / 100);
const fdt = (d?: string | null) => (d ? new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const isAdminRole = (role?: string) => role === "ADMIN" || role === "SUPER_ADMIN";

type Tab = "profile" | "reports" | "packages" | "ledgers" | "subscribers" | "documents" | "invoice" | "nas-bindings" | "activity";

export default function UserProfilePage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [u, setU] = useState<any>(null);
  const [me, setMe] = useState<any>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>("profile");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showAddBalance, setShowAddBalance] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [invShowLogo, setInvShowLogo] = useState(true);
  const [invShowAddress, setInvShowAddress] = useState(true);
  const [invShowPhone, setInvShowPhone] = useState(true);
  const [invShowEmail, setInvShowEmail] = useState(true);

  // User packages (assign pricing)
  const [userPkgs, setUserPkgs] = useState<any[]>([]);
  const [loadingPkgs, setLoadingPkgs] = useState(false);

  const toast_ = (msg: string, type: "ok" | "err" = "ok") => { setToast({ msg, type }); setTimeout(() => setToast(null), 2600); };

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  const load = useCallback(async () => {
    const r = await fetch(`${API}/users/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401) { router.push("/login"); return; }
    if (!r.ok) { setErr((await r.json())?.message || "Not allowed or not found"); return; }
    setU(await r.json());
  }, [id, token]);
  useEffect(() => { if (!token) { router.push("/login"); return; } load(); }, [id]);

  // Load current user for role checks
  useEffect(() => {
    if (!token) return;
    fetch(`${API}/auth/profile`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMe(d?.user ?? d))
      .catch(silent("authProfileFetch"));
  }, []);

  const loadPkgs = useCallback(async () => {
    setLoadingPkgs(true);
    try {
      const r = await fetch(`${API}/users/${id}/packages`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setUserPkgs(await r.json());
    } catch (_) {}
    setLoadingPkgs(false);
  }, [id, token]);

  useEffect(() => { if (tab === "packages") loadPkgs(); }, [tab]);

  /**
   * What this account has actually been doing.
   *
   * The endpoint already supported `forUser`, but only the central Logs page
   * consumed it — so answering "what did this dealer change last week" meant
   * leaving the profile, opening Logs, and filtering. Loaded lazily: an audit
   * trail is worth a query only when someone asks for it.
   */
  const [activity, setActivity] = useState<any[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [activityErr, setActivityErr] = useState("");

  const loadActivity = useCallback(async () => {
    setLoadingActivity(true);
    setActivityErr("");
    try {
      const r = await fetch(`${API}/logs/activity?limit=100&forUser=${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) { setActivityErr("Could not load this account's activity."); setLoadingActivity(false); return; }
      const d = await r.json();
      setActivity(Array.isArray(d?.logs) ? d.logs : []);
    } catch {
      setActivityErr("Could not load this account's activity.");
    }
    setLoadingActivity(false);
  }, [id, token]);

  useEffect(() => { if (tab === "activity") loadActivity(); }, [tab, loadActivity]);

  const savePkgPrice = async (pkgId: number, field: string, value: number | null) => {
    const pkg = userPkgs.find((p: any) => p.id === pkgId);
    const body: any = { price: pkg?.price ?? 0 };
    if (field === "price") body.price = value ?? 0;
    else if (field === "retailPrice") body.retailPrice = value;
    else if (field === "subresellerProfit") body.subresellerProfit = value;
    else if (field === "subscriberProfit") body.subscriberProfit = value;
    if (pkg?.price && body.price === undefined) body.price = pkg.price;
    const r = await fetch(`${API}/users/${id}/packages/${pkgId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) { toast_("Failed to save price", "err"); return; }
    toast_("Price updated");
    loadPkgs();
  };

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

  const isAdmin = isAdminRole(me?.role);

  if (err) return <div style={{ padding: 24, color: T.amber }}>{err}</div>;
  if (!u) return <div style={{ padding: 24, color: T.muted }}>Loading profile…</div>;

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 };
  const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", color: T.muted, fontSize: 11, textTransform: "uppercase" };
  const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, color: T.text };
  const Row = ({ k, v }: { k: string; v: any }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${T.border}` }}>
      <span style={{ color: T.muted, fontSize: 12 }}>{k}</span>
      <span style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>{v ?? "—"}</span>
    </div>
  );

  const TAB_NAMES: { key: Tab; label: string }[] = [
    { key: "profile", label: "Profile" },
    { key: "reports", label: "Reports" },
    { key: "packages", label: "Packages" },
    { key: "ledgers", label: "Ledgers" },
    { key: "subscribers", label: "Subscribers" },
    { key: "documents", label: "Documents" },
    { key: "invoice", label: "Invoice Template" },
    { key: "nas-bindings", label: "Interface/NAS Bindings" },
    { key: "activity", label: "Activity" },
  ];

  return (
    <div style={{ padding: 20, color: T.text }}>
      {toast && (
        <div style={{
          position: "fixed", right: 24, bottom: 24, zIndex: 100, padding: "14px 24px", borderRadius: 12,
          border: "1px solid", fontSize: 13, fontWeight: 500, boxShadow: "0 8px 32px rgba(0,0,0,0.4)", maxWidth: 400,
          background: toast.type === "ok" ? "rgba(16,185,129,0.08)" : "rgba(255,112,112,0.08)",
          borderColor: toast.type === "ok" ? "rgba(16,185,129,0.25)" : "rgba(255,112,112,0.25)",
          color: toast.type === "ok" ? "#10B981" : "#ff7070",
        }}>{toast.msg}</div>
      )}

      <button onClick={() => router.push("/users")}
        style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.sub, borderRadius: 8, padding: "5px 12px", fontSize: 12, cursor: "pointer", marginBottom: 14 }}>← Back to Users</button>

      {/* ── HEADER – avatar, name, role badges, switch-as ── */}
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
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
            <span style={{ padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 700, background: "rgba(139,92,246,0.15)", color: "#a78bfa" }}>{u.role}</span>
            {u.isActive ? (
              <span style={{ padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 700, background: "rgba(34,197,94,0.15)", color: T.green }}>Active</span>
            ) : (
              <span style={{ padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 700, background: "rgba(245,158,11,0.15)", color: T.amber }}>Inactive</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>Created by {u.parent?.name || "—"}</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          {isAdmin && (
            <button onClick={() => setShowEditModal(true)}
              style={{ border: "1px solid rgba(255,255,255,0.08)", cursor: "pointer", borderRadius: 9, padding: "8px 14px", fontSize: 12.5, fontWeight: 700, background: "rgba(255,255,255,0.06)", color: T.text }}>
              ✏️ Update User
            </button>
          )}
          <button onClick={switchAs}
            style={{ display: "inline-flex", alignItems: "center", gap: 7, border: "none", cursor: "pointer", borderRadius: 9, padding: "8px 14px", fontSize: 12.5, fontWeight: 700, color: "#fff", background: "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)", boxShadow: "0 4px 14px rgba(233,64,139,0.3)" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
            Switch as
          </button>
        </div>
      </div>

      {/* ── STAT CARDS ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, marginBottom: 16 }}>
        {[
          { label: "Packages", val: u._count?.ownedPackages ?? 0, color: T.accent },
          { label: "Subscribers", val: u._count?.ownedSubscribers ?? u._count?.subscribers ?? 0, color: T.green },
          { label: "Subresellers", val: u._count?.subresellers ?? 0, color: T.purple },
          { label: "Retailers", val: u._count?.retailers ?? 0, color: T.amber },
          { label: "Balance", val: money(u.balance), color: T.green },
        ].map((s) => (
          <div key={s.label} style={card}>
            <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase" }}>{s.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4, color: s.color }}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* ── TABS ── */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: `1px solid ${T.border}`, paddingBottom: 0, flexWrap: "wrap" }}>
        {TAB_NAMES.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              padding: "10px 18px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", borderRadius: "10px 10px 0 0",
              border: "none", background: tab === t.key ? T.card : "transparent",
              color: tab === t.key ? T.text : T.muted, borderBottom: tab === t.key ? `2px solid ${T.accent}` : "2px solid transparent",
              transition: "all 0.15s ease",
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ============================================================ */}
      {/* TAB: PROFILE */}
      {/* ============================================================ */}
      {tab === "profile" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 16 }}>
          {/* Organization */}
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Organization</div>
            <Row k="ISP" v={u.branch?.isp?.name} />
            <Row k="Branch" v={u.branch?.name} />
            <Row k="Created By" v={u.parent?.name ? `${u.parent.name} (${u.parent.role})` : "—"} />
          </div>

          {/* Profile Details */}
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Profile Details</div>
            <Row k="Full Name" v={u.name} />
            <Row k="Email" v={u.email} />
            <Row k="Username" v={u.email?.split("@")[0]} />
            <Row k="Role & Permission" v={u.role} />
            <Row k="Profile Status" v={u.isActive ? "Active" : "Inactive"} />
          </div>

          {/* Contact Information */}
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Contact Information</div>
            <Row k="Phone" v={u.phone} />
            <Row k="Email" v={u.email} />
            <Row k="Identity" v={u.identity} />
            <Row k="SMS Status" v={u.smsEnabled ? "Active" : "Inactive"} />
            <Row k="Email Status" v={u.emailEnabled ? "Active" : "Inactive"} />
          </div>

          {/* Profile Settings */}
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Profile Settings</div>
            <Row k="Auto Renew" v={u.autoRenew ? "Enabled" : "Disabled"} />
            {!u.autoRenew && (
              <div style={{ fontSize: 11, color: T.amber, marginTop: 2, fontStyle: "italic" }}>
                If Auto Renew is disabled, the user's subscribers will not be renewed automatically.
              </div>
            )}
            {u.additionalPhones && (
              <Row k="Additional Phones" v={(() => { try { return JSON.parse(u.additionalPhones).join(", "); } catch { return u.additionalPhones; } })()} />
            )}
            {u.additionalEmails && (
              <Row k="Additional Emails" v={(() => { try { return JSON.parse(u.additionalEmails).join(", "); } catch { return u.additionalEmails; } })()} />
            )}
            <Row k="Commission %" v={u.commissionPercent != null ? `${u.commissionPercent}%` : "0%"} />
          </div>

          {/* Interface / NAS Bindings */}
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Interface/NAS Bindings</div>
            <Row k="NAS Group" v={u.nasGroup || "—"} />
            <Row k="Area Group" v={u.areaGroup || "—"} />
          </div>

          {/* Preferences */}
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Preferences</div>
            <Row k="Billing Type" v={u.billingType || "PREPAID"} />
            <Row k="Accounting Limit" v={u.accountingLimit != null ? money(u.accountingLimit) : "—"} />
            {u.about && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase", marginBottom: 4 }}>About</div>
                <div style={{ fontSize: 13, color: T.text, background: T.row, borderRadius: 8, padding: "8px 12px" }}>{u.about}</div>
              </div>
            )}
          </div>

          {/* Address */}
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Location</div>
            <Row k="Address" v={u.address} />
            <Row k="City" v={u.city} />
            <Row k="Province" v={u.province} />
            <Row k="Country" v={u.country} />
            <Row k="Zip Code" v={u.zipCode} />
          </div>

          {/* Activity */}
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Activity</div>
            <Row k="Join Date" v={fdt(u.createdAt)} />
            <Row k="Last Login" v={fdt(u.lastLogin)} />
          </div>

          {/* Notes */}
          <div style={card}>
            <RecordNotes entityType="USER" entityId={u.id} title="Notes" />
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* TAB: REPORTS */}
      {/* ============================================================ */}
      {tab === "reports" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
          {[
            { label: "Total Subscribers", val: u._count?.ownedSubscribers ?? u._count?.subscribers ?? 0, color: T.accent },
            { label: "Total Payments", val: u.payments?.length ?? 0, color: T.green },
            { label: "Total Downline", val: (u._count?.subresellers ?? 0) + (u._count?.retailers ?? 0), color: T.purple },
            { label: "Tickets Assigned", val: u._count?.tickets ?? 0, color: T.amber },
          ].map((s) => (
            <div key={s.label} style={card}>
              <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase" }}>{s.label}</div>
              <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6, color: s.color }}>{s.val}</div>
            </div>
          ))}
        </div>
      )}

      {/* ============================================================ */}
      {/* TAB: PACKAGES */}
      {/* ============================================================ */}
      {tab === "packages" && (
        <div>
          <div style={{ ...card, marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Assign Packages</div>
            <div style={{ fontSize: 11, color: T.muted }}>
              Assign package price higher than parent package price.<br />
              <span style={{ color: T.amber }}>Minimum Price</span> = what this account's parent pays. <span style={{ color: T.accent }}>Price</span> = what this account charges its downline.
            </div>
          </div>

          {loadingPkgs ? (
            <div style={{ padding: 40, textAlign: "center", color: T.muted }}>Loading packages…</div>
          ) : userPkgs.length === 0 ? (
            <div style={{ ...card, textAlign: "center", padding: 40, color: T.muted }}>No packages available for this user.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {userPkgs.map((pkg: any) => {
                const definedPrice = pkg.price != null ? Number(pkg.price) : null;
                const definedRetail = pkg.retailPrice != null ? Number(pkg.retailPrice) : null;
                const definedSubPft = pkg.subresellerProfit != null ? Number(pkg.subresellerProfit) : null;
                const definedSubsPft = pkg.subscriberProfit != null ? Number(pkg.subscriberProfit) : null;
                const minPrice = pkg.minimumPrice ?? 0;

                return (
                  <div key={pkg.id} style={card}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.accent, marginBottom: 8 }}>
                      Package #{pkg.id} — {pkg.name}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
                      <Field label="Minimum Price" val={money(minPrice)} />
                      <EditableField label="Price" val={definedPrice} min={minPrice} placeholder="Enter Price"
                        onChange={(v) => savePkgPrice(pkg.id, "price", v)} />
                      <EditableField label="Subresellers Profit" val={definedSubPft}
                        placeholder="Enter Profit" onChange={(v) => savePkgPrice(pkg.id, "subresellerProfit", v)} />
                      <EditableField label="Subscriber Profit" val={definedSubsPft}
                        placeholder="Enter Profit" onChange={(v) => savePkgPrice(pkg.id, "subscriberProfit", v)} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* TAB: LEDGERS */}
      {/* ============================================================ */}
      {tab === "ledgers" && (
        <div>
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Wallet</div>
            <Row k="Current Balance" v={money(u.balance)} />
            {isAdmin && (
              <div style={{ marginTop: 12 }}>
                <button onClick={() => setShowAddBalance(true)}
                  style={{ padding: "8px 16px", borderRadius: 8, border: "none", cursor: "pointer", background: T.green, color: "#fff", fontWeight: 600, fontSize: 12 }}>
                  Add Balance
                </button>
              </div>
            )}
          </div>
          <div style={{ ...card, marginTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Recent Payments ({u.payments?.length ?? 0})</div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: `1px solid ${T.border}` }}>
                <th style={th}>Date</th><th style={th}>Amount</th><th style={th}>Method</th><th style={th}>Invoice</th>
              </tr></thead>
              <tbody>
                {(u.payments || []).map((p: any) => (
                  <tr key={p.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ ...td, color: T.sub }}>{fdt(p.paymentDate)}</td>
                    <td style={{ ...td, fontWeight: 700, color: T.green }}>{money(p.amount)}</td>
                    <td style={{ ...td, color: T.sub }}>{p.method}</td>
                    <td style={{ ...td, color: T.sub }}>{p.invoice?.invoiceNo || "—"}</td>
                  </tr>
                ))}
                {(!u.payments || u.payments.length === 0) && <tr><td style={{ ...td, color: T.muted }} colSpan={4}>No payments.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* TAB: SUBSCRIBERS */}
      {/* ============================================================ */}
      {tab === "subscribers" && (
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>All Subscribers ({u._count?.ownedSubscribers ?? 0})</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `1px solid ${T.border}` }}>
              <th style={th}>Name</th><th style={th}>Phone</th><th style={th}>Status</th><th style={th}>Package</th>
            </tr></thead>
            <tbody>
              {(u.subscribers || []).map((s: any) => (
                <tr key={s.id} style={{ cursor: "pointer", borderBottom: `1px solid ${T.border}` }}
                  onClick={() => router.push(`/subscribers/${s.id}`)}>
                  <td style={{ ...td, color: T.accent }}>{s.fullName}</td>
                  <td style={{ ...td, color: T.sub }}>{s.phone}</td>
                  <td style={{ ...td }}>
                    <span style={{ padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 700,
                      background: s.status === "ACTIVE" ? "rgba(34,197,94,0.15)" : "rgba(245,158,11,0.15)",
                      color: s.status === "ACTIVE" ? T.green : T.amber }}>{s.status}</span>
                  </td>
                  <td style={{ ...td, color: T.sub }}>{s.package?.name || "—"}</td>
                </tr>
              ))}
              {(!u.subscribers || u.subscribers.length === 0) && <tr><td style={{ ...td, color: T.muted }} colSpan={4}>No subscribers.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* ============================================================ */}
      {/* TAB: DOCUMENTS */}
      {/* ============================================================ */}
      {tab === "documents" && (
        <div style={{ ...card }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Identity Documents (CNIC)</div>
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
      )}

      {/* ============================================================ */}
      {/* TAB: INVOICE TEMPLATE */}
      {/* ============================================================ */}
      {tab === "invoice" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 16 }}>
          {/* Invoice Preview */}
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Invoice Preview</div>
            <div style={{
              background: T.row, borderRadius: 12, padding: 24, border: `1px solid ${T.border}`,
              maxWidth: 400,
            }}>
              {invShowLogo && (
                <div style={{ fontSize: 20, fontWeight: 800, color: T.accent, marginBottom: 12, letterSpacing: "-0.02em" }}>
                  {u.branch?.isp?.name || "JointBox ISP"}
                </div>
              )}
              <div style={{ fontSize: 18, fontWeight: 700, color: T.text, marginBottom: 4 }}>INVOICE</div>
              <div style={{ fontSize: 11, color: T.muted, marginBottom: 12 }}>Invoice #INV-{String(u.id).padStart(4, "0")} / {new Date().toLocaleDateString()}</div>
              <div style={{ borderTop: `2px solid ${T.border}`, paddingTop: 14, marginTop: 4 }}>
                <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase", marginBottom: 6 }}>Bill To:</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{u.name}</div>
                {invShowAddress && u.address && <div style={{ fontSize: 12, color: T.sub, marginTop: 2 }}>{u.address}</div>}
                {invShowAddress && u.city && <div style={{ fontSize: 12, color: T.sub }}>{u.city}{u.province ? `, ${u.province}` : ""}</div>}
                {invShowPhone && u.phone && <div style={{ fontSize: 12, color: T.sub, marginTop: 2 }}>{u.phone}</div>}
                {invShowEmail && u.email && <div style={{ fontSize: 12, color: T.sub }}>{u.email}</div>}
              </div>
              <div style={{ borderTop: `1px dashed ${T.border}`, marginTop: 14, paddingTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T.muted, paddingBottom: 6 }}>
                  <span>Description</span><span>Amount</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, color: T.text, padding: "6px 0" }}>
                  <span>Internet Subscription — Monthly</span><span style={{ color: T.green }}>{moneyWithCurrency(1500)}</span>
                </div>
                <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 6, paddingTop: 10, display: "flex", justifyContent: "space-between", fontSize: 16, fontWeight: 800, color: T.text }}>
                  <span>Total Due</span><span style={{ color: T.green }}>{moneyWithCurrency(1500)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Template Settings */}
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Template Settings</div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 16 }}>
              Configure which fields appear on invoices generated for this account.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <Toggle label="Show Logo / ISP Name" val={invShowLogo} onChange={() => setInvShowLogo(!invShowLogo)} />
              <Toggle label="Show Address Details" val={invShowAddress} onChange={() => setInvShowAddress(!invShowAddress)} />
              <Toggle label="Show Phone Number" val={invShowPhone} onChange={() => setInvShowPhone(!invShowPhone)} />
              <Toggle label="Show Email Address" val={invShowEmail} onChange={() => setInvShowEmail(!invShowEmail)} />
            </div>
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 11, color: T.muted, fontStyle: "italic" }}>
                Invoice template customization will be saved once the backend supports it.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* TAB: NAS BINDINGS */}
      {/* ============================================================ */}
      {tab === "nas-bindings" && (
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Interface/NAS Device Assignments</div>
          {u.nasAssignments && u.nasAssignments.length > 0 ? (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  <th style={th}>NAS Name</th>
                  <th style={th}>IP Address</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {u.nasAssignments.map((nas: any, idx: number) => (
                  <tr key={nas.id || idx} style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ ...td, color: T.accent, fontWeight: 600 }}>{nas.name || nas.nasName || "—"}</td>
                    <td style={{ ...td, color: T.sub }}>{nas.ipAddress || nas.ip || "—"}</td>
                    <td style={{ ...td }}>
                      <span style={{
                        padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 700,
                        background: (nas.status === "ACTIVE" || nas.status === "ONLINE") ? "rgba(34,197,94,0.15)" : "rgba(245,158,11,0.15)",
                        color: (nas.status === "ACTIVE" || nas.status === "ONLINE") ? T.green : T.amber,
                      }}>
                        {nas.status || "UNKNOWN"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ textAlign: "center", padding: 40, color: T.muted }}>
              No NAS devices assigned to this account.
            </div>
          )}
        </div>
      )}

      {/* ── ACTIVITY ── what this account has been doing ── */}
      {tab === "activity" && (
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Activity by this account</div>
            <button
              onClick={loadActivity}
              disabled={loadingActivity}
              style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.sub, borderRadius: 8, padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: loadingActivity ? "not-allowed" : "pointer" }}
            >
              {loadingActivity ? "Loading…" : "Refresh"}
            </button>
          </div>

          {activityErr ? (
            <div style={{ textAlign: "center", padding: 40, color: T.muted }}>{activityErr}</div>
          ) : loadingActivity && activity.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: T.muted }}>Loading…</div>
          ) : activity.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: T.muted }}>
              Nothing recorded for this account yet.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                    <th style={th}>When</th>
                    <th style={th}>Action</th>
                    <th style={th}>On</th>
                    <th style={th}>Details</th>
                    <th style={th}>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((a: any) => (
                    <tr key={a.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                      <td style={{ ...td, color: T.sub, whiteSpace: "nowrap" }}>{fdt(a.createdAt)}</td>
                      <td style={td}>
                        <span style={{
                          padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 700,
                          // Destructive and money-moving actions read differently
                          // from routine ones — this is an audit trail, and the
                          // eye should land on what changed something.
                          background: /DELETE|REVERSE|REFUND|REVOKE|DISCONNECT/i.test(a.action || "")
                            ? "rgba(239,68,68,0.15)"
                            : /CREATE|TOPUP|ACTIVAT/i.test(a.action || "")
                              ? "rgba(34,197,94,0.15)"
                              : "rgba(148,163,184,0.15)",
                          color: /DELETE|REVERSE|REFUND|REVOKE|DISCONNECT/i.test(a.action || "")
                            ? T.red
                            : /CREATE|TOPUP|ACTIVAT/i.test(a.action || "")
                              ? T.green
                              : T.sub,
                        }}>
                          {a.action || "—"}
                        </span>
                      </td>
                      <td style={{ ...td, color: T.sub }}>
                        {a.entity ? `${a.entity}${a.entityId ? ` #${a.entityId}` : ""}` : "—"}
                      </td>
                      <td style={{ ...td, color: T.sub, maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.details || ""}>
                        {a.details || "—"}
                      </td>
                      <td style={{ ...td, color: T.muted, whiteSpace: "nowrap" }}>{a.ipAddress || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {activity.length >= 100 && (
                <div style={{ fontSize: 11, color: T.muted, marginTop: 10, lineHeight: 1.7 }}>
                  Showing the 100 most recent entries. Use Logs &rarr; Activity for the full
                  history and filtering.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* UPDATE USER MODAL */}
      {/* ============================================================ */}
      {showEditModal && <UpdateUserModal
        user={u}
        token={token}
        onClose={() => setShowEditModal(false)}
        onSaved={(updated) => { setU(updated); setShowEditModal(false); toast_("User updated"); }}
        onError={(msg) => toast_(msg, "err")}
      />}

      {/* ============================================================ */}
      {/* ADD BALANCE MODAL */}
      {/* ============================================================ */}
      {showAddBalance && <AddBalanceModal
        userId={u.id}
        userName={u.name}
        token={token}
        onClose={() => setShowAddBalance(false)}
        onDone={() => { setShowAddBalance(false); load(); toast_("Balance updated"); }}
        onError={(m) => toast_(m, "err")}
      />}
    </div>
  );
}

// ─── Editable number field inline ──────────────────────────────────
function Field({ label, val }: { label: string; val: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: T.muted, textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{val}</span>
    </div>
  );
}

function EditableField({ label, val, min, placeholder, onChange }: {
  label: string; val: number | null; min?: number; placeholder: string;
  onChange: (v: number | null) => Promise<void>;
}) {
  const [edit, setEdit] = useState(false);
  const [input, setInput] = useState(val != null ? String(val) : "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const v = input.trim() === "" ? null : Number(input);
    await onChange(v);
    setEdit(false);
    setSaving(false);
  };

  if (!edit) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2, cursor: "pointer" }} onClick={() => { setInput(val != null ? String(val) : ""); setEdit(true); }}>
        <span style={{ fontSize: 10, color: T.muted, textTransform: "uppercase" }}>{label}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: val != null ? T.text : T.amber }}>
          {val != null ? new Intl.NumberFormat().format(val) : placeholder}
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: T.muted, textTransform: "uppercase" }}>{label}</span>
      <div style={{ display: "flex", gap: 4 }}>
        <input autoFocus type="number" value={input}
          min={min} step="any"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEdit(false); }}
          style={{ width: "100%", background: T.row, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 8px", color: T.text, fontSize: 13 }} />
        <button onClick={save} disabled={saving}
          style={{ padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer", background: T.green, color: "#fff", fontSize: 11, fontWeight: 600 }}>{saving ? "…" : "✓"}</button>
      </div>
    </div>
  );
}

// ─── Update User Modal ────────────────────────────────────────────
function UpdateUserModal({ user, token, onClose, onSaved, onError }: {
  user: any; token: string | null;
  onClose: () => void; onSaved: (u: any) => void; onError: (m: string) => void;
}) {
  const [form, setForm] = useState({
    name: user.name || "",
    email: user.email || "",
    phone: user.phone || "",
    identity: user.identity || "",
    address: user.address || "",
    city: user.city || "",
    province: user.province || "",
    country: user.country || "",
    zipCode: user.zipCode || "",
    dateOfBirth: user.dateOfBirth ? new Date(user.dateOfBirth).toISOString().split("T")[0] : "",
    about: user.about || "",
    billingType: user.billingType || "PREPAID",
    accountingLimit: user.accountingLimit != null ? String(user.accountingLimit) : "",
    nasGroup: user.nasGroup || "",
    areaGroup: user.areaGroup || "",
    additionalPhones: (() => { try { return JSON.parse(user.additionalPhones || "[]").join(", "); } catch { return ""; }})(),
    additionalEmails: (() => { try { return JSON.parse(user.additionalEmails || "[]").join(", "); } catch { return ""; }})(),
    isActive: user.isActive ?? true,
    autoRenew: user.autoRenew ?? true,
    smsEnabled: user.smsEnabled ?? true,
    emailEnabled: user.emailEnabled ?? true,
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    // Convert comma-separated to JSON arrays
    const phones = form.additionalPhones.split(",").map((s: string) => s.trim()).filter(Boolean);
    const emails = form.additionalEmails.split(",").map((s: string) => s.trim()).filter(Boolean);
    const payload: any = {
      name: form.name,
      email: form.email,
      phone: form.phone,
      identity: form.identity || null,
      address: form.address || null,
      city: form.city || null,
      province: form.province || null,
      country: form.country || null,
      zipCode: form.zipCode || null,
      dateOfBirth: form.dateOfBirth || null,
      about: form.about || null,
      billingType: form.billingType || "PREPAID",
      accountingLimit: form.accountingLimit ? Number(form.accountingLimit) : null,
      nasGroup: form.nasGroup || null,
      areaGroup: form.areaGroup || null,
      additionalPhones: phones.length ? JSON.stringify(phones) : null,
      additionalEmails: emails.length ? JSON.stringify(emails) : null,
      isActive: form.isActive,
      autoRenew: form.autoRenew,
      smsEnabled: form.smsEnabled,
      emailEnabled: form.emailEnabled,
    };
    try {
      const r = await fetch(`${API}/users/${user.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      if (!r.ok) { const e = await r.json().catch(() => null); onError(e?.message || "Update failed"); setSaving(false); return; }
      onSaved(await r.json());
    } catch (_) { onError("Network error"); setSaving(false); }
  };

  const toggle = (key: string) => setForm((f: any) => ({ ...f, [key]: !f[key] }));

  const Row2 = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <label style={{ fontSize: 11, fontFamily: "monospace", color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</label>
      {children}
    </div>
  );

  return (
    <Portal><div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
      onClick={onClose}>
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 20, padding: 28, maxWidth: 800, width: "100%", maxHeight: "90vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "#fff" }}>Update User</h2>
          <button style={{ background: "transparent", border: "none", color: T.muted, fontSize: 20, cursor: "pointer" }} onClick={onClose}>✕</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Row2 label="Full Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full Name"
            style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }} /></Row2>
          <Row2 label="Email"><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email"
            style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }} /></Row2>
          <Row2 label="Phone"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Phone"
            style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }} /></Row2>
          <Row2 label="Identity (CNIC)"><input value={form.identity} onChange={(e) => setForm({ ...form, identity: e.target.value })} placeholder="National ID number"
            style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }} /></Row2>
          <Row2 label="Country">
            <select value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}
              style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }}>
              <option value="">Select A Country</option>
              <option value="Pakistan">Pakistan</option>
              <option value="India">India</option>
              <option value="Bangladesh">Bangladesh</option>
              <option value="UAE">UAE</option>
              <option value="Other">Other</option>
            </select>
          </Row2>
          <Row2 label="Province">
            <select value={form.province} onChange={(e) => setForm({ ...form, province: e.target.value })}
              style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }}>
              <option value="">Select A Province</option>
              <option value="Punjab">Punjab</option>
              <option value="Sindh">Sindh</option>
              <option value="KPK">KPK</option>
              <option value="Balochistan">Balochistan</option>
            </select>
          </Row2>
          <Row2 label="City">
            <select value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })}
              style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }}>
              <option value="">Select A City</option>
              <option value="Lahore">Lahore</option>
              <option value="Karachi">Karachi</option>
              <option value="Islamabad">Islamabad</option>
              <option value="Peshawar">Peshawar</option>
              <option value="Quetta">Quetta</option>
            </select>
          </Row2>
          <Row2 label="Address"><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Enter Address"
            style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }} /></Row2>
          <Row2 label="Zip Code"><input value={form.zipCode} onChange={(e) => setForm({ ...form, zipCode: e.target.value })} placeholder="Enter Zip Code"
            style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }} /></Row2>
          <Row2 label="Date Of Birth"><input type="date" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })}
            style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }} /></Row2>
          <Row2 label="About"><textarea value={form.about} onChange={(e) => setForm({ ...form, about: e.target.value })} placeholder="Enter Note"
            style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%", minHeight: 60, resize: "vertical" }} /></Row2>
          <Row2 label="Additional Phones"><input value={form.additionalPhones} onChange={(e) => setForm({ ...form, additionalPhones: e.target.value })} placeholder="Comma separated"
            style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }} /></Row2>
          <Row2 label="Additional Emails"><input value={form.additionalEmails} onChange={(e) => setForm({ ...form, additionalEmails: e.target.value })} placeholder="Comma separated"
            style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }} /></Row2>
        </div>

        {/* Profile Settings toggles */}
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Profile Settings</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <Toggle label="Active" val={form.isActive} onChange={() => toggle("isActive")} />
            <Toggle label="SMS Status" val={form.smsEnabled} onChange={() => toggle("smsEnabled")} />
            <Toggle label="Email Status" val={form.emailEnabled} onChange={() => toggle("emailEnabled")} />
            <Toggle label="Auto Renew" val={form.autoRenew} onChange={() => toggle("autoRenew")} />
          </div>
        </div>

        {/* Preferences */}
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Preferences</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Row2 label="Billing Type">
              <select value={form.billingType} onChange={(e) => setForm({ ...form, billingType: e.target.value })}
                style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }}>
                <option value="PREPAID">Prepaid</option>
                <option value="POSTPAID">Postpaid</option>
              </select>
            </Row2>
            <Row2 label="Accounting Limit">
              <input type="number" value={form.accountingLimit} onChange={(e) => setForm({ ...form, accountingLimit: e.target.value })}
                placeholder="0"
                style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }} />
            </Row2>
            <Row2 label="NAS Group"><input value={form.nasGroup} onChange={(e) => setForm({ ...form, nasGroup: e.target.value })} placeholder="group_1"
              style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }} /></Row2>
            <Row2 label="Area Group"><input value={form.areaGroup} onChange={(e) => setForm({ ...form, areaGroup: e.target.value })} placeholder="group_1"
              style={{ background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13, width: "100%" }} /></Row2>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
          <button onClick={onClose}
            style={{ padding: "10px 24px", borderRadius: 10, fontSize: 13, fontWeight: 600, border: `1px solid ${T.border}`, cursor: "pointer", background: "rgba(255,255,255,0.04)", color: T.muted }}>Cancel</button>
          <button onClick={save} disabled={saving}
            style={{ padding: "10px 24px", borderRadius: 10, fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer", background: "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)", color: "#fff" }}>
            {saving ? "Saving…" : "Update User"}</button>
        </div>
      </div>
    </div></Portal>
  );
}

function Toggle({ label, val, onChange }: { label: string; val: boolean; onChange: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
      <span style={{ fontSize: 12, color: T.muted }}>{label}</span>
      <button onClick={onChange}
        style={{
          width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer", position: "relative", transition: "background 0.2s",
          background: val ? "rgba(16,185,129,0.4)" : "rgba(255,255,255,0.08)",
        }}>
        <span style={{
          position: "absolute", top: 2, left: val ? 22 : 2, width: 20, height: 20, background: "#fff", borderRadius: "50%", transition: "transform 0.2s",
        }} />
      </button>
    </div>
  );
}

// ─── Add Balance Modal ────────────────────────────────────────────
function AddBalanceModal({ userId, userName, token, onClose, onDone, onError }: {
  userId: number; userName: string; token: string | null;
  onClose: () => void; onDone: () => void; onError: (m: string) => void;
}) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!amount || Number(amount) <= 0) { onError("Enter a valid amount"); return; }
    setSaving(true);
    try {
      const r = await fetch(`${API}/organization/resellers/${userId}/wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amount: Number(amount), type: "TOPUP", notes: note || null }),
      });
      if (!r.ok) { const e = await r.json().catch(() => null); onError(e?.message || "Failed"); setSaving(false); return; }
      onDone();
    } catch (_) { onError("Network error"); setSaving(false); }
  };

  return (
    <Portal><div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
      onClick={onClose}>
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 20, padding: 28, maxWidth: 450, width: "100%" }}
        onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 12 }}>Add Balance — {userName}</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={{ fontSize: 11, fontFamily: "monospace", color: T.muted, textTransform: "uppercase" }}>Payment Method</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)}
              style={{ width: "100%", background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13 }}>
              <option value="BANK_TRANSFER">Bank Transfer</option>
              <option value="CASH">Cash</option>
              <option value="CARD">Card</option>
              <option value="JAZZCASH">JazzCash</option>
              <option value="EASYPAISA">Easypaisa</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontFamily: "monospace", color: T.muted, textTransform: "uppercase" }}>Amount</label>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Enter Amount"
              style={{ width: "100%", background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13 }} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontFamily: "monospace", color: T.muted, textTransform: "uppercase" }}>Note</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note"
              style={{ width: "100%", background: T.row, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontSize: 13 }} />
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
          <button onClick={onClose}
            style={{ padding: "10px 24px", borderRadius: 10, fontSize: 13, fontWeight: 600, border: `1px solid ${T.border}`, cursor: "pointer", background: "rgba(255,255,255,0.04)", color: T.muted }}>Cancel</button>
          <button onClick={save} disabled={saving}
            style={{ padding: "10px 24px", borderRadius: 10, fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer", background: T.green, color: "#fff" }}>
            {saving ? "…" : "Add Balance"}</button>
        </div>
      </div>
    </div></Portal>
  );
}