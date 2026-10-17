"use client";

import React from "react";
import API from "../components/api";

/**
 * PLANS & PRICING — platform owner only.
 *
 * The price list companies are sold on. Each plan carries a price and the
 * limits it allows. Choosing a plan for a company (Companies → Limits) copies
 * these limits to that company, and those copied limits are what the panel
 * enforces. Changing a plan here does not touch companies already on it until
 * "Apply to companies" is pressed, so a price edit never silently cuts anyone.
 */

interface Plan {
  id: number;
  name: string;
  price: number;
  currency: string;
  billingPeriod: "MONTHLY" | "YEARLY";
  maxSubscribers: number | null;
  maxNas: number | null;
  maxAccounts: number | null;
  features: string[];
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  companies: number;
}

type Draft = Omit<Plan, "id" | "companies" | "maxSubscribers" | "maxNas" | "maxAccounts" | "price" | "sortOrder"> & {
  price: string;
  sortOrder: string;
  maxSubscribers: string;
  maxNas: string;
  maxAccounts: string;
};

const FEATURE_LABEL: Record<string, string> = {
  subscribers: "Subscribers",
  billing: "Billing & invoices",
  accounting: "Accounting",
  monitoring: "Monitoring",
  fiber: "Fiber / OLT",
  hotspot: "Hotspot",
  api: "API access",
  "white-label": "White-label",
};

function token(): string {
  try {
    return localStorage.getItem("token") || "";
  } catch {
    return "";
  }
}

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, ...(init?.headers || {}) },
  });
  const body = (await r.json().catch(() => ({}))) as { message?: unknown };
  if (!r.ok) {
    const m = Array.isArray(body?.message) ? body.message.join(", ") : body?.message;
    throw new Error(String(m || `Request failed (${r.status})`));
  }
  return body as T;
}

const str = (v: number | null | undefined) => (v == null ? "" : String(v));
const toDraft = (p?: Plan): Draft => ({
  name: p?.name ?? "",
  price: p ? String(p.price) : "0",
  currency: p?.currency ?? "PKR",
  billingPeriod: p?.billingPeriod ?? "MONTHLY",
  maxSubscribers: str(p?.maxSubscribers),
  maxNas: str(p?.maxNas),
  maxAccounts: str(p?.maxAccounts),
  features: p?.features ?? ["subscribers", "billing"],
  description: p?.description ?? "",
  sortOrder: p ? String(p.sortOrder) : "10",
  isActive: p?.isActive ?? true,
});
const limit = (v: number | null) => (v == null ? "No limit" : v.toLocaleString());
const money = (p: Plan) =>
  `${p.currency} ${p.price.toLocaleString(undefined, { maximumFractionDigits: 2 })} / ${p.billingPeriod === "YEARLY" ? "year" : "month"}`;

export default function PlatformPlans() {
  const [plans, setPlans] = React.useState<Plan[] | null>(null);
  const [features, setFeatures] = React.useState<string[]>([]);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [editing, setEditing] = React.useState<Plan | "new" | null>(null);

  const load = React.useCallback(async () => {
    try {
      const r = await api<{ plans: Plan[]; features: string[] }>("/platform/plans");
      setPlans(r.plans);
      setFeatures(r.features);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPlans([]);
    }
  }, []);

  React.useEffect(() => {
    let alive = true;
    api<{ plans: Plan[]; features: string[] }>("/platform/plans")
      .then((r) => {
        if (!alive) return;
        setPlans(r.plans);
        setFeatures(r.features);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setPlans([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function remove(p: Plan) {
    if (!window.confirm(`Delete the ${p.name} plan?`)) return;
    try {
      await api(`/platform/plans/${p.id}`, { method: "DELETE" });
      setNotice(`${p.name} deleted.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function apply(p: Plan) {
    if (
      !window.confirm(
        `Copy ${p.name}'s current limits to the ${p.companies} compan${p.companies === 1 ? "y" : "ies"} on it?\n\n` +
          "A company already above a new limit keeps everything it has, but cannot add more until it is back under it.",
      )
    )
      return;
    try {
      const r = await api<{ updated: number }>(`/platform/plans/${p.id}/apply`, { method: "POST" });
      setNotice(`${p.name}: limits applied to ${r.updated} compan${r.updated === 1 ? "y" : "ies"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (plans === null) return <p style={{ fontSize: 13, color: "var(--muted)" }}>Loading plans…</p>;

  return (
    <div>
      <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 12px", lineHeight: 1.6, maxWidth: 720 }}>
        Your price list for ISP companies. Pick a plan for a company under <strong>Companies → Limits</strong>: its
        subscriber, router and sub-account limits are copied to that company and enforced by the panel. Editing a
        plan here changes companies already on it only when you press <strong>Apply to companies</strong>.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => setEditing(editing === "new" ? null : "new")} style={PRIMARY}>
          {editing === "new" ? "Cancel" : "＋ New plan"}
        </button>
        <button onClick={load} style={GHOST}>Refresh</button>
      </div>
      {error && <div style={ERR} role="alert">{error}</div>}
      {notice && <div style={OK} role="status">{notice}</div>}

      {editing && (
        <PlanForm
          key={editing === "new" ? "new" : editing.id}
          plan={editing === "new" ? undefined : editing}
          features={features}
          onDone={(msg) => {
            setEditing(null);
            setNotice(msg);
            setError("");
            void load();
          }}
          onCancel={() => setEditing(null)}
          onError={setError}
        />
      )}

      <div style={CARDS}>
        {plans.map((p) => (
          <article key={p.id} style={{ ...CARD, opacity: p.isActive ? 1 : 0.6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: "var(--text)" }}>{p.name}</h3>
              {!p.isActive && <span style={PILL}>off</span>}
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, margin: "6px 0 2px", color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
              {money(p)}
            </div>
            {p.description && <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>{p.description}</div>}
            <dl style={DL}>
              <dt>Subscribers</dt><dd>{limit(p.maxSubscribers)}</dd>
              <dt>Routers (NAS)</dt><dd>{limit(p.maxNas)}</dd>
              <dt>Sub-accounts</dt><dd>{limit(p.maxAccounts)}</dd>
              <dt>Companies on it</dt><dd>{p.companies}</dd>
            </dl>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "8px 0 10px" }}>
              {p.features.map((f) => (
                <span key={f} style={TAG}>{FEATURE_LABEL[f] ?? f}</span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button onClick={() => setEditing(p)} style={GHOST}>Edit</button>
              <button onClick={() => apply(p)} disabled={!p.companies} style={GHOST} title="Copy this plan's limits to every company on it">
                Apply to companies
              </button>
              <button onClick={() => remove(p)} disabled={p.companies > 0} style={GHOST} title={p.companies ? "Move its companies first, or switch it off" : "Delete"}>
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
      <p style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 14, maxWidth: 720, lineHeight: 1.6 }}>
        Limits are enforced today. The feature tags describe what the plan includes for your sales and invoices;
        they do not yet switch modules on or off inside a company&apos;s panel.
      </p>
    </div>
  );
}

function PlanForm({
  plan,
  features,
  onDone,
  onCancel,
  onError,
}: {
  plan?: Plan;
  features: string[];
  onDone: (msg: string) => void;
  onCancel: () => void;
  onError: (m: string) => void;
}) {
  const [f, setF] = React.useState<Draft>(toDraft(plan));
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.value });
  const badNum = (v: string) => v.trim() !== "" && !/^\d+$/.test(v.trim());
  const ready =
    f.name.trim() && /^\d+(\.\d{1,2})?$/.test(f.price.trim()) && !badNum(f.maxSubscribers) && !badNum(f.maxNas) && !badNum(f.maxAccounts);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    const num = (v: string) => (v.trim() === "" ? null : Number(v.trim()));
    const body = {
      name: f.name.trim(),
      price: Number(f.price),
      currency: f.currency,
      billingPeriod: f.billingPeriod,
      maxSubscribers: num(f.maxSubscribers),
      maxNas: num(f.maxNas),
      maxAccounts: num(f.maxAccounts),
      features: f.features,
      description: f.description,
      sortOrder: Number(f.sortOrder) || 0,
      isActive: f.isActive,
    };
    try {
      if (plan) await api(`/platform/plans/${plan.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await api("/platform/plans", { method: "POST", body: JSON.stringify(body) });
      onDone(plan ? `${body.name} saved.` : `${body.name} created.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ ...CARD, marginBottom: 14 }}>
      <div style={{ fontWeight: 800, fontSize: 14, color: "var(--text)", marginBottom: 10 }}>
        {plan ? `Edit ${plan.name}` : "New plan"}
      </div>
      <div style={GRID}>
        <Field id="pl-name" label="Plan name" value={f.name} onChange={set("name")} />
        <Field id="pl-price" label="Price" value={f.price} onChange={set("price")} hint="0 or more, up to 2 decimals" />
        <Field id="pl-cur" label="Currency" value={f.currency} onChange={set("currency")} hint="3 letters, e.g. PKR, USD" />
        <div>
          <label style={LBL} htmlFor="pl-per">Billed</label>
          <select id="pl-per" value={f.billingPeriod} onChange={set("billingPeriod")} style={INPUT}>
            <option value="MONTHLY">Monthly</option>
            <option value="YEARLY">Yearly</option>
          </select>
        </div>
        <Field id="pl-subs" label="Max subscribers" value={f.maxSubscribers} onChange={set("maxSubscribers")} hint="Empty = no limit" />
        <Field id="pl-nas" label="Max routers (NAS)" value={f.maxNas} onChange={set("maxNas")} hint="Empty = no limit" />
        <Field id="pl-acc" label="Max sub-accounts" value={f.maxAccounts} onChange={set("maxAccounts")} hint="Franchises, dealers, retailers, staff" />
        <Field id="pl-order" label="Order in list" value={f.sortOrder} onChange={set("sortOrder")} />
        <Field id="pl-desc" label="Short description" value={f.description ?? ""} onChange={set("description")} />
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: "12px 0 0" }}>
        <legend style={LBL}>Includes</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {features.map((ft) => (
            <label key={ft} style={{ fontSize: 12.5, display: "inline-flex", gap: 6, alignItems: "center", color: "var(--text)" }}>
              <input
                type="checkbox"
                checked={f.features.includes(ft)}
                onChange={(e) =>
                  setF({ ...f, features: e.target.checked ? [...f.features, ft] : f.features.filter((x) => x !== ft) })
                }
              />
              {FEATURE_LABEL[ft] ?? ft}
            </label>
          ))}
        </div>
      </fieldset>
      <label style={{ fontSize: 12.5, display: "inline-flex", gap: 6, alignItems: "center", marginTop: 12, color: "var(--text)" }}>
        <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
        Offered (switched-off plans cannot be given to new companies)
      </label>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button type="submit" disabled={!ready || busy} style={{ ...PRIMARY, opacity: !ready || busy ? 0.55 : 1 }}>
          {busy ? "Saving…" : "Save plan"}
        </button>
        <button type="button" onClick={onCancel} style={GHOST}>Cancel</button>
      </div>
    </form>
  );
}

function Field({ id, label, value, onChange, hint }: {
  id: string; label: string; value: string; onChange: React.ChangeEventHandler<HTMLInputElement>; hint?: string;
}) {
  return (
    <div>
      <label style={LBL} htmlFor={id}>{label}</label>
      <input id={id} value={value} onChange={onChange} style={INPUT} />
      {hint && <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

const CARDS: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 12 };
const CARD: React.CSSProperties = {
  border: "1px solid var(--border,#E2E8F0)", background: "var(--surface,#fff)", borderRadius: 12, padding: "14px 16px",
};
const DL: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 10px", fontSize: 12.5, margin: 0, color: "var(--text)",
};
const TAG: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: "2px 8px",
  border: "1px solid var(--border,#E2E8F0)", color: "var(--muted)",
};
const GRID: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10 };
const LBL: React.CSSProperties = {
  display: "block", fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--muted)", marginBottom: 4,
};
const INPUT: React.CSSProperties = {
  width: "100%", minWidth: 0, boxSizing: "border-box", border: "1px solid var(--border,#E2E8F0)",
  background: "var(--bg,#fff)", color: "var(--text)", borderRadius: 8, padding: "9px 11px", fontSize: 13,
};
const PRIMARY: React.CSSProperties = {
  border: "1px solid transparent", background: "linear-gradient(135deg,#6C3CE1,#E9408B)", color: "#fff",
  borderRadius: 9, padding: "8px 16px", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
};
const GHOST: React.CSSProperties = {
  border: "1px solid var(--border,#E2E8F0)", background: "var(--surface)", color: "var(--text)",
  borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer",
};
const PILL: React.CSSProperties = {
  border: "1px solid rgba(211,64,83,.38)", background: "rgba(211,64,83,.09)", color: "#b02a37",
  borderRadius: 999, padding: "1px 8px", fontSize: 9.5, fontWeight: 800, textTransform: "uppercase",
};
const ERR: React.CSSProperties = {
  border: "1px solid rgba(211,64,83,.38)", background: "rgba(211,64,83,.09)", color: "#b02a37",
  borderRadius: 9, padding: "9px 12px", fontSize: 12.5, fontWeight: 600, marginBottom: 12,
};
const OK: React.CSSProperties = {
  border: "1px solid rgba(22,163,74,.35)", background: "rgba(22,163,74,.08)", color: "var(--text)",
  borderRadius: 9, padding: "9px 12px", fontSize: 12.5, fontWeight: 600, marginBottom: 12,
};
