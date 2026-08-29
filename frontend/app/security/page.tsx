"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { silent } from "../components/silent";
import API_BASE from "../components/api";

const API = API_BASE;

const T = {
  bg: "var(--bg)", card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)", sub: "var(--muted)",
  accent: "#0ea5e9", green: "#22c55e", red: "#ef4444", amber: "#f59e0b",
};

const TABS = ["Permissions", "Child Permissions", "Two-Factor Auth", "Active Sessions", "API Keys"] as const;
type Tab = (typeof TABS)[number];

const fdt = (d: string) => new Date(d).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

export default function SecurityPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("Permissions");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [childSearch, setChildSearch] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // permissions
  const [meta, setMeta] = useState<any>(null);
  const [matrix, setMatrix] = useState<Record<string, string[]>>({});
  const [selectedRole, setSelectedRole] = useState("SALES");
  const [dirty, setDirty] = useState(false);
  // presets (role tiers: one-click recommended sets)
  const [presets, setPresets] = useState<any>({ roles: {}, labels: {} });
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
  const [permSearch, setPermSearch] = useState("");
  // expanded "more actions" rows in the role matrix
  const [expandedRes, setExpandedRes] = useState<Record<string, boolean>>({});
  const [resourceActions, setResourceActions] = useState<Record<string, any[]>>({});
  /**
   * API keys. The backend for these was complete — create, list, revoke, and a
   * guard enforcing them on the public API — but nothing in the panel ever
   * mentioned it, so the capability effectively did not exist for anyone who
   * could not use curl.
   *
   * `justCreated` holds the one and only time the plaintext key is visible:
   * the server stores a SHA-256 hash and cannot show it again.
   */
  type ApiKey = {
    id: number; name: string; prefix: string; scopes: string;
    isActive: boolean; lastUsedAt: string | null; lastUsedIp: string | null;
    expiresAt: string | null; createdAt: string; ownerId: number | null;
  };
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [keyName, setKeyName] = useState("");
  const [keyScopes, setKeyScopes] = useState("read");
  const [keyExpiry, setKeyExpiry] = useState("");
  const [justCreated, setJustCreated] = useState<{ key: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

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
    get("/security/presets").then((d) => setPresets(d || { roles: {}, labels: {} })).catch(silent("loadSecurityPresets"));
    // Same granular catalog the Child Permissions tab uses — also drives the
    // role matrix's expandable "more actions" rows below.
    get("/security/child-permissions/catalog").then((d) => {
      if (Array.isArray(d)) { setCatalog(d); setResourceActions(groupByResource(d)); }
    }).catch(silent("loadPermCatalogForMatrix"));
  }, []);

  useEffect(() => {
    if (tab === "Active Sessions") get("/security/sessions").then((d) => setSessions(Array.isArray(d) ? d : [])).catch(silent("loadActiveSessions"));
    if (tab === "Child Permissions") {
      get("/security/child-permissions/catalog").then((d) => setCatalog(Array.isArray(d) ? d : [])).catch(silent("loadChildPermCatalog"));
      get("/users").then((d) => setChildList(Array.isArray(d) ? d : [])).catch(silent("loadChildUserList"));
    }
    if (tab === "API Keys") loadApiKeys();
  }, [tab]);

  const loadApiKeys = useCallback(() => {
    get("/integrations/api-keys")
      .then((d) => setApiKeys(Array.isArray(d) ? d : []))
      .catch(silent("loadApiKeys"));
  }, [get]);

  async function createApiKey() {
    if (!keyName.trim()) { setMsg("Give the key a name so you can recognise it later."); return; }
    setBusy(true);
    try {
      const r = await fetch(`${API}/integrations/api-keys`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: keyName.trim(),
          scopes: keyScopes.split(",").map((s) => s.trim()).filter(Boolean),
          expiresInDays: keyExpiry ? Number(keyExpiry) : undefined,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(d?.message || "Could not create the key."); setBusy(false); return; }
      // The ONLY moment the plaintext exists — the server keeps a hash.
      setJustCreated({ key: d.key, name: d.name });
      setCopied(false);
      setKeyName(""); setKeyExpiry("");
      setMsg("");
      loadApiKeys();
    } catch {
      setMsg("Could not create the key.");
    }
    setBusy(false);
  }

  async function revokeApiKey(id: number, name: string) {
    // confirm2, not confirm: a local confirm() (2FA activation) shadows the
    // global one in this file, which is why that alias exists.
    if (!confirm2(`Revoke "${name}"? Anything using this key stops working immediately.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/integrations/api-keys/${id}`, { method: "DELETE", headers });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setMsg(d?.message || "Could not revoke the key.");
      } else {
        setMsg("");
        loadApiKeys();
      }
    } catch {
      setMsg("Could not revoke the key.");
    }
    setBusy(false);
  }

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

  /** Fill the matrix with a tier's recommended set (not yet saved). */
  function loadPreset(role: string) {
    const list = (presets.roles || {})[role] || [];
    setMatrix((m) => ({ ...m, [role]: list }));
    setDirty(true);
    setMsg(`${role} preset loaded (${list.length} permissions) — review and click Save.`);
  }

  // Catalog groups → map of resource → granular actions (for the matrix rows).
  function groupByResource(groups: any[]): Record<string, any[]> {
    const map: Record<string, any[]> = {};
    for (const g of groups || []) {
      const actions = (g.actions || []).filter((a: any) => !a.key.endsWith(".read") && !a.key.endsWith(".write"));
      if (actions.length) map[g.resource] = actions;
    }
    return map;
  }
  function toggleGranular(perm: string) {
    const next = has(perm) ? rolePerms.filter((p) => p !== perm) : [...rolePerms, perm];
    setMatrix({ ...matrix, [selectedRole]: next });
    setDirty(true);
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
            {presets?.roles?.[selectedRole] && (
              <button
                style={{ ...btn("#6C3CE1"), padding: "8px 12px", fontSize: 12.5 }}
                disabled={busy}
                onClick={() => loadPreset(selectedRole)}
                title="Load the recommended permission set for this tier, then review and save."
              >
                Load {presets.labels?.[selectedRole] || selectedRole} preset
              </button>
            )}
            <span style={{ fontSize: 12, color: T.muted }}>
              {rolePerms.length === 0
                ? "⚠ No permissions configured — this role is currently UNRESTRICTED. Tick anything to start enforcing, or load a preset."
                : `${rolePerms.length} permissions granted. Write implies read. SUPER_ADMIN always bypasses.`}
            </span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                <th style={th}>Resource</th><th style={{ ...th, textAlign: "center" }}>Read</th><th style={{ ...th, textAlign: "center" }}>Write</th><th style={{ ...th, width: 130 }} />
              </tr>
            </thead>
            <tbody>
              {meta.resources.map((res: string, i: number) => {
                const granular = resourceActions[res] || [];
                const expanded = expandedRes[res];
                const granted = granular.filter((a: any) => has(a.key)).length;
                return (
                  <Fragment key={res}>
                    <tr style={{ background: i % 2 ? "transparent" : T.row }}>
                      <td style={td}>{res}</td>
                      {["read", "write"].map((action) => (
                        <td key={action} style={{ ...td, textAlign: "center" }}>
                          <input type="checkbox" checked={has(`${res}.${action}`)} onChange={() => toggle(`${res}.${action}`)} style={{ width: 16, height: 16, cursor: "pointer" }} />
                        </td>
                      ))}
                      <td style={{ ...td, textAlign: "right" }}>
                        {granular.length > 0 && (
                          <button onClick={() => setExpandedRes((m) => ({ ...m, [res]: !expanded }))}
                            style={{ background: "transparent", border: "none", color: T.accent, fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                            {expanded ? "Hide" : `+ ${granted}/${granular.length} actions`}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr style={{ background: "transparent" }}>
                        <td colSpan={4} style={{ padding: "4px 10px 12px" }}>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {granular.map((a: any) => {
                              const on = has(a.key);
                              return (
                                <label key={a.key} title={a.key}
                                  style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, padding: "4px 9px", borderRadius: 7,
                                    border: `1px solid ${on ? "#C6E9D3" : "#E2E8F0"}`, background: on ? "#E7F6EC" : "#F7F9FC",
                                    color: on ? "#157F43" : "#64748B", cursor: "pointer" }}>
                                  <input type="checkbox" checked={on} onChange={() => toggleGranular(a.key)} />
                                  {a.label}
                                </label>
                              );
                            })}
                            {granular.length === 0 && <span style={{ fontSize: 12, color: T.muted }}>No extra actions.</span>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── CHILD PERMISSIONS ── */}
      {tab === "Child Permissions" && (
        <div style={card}>
          {/* Searchable account picker — scales to thousands of downline
              accounts, where a dropdown is unusable. Type to filter; the
              chosen account shows above with a "change" affordance. */}
          <div style={{ marginBottom: 14 }}>
            {(() => {
              const chosen = childList.find((u: any) => String(u.id) === String(selChild));
              const q = childSearch.trim().toLowerCase();
              const matches = q
                ? childList.filter((u: any) =>
                    (u.name || "").toLowerCase().includes(q) ||
                    (u.email || "").toLowerCase().includes(q) ||
                    (u.role || "").toLowerCase().includes(q))
                : childList;
              return (
                <>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                    <div style={{ flex: 1, minWidth: 220, position: "relative" }}>
                      <input
                        style={{ ...input, width: "100%", paddingLeft: 32 }}
                        placeholder="Search account by name, email or role…"
                        value={childSearch}
                        onChange={(e) => setChildSearch(e.target.value)}
                      />
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2" strokeLinecap="round"
                        style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }}>
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                    </div>
                    <button style={btn(T.green)} disabled={busy || !selChild} onClick={saveChildPerms}>Save permissions</button>
                  </div>

                  {chosen && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "9px 12px", background: "#EEF1FE", border: "1px solid #C7CEF9", borderRadius: 10, marginBottom: 8 }}>
                      <span style={{ fontSize: 13.5, color: "#1C2434" }}>
                        Editing <b>{chosen.name}</b> <span style={{ color: "#64748B" }}>· {chosen.role}</span>
                      </span>
                      <button onClick={() => { setSelChild(""); setChildSearch(""); }}
                        style={{ background: "transparent", border: "1px solid #C7CEF9", color: "#3C50E0", borderRadius: 7, padding: "4px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Change</button>
                    </div>
                  )}

                  {/* The results list only shows while picking (no account chosen,
                      or actively searching). Capped so a huge downline stays fast. */}
                  {(!selChild || q) && (
                    <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid #E2E8F0", borderRadius: 10 }}>
                      {matches.length === 0 ? (
                        <div style={{ padding: 16, fontSize: 13, color: "#94A3B8", textAlign: "center" }}>No account matches “{childSearch}”.</div>
                      ) : (
                        matches.slice(0, 100).map((u: any) => (
                          <button key={u.id}
                            onClick={() => { loadChildPerms(String(u.id)); setChildSearch(""); }}
                            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", textAlign: "left",
                              background: String(u.id) === String(selChild) ? "#EEF1FE" : "#fff", border: "none", borderBottom: "1px solid #EEF2F7",
                              padding: "10px 14px", cursor: "pointer", fontFamily: "inherit" }}>
                            <span style={{ minWidth: 0 }}>
                              <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "#1C2434" }}>{u.name}</span>
                              {u.email && <span style={{ display: "block", fontSize: 11.5, color: "#94A3B8" }}>{u.email}</span>}
                            </span>
                            <span style={{ flex: "none", fontSize: 11, fontWeight: 600, color: "#64748B", background: "#F1F5F9", padding: "3px 9px", borderRadius: 999 }}>{u.role}</span>
                          </button>
                        ))
                      )}
                      {matches.length > 100 && (
                        <div style={{ padding: "8px 14px", fontSize: 12, color: "#94A3B8" }}>Showing first 100 of {matches.length}. Keep typing to narrow.</div>
                      )}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: T.muted, marginTop: 8 }}>Untick an action below to block this account from doing it. Ticked = allowed.</div>
                </>
              );
            })()}
          </div>
          {!selChild && !childSearch && <div style={{ fontSize: 13, color: T.muted }}>Search and pick a downline account to control what it can do.</div>}
          {selChild && (
            <div style={{ marginBottom: 10, display: "flex", gap: 8, alignItems: "center" }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <input
                style={{ ...input, flex: 1, maxWidth: 340 }}
                placeholder="Filter permissions… (e.g. bandwidth, balance, export)"
                value={permSearch}
                onChange={(e) => setPermSearch(e.target.value)}
              />
              {permSearch && (
                <button onClick={() => setPermSearch("")} style={{ ...btn(T.card), color: T.sub, border: `1px solid ${T.border}` }}>Clear</button>
              )}
            </div>
          )}
          {selChild && catalog.map((group: any) => {
            const q = permSearch.trim().toLowerCase();
            const visibleActions = q
              ? group.actions.filter((a: any) =>
                  (a.label || "").toLowerCase().includes(q) || (a.key || "").toLowerCase().includes(q))
              : group.actions;
            if (q && visibleActions.length === 0) return null;
            const total = group.actions.length;
            const allowedCount = group.actions.filter((a: any) => !denied.has(a.key)).length;
            const open = openGroups[group.resource] ?? false;
            const allOn = allowedCount === total;
            return (
              <div key={group.resource} style={{ marginBottom: 10, border: "1px solid #E2E8F0", borderRadius: 10, overflow: "hidden" }}>
                {/* Collapsible header — click to expand; shows how many of this
                    group's actions are currently allowed. */}
                <button
                  onClick={() => setOpenGroups((m) => ({ ...m, [group.resource]: !open }))}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "#F7F9FC", border: "none", padding: "11px 14px", cursor: "pointer", fontFamily: "inherit" }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <span style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", color: "#64748B", fontSize: 12 }}>▶</span>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: "#1C2434" }}>{group.label}</span>
                    {q && <span style={{ fontSize: 11, color: "#94A3B8" }}>({visibleActions.length} match)</span>}
                  </span>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: allOn ? "#157F43" : allowedCount === 0 ? "#B02A37" : "#8A6209",
                    background: allOn ? "#E7F6EC" : allowedCount === 0 ? "#FDE8EA" : "#FDF3E3", padding: "3px 10px", borderRadius: 999 }}>
                    {allowedCount}/{total} allowed
                  </span>
                </button>
                {open && (
                  <div style={{ padding: "12px 14px 14px" }}>
                    <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                      <button onClick={() => visibleActions.forEach((a: any) => denied.has(a.key) && togglePerm(a.key))}
                        style={{ fontSize: 11.5, fontWeight: 600, color: "#157F43", background: "#E7F6EC", border: "1px solid #C6E9D3", borderRadius: 7, padding: "4px 10px", cursor: "pointer" }}>Allow all</button>
                      <button onClick={() => visibleActions.forEach((a: any) => !denied.has(a.key) && togglePerm(a.key))}
                        style={{ fontSize: 11.5, fontWeight: 600, color: "#B02A37", background: "#FDE8EA", border: "1px solid #F5C2C7", borderRadius: 7, padding: "4px 10px", cursor: "pointer" }}>Block all</button>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {visibleActions.map((a: any) => {
                        const allowed = !denied.has(a.key);
                        return (
                          <label key={a.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 10px", borderRadius: 8, border: `1px solid ${allowed ? "#C6E9D3" : "#E2E8F0"}`, background: allowed ? "#E7F6EC" : "#F7F9FC", color: allowed ? "#157F43" : "#64748B", cursor: "pointer" }}>
                            <input type="checkbox" checked={allowed} onChange={() => togglePerm(a.key)} />
                            {a.label}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
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

      {/* ── API KEYS ── */}
      {tab === "API Keys" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ ...card, fontSize: 12, lineHeight: 1.8, color: T.sub }}>
            Keys let another system talk to your panel without a person logging in — a
            reseller&rsquo;s own billing software, a mobile app backend, an automation script.
            Each key carries scopes and an optional expiry, and every use is recorded, so an
            abandoned key is visible and revocable.
          </div>

          {/* The plaintext key exists exactly once. */}
          {justCreated && (
            <div style={{ ...card, borderColor: T.green, background: "rgba(34,197,94,.08)" }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                &ldquo;{justCreated.name}&rdquo; created — copy it now
              </div>
              <div style={{ fontSize: 12, color: T.sub, marginBottom: 10, lineHeight: 1.7 }}>
                This is the only time this key can be shown. Only a hash is stored, so it cannot
                be recovered — if you lose it, revoke this key and make another.
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <code style={{ flex: 1, minWidth: 260, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "9px 11px", fontSize: 12, wordBreak: "break-all", fontFamily: "ui-monospace, monospace" }}>
                  {justCreated.key}
                </code>
                <button
                  style={btn(copied ? T.green : T.accent)}
                  onClick={() => {
                    navigator.clipboard?.writeText(justCreated.key).then(
                      () => setCopied(true),
                      // Clipboard access can be denied (insecure origin, permissions).
                      // Say so rather than showing a success that did not happen.
                      () => setMsg("Could not copy automatically — select the key and copy it by hand."),
                    );
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                <button style={btn(T.border)} onClick={() => setJustCreated(null)}>Done</button>
              </div>
            </div>
          )}

          {/* Create */}
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>New key</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 200px" }}>
                <span style={{ fontSize: 11, color: T.muted }}>Name</span>
                <input style={input} value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="e.g. Dealer mobile app" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 160px" }}>
                <span style={{ fontSize: 11, color: T.muted }}>Scopes</span>
                <select style={input} value={keyScopes} onChange={(e) => setKeyScopes(e.target.value)}>
                  <option value="read">read — look, never change</option>
                  <option value="read,write">read + write</option>
                  <option value="*">everything</option>
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "0 1 150px" }}>
                <span style={{ fontSize: 11, color: T.muted }}>Expires in (days)</span>
                <input style={input} type="number" min={1} value={keyExpiry} onChange={(e) => setKeyExpiry(e.target.value)} placeholder="never" />
              </label>
              <button style={btn(T.accent)} disabled={busy} onClick={createApiKey}>Create key</button>
            </div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 9, lineHeight: 1.7 }}>
              Give each integration its own key. Then revoking one stops that integration and
              nothing else — with a shared key you have to re-issue to everybody.
            </div>
          </div>

          {/* Existing */}
          <div style={card}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  <th style={th}>Name</th><th style={th}>Key</th><th style={th}>Scopes</th>
                  <th style={th}>Last used</th><th style={th}>Expires</th>
                  <th style={{ ...th, textAlign: "right" }} />
                </tr>
              </thead>
              <tbody>
                {apiKeys.map((k) => {
                  const expired = !!k.expiresAt && new Date(k.expiresAt) < new Date();
                  const dead = !k.isActive || expired;
                  return (
                    <tr key={k.id} style={{ opacity: dead ? 0.55 : 1 }}>
                      <td style={td}>
                        {k.name}
                        {!k.isActive && <span style={{ marginLeft: 6, fontSize: 10, color: T.red }}>revoked</span>}
                        {k.isActive && expired && <span style={{ marginLeft: 6, fontSize: 10, color: T.amber }}>expired</span>}
                      </td>
                      <td style={{ ...td, color: T.sub, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{k.prefix}…</td>
                      <td style={{ ...td, color: T.sub }}>{k.scopes}</td>
                      <td style={{ ...td, color: T.sub }}>
                        {k.lastUsedAt
                          ? <>{fdt(k.lastUsedAt)}{k.lastUsedIp ? <span style={{ color: T.muted }}> · {k.lastUsedIp}</span> : null}</>
                          : <span style={{ color: T.muted }}>never used</span>}
                      </td>
                      <td style={{ ...td, color: T.sub }}>{k.expiresAt ? fdt(k.expiresAt) : <span style={{ color: T.muted }}>never</span>}</td>
                      <td style={{ ...td, textAlign: "right" }}>
                        {k.isActive && (
                          <button style={btn(T.red)} disabled={busy} onClick={() => revokeApiKey(k.id, k.name)}>Revoke</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {apiKeys.length === 0 && (
                  <tr><td style={{ ...td, color: T.muted }} colSpan={6}>No keys yet. Create one above to let another system reach your panel.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}