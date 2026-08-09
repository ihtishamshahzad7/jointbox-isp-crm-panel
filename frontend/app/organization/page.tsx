"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { silent } from "../components/silent";
import API_BASE from "../components/api";

const API = API_BASE;

const T = {
  bg: "var(--bg)", card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)", sub: "var(--muted)",
  accent: "#0ea5e9", green: "#22c55e", red: "#ef4444", amber: "#f59e0b", purple: "#8b5cf6",
};

const TABS = ["ISPs", "Branches", "Resellers"] as const;
type Tab = (typeof TABS)[number];

const fmt = (n: number) => new Intl.NumberFormat().format(Math.round((n || 0) * 100) / 100);
const fdt = (d: string) => new Date(d).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

export default function OrganizationPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("ISPs");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const [isps, setIsps] = useState<any[]>([]);
  const [ispName, setIspName] = useState("");
  const [branches, setBranches] = useState<any[]>([]);
  const [branchForm, setBranchForm] = useState({ name: "", ispId: "", address: "" });
  const [resellers, setResellers] = useState<any[]>([]);
  const [walletFor, setWalletFor] = useState<any>(null);
  const [walletHistory, setWalletHistory] = useState<any[]>([]);
  const [walletForm, setWalletForm] = useState({ amount: "", type: "TOPUP", notes: "" });
  const [commissionEdit, setCommissionEdit] = useState<Record<number, string>>({});

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const get = useCallback(async (path: string) => {
    const r = await fetch(`${API}${path}`, { headers });
    if (r.status === 401) { router.push("/login"); throw new Error("unauthorized"); }
    return r.json();
  }, [token]);

  const loadAll = useCallback(() => {
    get("/organization/isps").then((d) => setIsps(Array.isArray(d) ? d : [])).catch(silent("loadIsps"));
    get("/organization/branches").then((d) => setBranches(Array.isArray(d) ? d : [])).catch(silent("loadBranches"));
    get("/organization/resellers").then((d) => setResellers(Array.isArray(d) ? d : [])).catch(silent("loadResellers"));
  }, [get]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    loadAll();
  }, []);

  async function post(path: string, body: any, method = "POST") {
    setBusy(true);
    try {
      const r = await fetch(`${API}${path}`, { method, headers, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) setMsg(data?.message || "Request failed");
      return r.ok;
    } finally { setBusy(false); }
  }

  async function addIsp() {
    if (!ispName.trim()) return;
    if (await post("/organization/isps", { name: ispName })) { setIspName(""); loadAll(); setMsg("ISP created"); }
  }
  async function delIsp(id: number) {
    if (!confirm("Delete this ISP?")) return;
    const r = await fetch(`${API}/organization/isps/${id}`, { method: "DELETE", headers });
    if (!r.ok) setMsg((await r.json())?.message || "Failed");
    loadAll();
  }
  async function addBranch() {
    if (!branchForm.name || !branchForm.ispId) return setMsg("Branch name and ISP are required");
    if (await post("/organization/branches", branchForm)) { setBranchForm({ name: "", ispId: "", address: "" }); loadAll(); setMsg("Branch created"); }
  }
  async function delBranch(id: number) {
    if (!confirm("Delete this branch?")) return;
    const r = await fetch(`${API}/organization/branches/${id}`, { method: "DELETE", headers });
    if (!r.ok) setMsg((await r.json())?.message || "Failed");
    loadAll();
  }
  async function saveCommission(id: number) {
    const percent = Number(commissionEdit[id]);
    if (await post(`/organization/resellers/${id}/commission`, { percent }, "PUT")) { loadAll(); setMsg("Commission saved"); }
  }
  async function toggleTopup(id: number, allowed: boolean) {
    if (await post(`/organization/resellers/${id}/topup-permission`, { allowed }, "PUT")) {
      loadAll(); setMsg(allowed ? "Balance-adding enabled" : "Balance-adding disabled");
    }
  }
  /**
   * The three delegated rights, all switched from one place.
   *
   * They were scattered — price-setting had an endpoint but no UI, router
   * registration had neither, and only balance-adding was reachable. A
   * permission you cannot see is a permission nobody can grant, which is how
   * accounts ended up silently unable to do their job.
   */
  async function togglePerm(id: number, key: "nas" | "price" | "topup", allowed: boolean) {
    const route = key === "nas" ? "nas-permission"
      : key === "price" ? "price-permission"
      : "topup-permission";
    const label = key === "nas" ? "Router registration"
      : key === "price" ? "Price-setting"
      : "Balance-adding";
    if (await post(`/organization/resellers/${id}/${route}`, { allowed }, "PUT")) {
      loadAll(); setMsg(`${label} ${allowed ? "enabled" : "disabled"}`);
    }
  }
  async function openWallet(u: any) {
    setWalletFor(u);
    setWalletHistory(await get(`/organization/resellers/${u.id}/wallet`));
  }
  async function walletSubmit() {
    const amount = Number(walletForm.amount);
    if (!amount || amount <= 0) return setMsg("Enter a valid amount");
    if (await post(`/organization/resellers/${walletFor.id}/wallet`, { ...walletForm, amount })) {
      setWalletForm({ amount: "", type: "TOPUP", notes: "" });
      setWalletHistory(await get(`/organization/resellers/${walletFor.id}/wallet`));
      loadAll();
      setMsg("Wallet updated");
    }
  }
  async function reverseTopup(reference: string) {
    if (!reference) return;
    const reason = prompt("Reverse this top-up? Optionally give a reason:", "");
    if (reason === null) return; // cancelled
    if (await post(`/organization/wallet/reverse-topup`, { reference, reason })) {
      setWalletHistory(await get(`/organization/resellers/${walletFor.id}/wallet`));
      loadAll();
      setMsg("Top-up reversed");
    }
  }

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 };
  const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", color: T.muted, fontSize: 11, textTransform: "uppercase" };
  const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, color: T.text };
  const input: React.CSSProperties = { background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px", color: T.text, fontSize: 13 };
  const btn = (bg: string): React.CSSProperties => ({ background: bg, color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.6 : 1 });
  const permLabel: React.CSSProperties = {
    fontSize: 11, color: T.sub, display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer",
  };
  const roleColor: Record<string, string> = { RESELLER: T.purple, SUB_RESELLER: T.accent, RETAILER: T.amber, SALES: T.green };

  function renderResellerRows(nodes: any[], depth = 0): any[] {
    return nodes.flatMap((u, i) => [
      <tr key={u.id} style={{ background: i % 2 ? "transparent" : T.row }}>
        <td style={{ ...td, paddingLeft: 10 + depth * 22 }}>
          {depth > 0 && <span style={{ color: T.muted }}>└ </span>}{u.name}
          <div style={{ fontSize: 11, color: T.muted }}>{u.email}</div>
        </td>
        <td style={td}><span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: `${roleColor[u.role] || T.muted}22`, color: roleColor[u.role] || T.muted, fontWeight: 700 }}>{u.role}</span></td>
        <td style={{ ...td, textAlign: "right" }}>{u._count?.salesSubscribers ?? 0}</td>
        <td style={{ ...td, textAlign: "right", fontWeight: 700, color: u.balance > 0 ? T.green : T.muted }}>{fmt(u.balance)}</td>
        <td style={{ ...td, whiteSpace: "nowrap" }}>
          <input style={{ ...input, width: 64, textAlign: "right" }} value={commissionEdit[u.id] ?? String(u.commissionPercent)} onChange={(e) => setCommissionEdit({ ...commissionEdit, [u.id]: e.target.value })} />
          <span style={{ color: T.muted, margin: "0 6px" }}>%</span>
          <button style={{ ...btn(T.accent), padding: "4px 10px", fontSize: 12 }} onClick={() => saveCommission(u.id)}>Save</button>
        </td>
        <td style={{ ...td, whiteSpace: "nowrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <label style={permLabel} title="Allow this account to add balance to its own downline from its own wallet.">
              <input type="checkbox" checked={!!u.canTopupDownline}
                onChange={(e) => togglePerm(u.id, "topup", e.target.checked)} />
              can add balance
            </label>
            <label style={permLabel} title="Allow this account to set what its own children pay per package. Without it, their downline can never be priced and cannot trade.">
              <input type="checkbox" checked={u.canSetPackagePrice !== false}
                onChange={(e) => togglePerm(u.id, "price", e.target.checked)} />
              can set prices
            </label>
            <label style={permLabel} title="Allow this account to register its OWN router. Their subscribers would then authenticate against a NAS you do not own — you lose session and traffic visibility for those customers. Grant to franchises running their own POP; leave off for dealers.">
              <input type="checkbox" checked={!!u.canAddNas}
                onChange={(e) => togglePerm(u.id, "nas", e.target.checked)} />
              can add router
              {u.canAddNas && <span style={{ color: T.amber, fontWeight: 700 }} title="This account can register routers outside your visibility.">!</span>}
            </label>
          </div>
        </td>
        <td style={{ ...td, textAlign: "right" }}>
          <button style={{ ...btn(T.card), border: `1px solid ${T.border}`, color: T.sub, padding: "4px 10px", fontSize: 12 }} onClick={() => openWallet(u)}>Wallet</button>
        </td>
      </tr>,
      ...renderResellerRows(u.children || [], depth + 1),
    ]);
  }

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

      {/* ── ISPs ── */}
      {tab === "ISPs" && (
        <div style={card}>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input style={{ ...input, width: 260 }} placeholder="New ISP name" value={ispName} onChange={(e) => setIspName(e.target.value)} />
            <button style={btn(T.accent)} disabled={busy} onClick={addIsp}>Add ISP</button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `1px solid ${T.border}` }}>
              <th style={th}>Name</th><th style={{ ...th, textAlign: "right" }}>Branches</th><th style={th}>Status</th><th style={th} />
            </tr></thead>
            <tbody>
              {isps.map((isp, i) => (
                <tr key={isp.id} style={{ background: i % 2 ? "transparent" : T.row }}>
                  <td style={{ ...td, fontWeight: 600 }}>{isp.name}</td>
                  <td style={{ ...td, textAlign: "right" }}>{isp._count?.branches ?? 0}</td>
                  <td style={td}><span style={{ fontSize: 11, color: isp.isActive ? T.green : T.muted }}>{isp.isActive ? "ACTIVE" : "OFF"}</span></td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button style={{ ...btn(T.red), padding: "4px 10px", fontSize: 12 }} onClick={() => delIsp(isp.id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {!isps.length && <tr><td style={{ ...td, color: T.muted }} colSpan={4}>No ISPs yet — create your main ISP first, then add branches under it.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* ── BRANCHES ── */}
      {tab === "Branches" && (
        <div style={card}>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <input style={input} placeholder="Branch name" value={branchForm.name} onChange={(e) => setBranchForm({ ...branchForm, name: e.target.value })} />
            <select style={input} value={branchForm.ispId} onChange={(e) => setBranchForm({ ...branchForm, ispId: e.target.value })}>
              <option value="">Select ISP</option>
              {isps.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
            <input style={{ ...input, flex: 1 }} placeholder="Address (optional)" value={branchForm.address} onChange={(e) => setBranchForm({ ...branchForm, address: e.target.value })} />
            <button style={btn(T.accent)} disabled={busy} onClick={addBranch}>Add branch</button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `1px solid ${T.border}` }}>
              <th style={th}>Branch</th><th style={th}>ISP</th><th style={th}>Address</th>
              <th style={{ ...th, textAlign: "right" }}>Subscribers</th><th style={{ ...th, textAlign: "right" }}>Staff</th><th style={th} />
            </tr></thead>
            <tbody>
              {branches.map((b, i) => (
                <tr key={b.id} style={{ background: i % 2 ? "transparent" : T.row }}>
                  <td style={{ ...td, fontWeight: 600 }}>{b.name}</td>
                  <td style={{ ...td, color: T.sub }}>{b.isp?.name}</td>
                  <td style={{ ...td, color: T.sub }}>{b.address || "—"}</td>
                  <td style={{ ...td, textAlign: "right" }}>{b._count?.subscribers ?? 0}</td>
                  <td style={{ ...td, textAlign: "right" }}>{b._count?.users ?? 0}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button style={{ ...btn(T.red), padding: "4px 10px", fontSize: 12 }} onClick={() => delBranch(b.id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {!branches.length && <tr><td style={{ ...td, color: T.muted }} colSpan={6}>No branches yet. Assign subscribers via API: POST /organization/branches/:id/assign</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* ── RESELLERS ── */}
      {tab === "Resellers" && (
        <div style={card}>
          <div style={{ fontSize: 12, color: T.muted, marginBottom: 10 }}>
            On every payment, the subscriber&apos;s salesperson — and each ancestor up the chain — earns their commission % automatically into their wallet.
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `1px solid ${T.border}` }}>
              <th style={th}>User</th><th style={th}>Role</th><th style={{ ...th, textAlign: "right" }}>Subscribers</th>
              <th style={{ ...th, textAlign: "right" }}>Wallet</th><th style={th}>Commission</th>
              <th style={th}>Permissions</th><th style={th} />
            </tr></thead>
            <tbody>
              {renderResellerRows(resellers)}
              {!resellers.length && <tr><td style={{ ...td, color: T.muted }} colSpan={7}>No reseller/sales users yet. Create them in Users with role RESELLER / SUB_RESELLER / RETAILER and set a parent to build the chain.</td></tr>}
            </tbody>
          </table>

          {walletFor && (
            <div style={{ position: "fixed", inset: 0, background: "#000a", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000 }} onClick={() => setWalletFor(null)}>
              <div style={{ ...card, width: 460, maxHeight: "80vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
                <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Wallet — {walletFor.name} <span style={{ color: T.green }}>({fmt(walletFor.balance)})</span></h3>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <input style={{ ...input, width: 100 }} type="number" placeholder="Amount" value={walletForm.amount} onChange={(e) => setWalletForm({ ...walletForm, amount: e.target.value })} />
                  <select style={input} value={walletForm.type} onChange={(e) => setWalletForm({ ...walletForm, type: e.target.value })}>
                    <option value="TOPUP">Top up</option><option value="WITHDRAWAL">Withdraw (pay out)</option>
                  </select>
                  <input style={{ ...input, flex: 1 }} placeholder="Notes" value={walletForm.notes} onChange={(e) => setWalletForm({ ...walletForm, notes: e.target.value })} />
                  <button style={btn(T.green)} disabled={busy} onClick={walletSubmit}>Apply</button>
                </div>
                {walletHistory.map((h) => (
                  <div key={h.id} style={{ display: "flex", gap: 10, fontSize: 12, padding: "4px 0", color: T.sub, borderBottom: `1px solid ${T.border}`, alignItems: "center" }}>
                    <span style={{ width: 120 }}>{fdt(h.createdAt)}</span>
                    <span style={{ width: 100 }}>{h.type}</span>
                    <span style={{ width: 80, textAlign: "right", color: h.amount >= 0 ? T.green : T.red }}>{fmt(h.amount)}</span>
                    <span style={{ width: 100, textAlign: "right" }}>bal {fmt(h.balanceAfter)}</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.notes || h.reference || ""}</span>
                    {h.type === "TOPUP" && h.reference?.startsWith("TOP#") && (
                      <button onClick={() => reverseTopup(h.reference)}
                        style={{ background: "transparent", color: T.red, border: `1px solid ${T.border}`, borderRadius: 6, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>
                        Reverse
                      </button>
                    )}
                  </div>
                ))}
                {!walletHistory.length && <div style={{ fontSize: 12, color: T.muted }}>No wallet history yet.</div>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
