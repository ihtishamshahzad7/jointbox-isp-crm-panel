"use client";

/**
 * Billing — read-only summary of this subscriber's invoices, payments and
 * tickets, with links into the real billing screens. Money flows stay in the
 * billing app; this page surfaces the state and the statement export.
 */
import React, { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useSubscriberDetail } from "./context";
import { Panel, Btn, StatusChip, EmptyState } from "./ui";
import { fmtDateTime, show } from "./lib";
import { money } from "../../components/currency";

export function BillingTab() {
  const { sub, invoices, payments, tickets } = useSubscriberDetail();
  const router = useRouter();

  const totals = useMemo(() => {
    const billed = invoices.reduce((a, i) => a + Number(i.total ?? 0), 0);
    const paid = invoices.reduce((a, i) => a + Number(i.paidAmount ?? 0), 0);
    const outstanding = billed - paid;
    return { billed, paid, outstanding };
  }, [invoices]);

  if (!sub) return <EmptyState title="No subscriber" />;

  const exportStatement = () => {
    const events = [
      ...invoices.map((i) => ({ date: i.createdAt || i.dueDate, type: "Invoice", ref: i.invoiceNo || i.id, desc: i.items?.[0]?.description || "Invoice", debit: Number(i.total ?? i.amount ?? 0), credit: 0 })),
      ...payments.map((p) => ({ date: p.createdAt || p.date, type: "Payment", ref: p.paymentNo || p.id, desc: p.method || "Payment", debit: 0, credit: Number(p.amount ?? 0) })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    let bal = 0;
    const rows = events.map((e) => {
      bal += e.debit - e.credit;
      return [new Date(e.date).toLocaleString(), e.type, e.ref, e.desc, e.debit || "", e.credit || "", bal.toFixed(2)];
    });
    const csv = [
      `Statement for ${sub.fullName} (${sub.username})`,
      `Generated ${new Date().toLocaleString()}`,
      "",
      ["Date", "Type", "Reference", "Description", "Debit", "Credit", "Balance"].join(","),
      ...rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `statement-${sub.username}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* Financial strip */}
      <div className="sd-kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 7 }}>
        <div className="sd-mini-cell">
          <div className="m-label">Billed (all invoices)</div>
          <div className="m-value">{money(totals.billed)}</div>
        </div>
        <div className="sd-mini-cell">
          <div className="m-label">Paid</div>
          <div className="m-value" style={{ color: "#219653" }}>{money(totals.paid)}</div>
        </div>
        <div className="sd-mini-cell">
          <div className="m-label">Outstanding</div>
          <div className="m-value" style={{ color: totals.outstanding > 0 ? "#D34053" : "var(--text)" }}>{money(Math.max(0, totals.outstanding))}</div>
        </div>
        <div className="sd-mini-cell">
          <div className="m-label">Wallet balance</div>
          <div className="m-value" style={{ color: Number(sub.balance ?? 0) < 0 ? "#D34053" : "var(--text)" }}>{money(sub.balance ?? 0)}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn size="sm" variant="primary" onClick={() => router.push("/invoices")}>Open Invoices</Btn>
        <Btn size="sm" variant="default" onClick={() => router.push("/payments")}>Open Payments</Btn>
        <Btn size="sm" variant="ghost" onClick={exportStatement} title="Invoices (debit) + payments (credit) with running balance, as CSV">⤓ Export statement</Btn>
      </div>

      {/* Invoices */}
      <Panel title={`Invoices (${invoices.length})`}
        actions={invoices.length ? <StatusChip level={invoices.some((i) => i.status !== "PAID" && i.status !== "VOID") ? "warn" : "ok"} text={invoices.some((i) => i.status !== "PAID" && i.status !== "VOID") ? "has open items" : "all settled"} dotPulse={false} /> : undefined}>
        {invoices.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>No invoices found.</div>
        ) : (
          <div className="sd-table-wrap">
            <table className="sd-table">
              <thead>
                <tr><th>Invoice</th><th>Status</th><th className="r">Amount</th><th className="r">Paid</th><th className="r">Due</th><th>Date</th></tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td style={{ fontWeight: 700 }}>{inv.invoiceNo}</td>
                    <td><StatusChip level={inv.status === "PAID" ? "ok" : inv.status === "VOID" ? "off" : "warn"} text={inv.status} dotPulse={false} /></td>
                    <td className="r">{money(inv.total)}</td>
                    <td className="r" style={{ color: "#219653" }}>{money(inv.paidAmount)}</td>
                    <td className="r" style={{ color: Number(inv.dueAmount) > 0 ? "#D34053" : "var(--text)" }}>{money(inv.dueAmount)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(inv.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Payments */}
      <Panel title={`Payments (${payments.length})`}>
        {payments.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>No payments found.</div>
        ) : (
          <div className="sd-table-wrap">
            <table className="sd-table">
              <thead>
                <tr><th>Payment</th><th>Method</th><th className="r">Amount</th><th>Reference</th><th>Date</th></tr>
              </thead>
              <tbody>
                {payments.map((pay) => (
                  <tr key={pay.id}>
                    <td style={{ fontWeight: 700 }}>{pay.paymentNo}</td>
                    <td>{show(pay.method)}</td>
                    <td className="r" style={{ color: "#219653", fontWeight: 700 }}>{money(pay.amount)}</td>
                    <td>{show(pay.referenceNo)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(pay.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Tickets */}
      <Panel title={`Tickets / complaints (${tickets.length})`}>
        {tickets.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>No tickets found.</div>
        ) : (
          <div className="sd-table-wrap">
            <table className="sd-table">
              <thead>
                <tr><th>Ticket</th><th>Status</th><th>Priority</th><th>Category</th><th>Subject</th><th>Created</th></tr>
              </thead>
              <tbody>
                {tickets.map((tkt) => (
                  <tr key={tkt.id}>
                    <td style={{ fontWeight: 700 }}>{tkt.ticketNo}</td>
                    <td><StatusChip level={tkt.status === "CLOSED" || tkt.status === "RESOLVED" ? "ok" : tkt.status === "OPEN" ? "warn" : "off"} text={tkt.status} dotPulse={false} /></td>
                    <td>{show(tkt.priority)}</td>
                    <td>{show(tkt.category)}</td>
                    <td>{show(tkt.subject)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(tkt.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}