"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { ndm, fmtBits, fmtTime, isUp, type NdmDevice, type NdmPort } from "../ndm";
import { NDMCSS, NdmModal, Stat, PortTile, useNdmRefresh } from "../ndm-ui";
import { useSSE } from "../../components/use-sse";

/** Every port across every reachable switch, live. */
export default function PortsPage() {
  const router = useRouter();
  const [devices, setDevices] = React.useState<NdmDevice[]>([]);
  const [portsByDevice, setPortsByDevice] = React.useState<Record<number, NdmPort[]>>({});
  const [q, setQ] = React.useState("");
  const [onlyDown, setOnlyDown] = React.useState(false);
  const [stats, setStats] = React.useState<any>(null);
  const [sel, setSel] = React.useState<{ device: NdmDevice; port: NdmPort } | null>(null);

  const load = React.useCallback(async () => {
    try {
      const ds = await ndm.devices();
      setDevices(ds);
      const map: Record<number, NdmPort[]> = {};
      await Promise.all(ds.map(async (d) => {
        try { map[d.id] = await ndm.ports(d.id); } catch { map[d.id] = []; }
      }));
      setPortsByDevice(map);
    } catch { /* keep last */ }
  }, []);
  const loadStats = React.useCallback(async () => {
    try { setStats(await ndm.stats()); } catch { /* fine */ }
  }, []);

  useNdmRefresh(load, () => {}, [load], 15000);
  useNdmRefresh(loadStats, () => {}, [loadStats], 30000);
  useSSE({ onEvent: (t: string) => { if (t === "ndm:port" || t === "ndm:event" || t === "ndm:device") void load(); } });

  const all = React.useMemo(() => {
    const rows: Array<{ device: NdmDevice; port: NdmPort }> = [];
    for (const d of devices) for (const p of portsByDevice[d.id] || []) rows.push({ device: d, port: p });
    return rows;
  }, [devices, portsByDevice]);

  const filtered = all.filter(({ port, device }) => {
    if (onlyDown && isUp(port)) return false;
    if (!q.trim()) return true;
    const hay = `${port.name} ${port.description || ""} ${device.name} ${device.ip}`.toLowerCase();
    return q.trim().toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  });

  const up = filtered.filter(({ port }) => isUp(port)).length;
  const down = filtered.length - up;
  const ds = stats?.devices || {};

  return (
    <div className="ndm">
      <style>{NDMCSS}</style>

      <div className="ndm-page-h">
        <div>
          <h1>Ports</h1>
          <p>Every interface on every monitored switch — live state, rates and errors.</p>
        </div>
        <div className="ndm-row-actions">
          <button className="ndm-btn" onClick={() => router.push("/monitoring/devices")}>Devices</button>
          <button className="ndm-btn" onClick={() => router.push("/monitoring/alerts")}>Alerts &amp; Rules</button>
        </div>
      </div>

      <div className="ndm-strip">
        <Stat label="Ports shown" value={filtered.length} />
        <Stat label="Up" value={up} color="var(--online)" />
        <Stat label="Down / disabled" value={down} color="var(--danger)" />
        <Stat label="Total ports (all devices)" value={ds.ports || all.length} />
        <Stat label="Open alerts" value={stats?.alerts?.open ?? 0} color={(stats?.alerts?.open || 0) > 0 ? "var(--danger)" : undefined} />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <input placeholder="Search port, description, device…" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, minWidth: 220, border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "8px 10px", background: "var(--surface)", color: "var(--text)" }} />
        <button className={`ndm-pill ${onlyDown ? "" : ""}`} style={onlyDown ? { borderColor: "var(--danger)", color: "var(--danger)" } : undefined}
          onClick={() => setOnlyDown((v) => !v)}>Only down {onlyDown ? "✓" : ""}</button>
      </div>

      {!all.length ? (
        <div className="ndm-empty">No ports yet — add a device and wait for its first poll.<button className="ndm-btn pri" style={{ marginTop: 12, display: "inline-block" }} onClick={() => router.push("/monitoring/devices")}>Add device</button></div>
      ) : (
        <>
          {/* Group by device so the context stays visible. */}
          {devices.map((d) => {
            const rows = filtered.filter((r) => r.device.id === d.id);
            if (!rows.length) return null;
            return (
              <div key={d.id} style={{ marginBottom: 18 }}>
                <div className="ndm-card-h">
                  <b style={{ cursor: "pointer" }} onClick={() => router.push(`/monitoring/devices/${d.id}`)} title="Open device">
                    <span className="ndm-dot" style={{ background: d.isReachable ? "#219653" : "#D34053" }} />{d.name}
                  </b>
                  <span className="ndm-card-sub">{d.ip} · {rows.filter((r) => isUp(r.port)).length} up / {rows.filter((r) => !isUp(r.port)).length} down · last poll {fmtTime(d.lastSnmpPollAt)}</span>
                </div>
                <div className="ndm-ports">
                  {rows.map(({ port }) => <PortTile key={port.id} port={port} onClick={() => setSel({ device: d, port })} />)}
                </div>
              </div>
            );
          })}
          {!filtered.length && <div className="ndm-empty">Nothing matches — try clearing the filters.</div>}
        </>
      )}

      {sel && <PortModalPair device={sel.device} port={sel.port} onClose={() => setSel(null)} />}
    </div>
  );
}

/** Port snapshot modal — full graphs live on the device page. */
function PortModalPair({ device, port, onClose }: { device: NdmDevice; port: NdmPort; onClose: () => void }) {
  const router = useRouter();
  return (
    <NdmModal title={`${device.name} — ${port.name}`} onClose={onClose}>
      <div className="ndm-form">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Stat label="RX rate" value={fmtBits(port.rxRateBps)} />
          <Stat label="TX rate" value={fmtBits(port.txRateBps)} />
          <Stat label="State" value={isUp(port) ? "UP" : "DOWN"} color={isUp(port) ? "var(--online)" : "var(--danger)"} />
          <Stat label="Errors / min" value={Math.round(port.errorRatePerMin)} color={port.errorRatePerMin > 0 ? "var(--danger)" : undefined} />
        </div>
        <div className="ndm-card-sub">{port.description || "no description"}{port.mac ? ` · ${port.mac}` : ""} · ifIndex {port.ifIndex} · full history &amp; graphs</div>
        <button className="ndm-btn pri" onClick={() => { onClose(); router.push(`/monitoring/devices/${device.id}`); }}>Open device →</button>
      </div>
    </NdmModal>
  );
}