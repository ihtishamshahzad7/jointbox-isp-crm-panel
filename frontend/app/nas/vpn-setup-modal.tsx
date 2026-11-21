"use client";

/**
 * Shown right after a router is added "via VPN".
 *
 * The router is on a network Uplinko cannot reach, so nothing works until the
 * router dials in. This screen gives the one script to paste into the MikroTik
 * terminal (L2TP/IPsec VPN + RADIUS + API user), then watches the tunnel and turns
 * "Connected" the moment the router's L2TP tunnel comes up.
 *
 * The script holds the router's VPN login, RADIUS secret and API password.
 * It is shown once only and is never stored in the browser.
 */
import { useEffect, useState } from "react";
import Portal from "../components/portal";
import API_BASE from "../components/api";

export type VpnSetup = {
  nasId: number;
  name: string;
  overlayIp: string;
  script: string;
  warning?: string;
};

type TunnelStatus = { online: boolean; lastHandshake: string | null } | null;

export function VpnSetupModal({ setup, headers, onClose }: {
  setup: VpnSetup;
  headers: Record<string, string>;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<TunnelStatus>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/nas/${setup.nasId}/vpn-status`, { headers });
        const b = r.ok ? await r.json().catch(() => null) : null;
        if (!stop && b) setStatus({ online: !!b.online, lastHandshake: b.lastHandshake ?? null });
      } catch { /* keep waiting */ }
    };
    void poll();
    const id = setInterval(() => void poll(), 5000);
    return () => { stop = true; clearInterval(id); };
  }, [setup.nasId, headers]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(setup.script);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked: the text is selectable below */ }
  };

  const connected = !!status?.online;
  const box: React.CSSProperties = { background: "#fff", border: "1px solid #E2E8F0", borderRadius: 12, padding: 20, width: "100%", maxWidth: 760, maxHeight: "95vh", overflowY: "auto", color: "#1C2434" };

  return (
    <Portal>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 2100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <div style={box} role="dialog" aria-label="Connect router via VPN">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 16 }}>Connect “{setup.name}” via VPN</div>
              <div style={{ fontSize: 12, color: "#64748B", marginTop: 4 }}>
                Tunnel address <code>{setup.overlayIp}</code> — this is now the router&apos;s NAS IP in Uplinko.
              </div>
            </div>
            <span style={{
              fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 999, whiteSpace: "nowrap",
              background: connected ? "#DCFCE7" : "#FEF3C7", color: connected ? "#166534" : "#92400E",
            }}>
              {connected ? "● Connected" : "● Waiting for router to connect…"}
            </span>
          </div>

          {setup.warning && (
            <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8, background: "#FEF2F2", color: "#991B1B", fontSize: 12, lineHeight: 1.5 }}>
              {setup.warning}
            </div>
          )}

          <ol style={{ fontSize: 13, lineHeight: 1.7, margin: "14px 0 10px", paddingLeft: 20 }}>
            <li>Open the MikroTik terminal (WinBox → New Terminal).</li>
            <li>Copy the script below and paste it in. It sets up the L2TP/IPsec VPN to Uplinko, RADIUS and the API user.</li>
            <li>Keep this window open — it turns <b>Connected</b> as soon as the router dials in.</li>
          </ol>

          <div style={{ position: "relative" }}>
            <pre style={{ background: "#0F172A", color: "#E2E8F0", fontSize: 11.5, lineHeight: 1.55, padding: 14, borderRadius: 8, overflowX: "auto", whiteSpace: "pre", margin: 0, userSelect: "all" }}>
              {setup.script}
            </pre>
            <button type="button" onClick={() => void copy()}
              style={{ position: "absolute", top: 8, right: 8, fontSize: 12, padding: "4px 10px", borderRadius: 6, border: "1px solid #334155", background: "#1E293B", color: "#E2E8F0", cursor: "pointer" }}>
              {copied ? "Copied" : "Copy script"}
            </button>
          </div>

          <p style={{ fontSize: 12, color: "#B45309", marginTop: 10 }}>
            This script contains the router&apos;s VPN login, RADIUS secret and API password. It is shown only once —
            copy it now. If it is lost, delete the router and add it again.
          </p>

          {connected && (
            <p style={{ fontSize: 13, color: "#166534", marginTop: 6 }}>
              The router is connected. Its users now authenticate with Uplinko through the tunnel.
            </p>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
            <button type="button" onClick={() => {
                if (!connected && !window.confirm("Close without the router connected? The script cannot be shown again — make sure you copied it.")) return;
                onClose();
              }}
              style={{ fontSize: 13, fontWeight: 600, padding: "8px 16px", borderRadius: 8, border: "1px solid #CBD5E1", background: connected ? "#16A34A" : "#fff", color: connected ? "#fff" : "#1C2434", cursor: "pointer" }}>
              {connected ? "Done" : "Close"}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
