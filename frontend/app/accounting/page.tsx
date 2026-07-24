"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { silent } from "../components/silent";

const API = process.env.NEXT_PUBLIC_BACKEND_URL || (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:"http://localhost:3001");

const T = {
  bg: "var(--bg)",
  card: "var(--surface)",
  border: "var(--border)",
  row: "var(--surface-2)",
  text: "var(--text)",
  muted: "var(--muted)",
  sub: "var(--muted)",
  accent: "#0ea5e9",
  green: "#22c55e",
  red: "#ef4444",
  amber: "#f59e0b",
  purple: "#8b5cf6",
};

const ACCOUNTS = ["", "CASH", "ACCOUNTS_RECEIVABLE", "REVENUE", "EXPENSE", "SUBSCRIBER_BALANCE"];
const TABS = ["Ledger", "Cashflow", "Expenses", "Balances", "Automation"] as const;
type Tab = (typeof TABS)[number];

const fmt = (n: number) =>
  new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
const fdate = (d: string | Date) => new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export default function AccountingPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("Ledger");
  const [summary, setSummary] = useState<any[]>([]);

  // ledger
  const [ledger, setLedger] = useState<any[]>([]);
  /** Why the ledger is empty, when it is empty for a reason. */
  const [ledgerNote, setLedgerNote] = useState("");
  const [ledgerCursor, setLedgerCursor] = useState<number | null>(null);
  const [ledgerAccount, setLedgerAccount] = useState("");
  // cashflow
  const [cashflow, setCashflow] = useState<any>(null);
  const [cfDays, setCfDays] = useState(30);
  // expenses
  const [expenses, setExpenses] = useState<any[]>([]);
  const [expForm, setExpForm] = useState({ category: "", amount: "", description: "" });
  // balances
  const [balances, setBalances] = useState<any[]>([]);
  const [historyFor, setHistoryFor] = useState<number | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [topupFor, setTopupFor] = useState<any>(null);
  const [topupAmount, setTopupAmount] = useState("");
  // automation
  const [runs, setRuns] = useState<any[]>([]);
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const get = useCallback(
    async (path: string) => {
      const r = await fetch(`${API}${path}`, { headers });
      if (r.status === 401) {
        router.push("/login");
        throw new Error("unauthorized");
      }
      return r.json();
    },
    [token],
  );

  useEffect(() => {
    if (!token) {
      router.push("/login");
      return;
    }
    get("/accounting/ledger/summary").then(setSummary).catch(silent("loadLedgerSummary"));
  }, []);

  // ── per-tab loaders ──────────────────────────────────────────
  const loadLedger = useCallback(
    async (reset = true) => {
      const cursor = reset ? "" : ledgerCursor ? `&cursor=${ledgerCursor}` : "";
      const acc = ledgerAccount ? `&account=${ledgerAccount}` : "";
      try {
        const data = await get(`/accounting/ledger?limit=50${acc}${cursor}`);

        // The response is not always a page of rows. A refusal comes back as
        // { statusCode, message }, and reading `.items` off that gave
        // undefined — which then crashed the render on `.map`. Any response
        // without an items array is treated as "nothing to show", with the
        // reason surfaced rather than swallowed.
        if (!Array.isArray(data?.items)) {
          setLedger([]);
          setLedgerCursor(null);
          setLedgerNote(data?.message || "The ledger is not available for this account.");
          return;
        }

        setLedgerNote("");
        setLedger(reset ? data.items : [...ledger, ...data.items]);
        setLedgerCursor(data.nextCursor ?? null);
      } catch (e: any) {
        setLedger([]);
        setLedgerCursor(null);
        setLedgerNote(e?.message || "Could not load the ledger.");
      }
    },
    [ledgerAccount, ledgerCursor, ledger, get],
  );

  useEffect(() => {
    if (!token) return;
    if (tab === "Ledger") void loadLedger(true);
    if (tab === "Cashflow") get(`/accounting/cashflow?days=${cfDays}`).then(setCashflow).catch(silent("loadCashflow"));
    if (tab === "Expenses") get("/accounting/expenses").then(setExpenses).catch(silent("loadExpenses"));
    if (tab === "Balances") get("/accounting/balances").then(setBalances).catch(silent("loadBalances"));
    if (tab === "Automation") get("/billing/runs").then(setRuns).catch(silent("loadBillingRuns"));
  }, [tab, ledgerAccount, cfDays]);

  // ── actions ──────────────────────────────────────────────────
  async function addExpense() {
    if (!expForm.category || !expForm.amount) return setMsg("Category and amount are required");
    setBusy(true);
    try {
      await fetch(`${API}/accounting/expenses`, { method: "POST", headers, body: JSON.stringify(expForm) });
      setExpForm({ category: "", amount: "", description: "" });
      setExpenses(await get("/accounting/expenses"));
      setMsg("Expense added");
    } finally {
      setBusy(false);
    }
  }

  async function deleteExpense(id: number) {
    if (!confirm("Delete this expense? A reversal will be posted to the ledger.")) return;
    await fetch(`${API}/accounting/expenses/${id}`, { method: "DELETE", headers });
    setExpenses(await get("/accounting/expenses"));
  }

  async function doTopup() {
    const amount = Number(topupAmount);
    if (!amount || amount <= 0) return setMsg("Enter a valid amount");
    setBusy(true);
    try {
      await fetch(`${API}/accounting/balances/${topupFor.id}/topup`, {
        method: "POST",
        headers,
        body: JSON.stringify({ amount }),
      });
      setTopupFor(null);
      setTopupAmount("");
      setBalances(await get("/accounting/balances"));
      setMsg("Balance topped up");
    } finally {
      setBusy(false);
    }
  }

  async function showHistory(id: number) {
    setHistoryFor(historyFor === id ? null : id);
    if (historyFor !== id) setHistory(await get(`/accounting/balances/${id}/history`));
  }

  async function triggerRun(type: string) {
    setBusy(true);
    try {
      const r = await fetch(`${API}/billing/run/${type}?dryRun=${dryRun ? 1 : 0}`, { method: "POST", headers });
      const data = await r.json();
      setMsg(`Job queued: ${data.jobId || JSON.stringify(data)}${dryRun ? " (dry run)" : ""}`);
      setTimeout(async () => setRuns(await get("/billing/runs")), 2500);
    } finally {
      setBusy(false);
    }
  }

  // ── UI helpers ───────────────────────────────────────────────
  const card: React.CSSProperties = {
    background: T.card,
    border: `1px solid ${T.border}`,
    borderRadius: 12,
    padding: 16,
  };
  const th: React.CSSProperties = {
    textAlign: "left",
    padding: "8px 10px",
    color: T.muted,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };
  const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, color: T.text };
  const btn = (bg: string): React.CSSProperties => ({
    background: bg,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    opacity: busy ? 0.6 : 1,
  });
  const input: React.CSSProperties = {
    background: T.bg,
    border: `1px solid ${T.border}`,
    borderRadius: 8,
    padding: "8px 10px",
    color: T.text,
    fontSize: 13,
  };

  const cfMax = cashflow?.series?.length
    ? Math.max(...cashflow.series.map((r: any) => Math.max(r.inflow, r.outflow)), 1)
    : 1;

  return (
    <div style={{ padding: 20, color: T.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        {msg && (
          <span style={{ fontSize: 12, color: T.sub, cursor: "pointer" }} onClick={() => setMsg("")}>
            {msg} ✕
          </span>
        )}
      </div>

      {/* summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 16 }}>
        {summary.map((s) => (
          <div key={s.account} style={card}>
            <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>
              {s.account.replaceAll("_", " ")}
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: s.net >= 0 ? T.green : T.red }}>
              {fmt(Math.abs(s.net))}
            </div>
            <div style={{ fontSize: 11, color: T.muted }}>Dr {fmt(s.debit)} · Cr {fmt(s.credit)}</div>
          </div>
        ))}
      </div>

      {/* tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {TABS.map((name) => (
          <button
            key={name}
            onClick={() => setTab(name)}
            style={{
              ...btn(tab === name ? T.accent : T.card),
              border: `1px solid ${tab === name ? T.accent : T.border}`,
              color: tab === name ? "#fff" : T.sub,
            }}
          >
            {name}
          </button>
        ))}
      </div>

      {/* ── LEDGER ── */}
      {tab === "Ledger" && (
        <div style={card}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <select value={ledgerAccount} onChange={(e) => setLedgerAccount(e.target.value)} style={input}>
              {ACCOUNTS.map((a) => (
                <option key={a} value={a}>
                  {a || "All accounts"}
                </option>
              ))}
            </select>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                <th style={th}>Date</th><th style={th}>Account</th><th style={th}>Description</th>
                <th style={th}>Ref</th><th style={{ ...th, textAlign: "right" }}>Debit</th>
                <th style={{ ...th, textAlign: "right" }}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((e, i) => (
                <tr key={e.id} style={{ background: i % 2 ? "transparent" : T.row }}>
                  <td style={td}>{fdate(e.entryDate)}</td>
                  <td style={td}>{e.account.replaceAll("_", " ")}</td>
                  <td style={{ ...td, color: T.sub }}>{e.description || "—"}</td>
                  <td style={{ ...td, color: T.muted, fontSize: 12 }}>{e.refType ? `${e.refType}#${e.refId ?? ""}` : "—"}</td>
                  <td style={{ ...td, textAlign: "right", color: e.debit ? T.green : T.muted }}>{e.debit ? fmt(e.debit) : ""}</td>
                  <td style={{ ...td, textAlign: "right", color: e.credit ? T.red : T.muted }}>{e.credit ? fmt(e.credit) : ""}</td>
                </tr>
              ))}
              {!ledger.length && (
                <tr><td style={{ ...td, color: ledgerNote ? T.amber : T.muted }} colSpan={6}>
                  {ledgerNote ||
                    "No ledger entries yet — they appear automatically when invoices and payments are created."}
                </td></tr>
              )}
            </tbody>
          </table>
          {ledgerCursor && (
            <button style={{ ...btn(T.card), border: `1px solid ${T.border}`, color: T.sub, marginTop: 10 }} onClick={() => loadLedger(false)}>
              Load more
            </button>
          )}
        </div>
      )}

      {/* ── CASHFLOW ── */}
      {tab === "Cashflow" && (
        <div style={card}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
            {[30, 60, 90].map((d) => (
              <button key={d} onClick={() => setCfDays(d)} style={{ ...btn(cfDays === d ? T.accent : T.card), border: `1px solid ${cfDays === d ? T.accent : T.border}`, color: cfDays === d ? "#fff" : T.sub }}>
                {d} days
              </button>
            ))}
            {cashflow && (
              <span style={{ marginLeft: "auto", fontSize: 13, color: T.sub }}>
                In <b style={{ color: T.green }}>{fmt(cashflow.totals.inflow)}</b> · Out{" "}
                <b style={{ color: T.red }}>{fmt(cashflow.totals.outflow)}</b> · Net{" "}
                <b style={{ color: cashflow.totals.net >= 0 ? T.green : T.red }}>{fmt(cashflow.totals.net)}</b>
              </span>
            )}
          </div>
          {cashflow?.series?.map((r: any) => (
            <div key={r.date} style={{ display: "grid", gridTemplateColumns: "90px 1fr 1fr 90px", gap: 8, alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: T.muted }}>{r.date}</span>
              <div style={{ background: T.bg, borderRadius: 4, height: 14 }}>
                <div style={{ width: `${(r.inflow / cfMax) * 100}%`, background: T.green, height: 14, borderRadius: 4 }} />
              </div>
              <div style={{ background: T.bg, borderRadius: 4, height: 14 }}>
                <div style={{ width: `${(r.outflow / cfMax) * 100}%`, background: T.red, height: 14, borderRadius: 4 }} />
              </div>
              <span style={{ fontSize: 12, textAlign: "right", color: r.net >= 0 ? T.green : T.red }}>{fmt(r.net)}</span>
            </div>
          ))}
          {!cashflow?.series?.length && <div style={{ color: T.muted, fontSize: 13 }}>No cash movement in this period.</div>}
        </div>
      )}

      {/* ── EXPENSES ── */}
      {tab === "Expenses" && (
        <div style={card}>
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            <input style={input} placeholder="Category (e.g. Bandwidth, Salary)" value={expForm.category} onChange={(e) => setExpForm({ ...expForm, category: e.target.value })} />
            <input style={input} placeholder="Amount" type="number" value={expForm.amount} onChange={(e) => setExpForm({ ...expForm, amount: e.target.value })} />
            <input style={{ ...input, flex: 1 }} placeholder="Description (optional)" value={expForm.description} onChange={(e) => setExpForm({ ...expForm, description: e.target.value })} />
            <button style={btn(T.accent)} disabled={busy} onClick={addExpense}>Add expense</button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                <th style={th}>Date</th><th style={th}>Category</th><th style={th}>Description</th>
                <th style={{ ...th, textAlign: "right" }}>Amount</th><th style={th} />
              </tr>
            </thead>
            <tbody>
              {expenses.map((e, i) => (
                <tr key={e.id} style={{ background: i % 2 ? "transparent" : T.row }}>
                  <td style={td}>{fdate(e.expenseDate)}</td>
                  <td style={td}>{e.category}</td>
                  <td style={{ ...td, color: T.sub }}>{e.description || "—"}</td>
                  <td style={{ ...td, textAlign: "right", color: T.red }}>{fmt(e.amount)}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button style={{ ...btn(T.red), padding: "4px 10px", fontSize: 12 }} onClick={() => deleteExpense(e.id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {!expenses.length && <tr><td style={{ ...td, color: T.muted }} colSpan={5}>No expenses recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* ── BALANCES ── */}
      {tab === "Balances" && (
        <div style={card}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                <th style={th}>Subscriber</th><th style={th}>Username</th><th style={th}>Phone</th>
                <th style={th}>Status</th><th style={{ ...th, textAlign: "right" }}>Balance</th><th style={th} />
              </tr>
            </thead>
            <tbody>
              {balances.map((b, i) => (
                <>
                  <tr key={b.id} style={{ background: i % 2 ? "transparent" : T.row }}>
                    <td style={td}>{b.fullName}</td>
                    <td style={{ ...td, color: T.sub }}>{b.username}</td>
                    <td style={{ ...td, color: T.sub }}>{b.phone}</td>
                    <td style={td}>
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: b.status === "ACTIVE" ? "#22c55e22" : "#ef444422", color: b.status === "ACTIVE" ? T.green : T.red }}>{b.status}</span>
                    </td>
                    <td style={{ ...td, textAlign: "right", fontWeight: 700, color: b.balance > 0 ? T.green : T.muted }}>{fmt(b.balance)}</td>
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                      <button style={{ ...btn(T.accent), padding: "4px 10px", fontSize: 12, marginRight: 6 }} onClick={() => setTopupFor(b)}>Top up</button>
                      <button style={{ ...btn(T.card), border: `1px solid ${T.border}`, color: T.sub, padding: "4px 10px", fontSize: 12 }} onClick={() => showHistory(b.id)}>History</button>
                    </td>
                  </tr>
                  {historyFor === b.id && (
                    <tr key={`h-${b.id}`}>
                      <td colSpan={6} style={{ ...td, background: T.bg }}>
                        {history.length ? history.map((h) => (
                          <div key={h.id} style={{ display: "flex", gap: 12, fontSize: 12, padding: "3px 0", color: T.sub }}>
                            <span style={{ width: 150 }}>{fdate(h.createdAt)}</span>
                            <span style={{ width: 90 }}>{h.type}</span>
                            <span style={{ width: 90, textAlign: "right", color: h.amount >= 0 ? T.green : T.red }}>{fmt(h.amount)}</span>
                            <span style={{ width: 110, textAlign: "right" }}>bal {fmt(h.balanceAfter)}</span>
                            <span>{h.reference || h.notes || ""}</span>
                          </div>
                        )) : <span style={{ color: T.muted, fontSize: 12 }}>No wallet history.</span>}
                      </td>
                    </tr>
                  )}
                </>
              ))}
              {!balances.length && <tr><td style={{ ...td, color: T.muted }} colSpan={6}>No subscribers found.</td></tr>}
            </tbody>
          </table>

          {topupFor && (
            <div style={{ position: "fixed", inset: 0, background: "#000a", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }} onClick={() => setTopupFor(null)}>
              <div style={{ ...card, width: 340 }} onClick={(e) => e.stopPropagation()}>
                <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Top up — {topupFor.fullName}</h3>
                <input style={{ ...input, width: "100%", marginBottom: 10 }} type="number" placeholder="Amount" value={topupAmount} onChange={(e) => setTopupAmount(e.target.value)} autoFocus />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button style={{ ...btn(T.card), border: `1px solid ${T.border}`, color: T.sub }} onClick={() => setTopupFor(null)}>Cancel</button>
                  <button style={btn(T.green)} disabled={busy} onClick={doTopup}>Confirm</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── AUTOMATION ── */}
      {tab === "Automation" && (
        <div style={card}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
            <button style={btn(T.accent)} disabled={busy} onClick={() => triggerRun("auto-invoice")}>Run auto-invoice</button>
            <button style={btn(T.green)} disabled={busy} onClick={() => triggerRun("auto-renewal")}>Run auto-renewal</button>
            <button style={btn(T.amber)} disabled={busy} onClick={() => triggerRun("suspension")}>Run suspension</button>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: T.sub, cursor: "pointer" }}>
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              Dry run (preview only)
            </label>
            <span style={{ marginLeft: "auto", fontSize: 12, color: T.muted }}>Scheduled nightly: 00:30 invoice · 01:00 renewal · 02:00 suspension</span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                <th style={th}>#</th><th style={th}>Type</th><th style={th}>Started</th><th style={th}>Mode</th>
                <th style={{ ...th, textAlign: "right" }}>Processed</th><th style={{ ...th, textAlign: "right" }}>OK</th>
                <th style={{ ...th, textAlign: "right" }}>Failed</th><th style={th}>Details</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r, i) => (
                <tr key={r.id} style={{ background: i % 2 ? "transparent" : T.row }}>
                  <td style={{ ...td, color: T.muted }}>{r.id}</td>
                  <td style={td}>{r.type}</td>
                  <td style={{ ...td, color: T.sub }}>{fdate(r.startedAt)}</td>
                  <td style={td}>{r.dryRun ? <span style={{ color: T.amber }}>DRY</span> : "LIVE"}</td>
                  <td style={{ ...td, textAlign: "right" }}>{r.processed}</td>
                  <td style={{ ...td, textAlign: "right", color: T.green }}>{r.succeeded}</td>
                  <td style={{ ...td, textAlign: "right", color: r.failed ? T.red : T.muted }}>{r.failed}</td>
                  <td style={{ ...td, color: T.muted, fontSize: 11, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.details || ""}>{r.details || "—"}</td>
                </tr>
              ))}
              {!runs.length && <tr><td style={{ ...td, color: T.muted }} colSpan={8}>No billing runs yet. Trigger one above (dry run is safe).</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
