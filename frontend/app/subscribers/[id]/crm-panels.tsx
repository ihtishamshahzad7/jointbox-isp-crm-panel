"use client";

/**
 * Advanced CRM panels for the Subscriber 360 billing tab: the server-built
 * account statement and printable receipts. Shown only when the company holds
 * `crm-advanced`; the backend refuses the routes otherwise, so hiding them
 * here is for tidiness, not for security.
 */
import React, { useEffect, useState } from "react";
import { Panel, Btn } from "./ui";
import { apiGet, apiSend } from "./lib";

export type GatedFeature = "ai-assistant" | "crm-advanced";

/** The add-on products the caller's company holds (empty while loading or on error). */
export function useCompanyFeatures(): Set<GatedFeature> {
  const [features, setFeatures] = useState<Set<GatedFeature>>(new Set());
  useEffect(() => {
    let live = true;
    apiGet<{ features: GatedFeature[] }>("/users/me/features").then((d) => {
      if (live && d?.features) setFeatures(new Set(d.features));
    });
    return () => { live = false; };
  }, []);
  return features;
}

type Entry = { date: string; reference: string; description: string; debit: number; credit: number; balance: number };
type Section = { currency: string; opening: number; debits: number; credits: number; closing: number; entries: Entry[] };
type Statement = {
  customer: { id: number; name: string; username: string; status: string };
  period: { from: string | null; to: string | null };
  sections: Section[];
  truncated: boolean;
};

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function StatementPanel({ subscriberId }: { subscriberId: number }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Statement | null>(null);
  // Which query the shown result answers; "loading" is derived, not set in the effect.
  const [loaded, setLoaded] = useState<{ key: string; ok: boolean } | null>(null);
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const key = `/crm/customers/${subscriberId}/statement${qs.toString() ? `?${qs}` : ""}`;
  const state = loaded?.key !== key ? "loading" : loaded.ok ? "idle" : "error";

  useEffect(() => {
    let live = true;
    apiGet<Statement>(key).then((d) => {
      if (!live) return;
      setData(d);
      setLoaded({ key, ok: !!d });
    });
    return () => { live = false; };
  }, [key]);

  const exportCsv = () => {
    if (!data) return;
    const q = (c: unknown) => `"${String(c).replace(/"/g, '""')}"`;
    const lines = [`Statement for ${data.customer.name} (${data.customer.username})`, `Period ${data.period.from ?? "start"} to ${data.period.to ?? "today"}`, ""];
    for (const s of data.sections) {
      lines.push(`Currency ${s.currency}`, ["Date", "Reference", "Description", "Debit", "Credit", "Balance"].join(","));
      lines.push(["", "", "Opening balance", "", "", s.opening.toFixed(2)].map(q).join(","));
      for (const e of s.entries) lines.push([e.date, e.reference, e.description, e.debit || "", e.credit || "", e.balance.toFixed(2)].map(q).join(","));
      lines.push(["", "", "Closing balance", s.debits.toFixed(2), s.credits.toFixed(2), s.closing.toFixed(2)].map(q).join(","), "");
    }
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `statement-${data.customer.username}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const input: React.CSSProperties = { fontSize: 12, padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)" };

  return (
    <Panel title="Account statement"
      actions={<Btn size="sm" variant="ghost" onClick={exportCsv} disabled={!data}>⤓ CSV</Btn>}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10, fontSize: 12, color: "var(--muted)" }}>
        <label htmlFor={`st-from-${subscriberId}`}>From</label>
        <input id={`st-from-${subscriberId}`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={input} />
        <label htmlFor={`st-to-${subscriberId}`}>To</label>
        <input id={`st-to-${subscriberId}`} type="date" value={to} onChange={(e) => setTo(e.target.value)} style={input} />
        {state === "loading" && <span>Loading…</span>}
        {state === "error" && <span style={{ color: "#D34053" }}>Could not load the statement. Check the dates or your access.</span>}
      </div>
      {data && data.sections.length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>No invoices or payments yet.</div>}
      {data?.sections.map((s) => (
        <div key={s.currency} className="sd-table-wrap" style={{ marginBottom: 10 }}>
          <table className="sd-table">
            <thead>
              <tr><th>Date</th><th>Reference</th><th>Description</th><th className="r">Debit</th><th className="r">Credit</th><th className="r">Balance ({s.currency})</th></tr>
            </thead>
            <tbody>
              <tr><td /><td /><td style={{ color: "var(--muted)" }}>Opening balance</td><td /><td /><td className="r">{fmt(s.opening)}</td></tr>
              {s.entries.map((e, i) => (
                <tr key={`${e.reference}-${i}`}>
                  <td style={{ whiteSpace: "nowrap" }}>{e.date}</td>
                  <td style={{ fontWeight: 700 }}>{e.reference}</td>
                  <td>{e.description}</td>
                  <td className="r">{e.debit ? fmt(e.debit) : ""}</td>
                  <td className="r" style={{ color: "#219653" }}>{e.credit ? fmt(e.credit) : ""}</td>
                  <td className="r" style={{ fontVariantNumeric: "tabular-nums", color: e.balance > 0 ? "#D34053" : "var(--text)" }}>{fmt(e.balance)}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 800 }}>
                <td /><td /><td>Closing balance</td><td className="r">{fmt(s.debits)}</td><td className="r">{fmt(s.credits)}</td><td className="r">{fmt(s.closing)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}
      {data?.truncated && <div style={{ fontSize: 11.5, color: "var(--muted)" }}>Showing the first 2,000 entries — narrow the dates to see the rest.</div>}
    </Panel>
  );
}

type Receipt = {
  receiptNo: string; customerName: string; username: string | null; packageName: string | null;
  amount: number; currency: string; method: string; referenceNo: string | null; paymentDate: string;
  invoiceNo: string | null; invoiceTotal: number | null; dueAfter: number | null; receivedBy: string | null;
  issuedAt: string; reprint: boolean;
};

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/** Opens the receipt in a print window. The first print issues it; reprints are marked as copies. */
export function ReceiptButton({ paymentId }: { paymentId: number }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    // Open first (inside the click) so pop-up blockers allow it.
    const w = window.open("", "_blank", "width=420,height=640");
    const r = await apiGet<Receipt>(`/crm/receipts/${paymentId}`);
    setBusy(false);
    if (!w) return;
    if (!r) { w.document.body.textContent = "Could not load the receipt."; return; }
    const row = (k: string, v: unknown) => (v === null || v === undefined || v === "" ? "" : `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`);
    const amount = (n: number | null) => (n == null ? null : `${r.currency} ${fmt(n)}`);
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${esc(r.receiptNo)}</title>
<style>body{font:13px/1.5 system-ui,sans-serif;color:#111;background:#fff;margin:24px}h1{font-size:17px;margin:0 0 2px}
.copy{display:inline-block;border:1px solid #111;padding:1px 6px;font-size:11px;letter-spacing:.08em;margin-left:6px}
table{width:100%;border-collapse:collapse;margin-top:12px}th{text-align:left;font-weight:600;color:#555;padding:4px 8px 4px 0;width:42%}
td{padding:4px 0;font-variant-numeric:tabular-nums}.amt td{font-size:18px;font-weight:800}small{color:#666}
@media print{button{display:none}}</style></head><body>
<h1>Payment receipt${r.reprint ? '<span class="copy">COPY</span>' : ""}</h1><small>No. ${esc(r.receiptNo)} · issued ${esc(new Date(r.issuedAt).toLocaleString())}</small>
<table>${row("Customer", r.customerName)}${row("Username", r.username)}${row("Package", r.packageName)}
${row("Paid on", new Date(r.paymentDate).toLocaleDateString())}${row("Method", r.method)}${row("Reference", r.referenceNo)}
${row("Invoice", r.invoiceNo)}${row("Invoice total", amount(r.invoiceTotal))}${row("Still due", amount(r.dueAfter))}${row("Received by", r.receivedBy)}
<tr class="amt"><th>Amount received</th><td>${esc(amount(r.amount))}</td></tr></table>
<p><button onclick="window.print()">Print</button></p></body></html>`);
    w.document.close();
  };
  return <Btn size="sm" variant="ghost" onClick={open} disabled={busy}>{busy ? "…" : "Receipt"}</Btn>;
}

type IssuedUnit = {
  id: number; status: string; charge: number; billing: string; invoiceId: number | null; issuedAt: string;
  recoveredAt: string | null; condition: string | null; billingError?: string;
  item: { id: number; serialNumber: string; type: string; model: string | null; qrCode: string | null } | null;
};
type StockUnit = { id: number; serialNumber: string; type: string; model: string | null; status: string };

/** Equipment at this customer: issue a unit from stock (free or charged on a normal invoice), bill, recover. */
export function EquipmentPanel({ subscriberId }: { subscriberId: number }) {
  const [rows, setRows] = useState<IssuedUnit[] | null>(null);
  const [rev, setRev] = useState(0);
  const [q, setQ] = useState("");
  const [stock, setStock] = useState<StockUnit[]>([]);
  const [itemId, setItemId] = useState("");
  const [charge, setCharge] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    apiGet<IssuedUnit[]>(`/crm/customers/${subscriberId}/equipment`).then((d) => { if (live) setRows(d ?? []); });
    return () => { live = false; };
  }, [subscriberId, rev]);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      apiGet<StockUnit[]>(`/inventory?status=IN_STOCK&limit=50${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`).then((d) => {
        if (live) setStock(d ?? []);
      });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, rev]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ text: await fn(), ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setBusy(false);
      setRev((n) => n + 1);
    }
  };

  const issue = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await apiSend<IssuedUnit>("/crm/inventory/issues", "POST", {
        itemId: Number(itemId), subscriberId, charge: charge.trim() === "" ? 0 : Number(charge), requestKey: crypto.randomUUID(),
      });
      setItemId("");
      setCharge("");
      if (r?.billingError) throw new Error(r.billingError);
      return r?.billing === "BILLED" ? "Issued and invoiced." : "Issued.";
    });
  };

  const input: React.CSSProperties = { fontSize: 12, padding: "5px 7px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)" };
  const open = (rows ?? []).filter((r) => r.status === "ISSUED");

  return (
    <Panel title={`Equipment (${open.length} with customer)`}>
      <form onSubmit={issue} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <label htmlFor={`eq-q-${subscriberId}`} style={{ fontSize: 12, color: "var(--muted)" }}>Issue from stock</label>
        <input id={`eq-q-${subscriberId}`} style={{ ...input, width: 150 }} placeholder="Search serial…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label htmlFor={`eq-item-${subscriberId}`} style={{ position: "absolute", left: -9999 }}>Unit</label>
        <select id={`eq-item-${subscriberId}`} style={{ ...input, maxWidth: 260 }} value={itemId} onChange={(e) => setItemId(e.target.value)}>
          <option value="">Choose unit…</option>
          {stock.map((s) => <option key={s.id} value={s.id}>{s.type} · {s.serialNumber}{s.model ? ` · ${s.model}` : ""}</option>)}
        </select>
        <label htmlFor={`eq-charge-${subscriberId}`} style={{ fontSize: 12, color: "var(--muted)" }}>Charge</label>
        <input id={`eq-charge-${subscriberId}`} style={{ ...input, width: 100 }} inputMode="decimal" placeholder="0 = free" value={charge} onChange={(e) => setCharge(e.target.value)} />
        <Btn size="sm" variant="primary" disabled={busy || !itemId}>Issue</Btn>
      </form>
      {msg && <div role="status" style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: msg.ok ? "#219653" : "#D34053" }}>{msg.text}</div>}
      {rows === null ? <div style={{ fontSize: 12, color: "var(--muted)" }}>Loading…</div> : rows.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--muted)" }}>No equipment issued yet.</div>
      ) : (
        <div className="sd-table-wrap">
          <table className="sd-table">
            <thead><tr><th>Unit</th><th>Issued</th><th className="r">Charge</th><th>Billing</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 700 }}>{r.item ? `${r.item.type} · ${r.item.serialNumber}` : `#${r.id}`}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.issuedAt.slice(0, 10)}</td>
                  <td className="r">{r.charge ? r.charge.toLocaleString() : "free"}</td>
                  <td>{r.billing === "BILLED" ? `Invoiced` : r.billing === "PENDING" ? "Not invoiced yet" : r.billing === "BILLING" ? "Invoicing…" : "—"}</td>
                  <td>{r.status === "ISSUED" ? "With customer" : `${r.status === "LOST" ? "Lost" : "Recovered"}${r.condition && r.condition !== "LOST" ? ` (${r.condition === "IN_STOCK" ? "to stock" : "faulty"})` : ""}`}</td>
                  <td className="r" style={{ whiteSpace: "nowrap" }}>
                    {r.billing === "PENDING" && (
                      <Btn size="xs" variant="warn" disabled={busy} onClick={() => run(async () => {
                        const b = await apiSend<IssuedUnit>(`/crm/inventory/issues/${r.id}/bill`, "POST");
                        if (b?.billingError) throw new Error(b.billingError);
                        return "Invoiced.";
                      })}>Bill now</Btn>
                    )}
                    {r.status === "ISSUED" && (["IN_STOCK", "FAULTY", "LOST"] as const).map((c) => (
                      <Btn key={c} size="xs" variant={c === "LOST" ? "danger" : "ghost"} disabled={busy}
                        onClick={() => {
                          if (c === "LOST" && !window.confirm("Write this unit off as lost?")) return;
                          void run(async () => {
                            await apiSend(`/crm/inventory/issues/${r.id}/recover`, "POST", { condition: c });
                            return c === "LOST" ? "Written off." : "Recovered.";
                          });
                        }}>{c === "IN_STOCK" ? "Recover" : c === "FAULTY" ? "Faulty" : "Lost"}</Btn>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

type Staff = { id: number; name: string; role: string };

/**
 * Terminate this customer. The disconnect is Uplinko's normal one (RADIUS,
 * live session, static IP); on top it records the reason and the monthly
 * revenue lost, and opens a recovery ticket if equipment is still out.
 */
export function TerminatePanel({ subscriberId, status, onDone }: { subscriberId: number; status?: string; onDone?: () => void }) {
  const [openForm, setOpenForm] = useState(false);
  const [reason, setReason] = useState("");
  const [assignTo, setAssignTo] = useState("");
  const [staff, setStaff] = useState<Staff[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (!openForm) return;
    let live = true;
    apiGet<Staff[]>("/users").then((d) => { if (live) setStaff(Array.isArray(d) ? d : []); });
    return () => { live = false; };
  }, [openForm]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.confirm("Terminate this customer? They will be disconnected now.")) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiSend<{ status: string; replay?: boolean; ticketId?: number; ticketError?: string; pendingUnits?: number }>(
        `/crm/customers/${subscriberId}/terminate`, "POST", { reason, assignTo: assignTo ? Number(assignTo) : null });
      if (r?.ticketError) setMsg({ text: r.ticketError, ok: false });
      else if (r?.replay) setMsg({ text: "Already terminated — the equipment recovery is still open.", ok: true });
      else setMsg({ text: r?.status === "RECOVERY_PENDING" ? `Terminated. Recovery ticket opened for ${r.pendingUnits ?? 0} unit(s).` : "Terminated. No equipment to recover.", ok: true });
      setOpenForm(false);
      onDone?.();
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), ok: false });
    } finally { setBusy(false); }
  };

  const input: React.CSSProperties = { fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)" };

  return (
    <Panel title="Termination"
      actions={!openForm && status !== "INACTIVE" ? <Btn size="sm" variant="danger" onClick={() => setOpenForm(true)}>Terminate…</Btn> : undefined}>
      {msg && <div role="status" style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: msg.ok ? "#219653" : "#D34053" }}>{msg.text}</div>}
      {openForm ? (
        <form onSubmit={submit} style={{ display: "grid", gap: 8, maxWidth: 560 }}>
          <label htmlFor={`term-reason-${subscriberId}`} style={{ fontSize: 12, color: "var(--muted)" }}>Reason (kept on record)</label>
          <textarea id={`term-reason-${subscriberId}`} style={{ ...input, minHeight: 64 }} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          <label htmlFor={`term-assign-${subscriberId}`} style={{ fontSize: 12, color: "var(--muted)" }}>Recovery assigned to (if equipment is out)</label>
          <select id={`term-assign-${subscriberId}`} style={input} value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
            <option value="">Unassigned</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.role.toLowerCase()}</option>)}
          </select>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn size="sm" variant="danger" disabled={busy || !reason.trim()}>{busy ? "Terminating…" : "Terminate customer"}</Btn>
            <Btn size="sm" variant="ghost" onClick={(e) => { e.preventDefault(); setOpenForm(false); }}>Cancel</Btn>
          </div>
        </form>
      ) : (
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          {status === "INACTIVE" ? "This customer is inactive." : "Disconnects the customer, records why, and opens a recovery ticket for any equipment still out."}
        </div>
      )}
    </Panel>
  );
}

type Costs = {
  equipment: Array<{ issueId: number; unit: string; status: string; cost: number | null; charged: number }>;
  expenses: Array<{ id: number; category: string; description: string | null; amount: number; status: string; counted: boolean }>;
  totals: {
    equipmentOut: number; equipmentRecovered: number; equipmentLost: number; unpricedUnits: number; linkedExpenses: number;
    chargedToCustomer: number; totalCost: number; monthlyRevenue: number; monthlyCost: number; monthlyMargin: number; paybackMonths: number | null;
  };
};

/** What this customer costs to serve, and how many months the connection takes to pay back. */
export function CostPanel({ subscriberId }: { subscriberId: number }) {
  const [data, setData] = useState<Costs | null>(null);
  const [rev, setRev] = useState(0);
  const [expenseId, setExpenseId] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    apiGet<Costs>(`/crm/customers/${subscriberId}/costs`).then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [subscriberId, rev]);

  const link = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiSend(`/crm/expenses/${Number(expenseId)}/customer`, "PUT", { subscriberId });
      setExpenseId("");
      setMsg({ text: "Expense linked.", ok: true });
      setRev((n) => n + 1);
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), ok: false });
    }
  };
  const unlink = async (id: number) => {
    try {
      await apiSend(`/crm/expenses/${id}/customer`, "PUT", { subscriberId: null });
      setRev((n) => n + 1);
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), ok: false });
    }
  };

  const t = data?.totals;
  const tile = (label: string, value: string, color?: string) => (
    <div className="sd-mini-cell" key={label}>
      <div className="m-label">{label}</div>
      <div className="m-value" style={color ? { color } : undefined}>{value}</div>
    </div>
  );
  const input: React.CSSProperties = { width: 90, fontSize: 12, padding: "5px 7px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)" };

  return (
    <Panel title="Cost to serve">
      {!data ? <div style={{ fontSize: 12, color: "var(--muted)" }}>Loading… (needs access to Accounting)</div> : (
        <>
          <div className="sd-kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 7, marginBottom: 10 }}>
            {tile("Equipment out", fmt(t!.equipmentOut))}
            {tile("Linked expenses", fmt(t!.linkedExpenses))}
            {tile("Paid by customer", fmt(t!.chargedToCustomer), "#219653")}
            {tile("Net cost", fmt(t!.totalCost), t!.totalCost > 0 ? "#D34053" : undefined)}
            {tile("Monthly margin", fmt(t!.monthlyMargin))}
            {tile("Pays back in", t!.paybackMonths === null ? "never at this margin" : t!.paybackMonths === 0 ? "already" : `${t!.paybackMonths} month${t!.paybackMonths === 1 ? "" : "s"}`)}
          </div>
          {t!.unpricedUnits > 0 && <div style={{ fontSize: 11.5, color: "#b45309", marginBottom: 8 }}>{t!.unpricedUnits} unit(s) have no purchase price, so the cost is understated.</div>}
          {data.expenses.length > 0 && (
            <div className="sd-table-wrap" style={{ marginBottom: 8 }}>
              <table className="sd-table">
                <thead><tr><th>Expense</th><th>Category</th><th className="r">Amount</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {data.expenses.map((e) => (
                    <tr key={e.id} style={{ opacity: e.counted ? 1 : 0.5 }}>
                      <td>#{e.id}{e.description ? ` · ${e.description}` : ""}</td>
                      <td>{e.category}</td>
                      <td className="r">{fmt(e.amount)}</td>
                      <td>{e.status.toLowerCase()}{e.counted ? "" : " (not counted)"}</td>
                      <td className="r"><Btn size="xs" variant="ghost" onClick={() => unlink(e.id)}>Unlink</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <form onSubmit={link} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
            <label htmlFor={`cost-exp-${subscriberId}`} style={{ color: "var(--muted)" }}>Link expense #</label>
            <input id={`cost-exp-${subscriberId}`} style={input} inputMode="numeric" value={expenseId} onChange={(e) => setExpenseId(e.target.value)} />
            <Btn size="sm" variant="default" disabled={!/^\d+$/.test(expenseId.trim())}>Link</Btn>
            {msg && <span role="status" style={{ fontWeight: 600, color: msg.ok ? "#219653" : "#D34053" }}>{msg.text}</span>}
          </form>
        </>
      )}
    </Panel>
  );
}
