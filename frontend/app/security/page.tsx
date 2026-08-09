"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { silent } from "../components/silent";
import API_BASE from "../components/api";

const API = API_BASE;

const T = {
  bg: "var(--bg)", card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)", sub: "var(--muted)",
  accent: "#0ea5e9", green: "#22c55e", red: "#ef4444", amber: "#f59e0b",
};

const TABS = ["Permissions", "Child Permissions", "Two-Factor Auth", "Active Sessions"] as const;
type Tab = (typeof TABS)[number];

const fdt = (d: string) => new Date(d).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

export default function SecurityPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("Permissions");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // permissions
  const [meta, setMeta] = useState<any>(null);
  const [matrix, setMatrix] = useState<Record<string, string[]>>({});
  const [selectedRole, setSelectedRole] = useState("SALES");
  const [dirty, setDirty] = useState(false);
  // 2fa
  const [tfa, setTfa] = useState<any>({ enabled: false });
  const [enrollment, setEnrollment] = useState<any>(null);
  const [tfaCode, setTfaCode] = useState("");
  // sessions
  const [sessions, setSessions] = useState<any[]>([]);
  // child permissions
  const [catalog, setCatalog] = useState<any[]>([]);
  const [childList, setChildList] = useState<any[]>([]);
  const [selChild, setSelChild] = useState<string>("");
  const [denied, setDenied] = useState<Set<string>>(new Set());

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const get = useCallback(async (path: string) => {
    const r = await fetch(`${API}${path}`, { headers });
    if (r.status === 401) { router.push("/login"); throw new Error("unauthorized"); }
    return r.json();
  }, [token]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    get("/security/meta").then(setMeta).catch(silent("loadSecurityMeta"));
    get("/security/permissions").then(setMatrix).catch(silent("loadPermissions"));
    get("/security/2fa").then(setTfa).catch(silent("loadTwoFactorStatus"));
  }, []);

  useEffect(() => {
    if (tab === "Active Sessions") get("/security/sessions").then((d) => setSessions(Array.isArray(d) ? d : [])).catch(silent("loadActiveSessions"));
    if (tab === "Child Permissions") {
      get("/security/child-permissions/catalog").then((d) => setCatalog(Array.isArray(d) ? d : [])).catch(silent("loadChildPermCatalog"));
      get("/users").then((d) => setChildList(Array.isArray(d) ? d : [])).catch(silent("loadChildUserList"));
    }
  }, [tab]);

  async function loadChildPerms(userId: string) {
    setSelChild(userId);
    setDenied(new Set());
    if (!userId) return;
    const map = await get(`/security/child-permissions/${userId}`).catch(() => ({}));
    const off = new Set<string>(Object.entries(map || {}).filter(([, v]) => v === false).map(([k]) => k));
    setDenied(off);
  }
  function togglePerm(key: string) {
    const next = new Set(denied);
    next.has(key) ? next.delete(key) : next.add(key);
    setDenied(next);
  }
  async function saveChildPerms() {
    if (!selChild) return;
    setBusy(true);
    try {
      await fetch(`${API}/security/child-permissions/${selChild}`, {
        method: "PUT", headers, body: JSON.stringify({ denied: Array.from(denied) }),
      });
      setMsg("Permissions saved");
    } finally { setBusy(false); }
  }

  // ── permissions helpers ──────────────────────────────────────
  const rolePerms = matrix[selectedRole] || [];
  const has = (perm: string) => rolePerms.includes(perm);
  function toggle(perm: string) {
    const next = has(perm) ? rolePerms.filter((p) => p !== perm) : [...rolePerms, perm];
    setMatrix({ ...matrix, [selectedRole]: next });
    setDirty(true);
  }

  async function saveRole() {
    setBusy(true);
    try {
      await fetch(`${API}/security/permissions/${selectedRole}`, {
        method: "PUT", headers, body: JSON.stringify({ permissions: rolePerms }),
      });
      setDirty(false);
      setMsg(rolePerms.length ? `${selectedRole} permissions saved` : `${selectedRole} is now unrestricted (no rows)`);
    } finally { setBusy(false); }
  }

  // ── 2fa actions ──────────────────────────────────────────────
  async function enroll() {
    setBusy(true);
    try {
      const r = await fetch(`${API}/security/2fa/enroll`, { method: "POST", headers });
      setEnrollment(await r.json());
    } finally { setBusy(false); }
  }

  async function confirm() {
    setBusy(true);
    try {
      const r = await fetch(`${API}/security/2fa/confirm`, { method: "POST", headers, body: JSON.stringify({ code: tfaCode }) });
      const data = await r.json();
      if (data.enabled) { setTfa({ enabled: true }); setEnrollment(null); setTfaCode(""); setMsg("Two-factor auth is now active"); }
      else setMsg(data.message || "Invalid code");
    } finally { setBusy(false); }
  }

  async function disable() {
    setBusy(true);
    try {
      const r = await fetch(`${API}/security/2fa/disable`, { method: "POST", headers, body: JSON.stringify({ code: tfaCode }) });
      const data = await r.json();
      if (data.enabled === false) { setTfa({ enabled: false }); setTfaCode(""); setMsg("Two-factor auth disabled"); }
      else setMsg(data.message || "Invalid code");
    } finally { setBusy(false); }
  }

  async function kill(sessionId: string) {
    if (!confirm2("Force log out this session?")) return;
    await fetch(`${API}/security/sessions/${sessionId}`, { method: "DELETE", headers });
    setSessions(await get("/security/sessions"));
  }
  const confirm2 = (m: string) => window.confirm(m);

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 };
  const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", color: T.muted, fontSize: 11, textTransform: "uppercase" };
  const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, color: T.text };
  const input: React.CSSProperties = { background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px", color: T.text, fontSize: 13 };
  const btn = (bg: string): React.CSSProperties => ({ background: bg, color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.6 : 1 });

  return (
    <div style={{ padding: 20, color: T.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        {msg && <span style={{ fontSize: 12, color: T.accent, cursor: "pointer" }} onClick={() => setMsg("")}>{msg} ✕</span>}
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {TABS.map((name) => (
          <button key={name} onClick={() => setTab(name)}
            style={{ ...btn(tab === name ? T.accent : T.card), border: `1px solid ${tab === name ? T.accent : T.border}`, color: tab === name ? "#fff" : T.sub }}>
            {name}
          </button>
        ))}
      </div>

      {/* ── PERMISSIONS MATRIX ── */}
      {tab === "Permissions" && meta && (
        <div style={card}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <select style={input} value={selectedRole} onChange={(e) => { setSelectedRole(e.target.value); setDirty(false); }}>
              {meta.roles.map((r: string) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button style={btn(T.green)} disabled={busy || !dirty} onClick={saveRole}>Save {selectedRole}</button>
            <span style={{ fontSize: 12, color: T.muted }}>
              {rolePerms.length === 0
                ? "⚠ No permissions configured — this role is currently UNRESTRICTED. Tick anything to start enforcing."
                : `${rolePerms.length} permissions granted. Write implies read. SUPER_ADMIN always bypasses.`}
            </span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                <th style={th}>Resource</th><th style={{ ...th, textAlign: "center" }}>Read</th><th style={{ ...th, textAlign: "center" }}>Write</th>
              </tr>
            </thead>
            <tbody>
              {meta.resources.map((res: string, i: number) => (
                <tr key={res} style={{ background: i % 2 ? "transparent" : T.row }}>
                  <td style={td}>{res}</td>
                  {["read", "write"].map((action) => (
                    <td key={action} style={{ ...td, textAlign: "center" }}>
                      <input type="checkbox" checked={has(`${res}.${action}`)} onChange={() => toggle(`${res}.${action}`)} style={{ width: 16, height: 16, cursor: "pointer" }} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── CHILD PERMISSIONS ── */}
      {tab === "Child Permissions" && (
        <div style={card}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <select style={input} value={selChild} onChange={(e) => loadChildPerms(e.target.value)}>
              <option value="">— pick a downline account —</option>
              {childList.map((u: any) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
            </select>
            <button style={btn(T.green)} disabled={busy || !selChild} onClick={saveChildPerms}>Save permissions</button>
            <span style={{ fontSize: 12, color: T.muted }}>Untick an action to block this account from doing it. Ticked = allowed.</span>
          </div>
          {!selChild && <div style={{ fontSize: 13, color: T.muted }}>Choose one of your downline accounts to control what it can do.</div>}
          {selChild && catalog.map((group: any) => (
            <div key={group.resource} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.sub, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>{group.label}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {group.actions.map((a: any) => {
                  const allowed = !denied.has(a.key);
                  return (
                    <label key={a.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: allowed ? "#14311f" : T.row, color: allowed ? "#86efac" : T.muted, cursor: "pointer" }}>
                      <input type="checkbox" checked={allowed} onChange={() => togglePerm(a.key)} />
                      {a.label}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── 2FA ── */}
      {tab === "Two-Factor Auth" && (
        <div style={{ ...card, maxWidth: 480 }}>
          {tfa.enabled ? (
            <>
              <div style={{ color: T.green, fontWeight: 700, marginBottom: 10 }}>✅ Two-factor authentication is ACTIVE on your account</div>
              <div style={{ fontSize: 13, color: T.sub, marginBottom: 10 }}>Enter a current code to disable it:</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input style={{ ...input, letterSpacing: 4, textAlign: "center", width: 140 }} maxLength={6} value={tfaCode} onChange={(e) => setTfaCode(e.target.value.replace(/\D/g, ""))} placeholder="000000" />
                <button style={btn(T.red)} disabled={busy} onClick={disable}>Disable 2FA</button>
              </div>
            </>
          ) : enrollment ? (
            <>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Step 2 — add to your authenticator app</div>
              <div style={{ fontSize: 13, color: T.sub, marginBottom: 8 }}>
                In Google Authenticator (or Authy, etc.) choose <b>Enter a setup key</b> and paste:
              </div>
              <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, fontFamily: "monospace", fontSize: 15, letterSpacing: 2, marginBottom: 10, wordBreak: "break-all" }}>
                {enrollment.secret}
              </div>
              <div style={{ fontSize: 11, color: T.muted, marginBottom: 12, wordBreak: "break-all" }}>{enrollment.otpauth}</div>
              <div style={{ fontSize: 13, color: T.sub, marginBottom: 8 }}>Then confirm with the 6-digit code it shows:</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input style={{ ...input, letterSpacing: 4, textAlign: "center", width: 140 }} maxLength={6} value={tfaCode} onChange={(e) => setTfaCode(e.target.value.replace(/\D/g, ""))} placeholder="000000" autoFocus />
                <button style={btn(T.green)} disabled={busy} onClick={confirm}>Activate</button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Two-factor authentication</div>
              <div style={{ fontSize: 13, color: T.sub, marginBottom: 12 }}>Add a second layer of security to your account using an authenticator app.</div>
              <button style={btn(T.green)} disabled={busy} onClick={enroll}>Enroll now</button>
            </>
          )}
        </div>
      )}

      {/* ── ACTIVE SESSIONS ── */}
      {tab === "Active Sessions" && (
        <div style={card}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                <th style={th}>User</th><th style={th}>Role</th><th style={th}>IP</th><th style={th}>Login</th><th style={{ ...th, textAlign: "right" }} />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s: any) => (
                <tr key={s.id}>
                  <td style={td}>{s.user?.name}</td>
                  <td style={{ ...td, color: T.sub }}>{s.user?.role}</td>
                  <td style={{ ...td, color: T.sub }}>{s.ipAddress}</td>
                  <td style={{ ...td, color: T.sub }}>{fdt(s.createdAt)}</td>
                  <td style={{ ...td, textAlign: "right" }}><button style={btn(T.red)} onClick={() => kill(s.id)}>Log out</button></td>
                </tr>
              ))}
              {sessions.length === 0 && <tr><td style={{ ...td, color: T.muted }} colSpan={5}>No active sessions.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}