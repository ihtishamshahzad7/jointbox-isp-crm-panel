"use client";

import React from "react";
import API from "../components/api";

/**
 * MANAGEMENT TUNNEL panel for one router.
 *
 * WHAT THIS SCREEN IS FOR
 * Most routers this panel manages sit behind CGNAT and have no reachable
 * address, so everything the panel does TOWARD them — a CoA disconnect for a
 * defaulter, a speed change, an SNMP poll — quietly stops working the moment
 * the router leaves the office LAN. Provisioning a tunnel here gives the panel
 * a permanent overlay address for that router.
 *
 * THE ONE THING THIS UI MUST GET RIGHT
 * The private key is returned ONCE and is never stored on the server. If the
 * operator closes this panel without copying it, the only recovery is a
 * rotation, which invalidates whatever they may already have pasted. So the
 * config is shown in a blocking, unmissable state — not a toast, not a row
 * that scrolls away — and the panel says plainly that it will not be shown
 * again. Everything else here is secondary to that.
 *
 * "Online" is deliberately never the word used for a fresh tunnel: WireGuard
 * has no connection state, only a last-handshake time, so until the router
 * dials in there is genuinely nothing to report and the panel says "waiting"
 * rather than guessing.
 */
type TunnelStatus = {
  overlayIp: string;
  enabled: boolean;
  publicKey: string;
  serverEndpoint: string;
  lastHandshake: string | null;
  online: boolean;
  rxBytes: string;
  txBytes: string;
  createdAt: string;
  rotatedAt: string | null;
};

type Provisioned = {
  overlayIp: string;
  privateKey: string;
  serverPublicKey: string;
  serverEndpoint: string;
  mikrotik: string;
  wgQuick: string;
  applied: boolean;
  warning?: string;
};

export function TunnelPanel({ nasId, nasName }: { nasId: number; nasName?: string }) {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [status, setStatus] = React.useState<TunnelStatus | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [issued, setIssued] = React.useState<Provisioned | null>(null);
  const [tab, setTab] = React.useState<"mikrotik" | "wgquick">("mikrotik");
  const [copied, setCopied] = React.useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const r = await fetch(`${API}/nas/${nasId}/tunnel`, { headers: H });
      setStatus(r.ok ? await r.json() : null);
    } catch {
      /* leave the previous reading rather than flashing an error on a blip */
    } finally {
      setLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nasId]);

  React.useEffect(() => {
    load();
    // A tunnel that has just been pasted into a router comes up within a
    // minute; polling means the operator sees it connect without refreshing.
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function call(path: string, method = "POST") {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${API}/nas/${nasId}${path}`, { method, headers: H });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d?.message || "That did not work. Please try again.");
        return null;
      }
      return d;
    } catch {
      setErr("Could not reach the panel API.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function provision(rotate = false) {
    const d = await call(rotate ? "/tunnel/rotate" : "/tunnel");
    if (d) {
      setIssued(d);
      setConfirmRotate(false);
      load();
    }
  }

  async function revoke() {
    const d = await call("/tunnel", "DELETE");
    if (d) {
      setStatus(null);
      setIssued(null);
      load();
    }
  }

  function copy(text: string, what: string) {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(what);
        setTimeout(() => setCopied(null), 1800);
      },
      () => setErr("Your browser blocked the clipboard — select the text and copy it by hand."),
    );
  }

  // ── the one-time config, which takes over the panel ──────────
  if (issued) {
    const config = tab === "mikrotik" ? issued.mikrotik : issued.wgQuick;
    return (
      <div style={S.wrap}>
        <style>{CSS}</style>
        <div className="tp-once">
          <div className="tp-once-head">
            <div>
              <h3>Tunnel config for {nasName || `NAS #${nasId}`}</h3>
              {/* The single most important sentence on this screen. */}
              <p className="tp-warn-strong">
                This contains the router&apos;s private key. It is not stored anywhere and
                cannot be shown again — copy it into the router now.
              </p>
            </div>
            <span className="tp-ip">{issued.overlayIp}</span>
          </div>

          {issued.warning && <div className="tp-warn">{issued.warning}</div>}

          <div className="tp-tabs">
            <button
              className={tab === "mikrotik" ? "on" : ""}
              onClick={() => setTab("mikrotik")}
            >
              MikroTik (RouterOS 7)
            </button>
            <button className={tab === "wgquick" ? "on" : ""} onClick={() => setTab("wgquick")}>
              wg-quick (Linux)
            </button>
          </div>

          <pre className="tp-config">{config}</pre>

          <div className="tp-actions">
            <button className="tp-btn primary" onClick={() => copy(config, "config")}>
              {copied === "config" ? "Copied" : "Copy config"}
            </button>
            <button
              className="tp-btn"
              onClick={() => {
                // Only once they have had the chance to copy it.
                setIssued(null);
                load();
              }}
            >
              I&apos;ve saved it — close
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── ordinary state ───────────────────────────────────────────
  return (
    <div style={S.wrap}>
      <style>{CSS}</style>

      <div className="tp-head">
        <h3>Management tunnel</h3>
        {status && (
          <span className={`tp-pill ${status.online ? "up" : "down"}`}>
            {status.online ? "Connected" : status.lastHandshake ? "Not responding" : "Waiting for router"}
          </span>
        )}
      </div>

      {err && <div className="tp-err">{err}</div>}

      {!loaded && <div className="tp-muted">Checking…</div>}

      {loaded && !status && (
        <>
          <p className="tp-lead">
            This router has no tunnel. Without one, the panel can only reach it when they
            share a network — so disconnects, speed changes and SNMP polls stop working as
            soon as the router is behind CGNAT or a dynamic address.
          </p>
          <button className="tp-btn primary" disabled={busy} onClick={() => provision(false)}>
            {busy ? "Creating…" : "Create tunnel"}
          </button>
        </>
      )}

      {loaded && status && (
        <>
          <dl className="tp-facts">
            <div>
              <dt>Tunnel address</dt>
              <dd className="tp-mono">{status.overlayIp}</dd>
            </div>
            <div>
              <dt>Panel endpoint</dt>
              <dd className="tp-mono">{status.serverEndpoint || "not configured"}</dd>
            </div>
            <div>
              <dt>Last handshake</dt>
              {/* The only real health signal WireGuard offers. */}
              <dd>{status.lastHandshake ? timeAgo(status.lastHandshake) : "never"}</dd>
            </div>
            <div>
              <dt>Traffic</dt>
              <dd className="tp-mono">
                ↓ {bytes(status.rxBytes)} · ↑ {bytes(status.txBytes)}
              </dd>
            </div>
            <div className="tp-wide">
              <dt>Router public key</dt>
              <dd className="tp-mono tp-key">{status.publicKey}</dd>
            </div>
          </dl>

          {!status.lastHandshake && (
            <p className="tp-muted">
              The config has been issued but the router has not connected yet. Paste it into
              the router, then this will update on its own.
            </p>
          )}

          <div className="tp-actions">
            {!confirmRotate ? (
              <button className="tp-btn" disabled={busy} onClick={() => setConfirmRotate(true)}>
                Rotate keys
              </button>
            ) : (
              <div className="tp-confirm">
                <span>
                  New keys are issued immediately and the config currently on the router
                  stops working until you paste the new one. The tunnel address stays the same.
                </span>
                <button className="tp-btn primary" disabled={busy} onClick={() => provision(true)}>
                  Rotate now
                </button>
                <button className="tp-btn" onClick={() => setConfirmRotate(false)}>
                  Cancel
                </button>
              </div>
            )}
            <button
              className="tp-btn danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Remove the tunnel to ${nasName || `NAS #${nasId}`}? The panel will lose remote access to it.`)) revoke();
              }}
            >
              Remove tunnel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Human handshake age. Precision beyond a minute is noise here. */
function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

function bytes(v: string): string {
  let n = Number(v || 0);
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

const S = { wrap: { marginTop: 16 } as React.CSSProperties };

const CSS = `
.tp-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.tp-head h3{font-size:14px;font-weight:700;margin:0}
.tp-pill{font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em}
.tp-pill.up{background:#E8F7EE;color:#1F8A4C}
.tp-pill.down{background:#FEF1EE;color:#A0342A}
.tp-lead{font-size:13px;color:#5A6472;line-height:1.6;margin:0 0 12px;max-width:62ch}
.tp-muted{font-size:12.5px;color:#8A93A0;line-height:1.6;margin:10px 0 0}
.tp-err{background:#FEF4F3;border:1px solid #F3C9C4;color:#A0342A;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:12px}
.tp-warn{background:#FFF8E6;border:1px solid #F0DCA6;color:#7A5A12;border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.6;margin-bottom:12px}
.tp-warn-strong{background:#FEF4F3;border:1px solid #F3C9C4;color:#A0342A;border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.6;margin:8px 0 0;font-weight:600;max-width:64ch}
.tp-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px 18px;margin:0 0 16px}
.tp-facts>div{min-width:0}
.tp-wide{grid-column:1/-1}
.tp-facts dt{font-size:11px;font-weight:700;color:#8A93A0;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
.tp-facts dd{margin:0;font-size:13.5px;color:#14181F}
.tp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.tp-key{font-size:11.5px;word-break:break-all;color:#5A6472}
.tp-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tp-btn{border:1px solid #D7DCE3;background:#fff;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;color:#3C4653}
.tp-btn:disabled{opacity:.55;cursor:default}
.tp-btn.primary{background:#2F6FED;border-color:#2F6FED;color:#fff}
.tp-btn.danger{color:#A0342A;border-color:#F3C9C4}
.tp-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:8px;background:#FFF8E6;border:1px solid #F0DCA6;border-radius:8px;padding:10px 12px;font-size:12.5px;color:#7A5A12;line-height:1.55;max-width:70ch}
.tp-once{border:1px solid #F0DCA6;background:#FFFDF7;border-radius:12px;padding:16px}
.tp-once-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:12px}
.tp-once-head h3{margin:0;font-size:14px;font-weight:700}
.tp-ip{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#fff;border:1px solid #E2E6EC;border-radius:8px;padding:5px 10px;white-space:nowrap}
.tp-tabs{display:flex;gap:6px;margin-bottom:10px}
.tp-tabs button{border:1px solid #D7DCE3;background:#fff;border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;color:#5A6472}
.tp-tabs button.on{background:#14181F;border-color:#14181F;color:#fff}
.tp-config{background:#14181F;color:#E6E9EE;border-radius:10px;padding:14px;font-size:12px;line-height:1.65;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:0 0 12px;white-space:pre}
`;

export default TunnelPanel;
