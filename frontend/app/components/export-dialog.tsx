"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal, Button, Field, Input, Segmented, Badge, NV } from "./ui";
import { exportCsv, exportExcel } from "./export-file";
import { silent } from "./silent";

const API =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

/**
 * ExportDialog — build a filtered subscriber extract.
 *
 * The point is to answer a specific question rather than dump the table:
 * "all 50 Mb customers under Dealer 1", "everyone in Chitral expiring this
 * week". Filters AND together, and a live count shows how many rows the
 * current combination matches BEFORE anything is downloaded — so a mistake
 * costs a glance rather than a wasted export and a trip through Excel.
 */

type Filters = {
  packageIds: number[]; ownerIds: number[]; areaIds: number[]; nasIds: number[];
  statuses: string[]; authMethods: string[];
  expiringWithinDays?: number; expiredOnly?: boolean;
  onlineOnly?: boolean; hasStaticIp?: boolean; withoutCnic?: boolean;
  createdFrom?: string; createdTo?: string; search?: string;
};

const EMPTY: Filters = {
  packageIds: [], ownerIds: [], areaIds: [], nasIds: [], statuses: [], authMethods: [],
};

export default function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [opts, setOpts] = useState<any>(null);
  const [f, setF] = useState<Filters>(EMPTY);
  const [columns, setColumns] = useState<string[]>([]);
  const [format, setFormat] = useState("EXCEL");
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<"filter" | "columns">("filter");

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  useEffect(() => {
    if (!open || opts) return;
    fetch(`${API}/subscribers/export/options`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) { setOpts(d); setColumns(d.defaultColumns || []); } })
      .catch(silent("exportOptionsFetch"));
  }, [open]);

  // Live match count, debounced so toggling several filters quickly doesn't
  // fire a request per click.
  const refreshCount = useCallback(() => {
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/subscribers/export/preview`, {
          method: "POST", headers, body: JSON.stringify(f),
        });
        const d = await r.json();
        setCount(r.ok ? d.total : null);
      } catch { setCount(null); }
    }, 300);
    return () => clearTimeout(t);
  }, [f]);

  useEffect(() => { if (open) return refreshCount(); }, [f, open]);

  const toggle = (key: keyof Filters, val: any) => {
    setF((p) => {
      const cur = (p[key] as any[]) || [];
      return { ...p, [key]: cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val] };
    });
  };

  const toggleCol = (key: string) =>
    setColumns((p) => (p.includes(key) ? p.filter((c) => c !== key) : [...p, key]));

  async function run() {
    setBusy(true);
    try {
      // ALWAYS the standard layout. `format` selects the file container only —
      // a single fixed column set is what makes the file portable, so there is
      // no path here that emits anything else.
      const r = await fetch(`${API}/subscribers/export/panel`, {
        method: "POST", headers, body: JSON.stringify(f),
      });
      const d = await r.json();
      if (!r.ok || !d.rows?.length) { setBusy(false); return; }

      if (format === "CSV") exportCsv(d.headers, d.rows, "subscribers");
      else exportExcel(d.headers, d.rows, "subscribers");
      onClose();
    } catch { /* dialog stays open so the operator can retry */ }
    setBusy(false);
  }

  const activeCount =
    f.packageIds.length + f.ownerIds.length + f.areaIds.length + f.nasIds.length +
    f.statuses.length + f.authMethods.length +
    (f.expiringWithinDays != null ? 1 : 0) + (f.expiredOnly ? 1 : 0) +
    (f.onlineOnly ? 1 : 0) + (f.hasStaticIp ? 1 : 0) + (f.withoutCnic ? 1 : 0) +
    (f.createdFrom ? 1 : 0) + (f.createdTo ? 1 : 0) + (f.search ? 1 : 0);

  const groups = [...new Set((opts?.columns || []).map((c: any) => c.group))] as string[];

  return (
    <Modal
      open={open} onClose={onClose} width={760}
      title="Export subscribers"
      subtitle="Stack conditions to export exactly the group you need — they all apply together."
      footer={
        <>
          <div style={{ marginRight: "auto", fontSize: 12, color: NV.muted }}>
            {count === null ? "Counting…" : (
              <>
                <b style={{ color: count ? NV.ok : NV.warn, fontSize: 14 }}>{count.toLocaleString()}</b>
                {" "}subscriber{count === 1 ? "" : "s"} match
                {activeCount > 0 && ` · ${activeCount} filter${activeCount === 1 ? "" : "s"}`}
              </>
            )}
          </div>
          {activeCount > 0 && <Button variant="quiet" onClick={() => setF(EMPTY)}>Clear filters</Button>}
          {step === "filter"
            ? <Button variant="primary" onClick={() => setStep("columns")}>Next →</Button>
            : (
              <>
                <Button variant="ghost" onClick={() => setStep("filter")}>← Filters</Button>
                <Button variant="primary" disabled={busy || !count} onClick={run}>
                  {busy ? "Preparing…" : `Download ${format === "CSV" ? "CSV" : "Excel"}`}
                </Button>
              </>
            )}
        </>
      }
    >
      {!opts ? (
        <div style={{ color: NV.muted, fontSize: 13, padding: 20 }}>Loading options…</div>
      ) : step === "filter" ? (
        <div style={{ display: "grid", gap: 18 }}>
          <Field label="Search" hint="Matches name, username, phone, email or CNIC.">
            <Input placeholder="Optional — leave blank for all"
              value={f.search || ""} onChange={(e) => setF({ ...f, search: e.target.value })} />
          </Field>

          <Picker label="Package" hint='e.g. pick "50 Mb" to export only those customers'
            items={opts.packages.map((p: any) => ({
              id: p.id, label: `${p.name}${p.downloadSpeed ? ` · ${p.downloadSpeed} Mb` : ""}`,
            }))}
            selected={f.packageIds} onToggle={(v) => toggle("packageIds", v)} />

          <Picker label="Owner / Dealer" hint="Whose customers to include"
            items={opts.owners.map((o: any) => ({ id: o.id, label: `${o.name} · ${o.role}` }))}
            selected={f.ownerIds} onToggle={(v) => toggle("ownerIds", v)} />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <Picker label="Area" items={opts.areas.map((a: any) => ({ id: a.id, label: a.name }))}
              selected={f.areaIds} onToggle={(v) => toggle("areaIds", v)} />
            <Picker label="Router" items={opts.nas.map((n: any) => ({ id: n.id, label: n.nasname }))}
              selected={f.nasIds} onToggle={(v) => toggle("nasIds", v)} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <Picker label="Status" items={opts.statuses.map((s: string) => ({ id: s, label: s }))}
              selected={f.statuses} onToggle={(v) => toggle("statuses", v)} />
            <Picker label="Auth method" items={opts.authMethods.map((s: string) => ({ id: s, label: s }))}
              selected={f.authMethods} onToggle={(v) => toggle("authMethods", v)} />
          </div>

          <div>
            <div style={LABEL}>Expiry</div>
            <div className="nv-row">
              {[
                { k: "exp7", label: "Expiring in 7 days", on: f.expiringWithinDays === 7,
                  set: () => setF({ ...f, expiringWithinDays: f.expiringWithinDays === 7 ? undefined : 7, expiredOnly: false }) },
                { k: "exp30", label: "Expiring in 30 days", on: f.expiringWithinDays === 30,
                  set: () => setF({ ...f, expiringWithinDays: f.expiringWithinDays === 30 ? undefined : 30, expiredOnly: false }) },
                { k: "expired", label: "Already expired", on: !!f.expiredOnly,
                  set: () => setF({ ...f, expiredOnly: !f.expiredOnly, expiringWithinDays: undefined }) },
              ].map((c) => (
                <Chip key={c.k} on={c.on} onClick={c.set}>{c.label}</Chip>
              ))}
            </div>
          </div>

          <div>
            <div style={LABEL}>Other conditions</div>
            <div className="nv-row">
              <Chip on={!!f.onlineOnly} onClick={() => setF({ ...f, onlineOnly: !f.onlineOnly })}>Online now</Chip>
              <Chip on={!!f.hasStaticIp} onClick={() => setF({ ...f, hasStaticIp: !f.hasStaticIp })}>Has static IP</Chip>
              <Chip on={!!f.withoutCnic} onClick={() => setF({ ...f, withoutCnic: !f.withoutCnic })}>Missing CNIC</Chip>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Field label="Created from">
              <Input type="date" value={f.createdFrom || ""}
                onChange={(e) => setF({ ...f, createdFrom: e.target.value })} />
            </Field>
            <Field label="Created to">
              <Input type="date" value={f.createdTo || ""}
                onChange={(e) => setF({ ...f, createdTo: e.target.value })} />
            </Field>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 18 }}>
          {/* The LAYOUT is fixed — the choice here is only the file container.
              A single standard layout is what makes a file portable between
              systems, so there is deliberately no column picker. */}
          <div>
            <div style={LABEL}>File type</div>
            <Segmented value={format} onChange={setFormat} options={[
              { id: "EXCEL", label: "Excel (.xls)", title: "Formatted spreadsheet with a frozen header row" },
              { id: "CSV", label: "CSV (.csv)", title: "Plain text, opens anywhere" },
            ]} />
            <div style={{ fontSize: 11.5, color: NV.muted, marginTop: 8, lineHeight: 1.6 }}>
              {format === "EXCEL"
                ? "A real spreadsheet — bold frozen header, sized columns, numbers typed so they sum and sort correctly."
                : "Plain text with a UTF-8 marker so Excel reads Urdu names correctly instead of mangling them."}
            </div>
          </div>

          <div style={{
            padding: "14px 16px", borderRadius: 12, fontSize: 11.5, lineHeight: 1.7,
            background: "rgba(0,201,255,.07)", border: "1px solid rgba(0,201,255,.28)", color: NV.muted,
          }}>
            <b style={{ color: "#00C9FF", display: "block", marginBottom: 5, fontSize: 12 }}>
              Standard 46-column layout
            </b>
            Every export and import uses the same columns in the same order —
            <code style={{ color: "#93C5FD" }}> isp_id</code> through
            <code style={{ color: "#93C5FD" }}> onu_note</code>. Empty columns are still written,
            because other systems match on position as well as on name. That is what lets a file
            leave this panel, be edited in Excel, and load back without losing anything.
          </div>

          <div>
            <div style={LABEL}>What is included</div>
            <div style={{ display: "grid", gap: 7, fontSize: 11.5, color: NV.muted }}>
              {[
                ["Identity", "full_name · username · identity (CNIC) · phone · email · address"],
                ["Service", "package_id · connection_type · expiration_date · profile_status · previous_balance"],
                ["Network", "nas_id · static_ip · mac_address · mac_lock_status · area_id"],
                ["Allowance", "total_volume · used_volume · total_session · used_session · discount"],
                ["Installation", "box_number · box_address · switch_board · switch_port · electric_socket · cable_type · uplink_port · fiber_code · fiber_color · onu_note"],
              ].map(([g, cols]) => (
                <div key={g} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                  <span style={{
                    minWidth: 78, fontSize: 10, fontWeight: 700, color: "#A78BFA",
                    textTransform: "uppercase", letterSpacing: ".05em",
                  }}>{g}</span>
                  <span style={{ flex: 1, fontFamily: "ui-monospace,monospace", fontSize: 10.5 }}>{cols}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ fontSize: 11.5, color: NV.warn, lineHeight: 1.6 }}>
            The file contains <b>plain-text passwords</b> when exported by the ISP owner —
            that is required for a migration to be usable on the far side. Handle it accordingly.
            Dealers receive the same layout with those two columns blank.
          </div>
        </div>
      )}
    </Modal>
  );
}

const LABEL: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 600, color: "var(--muted)",
  textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8,
};

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      background: on ? "linear-gradient(135deg,#6C3CE1,#E9408B)" : "var(--surface-2)",
      color: on ? "#fff" : "var(--muted)",
      border: `1px solid ${on ? "transparent" : "var(--border)"}`,
      borderRadius: 99, padding: "6px 13px", fontSize: 11.5, fontWeight: 600,
      cursor: "pointer", fontFamily: "inherit",
      boxShadow: on ? "0 4px 14px rgba(233,64,139,.26)" : "none",
      transition: "all .16s cubic-bezier(.34,1.56,.64,1)",
    }}>{children}</button>
  );
}

/** Long option lists get a search box — a hundred dealers is unusable as chips. */
function Picker({
  label, hint, items, selected, onToggle,
}: {
  label: string; hint?: string;
  items: Array<{ id: any; label: string }>;
  selected: any[]; onToggle: (v: any) => void;
}) {
  const [q, setQ] = useState("");
  const shown = q ? items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())) : items;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <div style={LABEL}>{label}{selected.length > 0 && <Badge tone="info"> {selected.length}</Badge>}</div>
        {items.length > 8 && (
          <input placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)}
            style={{
              background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8,
              padding: "4px 9px", fontSize: 11, color: "var(--text)", outline: "none", width: 120,
            }} />
        )}
      </div>
      {hint && <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>{hint}</div>}
      <div className="nv-row" style={{ maxHeight: 132, overflowY: "auto" }}>
        {shown.length === 0 && <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Nothing matches.</span>}
        {shown.map((i) => (
          <Chip key={i.id} on={selected.includes(i.id)} onClick={() => onToggle(i.id)}>{i.label}</Chip>
        ))}
      </div>
    </div>
  );
}
