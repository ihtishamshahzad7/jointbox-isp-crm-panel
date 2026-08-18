"use client";

/**
 * Package Detail Drawer — the control panel for one plan.
 *
 * Every number comes from GET /packages/:id/overview (real DB + JSON-store
 * data). Tabs:
 *   Overview  — plan facts, health checks, what a subscriber gets
 *   Pricing   — base + taxes → final; reseller buy rows (real rows only);
 *               profit is theirs, never shown as wallet credit
 *   Revenue   — real monthly revenue from ACTIVE subscribers' sellPrice
 *   Pool      — honest pool capacity+estimate with a label, plus RADIUS
 *               rate-limit preview (same string radius-sync writes)
 *   Audit     — ActivityLog rows with the acting user
 */
import { useEffect, useState } from "react";
import useSWR from "swr";
import Portal from "../components/portal";
import API from "../components/api";
import { money } from "../components/currency";
import {
  OverviewResponse, fupInfo, durationLabel, serviceTypeLabel,
  healthTone, fmtDate,
} from "./lib";

type Tab = "overview" | "pricing" | "revenue" | "pool" | "audit";

const TAB_LABEL: Record<Tab, string> = {
  overview: "Overview",
  pricing: "Pricing & Profit",
  revenue: "Revenue",
  pool: "Pool & RADIUS",
  audit: "Audit",
};

const MUTATION_LABEL: Record<string, string> = {
  PACKAGE_CREATE: "Created",
  PACKAGE_UPDATE: "Updated",
  PACKAGE_DELETE: "Deleted",
  PACKAGE_ACTIVATE: "Activated",
  PACKAGE_ARCHIVE: "Archived",
  PACKAGE_DUPLICATE: "Duplicated",
};

export default function PackageDetailDrawer({ id, token, onClose, onChanged }: {
  id: number; token: string | null; onClose: () => void; onChanged?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");

  const fetcher = async (url: string) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token || ""}` } });
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.json();
  };

  const { data, isLoading, error, mutate } = useSWR<OverviewResponse>(
    token ? `${API}/packages/${id}/overview` : null,
    fetcher
  );

  useEffect(() => { setTab("overview"); }, [id]);

  const pkg = data?.package;
  const fup = data?.fup;
  const hasWarn = (data?.health || []).some((h) => h.level === "warn");

  return (
    <Portal>
      <div style={{ position: "fixed", inset: 0, zIndex: 3000, background: "rgba(0,0,0,.45)", backdropFilter: "blur(3px)" }}
        onClick={onClose}>
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute", top: 0, right: 0, height: "100%", width: "min(680px, 94vw)",
            background: "var(--surface)", borderLeft: "1px solid var(--border)",
            display: "flex", flexDirection: "column", boxShadow: "-18px 0 50px rgba(0,0,0,.5)",
          }}>
          {/* Header */}
          <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "flex-start", gap: "14px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                <h2 style={{ fontSize: "18px", fontWeight: "800", color: "var(--text)", margin: 0 }}>{pkg?.name ?? "Package"}</h2>
                <span style={{
                  padding: "3px 10px", borderRadius: "999px", fontSize: "10px", fontWeight: "700", letterSpacing: ".06em", textTransform: "uppercase",
                  background: pkg?.isActive ? "rgba(16,185,129,.12)" : "rgba(255,112,112,.12)",
                  color: pkg?.isActive ? "#10B981" : "#ff7070",
                }}>
                  {pkg?.isActive ? "Active" : "Archived"}
                </span>
                {hasWarn && (
                  <span style={{ padding: "3px 10px", borderRadius: "999px", fontSize: "10px", fontWeight: "700",
                    background: "rgba(245,158,11,.12)", color: "#F59E0B" }}>⚠ config issue</span>
                )}
              </div>
              {pkg?.description && (
                <div style={{ fontSize: "12.5px", color: "var(--muted)", marginTop: "6px", lineHeight: 1.6 }}>{pkg.description}</div>
              )}
              <div style={{ fontSize: "11px", color: "var(--muted)", marginTop: "6px", fontFamily: "monospace" }}>
                {serviceTypeLabel(pkg?.serviceType)} · {durationLabel(pkg?.durationType)} · {money(pkg?.price)}{pkg?.duration ? ` / ${pkg.duration} day${pkg.duration === 1 ? "" : "s"}` : ""}
              </div>
            </div>
            <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: "20px", cursor: "pointer", lineHeight: 1 }} title="Close">✕</button>
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: "4px", padding: "10px 14px", borderBottom: "1px solid var(--border)", overflowX: "auto" }}>
            {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                style={{
                  padding: "7px 14px", borderRadius: "9px", fontSize: "12px", fontWeight: "600", cursor: "pointer",
                  border: "1px solid transparent", whiteSpace: "nowrap",
                  background: tab === t ? "rgba(108,60,225,.16)" : "transparent",
                  color: tab === t ? "var(--accent)" : "var(--muted)",
                }}>
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>
            {isLoading && <div style={{ color: "var(--muted)", fontSize: "13px" }}>Loading…</div>}
            {!isLoading && error && (
              <div style={{ color: "#ff7070", fontSize: "13px", lineHeight: 1.7 }}>
                Could not load package overview (HTTP {error?.message?.replace("Request failed: ", "")}).<br />
                The table still works — this drawer needs the overview endpoint.
              </div>
            )}
            {!isLoading && !error && data && (
              <>
                {tab === "overview" && <OverviewTab data={data} onRefresh={mutate} />}
                {tab === "pricing" && <PricingTab data={data} />}
                {tab === "revenue" && <RevenueTab data={data} />}
                {tab === "pool" && <PoolTab data={data} />}
                {tab === "audit" && <AuditTab data={data} />}
              </>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: "10px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)" }}>{label}</div>
      <div style={{ fontSize: "13px", fontWeight: "600", color: "var(--text)", marginTop: "3px" }}>{children}</div>
    </div>
  );
}

function OverviewTab({ data, onRefresh }: { data: OverviewResponse; onRefresh: () => void }) {
  const pkg = data.package;
  const fup = data.fup;
  const subs = pkg._count?.subscribers ?? data.impact.subscribers ?? 0;

  const specs = [
    { label: "Download", value: pkg.downloadSpeed != null ? `↓ ${pkg.downloadSpeed} Mbps` : "—" },
    { label: "Upload", value: pkg.uploadSpeed != null ? `↑ ${pkg.uploadSpeed} Mbps` : "—" },
    { label: "Quota / FUP", value: fup?.label ?? "—" },
    { label: "Duration", value: pkg.duration ? `${pkg.duration} day${pkg.duration === 1 ? "" : "s"}` : "—" },
    { label: "List price", value: pkg.price != null ? money(pkg.price) : "—" },
    { label: "IP Pool", value: pkg.pool?.name ?? "None assigned" },
    { label: "Subscribers", value: subs > 0 ? String(subs) : "0 (no subscribers)" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px" }}>
        {specs.map((s) => <Field key={s.label} label={s.label}>{s.value}</Field>)}
      </div>

      {/* Health checks — derived from real data server-side. */}
      <section>
        <h3 style={{ fontSize: "12px", fontWeight: "800", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", margin: "0 0 10px" }}>Configuration checks</h3>
        {(data.health || []).length === 0 && <div style={{ fontSize: "13px", color: "var(--muted)" }}>No checks.</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {(data.health || []).map((h, i) => {
            const t = healthTone(h.level);
            return (
              <div key={i} style={{
                padding: "10px 14px", borderRadius: "10px", border: "1px solid var(--border)",
                background: t.bg, fontSize: "12.5px", color: h.level === "warn" ? "#F59E0B" : "var(--muted)", lineHeight: 1.5,
              }}>
                {h.message}
              </div>
            );
          })}
        </div>
      </section>

      {/* Burden & maintenance */}
      <section>
        <h3 style={{ fontSize: "12px", fontWeight: "800", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", margin: "0 0 8px" }}>Details</h3>
        <div style={{ fontSize: "13px", color: "var(--muted)", lineHeight: 1.8 }}>
          {pkg.invoiceDescription && <div><b style={{ color: "var(--text)" }}>Invoice line:</b> {pkg.invoiceDescription}</div>}
          {data.warnings?.length > 0 && (
            <div style={{ color: "#F59E0B" }}>{data.warnings.map((w) => w.message).join(" · ")}</div>
          )}
          <div>{data.impact.resellers} reseller price assignment(s) · {data.impact.groups} access group(s)</div>
          <div style={{ fontSize: "11px", opacity: .8 }}>Changes take effect on new activations and renewals — live subscribers keep running until their session renews.</div>
        </div>
        <button onClick={onRefresh} style={{
          marginTop: "12px", padding: "7px 14px", borderRadius: "9px", fontSize: "12px", fontWeight: "600", cursor: "pointer",
          border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text)",
        }}>Refresh</button>
      </section>
    </div>
  );
}

function PricingTab({ data }: { data: OverviewResponse }) {
  const { pricing } = data;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <section>
        <h3 style={{ fontSize: "12px", fontWeight: "800", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", margin: "0 0 10px" }}>Price to the end customer</h3>
        <div style={{ border: "1px solid var(--border)", borderRadius: "12px", overflow: "hidden" }}>
          <RowLine k="Base (list) price" v={money(pricing.basePrice)} />
          {(pricing.taxDetail || []).map((t) => (
            <RowLine key={t.id} k={`↳ ${t.name} (${t.groupName})`}
              v={t.type === "FORMULA" ? "formula — computed at invoice time" : money(t.appliedAmount)} />
          ))}
          {(pricing.taxDetail || []).length === 0 && <RowLine k="↳ Taxes / fees" v="None linked" muted />}
          <RowLine k="Final (base + linked taxes)" v={money(pricing.finalWithTax)} strong />
        </div>
        <p style={{ fontSize: "11px", color: "var(--muted)", marginTop: "8px" }}>{pricing.note}</p>
      </section>

      <section>
        <h3 style={{ fontSize: "12px", fontWeight: "800", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", margin: "0 0 10px" }}>Reseller buy prices (real rows)</h3>
        {(pricing.resellerPrices || []).length === 0 && (
          <div style={{ fontSize: "13px", color: "var(--muted)" }}>No reseller price assignments recorded for this package.</div>
        )}
        {(pricing.resellerPrices || []).map((r) => (
          <div key={r.id} style={{ border: "1px solid var(--border)", borderRadius: "12px", padding: "12px 14px", marginBottom: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <div style={{ fontSize: "13px", fontWeight: "700", color: "var(--text)" }}>{r.user?.name || "—"}</div>
              <div style={{ fontSize: "12px", fontFamily: "monospace", color: "var(--muted)" }}>{r.user?.role} · {r.user?.email || "no email"}</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "8px", marginTop: "10px" }}>
              <Field label="Buy (wholesale)">{money(r.price)}</Field>
              <Field label="Retail">{r.retailPrice != null ? money(r.retailPrice) : "not set"}</Field>
              <Field label="Sub-reseller profit">{r.subresellerProfit != null ? money(r.subresellerProfit) : "—"}</Field>
              <Field label="Subscriber profit">{r.subscriberProfit != null ? money(r.subscriberProfit) : "—"}</Field>
            </div>
          </div>
        ))}
        {pricing.resellerPrices?.length ? (
          <p style={{ fontSize: "11px", color: "var(--muted)", marginTop: "8px" }}>
            Profit lives on the price rows, not the wallet — activation and renewal profits are settled through
            Reseller Pricing, not fabricated here.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function RowLine({ k, v, muted, strong }: { k: string; v: React.ReactNode; muted?: boolean; strong?: boolean }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px",
      padding: "10px 14px", borderBottom: "1px solid var(--border)",
      fontSize: strong ? "13.5px" : "13px", fontWeight: strong ? "800" : "500",
      color: muted ? "var(--muted)" : "var(--text)",
      background: strong ? "rgba(16,185,129,.06)" : "transparent",
    }}>
      <span>{k}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{v}</span>
    </div>
  );
}

function RevenueTab({ data }: { data: OverviewResponse }) {
  const r = data.revenue;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px" }}>
        <Field label="Monthly revenue">{money(r.monthlyRevenue)}</Field>
        <Field label="Active subscribers">{String(r.active)}</Field>
        <Field label="ARPU (rev per active)">{money(r.arpu)}</Field>
      </div>
      <p style={{ fontSize: "11px", color: "var(--muted)", margin: 0 }}>{r.note}</p>
      <div style={{ fontSize: "12.5px", color: "var(--muted)", lineHeight: 1.7 }}>
        Revenue is what ACTIVE subscribers actually pay (their sellPrice, which can differ per reseller).
        This matches the Reports → Analytics package mix so this drawer can never disagree with the reports page.
      </div>
    </div>
  );
}

function PoolTab({ data }: { data: OverviewResponse }) {
  const pool = data.pool;
  const radius = data.radius;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <section>
        <h3 style={{ fontSize: "12px", fontWeight: "800", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", margin: "0 0 10px" }}>IP Pool</h3>
        {!pool ? (
          <div style={{ fontSize: "13px", color: "var(--muted)" }}>
            No IP pool assigned — the NAS decides the address from its own PPPoE profile pool.
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "12px" }}>
              <Field label="Pool">{pool.name}</Field>
              <Field label="Network">{pool.network || "—"}/{pool.subnet || "—"}</Field>
              <Field label="Capacity (subnet math)">{pool.capacity.toLocaleString()}</Field>
              <Field label="Estimated used">{pool.estimatedUsed.toLocaleString()}</Field>
              <Field label="Utilization (estimate)">{pool.utilizationPct}%</Field>
            </div>
            <div style={{ height: "8px", borderRadius: "4px", background: "var(--surface-2)", overflow: "hidden", marginTop: "12px" }}>
              <div style={{ width: `${Math.min(100, pool.utilizationPct)}%`, height: "100%",
                background: pool.utilizationPct > 85 ? "#ff7070" : pool.utilizationPct > 60 ? "#F59E0B" : "#10B981" }} />
            </div>
            <p style={{ fontSize: "11px", color: "var(--muted)", marginTop: "8px" }}>{pool.note}</p>
          </>
        )}
      </section>

      <section>
        <h3 style={{ fontSize: "12px", fontWeight: "800", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", margin: "0 0 10px" }}>RADIUS preview</h3>
        <div style={{ border: "1px solid var(--border)", borderRadius: "12px", padding: "14px", fontFamily: "ui-monospace,monospace", fontSize: "12.5px", lineHeight: 1.8 }}>
          <div><b style={{ color: "var(--text)" }}>Mikrotik-Rate-Limit</b> = <code>{radius.rateLimit}</code></div>
          {radius.poolName && <div><b style={{ color: "var(--text)" }}>Framed-Pool</b> = <code>{radius.poolName}</code></div>}
          {(radius.policyAttributes || []).map((a, i) => (
            <div key={i}><b style={{ color: "var(--text)" }}>{a.attribute}</b> {a.op} <code>{a.value}</code></div>
          ))}
          {(radius.policyAttributes || []).length === 0 && <div style={{ color: "var(--muted)" }}>No linked policy attributes — standard rate limit only.</div>}
        </div>
        <p style={{ fontSize: "11px", color: "var(--muted)", marginTop: "8px" }}>{radius.note}</p>
      </section>
    </div>
  );
}

function AuditTab({ data }: { data: OverviewResponse }) {
  const audits = data.audit || [];
  if (!audits.length) {
    return <div style={{ fontSize: "13px", color: "var(--muted)" }}>No package history yet — changes here are recorded going forward.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {audits.map((a) => {
        let detail = "";
        try { detail = a.details ? JSON.stringify(JSON.parse(a.details), null, 1) : ""; } catch { detail = a.details || ""; }
        return (
          <div key={a.id} style={{ border: "1px solid var(--border)", borderRadius: "12px", padding: "12px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <span style={{ fontWeight: "700", fontSize: "13px", color: "var(--text)" }}>
                {MUTATION_LABEL[a.action] || a.action}
              </span>
              <span style={{ fontSize: "11px", color: "var(--muted)", fontFamily: "monospace" }}>{fmtDate(a.createdAt)}</span>
            </div>
            <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "6px" }}>
              {a.user ? `${a.user.name} (${a.user.role})` : "system"}
            </div>
            {detail && (
              <pre style={{ fontSize: "11px", color: "var(--muted)", background: "var(--surface-2)", borderRadius: "8px", padding: "10px", margin: "8px 0 0", overflowX: "auto", whiteSpace: "pre-wrap" }}>{detail}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}