"use client";

/**
 * Panel VPN servers — WireGuard / OpenVPN / L2TP-IPsec.
 *
 * The panel does not run the VPN daemons itself (it is an unprivileged
 * service). For each type it shows status, lets the operator set the endpoint
 * host and ports, and hands over a one-time install script to run on the panel
 * host plus the MikroTik config to paste on each router. Several VPNs can run
 * at once and many routers can connect to each.
 *
 * Platform-owner only (enforced by the backend).
 */

import React from "react";
import API from "../components/api";

type Server = {
  type: "wireguard" | "openvpn" | "l2tp" | "sstp";
  name: string;
  blurb: string;
  running: boolean;
  ready: boolean;
  listenPort?: number;
  proto?: string;
  subnet: string;
  serverIp: string;
  publicKey?: string | null;
  install: string;
  mikrotik: string;
};
type Overview = { endpointHost: string; endpointSet: boolean; servers: Server[] };

const G = "#16a34a";
const G2 = "#22c55e";

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
      style={{
        border: `1px solid ${G}`, background: done ? G : "transparent",
        color: done ? "#fff" : G, borderRadius: 8, padding: "5px 12px",
        fontSize: 12.5, fontWeight: 700, cursor: "pointer",
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

function Badge({ ok, warn, children }: { ok?: boolean; warn?: boolean; children: React.ReactNode }) {
  const c = ok ? G : warn ? "#b45309" : "#b02a37";
  const bg = ok ? "rgba(22,163,74,.12)" : warn ? "rgba(245,158,11,.12)" : "rgba(211,64,83,.1)";
  return (
    <span style={{ color: c, background: bg, border: `1px solid ${c}55`, borderRadius: 999, padding: "2px 10px", fontSize: 11.5, fontWeight: 800 }}>
      {children}
    </span>
  );
}

export default function VpnPage() {
  const [data, setData] = React.useState<Overview | null>(null);
  const [host, setHost] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState("");
  const [err, setErr] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  const load = React.useCallback(async () => {
    try {
      const r = await fetch(`${API}/vpn`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        setErr(r.status === 403 ? "VPN servers are managed by the platform owner." : `Could not load (HTTP ${r.status}).`);
        return;
      }
      const d: Overview = await r.json();
      setData(d);
      setHost(d.endpointHost || "");
      setErr("");
    } catch {
      setErr("Could not reach the panel.");
    }
  }, [token]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const saveHost = async () => {
    setSaving(true);
    setMsg("");
    try {
      const r = await fetch(`${API}/vpn`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ endpointHost: host }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        setErr(b?.message || `Save failed (HTTP ${r.status}).`);
      } else {
        setMsg("Saved. Routers will dial this address.");
        await load();
      }
    } finally {
      setSaving(false);
    }
  };

  const wrap: React.CSSProperties = { maxWidth: 900 };
  const card: React.CSSProperties = {
    background: "var(--surface,#fff)", border: "1px solid var(--border,#E2E8F0)",
    borderLeft: `4px solid ${G}`, borderRadius: 12, padding: 18, marginBottom: 16,
  };
  const pre: React.CSSProperties = {
    background: "#0b1220", color: "#d7f7e3", borderRadius: 10, padding: "12px 14px",
    fontSize: 12, lineHeight: 1.6, overflowX: "auto", whiteSpace: "pre", margin: "8px 0 0",
    border: "1px solid rgba(22,163,74,.3)",
  };
  const input: React.CSSProperties = {
    width: "100%", background: "var(--bg,#fff)", border: "1px solid var(--border,#E2E8F0)",
    borderRadius: 9, padding: "9px 11px", color: "var(--text,#111)", font: "inherit",
  };

  return (
    <div style={wrap}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <span style={{ background: `linear-gradient(135deg, ${G}, ${G2})`, color: "#fff", fontWeight: 800, fontSize: 12, padding: "4px 11px", borderRadius: 999 }}>VPN</span>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: "var(--text,#111)" }}>Panel VPN Servers</h1>
      </div>
      <p style={{ color: "var(--muted,#64748B)", fontSize: 13.5, marginBottom: 18 }}>
        Let a remote MikroTik behind CGNAT reach this panel so its PPPoE users authenticate here and
        the panel can run RADIUS/CoA toward the router. Run several at once; many routers can connect to each.
      </p>

      {err && (
        <div style={{ ...card, borderLeftColor: "#b02a37", background: "rgba(211,64,83,.06)" }}>{err}</div>
      )}

      {/* Endpoint host — the address every router dials. */}
      <div style={card}>
        <h2 style={{ fontSize: 15, fontWeight: 800, margin: "0 0 4px", color: "var(--text,#111)" }}>Panel public address</h2>
        <p style={{ color: "var(--muted,#64748B)", fontSize: 13, margin: "0 0 10px" }}>
          The public hostname or IP of this panel that routers will connect to. Required for every VPN type.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input style={{ ...input, flex: 1, minWidth: 220 }} value={host} placeholder="vpn.yourdomain.com or 203.0.113.10"
            onChange={(e) => setHost(e.target.value)} />
          <button type="button" onClick={saveHost} disabled={saving}
            style={{ border: "none", borderRadius: 9, padding: "9px 18px", fontWeight: 800, color: "#fff", cursor: "pointer", background: `linear-gradient(135deg, ${G}, ${G2})` }}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        {msg && <p style={{ color: G, fontSize: 12.5, margin: "8px 0 0", fontWeight: 600 }}>{msg}</p>}
        {data && !data.endpointSet && (
          <p style={{ color: "#b45309", fontSize: 12.5, margin: "8px 0 0" }}>Set this first — without it the routers have nothing to dial.</p>
        )}
      </div>

      {data?.servers.map((s) => (
        <div key={s.type} style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: "var(--text,#111)" }}>{s.name}</h2>
            {s.ready ? <Badge ok>Ready</Badge> : s.running ? <Badge warn>Running · set endpoint</Badge> : <Badge>Not running</Badge>}
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setOpen(open === s.type ? null : s.type)}
                style={{ border: `1px solid ${G}`, background: "transparent", color: G, borderRadius: 8, padding: "5px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
                {open === s.type ? "Hide setup" : "Setup"}
              </button>
              <button type="button" onClick={() => void load()}
                style={{ border: "1px solid var(--border,#E2E8F0)", background: "transparent", color: "var(--text,#111)", borderRadius: 8, padding: "5px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
                Re-check
              </button>
            </span>
          </div>
          <p style={{ color: "var(--muted,#64748B)", fontSize: 13, margin: "6px 0 0" }}>{s.blurb}</p>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12.5, color: "var(--muted,#64748B)", marginTop: 8 }}>
            <span>Overlay: <b style={{ color: "var(--text,#111)" }}>{s.subnet}</b> (panel {s.serverIp})</span>
            {s.listenPort ? <span>Port: <b style={{ color: "var(--text,#111)" }}>{s.listenPort}{s.proto ? "/" + s.proto : ""}</b></span> : null}
            {s.publicKey ? <span>Key: <b style={{ color: "var(--text,#111)", fontFamily: "monospace" }}>{s.publicKey.slice(0, 16)}…</b></span> : null}
          </div>

          {open === s.type && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
                <strong style={{ fontSize: 13, color: "var(--text,#111)" }}>1. Run once on the panel host (as root)</strong>
                <Copy text={s.install} label="Copy script" />
              </div>
              <pre style={pre}>{s.install}</pre>
              <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0 2px" }}>
                <strong style={{ fontSize: 13, color: "var(--text,#111)" }}>2. Paste on each MikroTik router</strong>
                <Copy text={s.mikrotik} label="Copy config" />
              </div>
              <pre style={pre}>{s.mikrotik}</pre>
              <p style={{ color: "var(--muted,#64748B)", fontSize: 12.5, marginTop: 10 }}>
                3. Add the router under <b>Routers (NAS)</b>, set its address to its overlay IP on this VPN,
                and the panel will run RADIUS/CoA to it over the tunnel. For WireGuard, issue the per-router
                keys from that router’s <b>Tunnel</b> tab, then click <b>Reconcile</b>.
              </p>
            </div>
          )}
        </div>
      ))}

      {data && (
        <ClientConfigMaker card={card} input={input} pre={pre} token={token} />
      )}

      {!data && !err && <p style={{ color: "var(--muted,#64748B)" }}>Loading…</p>}
    </div>
  );
}

/** Generate the join config for one router, for any vendor. */
function ClientConfigMaker({
  card, input, pre, token,
}: {
  card: React.CSSProperties; input: React.CSSProperties; pre: React.CSSProperties; token: string | null;
}) {
  const [type, setType] = React.useState<"wireguard" | "openvpn" | "l2tp" | "sstp">("wireguard");
  const [vendor, setVendor] = React.useState("mikrotik");
  const [name, setName] = React.useState("");
  const [ip, setIp] = React.useState("");
  const [cfg, setCfg] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const gen = async () => {
    setBusy(true);
    try {
      const q = new URLSearchParams({ vendor, name: name || "router", ip });
      const r = await fetch(`${API}/vpn/${type}/client?${q.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const b = await r.json();
      setCfg(r.ok ? b.config : b?.message || `Error (HTTP ${r.status})`);
    } catch {
      setCfg("Could not reach the panel.");
    } finally {
      setBusy(false);
    }
  };

  const sel: React.CSSProperties = { ...input, width: "auto", flex: "0 0 auto" };
  return (
    <div style={card}>
      <h2 style={{ fontSize: 15, fontWeight: 800, margin: "0 0 4px", color: "var(--text,#111)" }}>
        Client config for a router — any vendor
      </h2>
      <p style={{ color: "var(--muted,#64748B)", fontSize: 13, margin: "0 0 10px" }}>
        Pick the VPN, the router’s vendor and its overlay IP, then paste the generated config on the device.
        WireGuard is the fastest and the recommended default.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select style={sel} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="wireguard">WireGuard</option>
          <option value="openvpn">OpenVPN</option>
          <option value="l2tp">L2TP/IPsec</option>
          <option value="sstp">SSTP</option>
        </select>
        <select style={sel} value={vendor} onChange={(e) => setVendor(e.target.value)}>
          <option value="mikrotik">MikroTik</option>
          <option value="cisco">Cisco</option>
          <option value="juniper">Juniper</option>
          <option value="linux">Linux</option>
          <option value="generic">Generic</option>
        </select>
        <input style={{ ...input, width: 160, flex: "0 0 auto" }} placeholder="router name" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={{ ...input, width: 150, flex: "0 0 auto" }} placeholder="overlay IP e.g. 10.66.0.2" value={ip} onChange={(e) => setIp(e.target.value)} />
        <button type="button" onClick={gen} disabled={busy || !ip}
          style={{ border: "none", borderRadius: 9, padding: "9px 18px", fontWeight: 800, color: "#fff", cursor: "pointer", background: "linear-gradient(135deg,#16a34a,#22c55e)", opacity: busy || !ip ? 0.6 : 1 }}>
          {busy ? "…" : "Generate"}
        </button>
      </div>
      {cfg && (
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(cfg); }}
            style={{ border: "1px solid #16a34a", background: "transparent", color: "#16a34a", borderRadius: 8, padding: "4px 11px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
            Copy
          </button>
          <pre style={pre}>{cfg}</pre>
        </div>
      )}
    </div>
  );
}
