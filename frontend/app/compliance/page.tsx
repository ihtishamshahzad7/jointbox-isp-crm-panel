"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Page, PageHead, Card, StatStrip, Stat, Button, Badge, Table, Cell, Col,
  Modal, Field, Input, Segmented, Empty, Callout, Meter, useToast, NV,
} from "../components/ui";
import { money } from "../components/currency";

const API =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

/**
 * Compliance — CNIC verification and data-usage enforcement.
 *
 * First page migrated onto the Nova UI kit. It composes shared primitives
 * instead of hand-rolling inline styles, which is why there is almost no
 * styling code left in here: the look now comes from the kit, so this file
 * can be about the workflow.
 */

const KYC_LABEL: Record<string, { label: string; tone: "ok" | "warn" | "bad" }> = {
  VERIFIED: { label: "Verified", tone: "ok" },
  PENDING: { label: "Awaiting check", tone: "warn" },
  REJECTED: { label: "Rejected", tone: "bad" },
  EXPIRED: { label: "CNIC expired", tone: "bad" },
};

const fd = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : "—");

/** Format as typed: 35201-1234567-1 */
const maskCnic = (v: string) => {
  const n = v.replace(/\D/g, "").slice(0, 13);
  if (n.length <= 5) return n;
  if (n.length <= 12) return `${n.slice(0, 5)}-${n.slice(5)}`;
  return `${n.slice(0, 5)}-${n.slice(5, 12)}-${n.slice(12)}`;
};

export default function CompliancePage() {
  const router = useRouter();
  const { show, node: toastNode } = useToast();

  const [tab, setTab] = useState("kyc");
  const [filter, setFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [stats, setStats] = useState<any>(null);
  const [queue, setQueue] = useState<any[]>([]);
  const [userRows, setUserRows] = useState<any[]>([]);
  const [dupes, setDupes] = useState<any[]>([]);
  const [fup, setFup] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ cnicNumber: "", cnicExpiry: "" });

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    try {
      const [st, q, dp, fu, uq] = await Promise.all([
        fetch(`${API}/compliance/kyc/stats`, { headers }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API}/compliance/kyc/queue?filter=${filter}`, { headers }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/compliance/kyc/duplicates`, { headers }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/compliance/fup/report`, { headers }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/compliance/kyc/users/queue?filter=${filter}`, { headers }).then((r) => (r.ok ? r.json() : [])),
      ]);
      setStats(st);
      setQueue(Array.isArray(q) ? q : []);
      setDupes(Array.isArray(dp) ? dp : []);
      setFup(Array.isArray(fu) ? fu : []);
      setUserRows(Array.isArray(uq) ? uq : []);
    } catch { /* keep the last good view */ }
    setLoading(false);
  }, [token, filter]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    load();
  }, [token, filter]);

  async function call(path: string, method: string, body?: any, okMsg = "Saved") {
    setBusy(true);
    try {
      const r = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Failed");
      show(d?.warning || okMsg, d?.warning ? "warn" : "ok");
      load();
      return d;
    } catch (e: any) { show(e.message, "bad"); return null; } finally { setBusy(false); }
  }

  function exportRegister() {
    fetch(`${API}/compliance/kyc/register`, { headers })
      .then((r) => r.json())
      .then((rows: any[]) => {
        if (!rows?.length) return show("Nothing to export", "warn");
        const cols = Object.keys(rows[0]);
        const csv = [
          cols.join(","),
          ...rows.map((r) => cols.map((c) => `"${String(r[c] ?? "").replace(/"/g, '""')}"`).join(",")),
        ].join("\n");
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `subscriber-register-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        show(`Exported ${rows.length} subscriber(s)`);
      })
      .catch(() => show("Export failed", "bad"));
  }

  const visible = queue.filter((r) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [r.fullName, r.username, r.phone, r.cnicNumber, r.formattedCnic]
      .some((v) => String(v ?? "").toLowerCase().includes(q));
  });

  /* ── columns ── */
  const kycCols: Col<any>[] = [
    { key: "sub", header: "Subscriber",
      render: (r) => <Cell top={r.fullName} bottom={`${r.username} · ${r.phone || "no phone"}`} /> },
    { key: "cnic", header: "CNIC",
      render: (r) => r.formattedCnic
        ? <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 12 }}>{r.formattedCnic}</span>
        : <span style={{ color: NV.bad }}>not recorded</span> },
    { key: "docs", header: "Documents",
      render: (r) => r.hasDocuments
        ? <Badge tone="ok" dot>both sides</Badge>
        : <Badge tone="warn" dot>{r.cnicFrontUrl ? "back missing" : r.cnicBackUrl ? "front missing" : "none uploaded"}</Badge> },
    { key: "exp", header: "Expiry",
      render: (r) => (
        <Cell top={fd(r.cnicExpiry)}
          bottom={r.daysToExpiry !== null && r.daysToExpiry <= 60
            ? (r.daysToExpiry < 0 ? `expired ${-r.daysToExpiry}d ago` : `${r.daysToExpiry}d left`)
            : undefined} />
      ) },
    { key: "status", header: "Status",
      render: (r) => {
        const k = KYC_LABEL[r.kycStatus] || KYC_LABEL.PENDING;
        return <Badge tone={k.tone} dot>{k.label}</Badge>;
      } },
    { key: "act", header: "", align: "right",
      render: (r) => (
        <div className="nv-row" style={{ justifyContent: "flex-end" }} onClick={(e) => e.stopPropagation()}>
          <Button size="sm" onClick={() => {
            setEditing(r);
            setForm({ cnicNumber: r.formattedCnic || "", cnicExpiry: r.cnicExpiry ? String(r.cnicExpiry).slice(0, 10) : "" });
          }}>CNIC</Button>
          <Button size="sm" variant="success" disabled={busy}
            onClick={() => call(`/compliance/kyc/${r.id}/verify`, "PATCH", { approved: true }, `${r.fullName} verified`)}>
            Verify
          </Button>
          <Button size="sm" variant="quiet" disabled={busy}
            onClick={() => call(`/compliance/kyc/${r.id}/verify`, "PATCH", { approved: false, notes: "Rejected from queue" }, "Marked rejected")}>
            Reject
          </Button>
        </div>
      ) },
  ];

  const fupCols: Col<any>[] = [
    { key: "sub", header: "Subscriber",
      render: (r) => <Cell top={r.name} bottom={`${r.username} · ${r.phone || "no phone"}`} /> },
    { key: "pkg", header: "Package", render: (r) => <span style={{ color: NV.muted }}>{r.package || "—"}</span> },
    { key: "use", header: "Usage", width: 190,
      render: (r) => (
        <div>
          <Meter value={r.percentUsed} tone={r.percentUsed >= 100 ? "bad" : r.percentUsed >= 90 ? "warn" : "ok"} />
          <div style={{ fontSize: 11, color: NV.muted, marginTop: 4 }}>
            {r.usedGb} of {r.quotaGb} GB · {r.percentUsed}%
          </div>
        </div>
      ) },
    { key: "state", header: "State",
      render: (r) => r.fupApplied
        ? <Badge tone="bad" dot>Throttled → {r.throttledTo}</Badge>
        : r.upsellCandidate
          ? <Badge tone="warn" dot>Over limit</Badge>
          : <Badge dot>Within limit</Badge> },
    { key: "act", header: "", align: "right",
      render: (r) => r.fupApplied ? (
        <div onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="success" disabled={busy}
            onClick={() => call(`/compliance/fup/${r.subscriberId}/release`, "PATCH", undefined, "Full speed restored")}>
            Restore speed
          </Button>
        </div>
      ) : null },
  ];

  const userVisible = userRows.filter((r) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [r.name, r.email, r.role, r.phone, r.cnicNumber, r.formattedCnic]
      .some((v) => String(v ?? "").toLowerCase().includes(q));
  });

  const userCols: Col<any>[] = [
    { key: "u", header: "Account",
      render: (r) => <Cell top={r.name} bottom={`${r.role} · ${r.email || "no email"}`} /> },
    { key: "cnic", header: "CNIC",
      render: (r) => r.formattedCnic
        ? <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 12 }}>{r.formattedCnic}</span>
        : <span style={{ color: NV.bad }}>not recorded</span> },
    { key: "docs", header: "Documents",
      render: (r) => r.hasDocuments
        ? <Badge tone="ok" dot>both sides</Badge>
        : <Badge tone="warn" dot>{r.cnicFrontUrl ? "back missing" : r.cnicBackUrl ? "front missing" : "none uploaded"}</Badge> },
    { key: "exp", header: "Expiry",
      render: (r) => <Cell top={fd(r.cnicExpiry)}
        bottom={r.daysToExpiry !== null && r.daysToExpiry <= 60
          ? (r.daysToExpiry < 0 ? `expired ${-r.daysToExpiry}d ago` : `${r.daysToExpiry}d left`) : undefined} /> },
    { key: "status", header: "Status",
      render: (r) => { const k = KYC_LABEL[r.kycStatus] || KYC_LABEL.PENDING; return <Badge tone={k.tone} dot>{k.label}</Badge>; } },
    { key: "act", header: "", align: "right",
      render: (r) => (
        <div className="nv-row" style={{ justifyContent: "flex-end" }} onClick={(e) => e.stopPropagation()}>
          <Button size="sm" onClick={() => {
            setEditing({ ...r, fullName: r.name, username: r.email, _isUser: true });
            setForm({ cnicNumber: r.formattedCnic || "", cnicExpiry: r.cnicExpiry ? String(r.cnicExpiry).slice(0, 10) : "" });
          }}>CNIC</Button>
          <Button size="sm" variant="success" disabled={busy}
            onClick={() => call(`/compliance/kyc/users/${r.id}/verify`, "PATCH", { approved: true }, `${r.name} verified`)}>Verify</Button>
          <Button size="sm" variant="quiet" disabled={busy}
            onClick={() => call(`/compliance/kyc/users/${r.id}/verify`, "PATCH", { approved: false, notes: "Rejected from queue" }, "Marked rejected")}>Reject</Button>
        </div>
      ) },
  ];

  return (
    <Page>
      {toastNode}

      <PageHead
        title="KYC & Data Usage"
        subtitle="Identity verification for every connection, and fair-usage enforcement."
        actions={<Button variant="primary" onClick={exportRegister}>Export register</Button>}
      />

      <StatStrip>
        <Stat label="Verified" value={`${stats?.compliancePercent ?? 0}%`}
          sub={`${stats?.verified ?? 0} of ${stats?.total ?? 0} connections`}
          progress={stats?.compliancePercent ?? 0}
          gradient={NV.secondary} glow={NV.glowSecondary}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>} />
        <Stat label="Needs checking" value={stats?.pending ?? 0} sub="sitting in the queue"
          tone={stats?.pending ? "warn" : undefined} gradient={NV.accent}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>} />
        <Stat label="No CNIC on file" value={stats?.missingCnicNumber ?? 0} sub="cannot be verified at all"
          tone={stats?.missingCnicNumber ? "bad" : undefined} gradient={NV.danger}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="3" y1="10" x2="21" y2="10" /></svg>} />
        <Stat label="Expiring in 60 days" value={stats?.expiringIn60Days ?? 0} sub="chase before they lapse"
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /></svg>} />
      </StatStrip>

      <div className="nv-row" style={{ marginBottom: 16, justifyContent: "space-between" }}>
        <Segmented value={tab} onChange={setTab} options={[
          { id: "kyc", label: `Subscriber KYC (${queue.length})` },
          { id: "users", label: `Account KYC (${userRows.length})` },
          { id: "duplicates", label: `Shared CNICs (${dupes.length})` },
          { id: "fup", label: `Data usage (${fup.length})` },
        ]} />
      </div>

      {/* ── Verification queue ── */}
      {tab === "kyc" && (
        <Card
          title="Verification queue"
          subtitle="Connections needing an identity check, worst first."
          pad={0}
          actions={
            <div className="nv-row">
              <Input placeholder="Search name, username, phone or CNIC…"
                value={search} onChange={(e) => setSearch(e.target.value)}
                style={{ width: 260 }} />
              <Segmented value={filter} onChange={setFilter} options={[
                { id: "ALL", label: "All" },
                { id: "PENDING", label: "Pending" },
                { id: "MISSING", label: "Incomplete" },
                { id: "EXPIRED", label: "Expired" },
              ]} />
            </div>
          }
        >
          <Table cols={kycCols} rows={visible} loading={loading}
            onRowClick={(r) => router.push(`/subscribers/${r.id}`)}
            empty="Nothing to check"
            emptyHint="Every connection in this view has a complete, verified identity on file." />
        </Card>
      )}

      {/* ── Account (reseller / staff) KYC ── */}
      {tab === "users" && (
        <Card
          title="Account verification queue"
          subtitle="Identity checks for reseller and staff accounts you manage."
          pad={0}
          actions={
            <div className="nv-row">
              <Input placeholder="Search name, email, role or CNIC…"
                value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />
              <Segmented value={filter} onChange={setFilter} options={[
                { id: "ALL", label: "All" },
                { id: "PENDING", label: "Pending" },
                { id: "MISSING", label: "Incomplete" },
                { id: "EXPIRED", label: "Expired" },
              ]} />
            </div>
          }
        >
          <Table cols={userCols} rows={userVisible} loading={loading}
            onRowClick={(r) => router.push(`/users/${r.id}`)}
            empty="Nothing to check"
            emptyHint="Every account in this view has a complete, verified identity on file." />
        </Card>
      )}

      {/* ── Shared CNICs ── */}
      {tab === "duplicates" && (
        <>
          <Callout tone="warn" title="One CNIC on several connections">
            Often a household or a business with multiple lines — and sometimes resale.
            These are listed so the decision is deliberate rather than accidental.
          </Callout>

          {dupes.length === 0 ? (
            <Card><Empty title="No shared CNICs"
              hint="No identity document appears on more than one connection." /></Card>
          ) : dupes.map((d) => (
            <Card key={d.cnicNumber} pad={2}
              title={d.formatted}
              actions={<Badge tone="warn">{d.count} connections</Badge>}>
              <div style={{ display: "grid", gap: 6 }}>
                {d.subscribers.map((sub: any) => {
                  const k = KYC_LABEL[sub.kycStatus] || KYC_LABEL.PENDING;
                  return (
                    <div key={sub.id} onClick={() => router.push(`/subscribers/${sub.id}`)}
                      style={{
                        background: "var(--surface-2)", borderRadius: 10, padding: "10px 14px",
                        cursor: "pointer", display: "flex", justifyContent: "space-between",
                        alignItems: "center", gap: 12, fontSize: 12.5,
                      }}>
                      <Cell top={sub.fullName} bottom={sub.username} />
                      <div className="nv-row">
                        <Badge tone={k.tone} dot>{k.label}</Badge>
                        <Badge>{sub.status}</Badge>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}
        </>
      )}

      {/* ── Data usage ── */}
      {tab === "fup" && (
        <Card
          title="Heavy users"
          subtitle="Customers at 70% of their allowance or beyond. Passing the limit reduces speed rather than cutting the line, so they stay connected and billable — and anyone at 100% is a natural upgrade conversation."
          pad={0}
        >
          <Table cols={fupCols} rows={fup} loading={loading}
            onRowClick={(r) => router.push(`/subscribers/${r.subscriberId}`)}
            empty="Nobody is near their limit"
            emptyHint="Customers appear here once they reach 70% of the data allowance on their package." />
        </Card>
      )}

      {/* ── CNIC editor ── */}
      <Modal
        open={!!editing} onClose={() => setEditing(null)}
        title="Record CNIC"
        subtitle={editing ? `${editing.fullName} · ${editing.username}` : undefined}
        width={440}
        footer={
          <>
            <Button variant="quiet" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" disabled={busy}
              onClick={async () => {
                const path = editing?._isUser
                  ? `/compliance/kyc/users/${editing.id}/cnic`
                  : `/compliance/kyc/${editing.id}/cnic`;
                const d = await call(path, "POST", {
                  cnicNumber: form.cnicNumber,
                  cnicExpiry: form.cnicExpiry || undefined,
                }, "CNIC recorded");
                if (d) setEditing(null);
              }}>Save</Button>
          </>
        }
      >
        <Field label="CNIC number" hint="13 digits. Punctuation is ignored when matching for duplicates.">
          <Input value={form.cnicNumber} placeholder="35201-1234567-1"
            style={{ fontFamily: "ui-monospace,monospace" }}
            onChange={(e) => setForm({ ...form, cnicNumber: maskCnic(e.target.value) })} />
        </Field>
        <Field label="Expiry date" hint="Optional. Expired documents are flagged automatically each morning.">
          <Input type="date" value={form.cnicExpiry}
            onChange={(e) => setForm({ ...form, cnicExpiry: e.target.value })} />
        </Field>
      </Modal>
    </Page>
  );
}
