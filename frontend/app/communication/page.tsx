"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { silent } from "../components/silent";

const API = process.env.NEXT_PUBLIC_BACKEND_URL || (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:"http://localhost:3001");

const T = {
  bg: "var(--bg)", card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)", sub: "var(--muted)",
  accent: "#0ea5e9", green: "#22c55e", red: "#ef4444", amber: "#f59e0b",
};

const EVENTS = ["MANUAL", "WELCOME", "INVOICE_CREATED", "PAYMENT_RECEIVED", "EXPIRY_REMINDER", "RENEWAL", "SUSPENSION"];
const VARS = "{name} {username} {phone} {package} {amount} {dueAmount} {expiry} {invoiceNo} {balance} {daysLeft}";
const TABS = ["Templates", "Send", "Log"] as const;
type Tab = (typeof TABS)[number];

const fdate = (d: string) => new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export default function CommunicationPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("Templates");
  const [status, setStatus] = useState<any>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // templates
  const [templates, setTemplates] = useState<any[]>([]);
  const [tplForm, setTplForm] = useState<any>({ name: "", channel: "SMS", event: "MANUAL", subject: "", body: "" });
  const [editingTpl, setEditingTpl] = useState<number | null>(null);
  // send
  const [sendForm, setSendForm] = useState<any>({ channel: "SMS", title: "", body: "", status: "ALL", areaId: "", packageId: "" });
  const [areas, setAreas] = useState<any[]>([]);
  const [packages, setPackages] = useState<any[]>([]);
  // test
  const [testForm, setTestForm] = useState({ channel: "SMS", recipient: "", message: "Test from Jointbox" });
  // log
  const [log, setLog] = useState<any[]>([]);
  const [logCursor, setLogCursor] = useState<number | null>(null);
  const [logStatus, setLogStatus] = useState("");

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const get = useCallback(async (path: string) => {
    const r = await fetch(`${API}${path}`, { headers });
    if (r.status === 401) { router.push("/login"); throw new Error("unauthorized"); }
    return r.json();
  }, [token]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    get("/communication/status").then(setStatus).catch(silent("loadCommStatus"));
    get("/areas").then((d) => setAreas(Array.isArray(d) ? d : [])).catch(silent("loadAreas"));
    get("/packages").then((d) => setPackages(Array.isArray(d) ? d : [])).catch(silent("loadPackages"));
  }, []);

  const loadLog = useCallback(async (reset = true) => {
    const cursor = reset ? "" : logCursor ? `&cursor=${logCursor}` : "";
    const st = logStatus ? `&status=${logStatus}` : "";
    const data = await get(`/communication/messages?limit=50${st}${cursor}`);
    setLog(reset ? data.items : [...log, ...data.items]);
    setLogCursor(data.nextCursor);
  }, [logCursor, logStatus, log, get]);

  useEffect(() => {
    if (!token) return;
    if (tab === "Templates") get("/communication/templates").then(setTemplates).catch(silent("loadTemplates"));
    if (tab === "Log") void loadLog(true);
  }, [tab, logStatus]);

  async function saveTemplate() {
    if (!tplForm.name || !tplForm.body) return setMsg("Name and body are required");
    setBusy(true);
    try {
      const url = editingTpl ? `/communication/templates/${editingTpl}` : "/communication/templates";
      await fetch(`${API}${url}`, { method: editingTpl ? "PUT" : "POST", headers, body: JSON.stringify(tplForm) });
      setTplForm({ name: "", channel: "SMS", event: "MANUAL", subject: "", body: "" });
      setEditingTpl(null);
      setTemplates(await get("/communication/templates"));
      setMsg("Template saved");
    } finally { setBusy(false); }
  }

  async function deleteTemplate(id: number) {
    if (!confirm("Delete this template?")) return;
    await fetch(`${API}/communication/templates/${id}`, { method: "DELETE", headers });
    setTemplates(await get("/communication/templates"));
  }

  async function toggleTemplate(tpl: any) {
    await fetch(`${API}/communication/templates/${tpl.id}`, { method: "PUT", headers, body: JSON.stringify({ ...tpl, isActive: !tpl.isActive }) });
    setTemplates(await get("/communication/templates"));
  }

  async function doBulkSend() {
    if (!sendForm.body) return setMsg("Message body is required");
    if (!confirm(`Send this ${sendForm.channel} to the selected audience?`)) return;
    setBusy(true);
    try {
      const target: any = {};
      if (sendForm.status && sendForm.status !== "ALL") target.status = sendForm.status;
      if (sendForm.areaId) target.areaId = Number(sendForm.areaId);
      if (sendForm.packageId) target.packageId = Number(sendForm.packageId);
      const r = await fetch(`${API}/communication/send`, {
        method: "POST", headers,
        body: JSON.stringify({ channel: sendForm.channel, title: sendForm.title, body: sendForm.body, target }),
      });
      const data = await r.json();
      setMsg(`Queued ${data.queued} of ${data.matched} matched subscribers`);
    } finally { setBusy(false); }
  }

  async function doTest() {
    if (!testForm.recipient) return setMsg("Enter a phone/email for the test");
    setBusy(true);
    try {
      await fetch(`${API}/communication/test`, { method: "POST", headers, body: JSON.stringify(testForm) });
      setMsg("Test message queued — check the Log tab");
    } finally { setBusy(false); }
  }

  async function retry(id: number) {
    await fetch(`${API}/communication/messages/${id}/retry`, { method: "POST", headers });
    void loadLog(true);
  }

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 };
  const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", color: T.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 };
  const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, color: T.text };
  const input: React.CSSProperties = { background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px", color: T.text, fontSize: 13 };
  const btn = (bg: string): React.CSSProperties => ({ background: bg, color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.6 : 1 });
  const statusColor = (s: string) => (s === "SENT" ? T.green : s === "SIMULATED" ? T.amber : s === "FAILED" ? T.red : T.sub);

  return (
    <div style={{ padding: 20, color: T.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {status && (
            <span style={{ fontSize: 12, color: T.sub }}>
              SMS: <b style={{ color: status.sms === "configured" ? T.green : T.amber }}>{status.sms}</b> · Email:{" "}
              <b style={{ color: status.email === "configured" ? T.green : T.amber }}>{status.email}</b>
            </span>
          )}
          {msg && <span style={{ fontSize: 12, color: T.accent, cursor: "pointer" }} onClick={() => setMsg("")}>{msg} ✕</span>}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {TABS.map((name) => (
          <button key={name} onClick={() => setTab(name)}
            style={{ ...btn(tab === name ? T.accent : T.card), border: `1px solid ${tab === name ? T.accent : T.border}`, color: tab === name ? "#fff" : T.sub }}>
            {name}
          </button>
        ))}
      </div>

      {/* ── TEMPLATES ── */}
      {tab === "Templates" && (
        <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 14, alignItems: "start" }}>
          <div style={card}>
            <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>{editingTpl ? `Edit template #${editingTpl}` : "New template"}</h3>
            <div style={{ display: "grid", gap: 8 }}>
              <input style={input} placeholder="Name (unique)" value={tplForm.name} onChange={(e) => setTplForm({ ...tplForm, name: e.target.value })} />
              <div style={{ display: "flex", gap: 8 }}>
                <select style={{ ...input, flex: 1 }} value={tplForm.channel} onChange={(e) => setTplForm({ ...tplForm, channel: e.target.value })}>
                  <option value="SMS">SMS</option><option value="EMAIL">Email</option>
                </select>
                <select style={{ ...input, flex: 2 }} value={tplForm.event} onChange={(e) => setTplForm({ ...tplForm, event: e.target.value })}>
                  {EVENTS.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
                </select>
              </div>
              {tplForm.channel === "EMAIL" && (
                <input style={input} placeholder="Email subject" value={tplForm.subject} onChange={(e) => setTplForm({ ...tplForm, subject: e.target.value })} />
              )}
              <textarea style={{ ...input, minHeight: 110, resize: "vertical" }} placeholder="Message body — use variables below"
                value={tplForm.body} onChange={(e) => setTplForm({ ...tplForm, body: e.target.value })} />
              <div style={{ fontSize: 11, color: T.muted }}>Variables: {VARS}</div>
              {tplForm.body && (
                <div style={{ fontSize: 12, color: T.sub, background: T.bg, borderRadius: 8, padding: 8 }}>
                  Preview: {tplForm.body.replace("{name}", "Rashid Ahmed").replace("{username}", "rashid01").replace("{amount}", "1500").replace("{expiry}", "2026-08-15").replace("{package}", "Home 20M").replace("{invoiceNo}", "INV-2026-00042").replace("{daysLeft}", "3").replace("{dueAmount}", "1500").replace("{phone}", "017XXXXXXXX").replace("{balance}", "500")}
                </div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button style={btn(T.accent)} disabled={busy} onClick={saveTemplate}>{editingTpl ? "Update" : "Create"}</button>
                {editingTpl && (
                  <button style={{ ...btn(T.card), border: `1px solid ${T.border}`, color: T.sub }}
                    onClick={() => { setEditingTpl(null); setTplForm({ name: "", channel: "SMS", event: "MANUAL", subject: "", body: "" }); }}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </div>

          <div style={card}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  <th style={th}>Name</th><th style={th}>Channel</th><th style={th}>Event</th><th style={th}>Body</th><th style={th}>Active</th><th style={th} />
                </tr>
              </thead>
              <tbody>
                {templates.map((tpl, i) => (
                  <tr key={tpl.id} style={{ background: i % 2 ? "transparent" : T.row }}>
                    <td style={td}>{tpl.name}</td>
                    <td style={td}>{tpl.channel}</td>
                    <td style={{ ...td, fontSize: 12, color: T.sub }}>{tpl.event}</td>
                    <td style={{ ...td, color: T.sub, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={tpl.body}>{tpl.body}</td>
                    <td style={td}>
                      <span onClick={() => toggleTemplate(tpl)} style={{ cursor: "pointer", fontSize: 11, padding: "2px 8px", borderRadius: 20, background: tpl.isActive ? "#22c55e22" : "var(--muted)22", color: tpl.isActive ? T.green : T.muted }}>
                        {tpl.isActive ? "ON" : "OFF"}
                      </span>
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap", textAlign: "right" }}>
                      <button style={{ ...btn(T.card), border: `1px solid ${T.border}`, color: T.sub, padding: "4px 10px", fontSize: 12, marginRight: 6 }}
                        onClick={() => { setEditingTpl(tpl.id); setTplForm({ name: tpl.name, channel: tpl.channel, event: tpl.event, subject: tpl.subject || "", body: tpl.body, isActive: tpl.isActive }); }}>
                        Edit
                      </button>
                      <button style={{ ...btn(T.red), padding: "4px 10px", fontSize: 12 }} onClick={() => deleteTemplate(tpl.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
                {!templates.length && <tr><td style={{ ...td, color: T.muted }} colSpan={6}>No templates yet. Create one for WELCOME or EXPIRY_REMINDER to activate automatic messages.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── SEND ── */}
      {tab === "Send" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 14, alignItems: "start" }}>
          <div style={card}>
            <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>Bulk send / Notice</h3>
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select style={input} value={sendForm.channel} onChange={(e) => setSendForm({ ...sendForm, channel: e.target.value })}>
                  <option value="SMS">SMS</option><option value="EMAIL">Email</option>
                </select>
                <select style={input} value={sendForm.status} onChange={(e) => setSendForm({ ...sendForm, status: e.target.value })}>
                  {["ALL", "ACTIVE", "INACTIVE", "EXPIRED", "SUSPENDED"].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <select style={input} value={sendForm.areaId} onChange={(e) => setSendForm({ ...sendForm, areaId: e.target.value })}>
                  <option value="">All areas</option>
                  {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <select style={input} value={sendForm.packageId} onChange={(e) => setSendForm({ ...sendForm, packageId: e.target.value })}>
                  <option value="">All packages</option>
                  {packages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <input style={input} placeholder="Notice title (for the audit log)" value={sendForm.title} onChange={(e) => setSendForm({ ...sendForm, title: e.target.value })} />
              <textarea style={{ ...input, minHeight: 120, resize: "vertical" }} placeholder={`Message — variables work here too: ${VARS}`}
                value={sendForm.body} onChange={(e) => setSendForm({ ...sendForm, body: e.target.value })} />
              <button style={{ ...btn(T.accent), width: 160 }} disabled={busy} onClick={doBulkSend}>Queue broadcast</button>
            </div>
          </div>

          <div style={card}>
            <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>Send test</h3>
            <div style={{ display: "grid", gap: 8 }}>
              <select style={input} value={testForm.channel} onChange={(e) => setTestForm({ ...testForm, channel: e.target.value })}>
                <option value="SMS">SMS</option><option value="EMAIL">Email</option>
              </select>
              <input style={input} placeholder={testForm.channel === "SMS" ? "Phone number" : "Email address"} value={testForm.recipient} onChange={(e) => setTestForm({ ...testForm, recipient: e.target.value })} />
              <input style={input} value={testForm.message} onChange={(e) => setTestForm({ ...testForm, message: e.target.value })} />
              <button style={btn(T.green)} disabled={busy} onClick={doTest}>Send test</button>
              <div style={{ fontSize: 11, color: T.muted }}>
                Gateways unset → messages are <b style={{ color: T.amber }}>SIMULATED</b> (logged but not delivered). Configure SMS_GATEWAY_URL / SMTP_* in backend .env to go live.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── LOG ── */}
      {tab === "Log" && (
        <div style={card}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <select style={input} value={logStatus} onChange={(e) => setLogStatus(e.target.value)}>
              <option value="">All statuses</option>
              {["QUEUED", "SENT", "SIMULATED", "FAILED"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                <th style={th}>Date</th><th style={th}>Channel</th><th style={th}>Recipient</th>
                <th style={th}>Event</th><th style={th}>Message</th><th style={th}>Status</th><th style={th} />
              </tr>
            </thead>
            <tbody>
              {log.map((m, i) => (
                <tr key={m.id} style={{ background: i % 2 ? "transparent" : T.row }}>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{fdate(m.createdAt)}</td>
                  <td style={td}>{m.channel}</td>
                  <td style={{ ...td, color: T.sub }}>{m.recipient}</td>
                  <td style={{ ...td, fontSize: 12, color: T.sub }}>{m.event}</td>
                  <td style={{ ...td, color: T.sub, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.error ? `${m.body}\n\nError: ${m.error}` : m.body}>{m.body}</td>
                  <td style={{ ...td, color: statusColor(m.status), fontWeight: 600, fontSize: 12 }}>{m.status}</td>
                  <td style={td}>
                    {m.status === "FAILED" && (
                      <button style={{ ...btn(T.amber), padding: "3px 8px", fontSize: 11 }} onClick={() => retry(m.id)}>Retry</button>
                    )}
                  </td>
                </tr>
              ))}
              {!log.length && <tr><td style={{ ...td, color: T.muted }} colSpan={7}>No messages yet. Send a test from the Send tab.</td></tr>}
            </tbody>
          </table>
          {logCursor && (
            <button style={{ ...btn(T.card), border: `1px solid ${T.border}`, color: T.sub, marginTop: 10 }} onClick={() => loadLog(false)}>Load more</button>
          )}
        </div>
      )}
    </div>
  );
}
