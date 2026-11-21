"use client";

/**
 * The server, as the platform account sees it — Settings, super admin only.
 *
 * Everything here belongs to the INSTALLATION, not to any company on it:
 * whether the panel, its database, Redis and FreeRADIUS are up, how loaded the
 * machine is, the currency every company bills in, and the maintenance sweeps
 * that act across all companies at once. Answers are numbers only — no
 * company's customers, routers or money ever appear here.
 */
import { useCallback, useEffect, useState } from "react";
import API_BASE from "../components/api";
import s from "./platform-server.module.css";
import RadiusRouters from "../components/radius-routers";

type Health = {
  build?: string;
  db?: boolean;
  redis?: { required: boolean; ready: boolean } | null;
  radius?: boolean | null;
  cpu?: number;
  ramPct?: number;
  ramUsedGb?: number;
  ramTotalGb?: number;
  uptimeSecs?: number;
  cores?: number;
  load?: number[];
  disk?: { totalGb: number; usedGb: number; freeGb: number; pct: number } | null;
  queueMode?: string;
  waiting?: number;
  failed?: number;
};

type Tone = "ok" | "warn" | "bad" | "idle";

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") || "" : "";
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function getJson(path: string, init?: RequestInit): Promise<{ ok: boolean; body: any }> {
  try {
    const r = await fetch(`${API_BASE}${path}`, { ...init, headers: authHeaders() });
    const body = await r.json().catch(() => null);
    return { ok: r.ok, body };
  } catch {
    return { ok: false, body: null };
  }
}

function uptime(secs?: number): string {
  if (!secs && secs !== 0) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function Row({ label, value, tone, note }: { label: string; value: string; tone: Tone; note?: string }) {
  return (
    <div className={s.row}>
      <i className={`${s.dot} ${s[tone]}`} aria-hidden />
      <span className={s.rowLabel}>{label}</span>
      <span className={s.rowValue}>{value}</span>
      {note && <span className={s.rowNote}>{note}</span>}
    </div>
  );
}

const CHECKS = [
  {
    id: "sync",
    label: "Routers known to FreeRADIUS",
    help: "Rebuilds FreeRADIUS's router list from the encrypted vault, checks it, and restarts FreeRADIUS only if it changed. A router missing from the list gets no answer to any login.",
    run: async () => {
      const sync = await getJson("/nas/radius/vault/sync", { method: "POST" });
      const { ok, body } = await getJson("/nas/radius/vault");
      if (!ok || !body) return { tone: "bad" as Tone, text: body?.message || "Could not check." };
      if (!body.freeradiusOnThisServer) return { tone: "idle" as Tone, text: "FreeRADIUS is not installed on this server." };
      const r = body.routers || {};
      const bad: string[] = [];
      const warn: string[] = [];
      if (body.running === false) bad.push("FreeRADIUS is not running — no customer can sign in (check: journalctl -u freeradius -n 50)");
      if (body.brokenWildcardInclude) bad.push("clients.conf has \"$INCLUDE clients.d/*.conf\", which stops FreeRADIUS starting — run the update again");
      if (sync.body && sync.body.ok === false) bad.push(sync.body.message || "FreeRADIUS was not updated");
      if (r.undecryptable) bad.push(`${r.undecryptable} router secret(s) cannot be decrypted — SECRETS_KEY in backend/.env changed`);
      if (body.mode === "file" && body.file?.exists && body.file.groupReadable === false) bad.push(`the router file is not readable by FreeRADIUS (mode ${body.file.mode})`);
      if (body.file?.exists && body.file.worldReadable) bad.push(`the router file can be read by every user on the server (mode ${body.file.mode}) — it should be 640`);
      if (body.mode === "file" && body.file?.exists && body.file.matchesDatabase === false && !body.syncing) warn.push("FreeRADIUS's router list differs from the panel — it is re-synced automatically within 5 minutes");
      if (body.mode !== "file") warn.push("FreeRADIUS still reads router secrets from the database in plain text — run the update script once to switch it to the encrypted file");
      if (body.mode === "file" && body.file?.loadedByFreeradius === false && !body.syncing) bad.push("the router file changed after FreeRADIUS started, so the running FreeRADIUS does not have it yet");
      const skipped: { id: number; reason: string }[] = Array.isArray(r.skipped) ? r.skipped : [];
      if (skipped.length) warn.push(`${skipped.length} active router(s) left out: ${skipped.slice(0, 3).map((x) => `#${x.id} ${x.reason}`).join("; ")}${skipped.length > 3 ? "…" : ""}`);
      const inFile = body.file?.clients ?? 0;
      const summary = body.mode === "file"
        ? `${inFile} of ${r.active ?? 0} active router(s) in FreeRADIUS's list.`
        : `${r.active ?? 0} active router(s); ${r.encrypted ?? 0} with an encrypted secret.`;
      if (bad.length) return { tone: "bad" as Tone, text: `${bad.join("; ")}. ${summary}` };
      if (warn.length) return { tone: "warn" as Tone, text: `${warn.join("; ")}. ${summary}` };
      return { tone: "ok" as Tone, text: `${summary}${sync.body?.restarted ? " FreeRADIUS restarted with the new list." : ""}` };
    },
  },
  {
    id: "stale",
    label: "Close stale sessions",
    help: "Sessions with no update for 30 minutes, on every router. Customers who are really online reconnect normally.",
    run: async () => {
      const { ok, body } = await getJson("/logs/radius/close-stale", { method: "POST" });
      if (!ok) return { tone: "bad" as Tone, text: body?.message || "Could not run." };
      return { tone: "ok" as Tone, text: body?.error ? body.error : `Closed ${body?.closed ?? 0} stale session(s).` };
    },
  },
  {
    id: "dupes",
    label: "Sweep duplicate logins",
    help: "One login online from two devices at once. Runs on its own every 2 minutes.",
    run: async () => {
      const { ok, body } = await getJson("/network/duplicate-sessions/sweep", { method: "POST" });
      if (!ok) return { tone: "bad" as Tone, text: body?.message || "Could not run." };
      return { tone: "ok" as Tone, text: `${body?.offenders ?? 0} login(s) found, ${body?.sessionsCut ?? 0} session(s) cut.` };
    },
  },
];


type VpnSettings = {
  mgmtEnabled: boolean;
  publicIp: string | null;
  mgmtPool: string;
  protectedCidrs: string;
  allowPrivateEndpoints: boolean;
  source: "panel" | "environment";
  server: { tooling: { ok: boolean; detail: string }; addresses: string[] };
  hardwareVerified: boolean;
};

/**
 * NAS management VPN — switched on and configured here, never from a shell.
 * Saved in the database; the backend reads it on every VPN action, so there is
 * no .env edit and no restart.
 */
function MgmtVpnPanel() {
  const [v, setV] = useState<VpnSettings | null>(null);
  const [err, setErr] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [ip, setIp] = useState("");
  const [pool, setPool] = useState("");
  const [cidrs, setCidrs] = useState("");
  const [allowPriv, setAllowPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null);

  const fill = (b: VpnSettings) => {
    setV(b);
    setEnabled(b.mgmtEnabled);
    setIp(b.publicIp || "");
    setPool(b.mgmtPool || "");
    setCidrs(b.protectedCidrs || "");
    setAllowPriv(b.allowPrivateEndpoints);
  };

  useEffect(() => {
    getJson("/platform/vpn-settings").then(({ ok, body }) => {
      if (ok && body) fill(body);
      else setErr(body?.message || "Could not load the VPN settings.");
    });
  }, []);

  const save = async () => {
    setMsg(null);
    if (enabled && !ip.trim()) { setMsg({ tone: "bad", text: "Enter this server's public IP before turning the VPN on." }); return; }
    if (enabled && !v?.mgmtEnabled &&
        !window.confirm("Turn on the NAS management VPN for this server? Companies can then connect their routers over L2TP/IPsec. It has not been tested on real routers yet.")) return;
    setBusy(true);
    const { ok, body } = await getJson("/platform/vpn-settings", {
      method: "PUT",
      body: JSON.stringify({
        mgmtEnabled: enabled,
        publicIp: ip.trim() || null,
        mgmtPool: pool.trim() || null,
        protectedCidrs: cidrs.trim() || null,
        allowPrivateEndpoints: allowPriv,
      }),
    });
    setBusy(false);
    if (!ok) {
      const m = body?.message;
      setMsg({ tone: "bad", text: Array.isArray(m) ? m.join(" ") : m || "Could not save." });
      return;
    }
    fill(body);
    setMsg({ tone: "ok", text: body.mgmtEnabled ? "Saved — the NAS management VPN is on. No restart needed." : "Saved — the NAS management VPN is off." });
  };

  return (
    <div className={`${s.panel} ${s.wide}`}>
      <div className={s.head}>
        <div>
          <div className={s.eyebrow}>Installation</div>
          <h3>NAS management VPN</h3>
        </div>
        {v && (
          <span className={`${s.faint} ${v.mgmtEnabled ? s.okText : ""}`}>
            {v.mgmtEnabled ? "On" : "Off"}{v.source === "environment" ? " · from server .env until saved here" : ""}
          </span>
        )}
      </div>
      <p className={s.lede}>
        Lets this server reach company routers over an L2TP/IPsec tunnel. Turn it on and set the server&apos;s public IP
        here; it takes effect immediately, with no shell commands and no restart.
      </p>
      {err ? (
        <p className={`${s.note} ${s.badText}`}>{err}</p>
      ) : !v ? (
        <p className={s.faint}>Loading…</p>
      ) : (
        <>
          <div className={s.form}>
            <label className={s.field} htmlFor="ps-vpn-on">
              <span className={s.fieldLabel}>Enabled</span>
              <input id="ps-vpn-on" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            </label>
            <label className={s.field} htmlFor="ps-vpn-ip">
              <span className={s.fieldLabel}>Server public IP</span>
              <input id="ps-vpn-ip" className={s.input} value={ip} maxLength={15} placeholder="e.g. 45.67.89.10"
                list="ps-vpn-ip-hints" onChange={(e) => setIp(e.target.value)} />
              <datalist id="ps-vpn-ip-hints">
                {v.server.addresses.map((a) => <option key={a} value={a} />)}
              </datalist>
            </label>
            <label className={s.field} htmlFor="ps-vpn-pool">
              <span className={s.fieldLabel}>Tunnel address pool</span>
              <input id="ps-vpn-pool" className={s.input} value={pool} maxLength={18} placeholder="10.255.0.0/16"
                onChange={(e) => setPool(e.target.value)} />
            </label>
            <label className={s.field} htmlFor="ps-vpn-cidrs">
              <span className={s.fieldLabel}>Protected networks (comma-separated)</span>
              <input id="ps-vpn-cidrs" className={s.input} value={cidrs} maxLength={1000} placeholder="optional"
                onChange={(e) => setCidrs(e.target.value)} />
            </label>
            <label className={s.field} htmlFor="ps-vpn-priv">
              <span className={s.fieldLabel}>Allow routers on private IPs</span>
              <input id="ps-vpn-priv" type="checkbox" checked={allowPriv} onChange={(e) => setAllowPriv(e.target.checked)} />
            </label>
            <button type="button" className={`${s.action} ${s.primary}`} onClick={() => void save()} disabled={busy}>
              {busy ? "Saving…" : "Save VPN settings"}
            </button>
          </div>
          <p className={s.note}>
            Addresses on this server: {v.server.addresses.length ? v.server.addresses.join(", ") : "none found"}. Use the
            one routers reach from the internet.
          </p>
          <p className={`${s.note} ${v.server.tooling.ok ? s.okText : s.warnText}`}>
            VPN client tools: {v.server.tooling.ok ? "installed" : v.server.tooling.detail}
          </p>
          {!v.hardwareVerified && (
            <p className={`${s.note} ${s.warnText}`}>
              Not yet tested on real routers. Turn it on for a test server first.
            </p>
          )}
          {msg && <p className={`${s.note} ${msg.tone === "bad" ? s.badText : msg.tone === "warn" ? s.warnText : s.okText}`}>{msg.text}</p>}
        </>
      )}
    </div>
  );
}

export default function PlatformServer() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState<string>("");
  const [cur, setCur] = useState<{ currency: string | null; currencySymbol: string | null } | null>(null);
  const [code, setCode] = useState("");
  const [symbol, setSymbol] = useState("");
  const [curMsg, setCurMsg] = useState<{ tone: Tone; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<Record<string, { tone: Tone; text: string } | "busy">>({});

  const load = useCallback(async () => {
    setLoading(true);
    const [h, ready, stats, queues, radius] = await Promise.all([
      getJson("/health"),
      getJson("/health/ready"),
      getJson("/system/stats"),
      getJson("/system/queues"),
      getJson("/subscribers/test-radius-connection"),
    ]);
    const q: any[] = Array.isArray(queues.body?.queues) ? queues.body.queues : [];
    setHealth({
      build: h.body?.build,
      // /health/ready answers 503 with { db, redis } when something is down.
      db: ready.ok || ready.body?.db === true,
      redis: ready.body?.redis ?? null,
      radius: radius.ok ? !!radius.body?.connected : null,
      cpu: stats.body?.cpu,
      ramPct: stats.body?.ramPct,
      ramUsedGb: stats.body?.ramUsedGb,
      ramTotalGb: stats.body?.ramTotalGb,
      uptimeSecs: stats.body?.uptimeSecs,
      cores: stats.body?.cores,
      load: stats.body?.load,
      disk: stats.body?.disk ?? null,
      queueMode: queues.body?.mode,
      waiting: q.reduce((n, x) => n + (Number(x.waiting) || 0), 0),
      failed: q.reduce((n, x) => n + (Number(x.failed) || 0), 0),
    });
    setChecked(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    setLoading(false);
  }, []);

  // Real time: re-check the server every 15 s while this page is open.
  useEffect(() => {
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    void load();
    getJson("/organization/currency").then(({ body }) => {
      if (!body) return;
      setCur(body);
      setCode(body.currency || "");
      setSymbol(body.currencySymbol || "");
    });
  }, [load]);

  const saveCurrency = async () => {
    const c = code.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) { setCurMsg({ tone: "bad", text: "Use the 3-letter ISO code, e.g. PKR, INR, BDT, USD." }); return; }
    if (cur?.currency && c !== cur.currency &&
        !window.confirm(`Bill every company in ${c} from now on? Invoices already raised keep ${cur.currency}.`)) return;
    setSaving(true);
    const { ok, body } = await getJson("/organization/currency", {
      method: "PUT",
      body: JSON.stringify({ currency: c, currencySymbol: symbol.trim() || c }),
    });
    setSaving(false);
    if (!ok) { setCurMsg({ tone: "bad", text: body?.message || "Could not save." }); return; }
    setCur({ currency: body.currency, currencySymbol: body.currencySymbol });
    setCurMsg({ tone: body.warning ? "warn" : "ok", text: body.warning || `Saved — every company now bills in ${body.currency}.` });
  };

  const run = async (id: string) => {
    const check = CHECKS.find((c) => c.id === id);
    if (!check) return;
    setResults((r) => ({ ...r, [id]: "busy" }));
    const res = await check.run();
    setResults((r) => ({ ...r, [id]: res }));
  };

  const hh = health;
  const cpuTone: Tone = hh?.cpu == null ? "idle" : hh.cpu >= 90 ? "bad" : hh.cpu >= 70 ? "warn" : "ok";
  const ramTone: Tone = hh?.ramPct == null ? "idle" : hh.ramPct >= 92 ? "bad" : hh.ramPct >= 80 ? "warn" : "ok";
  const diskTone: Tone = !hh?.disk ? "idle" : hh.disk.pct >= 90 ? "bad" : hh.disk.pct >= 80 ? "warn" : "ok";
  const loadTone: Tone = !hh?.load || !hh.cores ? "idle" : hh.load[0] >= hh.cores * 1.5 ? "bad" : hh.load[0] >= hh.cores ? "warn" : "ok";
  const redisTone: Tone = !hh?.redis ? "idle" : hh.redis.ready ? "ok" : hh.redis.required ? "bad" : "idle";
  const queueTone: Tone = hh?.queueMode === "inline" ? "idle" : (hh?.failed || 0) > 0 || (hh?.waiting || 0) > 500 ? "warn" : "ok";

  return (
    <section id={s.root} className={s.wrap} aria-label="Server">
      <div className={s.panel}>
        <div className={s.head}>
          <div>
            <div className={s.eyebrow}>Installation</div>
            <h3>Server health</h3>
          </div>
          <div className={s.headSide}>
            {checked && <span className={s.faint}>Live · checked {checked}</span>}
            <button type="button" className={s.action} onClick={() => void load()} disabled={loading}>
              {loading ? "Checking…" : "Check again"}
            </button>
          </div>
        </div>
        {!hh ? (
          <p className={s.faint}>Checking the server…</p>
        ) : (
          <div className={s.rows}>
            <Row label="Panel" value={hh.build && hh.build !== "unknown" ? `Running · build ${hh.build}` : "Running"} tone="ok" />
            <Row label="Database" value={hh.db ? "Connected" : "Not reachable"} tone={hh.db ? "ok" : "bad"} />
            <Row label="FreeRADIUS database" value={hh.radius == null ? "Not checked" : hh.radius ? "Connected" : "Not reachable"}
              tone={hh.radius == null ? "idle" : hh.radius ? "ok" : "bad"}
              note={hh.radius === false ? "Customers cannot sign in while this is down." : undefined} />
            <Row label="Redis" value={!hh.redis ? "—" : hh.redis.ready ? "Connected" : hh.redis.required ? "Required but down" : "Not used (single server)"} tone={redisTone} />
            <Row label="CPU" value={hh.cpu == null ? "—" : `${hh.cpu}%`} tone={cpuTone} />
            <Row label="Memory" value={hh.ramPct == null ? "—" : `${hh.ramPct}% · ${hh.ramUsedGb} of ${hh.ramTotalGb} GB`} tone={ramTone} />
            <Row label="Disk" value={!hh.disk ? "—" : `${hh.disk.pct.toFixed(1)}% used · ${hh.disk.freeGb} GB free of ${hh.disk.totalGb} GB`} tone={diskTone}
              note={diskTone === "bad" ? "Almost full — clear old logs/backups or expand the disk before the database stops writing." : undefined} />
            <Row label="Load" value={!hh.load ? "—" : `${hh.load.join(" · ")}${hh.cores ? ` (${hh.cores} cores)` : ""}`} tone={loadTone} />
            <Row label="Uptime" value={uptime(hh.uptimeSecs)} tone="ok" />
            <Row label="Background queue"
              value={hh.queueMode === "inline" ? "Runs inline (no Redis)" : `${hh.waiting ?? 0} waiting · ${hh.failed ?? 0} failed`}
              tone={queueTone} />
          </div>
        )}
      </div>

      <div className={s.panel}>
        <div className={s.head}>
          <div>
            <div className={s.eyebrow}>All companies</div>
            <h3>Billing currency</h3>
          </div>
        </div>
        <p className={s.lede}>
          Every company on this server bills and reports in this currency. Changing it applies to new invoices; each
          invoice already raised keeps the currency it was written in.
        </p>
        <div className={s.form}>
          <label className={s.field} htmlFor="ps-cur-code">
            <span className={s.fieldLabel}>ISO code</span>
            <input id="ps-cur-code" className={s.input} value={code} maxLength={3} placeholder="PKR"
              onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </label>
          <label className={s.field} htmlFor="ps-cur-sym">
            <span className={s.fieldLabel}>Shown as</span>
            <input id="ps-cur-sym" className={s.input} value={symbol} maxLength={8} placeholder="Rs"
              onChange={(e) => setSymbol(e.target.value)} />
          </label>
          <button type="button" className={`${s.action} ${s.primary}`} onClick={() => void saveCurrency()} disabled={saving}>
            {saving ? "Saving…" : "Save currency"}
          </button>
        </div>
        {!cur?.currency && !curMsg && (
          <p className={`${s.note} ${s.warnText}`}>No currency is set yet — companies cannot take payments until it is.</p>
        )}
        {curMsg && <p className={`${s.note} ${curMsg.tone === "bad" ? s.badText : curMsg.tone === "warn" ? s.warnText : s.okText}`}>{curMsg.text}</p>}
      </div>

      <div className={`${s.panel} ${s.wide}`}>
        <div className={s.head}>
          <div>
            <div className={s.eyebrow}>Across every company</div>
            <h3>Maintenance</h3>
          </div>
          <a className={s.link} href="/jobs">Full money &amp; RADIUS reconcile →</a>
        </div>
        <div className={s.checks}>
          {CHECKS.map((c) => {
            const r = results[c.id];
            return (
              <div key={c.id} className={s.check}>
                <div className={s.checkText}>
                  <strong className={s.checkName}>{c.label}</strong>
                  <span className={s.faint}>{c.help}</span>
                  {r && r !== "busy" && (
                    <span className={`${s.result} ${r.tone === "bad" ? s.badText : r.tone === "warn" ? s.warnText : s.okText}`}>{r.text}</span>
                  )}
                </div>
                <button type="button" className={s.action} disabled={r === "busy"} onClick={() => void run(c.id)}>
                  {r === "busy" ? "Running…" : "Run"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <MgmtVpnPanel />

      <div className={s.wide}>
        <RadiusRouters platform />
      </div>
    </section>
  );
}
