"use client";

import React from "react";
import API from "../components/api";

/**
 * THE ISP COMPANIES HOSTED ON THIS PANEL — platform owner only.
 *
 * Users & Staff answers "who works for me". This answers "which businesses am
 * I hosting, and how big is each one" — a question the reseller tree cannot
 * show, because each company's tree is deliberately invisible from every other
 * one and from the list that contains them all.
 *
 * ── WHAT THIS SCREEN IS FOR ──────────────────────────────────────────────
 * Deciding things about CLIENTS: has this one outgrown its plan, is that one
 * actually using the panel, should this one be suspended for non-payment. So
 * the columns are the ones those decisions turn on — subscribers, routers, the
 * shape of the downline — and not the account detail that belongs on a profile.
 *
 * ── HOW THE PLATFORM HELPS A CLIENT ──────────────────────────────────────
 * The platform account sees no company's subscribers, routers or billing —
 * the backend refuses those routes to it. To help a client, "Sign in" opens
 * the panel AS that company (audited, one day at most, "Return" in the
 * header comes back). The confirmation names the company, so the wrong row
 * is not opened by accident.
 *
 * Suspending is the exception, and it is the one action that belongs here:
 * it is a commercial decision about a client, not an operation inside their
 * business. It sets isActive=false on the company account, which stops that
 * login — it does NOT touch their subscribers, who keep their service because
 * FreeRADIUS reads the database directly and never asks the panel.
 */

interface Company {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  city: string | null;
  isActive: boolean;
  createdAt: string;
  balance: number;
  franchises: number;
  dealers: number;
  retailers: number;
  staff: number;
  subscribers: number;
  nas: number;
  plan?: Plan | null;
}

/** What the platform allows this company. null in a field = no limit. */
interface Plan {
  maxSubscribers: number | null;
  maxNas: number | null;
  maxAccounts: number | null;
  expiresAt: string | null;
  note: string | null;
}

const accountsOf = (c: Company) => c.franchises + c.dealers + c.retailers + c.staff;
const planEnded = (p?: Plan | null) => !!p?.expiresAt && new Date(p.expiresAt).getTime() < Date.now();
const ofCap = (used: number, cap?: number | null) => (cap == null ? used.toLocaleString() : `${used.toLocaleString()} / ${cap.toLocaleString()}`);
const nearCap = (used: number, cap?: number | null) => cap != null && cap > 0 && used / cap >= 0.9;

function token(): string {
  try {
    return localStorage.getItem("token") || "";
  } catch {
    return "";
  }
}

async function api(path: string, init?: RequestInit) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token()}`,
      ...(init?.headers || {}),
    },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.message || `Request failed (${r.status})`);
  return body;
}

export default function Companies() {
  const [rows, setRows] = React.useState<Company[] | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState<number | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<Company | null>(null);
  const [limits, setLimits] = React.useState<Company | null>(null);

  const load = React.useCallback(async () => {
    try {
      setRows(await api("/users/companies"));
      setError("");
    } catch (e: any) {
      setError(String(e?.message || e));
      setRows([]);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function toggle(c: Company) {
    const verb = c.isActive ? "Suspend" : "Reactivate";
    if (
      !window.confirm(
        `${verb} ${c.name}?\n\n` +
          (c.isActive
            ? "Their panel login stops working immediately. Their subscribers stay online — FreeRADIUS reads the database directly and never asks the panel."
            : "Their panel login starts working again.")
      )
    ) {
      return;
    }
    setBusy(c.id);
    try {
      await api(`/users/${c.id}/toggle`, { method: "PATCH" });
      await load();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }

  async function signIn(c: Company) {
    if (!window.confirm(
      `Sign in as ${c.name}?\n\nYou will work inside their panel as them — every action is logged against you. ` +
        "Use Return in the header to come back to the platform.",
    )) return;
    setBusy(c.id);
    try {
      const d = await api(`/auth/impersonate/${c.id}`, { method: "POST" });
      if (!d?.token) throw new Error("Could not open this company.");
      localStorage.setItem("token", d.token);
      window.location.assign("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  if (rows === null) {
    return <p style={{ fontSize: 13, color: "var(--muted)" }}>Loading companies…</p>;
  }

  const live = rows.filter((r) => r.isActive).length;
  const subs = rows.reduce((n, r) => n + r.subscribers, 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
          <strong style={{ color: "var(--text)" }}>{rows.length}</strong> compan
          {rows.length === 1 ? "y" : "ies"} · {live} active ·{" "}
          <strong style={{ color: "var(--text)" }}>{subs.toLocaleString()}</strong> subscribers in total
        </div>
        <button onClick={() => setAdding((v) => !v)} style={PRIMARY}>
          {adding ? "Cancel" : "＋ New company"}
        </button>
        <button onClick={load} style={GHOST}>Refresh</button>
      </div>

      {error && <div style={ERR}>{error}</div>}

      {adding && <NewCompany onDone={() => { setAdding(false); void load(); }} onError={setError} />}
      {limits && (
        <PlanEditor
          key={`plan-${limits.id}`}
          company={limits}
          onDone={() => { setLimits(null); void load(); }}
          onCancel={() => setLimits(null)}
          onError={setError}
        />
      )}
      {editing && (
        <EditCompany
          key={editing.id}
          company={editing}
          onDone={() => { setEditing(null); void load(); }}
          onCancel={() => setEditing(null)}
          onError={setError}
        />
      )}

      {rows.length === 0 && !error && (
        <div style={EMPTY}>
          No ISP companies yet. Create one and it becomes an independent tenant:
          its own franchises, dealers and retailers, invisible to every other
          company on this panel. Your own ISP business runs inside a company
          as well — create it here, then use Sign in to work in it.
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                {["Company", "Subscribers", "Routers", "Sub-accounts", "Franchises", "Dealers", "Since", ""].map((h, i) => (
                  <th key={h} style={{ ...TH, textAlign: i === 0 || i === 7 ? "left" : "right" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} style={{ opacity: c.isActive ? 1 : 0.55 }}>
                  <td style={TD}>
                    <div style={{ fontWeight: 700 }}>
                      {c.name}
                      {!c.isActive && <span style={PILL}>suspended</span>}
                      {c.isActive && planEnded(c.plan) && <span style={PILL}>plan ended</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>
                      {c.email}
                      {c.city ? ` · ${c.city}` : ""}
                      {c.plan?.expiresAt && !planEnded(c.plan) ? ` · plan ends ${new Date(c.plan.expiresAt).toLocaleDateString()}` : ""}
                    </div>
                  </td>
                  <td style={{ ...NUM, color: nearCap(c.subscribers, c.plan?.maxSubscribers) ? "#b45309" : undefined }}>{ofCap(c.subscribers, c.plan?.maxSubscribers)}</td>
                  <td style={{ ...NUM, color: nearCap(c.nas, c.plan?.maxNas) ? "#b45309" : undefined }}>{ofCap(c.nas, c.plan?.maxNas)}</td>
                  <td style={{ ...NUM, color: nearCap(accountsOf(c), c.plan?.maxAccounts) ? "#b45309" : undefined }}>{ofCap(accountsOf(c), c.plan?.maxAccounts)}</td>
                  <td style={NUM}>{c.franchises}</td>
                  <td style={NUM}>{c.dealers}</td>
                  <td style={NUM}>{new Date(c.createdAt).toLocaleDateString()}</td>
                  <td style={{ ...TD, whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => signIn(c)} disabled={busy === c.id} style={GHOST} title="Open this company's panel to help them">
                        Sign in
                      </button>
                      <button onClick={() => setEditing(c)} disabled={busy === c.id} style={GHOST}>Edit</button>
                      <button onClick={() => { setEditing(null); setLimits(c); }} disabled={busy === c.id} style={GHOST} title="Caps on subscribers, routers and sub-accounts, and an end date">
                        Limits
                      </button>
                      <button onClick={() => toggle(c)} disabled={busy === c.id} style={GHOST}>
                        {busy === c.id ? "…" : c.isActive ? "Suspend" : "Reactivate"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewCompany({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [f, setF] = React.useState({ name: "", email: "", password: "", phone: "", city: "" });
  const [busy, setBusy] = React.useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const ready = f.name.trim() && f.email.trim() && f.password.length >= 8;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      await api("/users", { method: "POST", body: JSON.stringify({ ...f, role: "ADMIN" }) });
      onDone();
    } catch (err: any) {
      onError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={CARD}>
      <div style={{ fontWeight: 800, color: "var(--text)", fontSize: 14, marginBottom: 4 }}>New ISP company</div>
      <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 12px", lineHeight: 1.6 }}>
        This creates the company's owner account. Everything they build —
        franchises, dealers, retailers, subscribers, routers — hangs beneath it
        and is invisible to every other company here. They will not see the
        licence, the server console, the database or the panel updates.
      </p>
      <div style={GRID}>
        <F label="Company name" v={f.name} on={set("name")} />
        <F label="Owner email (their login)" v={f.email} on={set("email")} type="email" />
        <F label="Password" v={f.password} on={set("password")} type="password" hint="At least 8 characters, with letters and numbers" />
        <F label="Phone" v={f.phone} on={set("phone")} />
        <F label="City" v={f.city} on={set("city")} />
      </div>
      <button type="submit" disabled={!ready || busy} style={{ ...PRIMARY, marginTop: 12, opacity: !ready || busy ? 0.55 : 1 }}>
        {busy ? "Creating…" : "Create company"}
      </button>
    </form>
  );
}

/** Company details and the owner's password — never its role or place in the tree. */
function EditCompany({ company, onDone, onCancel, onError }: {
  company: Company; onDone: () => void; onCancel: () => void; onError: (m: string) => void;
}) {
  const [f, setF] = React.useState({
    name: company.name || "", email: company.email || "", phone: company.phone || "", city: company.city || "", password: "",
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const ready = f.name.trim() && f.email.trim() && (!f.password || f.password.length >= 8);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      const body: Record<string, string> = { name: f.name.trim(), email: f.email.trim(), phone: f.phone, city: f.city };
      if (f.password) body.password = f.password;
      await api(`/users/${company.id}`, { method: "PUT", body: JSON.stringify(body) });
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={CARD}>
      <div style={{ fontWeight: 800, color: "var(--text)", fontSize: 14, marginBottom: 10 }}>Edit {company.name}</div>
      <div style={GRID}>
        <F label="Company name" v={f.name} on={set("name")} />
        <F label="Owner email (their login)" v={f.email} on={set("email")} type="email" />
        <F label="Phone" v={f.phone} on={set("phone")} />
        <F label="City" v={f.city} on={set("city")} />
        <F label="New password" v={f.password} on={set("password")} type="password" hint="Leave empty to keep the current one" />
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button type="submit" disabled={!ready || busy} style={{ ...PRIMARY, opacity: !ready || busy ? 0.55 : 1 }}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} style={GHOST}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * Plan & limits for one company. Empty = no limit. Past the end date the
 * company and everyone under it are signed out until it is moved (their
 * customers stay online — FreeRADIUS does not ask the panel).
 */
function PlanEditor({ company, onDone, onCancel, onError }: {
  company: Company; onDone: () => void; onCancel: () => void; onError: (m: string) => void;
}) {
  const p = company.plan;
  const str = (v: number | null | undefined) => (v == null ? "" : String(v));
  const [f, setF] = React.useState({
    maxSubscribers: str(p?.maxSubscribers), maxNas: str(p?.maxNas), maxAccounts: str(p?.maxAccounts),
    expiresAt: p?.expiresAt ? new Date(p.expiresAt).toISOString().slice(0, 10) : "", note: p?.note || "",
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const bad = (v: string) => v.trim() !== "" && !/^\d+$/.test(v.trim());
  const ready = !bad(f.maxSubscribers) && !bad(f.maxNas) && !bad(f.maxAccounts);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    if (f.expiresAt && new Date(`${f.expiresAt}T23:59:59`).getTime() < Date.now() &&
        !window.confirm(`That date has passed: ${company.name} and everyone under it will be signed out now. Continue?`)) return;
    setBusy(true);
    try {
      const num = (v: string) => (v.trim() === "" ? null : Number(v.trim()));
      await api(`/users/companies/${company.id}/plan`, {
        method: "PUT",
        body: JSON.stringify({
          maxSubscribers: num(f.maxSubscribers), maxNas: num(f.maxNas), maxAccounts: num(f.maxAccounts),
          // End of the chosen day, local time.
          expiresAt: f.expiresAt ? new Date(`${f.expiresAt}T23:59:59`).toISOString() : null,
          note: f.note.trim() || null,
        }),
      });
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={CARD}>
      <div style={{ fontWeight: 800, color: "var(--text)", fontSize: 14, marginBottom: 4 }}>Limits for {company.name}</div>
      <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 10, lineHeight: 1.55, maxWidth: 640 }}>
        Leave a box empty for no limit. At a limit the company cannot add more until you raise it. After the end
        date the company and everyone under it are signed out; their customers stay online.
      </div>
      <div style={GRID}>
        <F label={`Subscribers (now ${company.subscribers.toLocaleString()})`} v={f.maxSubscribers} on={set("maxSubscribers")} hint="Maximum customers" />
        <F label={`Routers (now ${company.nas})`} v={f.maxNas} on={set("maxNas")} hint="Maximum NAS / routers" />
        <F label={`Sub-accounts (now ${accountsOf(company)})`} v={f.maxAccounts} on={set("maxAccounts")} hint="Franchises, dealers, retailers and staff" />
        <F label="Plan ends" v={f.expiresAt} on={set("expiresAt")} type="date" hint="Empty = never" />
        <F label="Note (only you see it)" v={f.note} on={set("note")} hint="e.g. Gold plan, paid to Dec" />
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button type="submit" disabled={!ready || busy} style={{ ...PRIMARY, opacity: !ready || busy ? 0.55 : 1 }}>
          {busy ? "Saving…" : "Save limits"}
        </button>
        <button type="button" onClick={onCancel} style={GHOST}>Cancel</button>
      </div>
    </form>
  );
}

function F({ label, v, on, type = "text", hint }: { label: string; v: string; on: any; type?: string; hint?: string }) {
  return (
    <div>
      <label style={LBL}>{label}</label>
      <input type={type} value={v} onChange={on} style={INPUT} />
      {hint && <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

const TH: React.CSSProperties = {
  fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em",
  color: "var(--muted)", padding: "8px 10px", borderBottom: "1px solid var(--border,#E2E8F0)", whiteSpace: "nowrap",
};
const TD: React.CSSProperties = { padding: "10px", borderBottom: "1px solid var(--border,#E2E8F0)", verticalAlign: "top" };
const NUM: React.CSSProperties = { ...TD, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600, whiteSpace: "nowrap" };
const PILL: React.CSSProperties = {
  marginLeft: 7, border: "1px solid rgba(211,64,83,.38)", background: "rgba(211,64,83,.09)",
  color: "#b02a37", borderRadius: 999, padding: "1px 8px", fontSize: 9.5, fontWeight: 800, textTransform: "uppercase",
};
const CARD: React.CSSProperties = {
  border: "1px solid var(--border,#E2E8F0)", background: "var(--surface,#fff)",
  borderRadius: 12, padding: "14px 16px", margin: "0 0 14px",
};
const GRID: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 10 };
const LBL: React.CSSProperties = {
  display: "block", fontSize: 9.5, fontWeight: 800, textTransform: "uppercase",
  letterSpacing: ".06em", color: "var(--muted)", marginBottom: 4,
};
const INPUT: React.CSSProperties = {
  width: "100%", minWidth: 0, boxSizing: "border-box", border: "1px solid var(--border,#E2E8F0)",
  background: "var(--bg,#fff)", color: "var(--text)", borderRadius: 8, padding: "9px 11px", fontSize: 13,
};
const PRIMARY: React.CSSProperties = {
  border: "1px solid transparent", background: "linear-gradient(135deg,#6C3CE1,#E9408B)", color: "#fff",
  borderRadius: 9, padding: "8px 16px", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
};
// No "#fff" anywhere in a button's inline style: a global rule forces white
// text on any button whose style mentions it, which made these invisible.
const GHOST: React.CSSProperties = {
  border: "1px solid var(--border,#E2E8F0)", background: "var(--surface)", color: "var(--text)",
  borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer",
};
const ERR: React.CSSProperties = {
  border: "1px solid rgba(211,64,83,.38)", background: "rgba(211,64,83,.09)", color: "#b02a37",
  borderRadius: 9, padding: "9px 12px", fontSize: 12.5, fontWeight: 600, marginBottom: 12,
};
const EMPTY: React.CSSProperties = {
  border: "1px dashed var(--border,#E2E8F0)", borderRadius: 11, padding: "18px",
  fontSize: 12.5, lineHeight: 1.65, color: "var(--muted)", maxWidth: 560,
};
