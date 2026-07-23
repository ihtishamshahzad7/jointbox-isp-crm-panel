"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const API =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

const T = {
  card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)",
  accent: "#0ea5e9", green: "#22c55e", amber: "#f59e0b", red: "#ef4444", purple: "#8b5cf6",
};

const STATUS_STYLE: Record<string, { c: string; bg: string; label: string }> = {
  IN_STOCK:  { c: "#4ade80", bg: "#14532d", label: "In stock" },
  ASSIGNED:  { c: "#38bdf8", bg: "#0c4a6e", label: "With reseller" },
  INSTALLED: { c: "#a78bfa", bg: "#3730a3", label: "Installed" },
  FAULTY:    { c: "#f87171", bg: "#450a0a", label: "Faulty" },
  RETURNED:  { c: "#fbbf24", bg: "#422006", label: "Returned" },
  LOST:      { c: "#f87171", bg: "#450a0a", label: "Lost" },
};

const TYPES = ["ONU", "ROUTER", "SWITCH", "OLT", "CABLE", "SPLITTER", "ANTENNA", "OTHER"];

export default function InventoryPage() {
  const router = useRouter();
  const [items, setItems] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [filter, setFilter] = useState({ status: "ALL", type: "ALL", q: "" });
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [form, setForm] = useState({
    serialNumber: "", macAddress: "", type: "ONU", brand: "", model: "",
    purchasePrice: "", purchaseDate: "", warrantyUntil: "", supplier: "", notes: "",
  });

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (filter.status !== "ALL") qs.set("status", filter.status);
    if (filter.type !== "ALL") qs.set("type", filter.type);
    if (filter.q) qs.set("q", filter.q);
    try {
      const [i, s, u] = await Promise.all([
        fetch(`${API}/inventory?${qs}`, { headers }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/inventory/stats`, { headers }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API}/users`, { headers }).then((r) => (r.ok ? r.json() : [])),
      ]);
      setItems(Array.isArray(i) ? i : []);
      setStats(s);
      setUsers(Array.isArray(u) ? u : []);
    } catch { /* ignore */ }
  }, [filter, token]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    load();
  }, [filter, token]);

  const note = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  async function save() {
    if (!form.serialNumber.trim()) return note("Serial number is required.", false);
    setBusy(true);
    try {
      const r = await fetch(`${API}/inventory`, { method: "POST", headers, body: JSON.stringify(form) });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Could not save");
      setShowForm(false);
      setForm({ serialNumber: "", macAddress: "", type: "ONU", brand: "", model: "",
        purchasePrice: "", purchaseDate: "", warrantyUntil: "", supplier: "", notes: "" });
      note(`Added ${d.serialNumber}`);
      load();
    } catch (e: any) { note(e.message, false); } finally { setBusy(false); }
  }

  async function act(path: string, method = "PATCH", body?: any) {
    setBusy(true);
    try {
      const r = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Action failed");
      note("Updated");
      load();
    } catch (e: any) { note(e.message, false); } finally { setBusy(false); }
  }

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 14 };
  const input: React.CSSProperties = {
    background: T.row, border: `1px solid ${T.border}`, borderRadius: 8,
    padding: "8px 10px", color: T.text, fontSize: 12, width: "100%",
  };
  const btn = (bg: string): React.CSSProperties => ({
    background: bg, color: "#fff", border: "none", borderRadius: 8,
    padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.6 : 1,
  });

  const resellers = users.filter((u) => ["RESELLER", "SUB_RESELLER", "RETAILER"].includes(u.role));

  return (
    <div style={{ padding: 20, color: T.text }}>
      {toast && (
        <div style={{
          ...card, marginBottom: 12, borderColor: toast.ok ? T.green : T.red,
          color: toast.ok ? T.green : T.red, fontSize: 12, fontWeight: 600,
        }}>{toast.msg}</div>
      )}

      {/* Stock summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 10, marginBottom: 14 }}>
        {[
          ["Total", stats?.total, T.text],
          ["In stock", stats?.inStock, T.green],
          ["With resellers", stats?.assigned, T.accent],
          ["Installed", stats?.installed, T.purple],
          ["Faulty", stats?.faulty, T.red],
          ["Warranty <30d", stats?.warrantyExpiring30d, T.amber],
        ].map(([label, val, color]: any) => (
          <div key={label} style={card}>
            <div style={{ fontSize: 10.5, color: T.muted, textTransform: "uppercase" }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color, marginTop: 2 }}>{val ?? 0}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input
          style={{ ...input, flex: "1 1 200px" }}
          placeholder="Search serial, MAC, model…"
          value={filter.q}
          onChange={(e) => setFilter({ ...filter, q: e.target.value })}
        />
        <select style={{ ...input, width: 150 }} value={filter.status}
          onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          <option value="ALL">All statuses</option>
          {Object.keys(STATUS_STYLE).map((s) => <option key={s} value={s}>{STATUS_STYLE[s].label}</option>)}
        </select>
        <select style={{ ...input, width: 130 }} value={filter.type}
          onChange={(e) => setFilter({ ...filter, type: e.target.value })}>
          <option value="ALL">All types</option>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button style={btn(T.accent)} onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "+ Add item"}
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>New inventory item</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10 }}>
            <div><label style={{ fontSize: 10.5, color: T.muted }}>Serial number *</label>
              <input style={input} value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} /></div>
            <div><label style={{ fontSize: 10.5, color: T.muted }}>MAC address</label>
              <input style={input} value={form.macAddress} onChange={(e) => setForm({ ...form, macAddress: e.target.value })} /></div>
            <div><label style={{ fontSize: 10.5, color: T.muted }}>Type</label>
              <select style={input} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select></div>
            <div><label style={{ fontSize: 10.5, color: T.muted }}>Brand</label>
              <input style={input} value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} /></div>
            <div><label style={{ fontSize: 10.5, color: T.muted }}>Model</label>
              <input style={input} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></div>
            <div><label style={{ fontSize: 10.5, color: T.muted }}>Purchase price</label>
              <input style={input} type="number" value={form.purchasePrice} onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })} /></div>
            <div><label style={{ fontSize: 10.5, color: T.muted }}>Purchase date</label>
              <input style={input} type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} /></div>
            <div><label style={{ fontSize: 10.5, color: T.muted }}>Warranty until</label>
              <input style={input} type="date" value={form.warrantyUntil} onChange={(e) => setForm({ ...form, warrantyUntil: e.target.value })} /></div>
            <div><label style={{ fontSize: 10.5, color: T.muted }}>Supplier</label>
              <input style={input} value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} /></div>
          </div>
          <button style={{ ...btn(T.green), marginTop: 10 }} disabled={busy} onClick={save}>Save item</button>
        </div>
      )}

      {/* Stock list */}
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 800 }}>
            <thead>
              <tr style={{ background: T.row }}>
                {["Serial / MAC", "Type", "Status", "Held by", "Installed at", "Warranty", "Actions"].map((h) => (
                  <th key={h} style={{ padding: "9px 10px", textAlign: "left", fontSize: 10, color: T.muted, textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const st = STATUS_STYLE[it.status] || STATUS_STYLE.IN_STOCK;
                const warrantyLeft = it.warrantyUntil
                  ? Math.ceil((new Date(it.warrantyUntil).getTime() - Date.now()) / 86400000)
                  : null;
                return (
                  <tr key={it.id} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: "9px 10px" }}>
                      <div style={{ fontWeight: 600, fontSize: 12 }}>{it.serialNumber}</div>
                      <div style={{ fontSize: 10, color: T.muted }}>{it.macAddress || "—"}</div>
                    </td>
                    <td style={{ padding: "9px 10px", fontSize: 11, color: T.muted }}>
                      {it.type}<div style={{ fontSize: 10 }}>{[it.brand, it.model].filter(Boolean).join(" ") || "—"}</div>
                    </td>
                    <td style={{ padding: "9px 10px" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: st.c, background: st.bg, padding: "2px 8px", borderRadius: 4 }}>
                        {st.label}
                      </span>
                    </td>
                    <td style={{ padding: "9px 10px", fontSize: 11 }}>{it.owner?.name || "—"}</td>
                    <td style={{ padding: "9px 10px", fontSize: 11 }}>
                      {it.subscriber ? (
                        <span style={{ color: T.accent, cursor: "pointer" }}
                          onClick={() => router.push(`/subscribers?focus=${it.subscriber.id}`)}>
                          {it.subscriber.fullName}
                        </span>
                      ) : "—"}
                    </td>
                    <td style={{ padding: "9px 10px", fontSize: 11, color: warrantyLeft !== null && warrantyLeft < 30 ? T.amber : T.muted }}>
                      {warrantyLeft === null ? "—" : warrantyLeft < 0 ? "Expired" : `${warrantyLeft}d`}
                    </td>
                    <td style={{ padding: "9px 10px" }}>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {it.status !== "INSTALLED" && (
                          <select
                            style={{ ...input, width: 130, fontSize: 10.5, padding: "4px 6px" }}
                            value=""
                            onChange={(e) => e.target.value && act(`/inventory/${it.id}/assign/${e.target.value}`)}
                          >
                            <option value="">Issue to…</option>
                            {resellers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                          </select>
                        )}
                        {it.status !== "IN_STOCK" && (
                          <button style={{ ...btn(T.amber), padding: "4px 8px", fontSize: 10.5 }}
                            onClick={() => act(`/inventory/${it.id}/return`, "PATCH", { status: "IN_STOCK" })}>
                            Return
                          </button>
                        )}
                        <button style={{ ...btn(T.red), padding: "4px 8px", fontSize: 10.5 }}
                          onClick={() => act(`/inventory/${it.id}/return`, "PATCH", { status: "FAULTY" })}>
                          Faulty
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!items.length && (
                <tr><td colSpan={7} style={{ padding: 20, textAlign: "center", color: T.muted, fontSize: 12 }}>
                  No stock yet. Add your first item above.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
