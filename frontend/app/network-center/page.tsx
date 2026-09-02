"use client";

import Hub from "../components/hub";
import Operations from "../operations/page";
import Noc from "../noc/page";
import LiveNetwork from "../network/page";
import Nas from "../nas/page";
import IpPools from "../ip-pools/page";
import StaticIps from "../static-ips/page";
import Prefixes from "../prefixes/page";
import Outages from "../outages/page";
import Fiber from "../fiber/page";

/**
 * Frontend-only network workspace. Existing screens and data contracts stay
 * untouched; this page adds a faster visual command layer around them.
 */
export default function NetworkCenter() {
  return (
    <div className="jb-network-workspace">
      <section className="jb-network-hero" aria-labelledby="network-title">
        <div className="jb-network-hero-copy">
          <div className="jb-network-eyebrow"><span className="jb-live-dot" /> NETWORK CENTER</div>
          <h1 id="network-title">Network command center</h1>
          <p>One fast workspace for operations, live network, FTTH, routers, IP addressing and outages.</p>
        </div>
        <div className="jb-network-actions" aria-label="Network shortcuts">
          <button type="button" className="jb-network-action">⌕ <span>Search</span><kbd>⌘K</kbd></button>
          <button type="button" className="jb-network-action primary">＋ <span>Quick action</span></button>
        </div>
      </section>

      <div className="jb-network-strip" aria-label="Network workspace shortcuts">
        <div><strong>⚡ Fast workspace</strong><span>Switch sections without losing context</span></div>
        <div><strong>◉ Live-first</strong><span>Keep health and events close to every screen</span></div>
        <div><strong>⌁ Responsive</strong><span>Designed for desktop, tablet and mobile</span></div>
      </div>

      <Hub
        storageKey="network"
        tabs={[
          { id: "ops", label: "Operations", hint: "Alerts, router health and what needs attention now.", render: () => <Operations /> },
          { id: "noc", label: "NOC / Uptime", hint: "Segment health, uptime and the outage timeline.", render: () => <Noc /> },
          { id: "live", label: "Live Network", hint: "Who is online right now, per router.", render: () => <LiveNetwork /> },
          { id: "nas", label: "NAS / Routers", hint: "Your MikroTiks and their RADIUS settings.", render: () => <Nas /> },
          { id: "fiber", label: "FTTH / Fiber", hint: "OLTs, PON ports, ONUs and fiber topology.", render: () => <Fiber /> },
          { id: "pools", label: "IP Pools", hint: "Address ranges handed out to customers automatically.", render: () => <IpPools /> },
          { id: "static", label: "Static IPs", hint: "Fixed addresses sold as a monthly add-on.", render: () => <StaticIps /> },
          { id: "prefixes", label: "Prefix Register", hint: "Routed blocks, VLANs and transit links for corporate clients.", render: () => <Prefixes /> },
          { id: "outages", label: "Outages & Power", hint: "Load-shedding, power cuts and network faults.", render: () => <Outages /> },
        ]}
      />

      <style jsx>{`
        .jb-network-workspace{width:100%;min-width:0}
        .jb-network-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:18px 0 20px;margin-bottom:12px;border-bottom:1px solid var(--border)}
        .jb-network-hero-copy{min-width:0}
        .jb-network-eyebrow{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:10px;font-weight:850;letter-spacing:.12em;margin-bottom:7px}
        .jb-live-dot{width:7px;height:7px;border-radius:50%;background:var(--online);box-shadow:0 0 0 4px color-mix(in srgb,var(--online) 12%,transparent);animation:jbPulse 2s ease-in-out infinite}
        .jb-network-hero h1{font-size:clamp(23px,3vw,31px);line-height:1.05;letter-spacing:-.045em;font-weight:900;color:var(--text);margin:0 0 7px}
        .jb-network-hero p{max-width:720px;color:var(--muted);font-size:12px;line-height:1.55;margin:0}
        .jb-network-actions{display:flex;gap:8px;flex:0 0 auto}
        .jb-network-action{height:38px;padding:0 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--text);font-size:10.5px;font-weight:800;display:inline-flex;align-items:center;gap:7px;box-shadow:0 3px 12px rgba(15,23,42,.04);cursor:pointer;transition:transform .15s ease,box-shadow .15s ease,border-color .15s ease}
        .jb-network-action:hover{transform:translateY(-1px);border-color:color-mix(in srgb,var(--accent) 35%,var(--border));box-shadow:0 8px 20px rgba(15,23,42,.08)}
        .jb-network-action.primary{background:var(--accent);border-color:var(--accent);color:#fff;box-shadow:0 7px 18px color-mix(in srgb,var(--accent) 24%,transparent)}
        .jb-network-action kbd{padding:2px 5px;border:1px solid var(--border);border-radius:5px;background:var(--surface-2);color:var(--muted);font-size:9px;font-weight:800}
        .jb-network-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0 0 15px}
        .jb-network-strip>div{display:flex;align-items:center;gap:8px;min-width:0;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:linear-gradient(135deg,var(--surface),var(--surface-2));box-shadow:0 3px 12px rgba(15,23,42,.035)}
        .jb-network-strip strong{font-size:10px;white-space:nowrap;color:var(--text)}
        .jb-network-strip span{font-size:9.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        @keyframes jbPulse{0%,100%{opacity:1}50%{opacity:.45}}
        @media(max-width:800px){.jb-network-hero{align-items:flex-start;flex-direction:column;gap:14px}.jb-network-actions{width:100%}.jb-network-action{flex:1;justify-content:center}.jb-network-strip{grid-template-columns:1fr}.jb-network-strip>div{justify-content:space-between}}
        @media(prefers-reduced-motion:reduce){.jb-live-dot{animation:none}.jb-network-action{transition:none}}
      `}</style>
    </div>
  );
}
