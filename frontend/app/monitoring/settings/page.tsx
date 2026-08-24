"use client";

/**
 * Settings — live subsystem health (§52): SNMP connectivity, poller beat,
 * alert/notification engines, sound, monitored vs excluded interfaces, plus
 * the syslog listener status. Real numbers only — nothing invented.
 */
import React from "react";
import { ndm, fmtTime, type ForwardTarget, type ArchiveStatus, type ArchiveFile } from "../ndm";
import { NDMCSS, Stat, useNdmRefresh } from "../ndm-ui";
import { NdmTabs } from "../ndm-tabs";
import { NdmSoundBell } from "../../components/ndm-sound";

export default function SettingsPage() {
  const [diag, setDiag] = React.useState<any>(null);
  const [err, setErr] = React.useState("");

  const load = React.useCallback(async () => {
    try { setDiag(await ndm.diagnostics()); setErr(""); }
    catch (e: any) { setErr(e?.message || "Diagnostics are only visible to admins."); }
  }, []);

  useNdmRefresh(load, () => {}, [load], 20000);

  const p = diag?.poller ?? ({} as any);
  const a = diag?.alertEngine ?? ({} as any);
  const s = diag?.sound ?? ({} as any);
  const i = diag?.interfaces ?? ({} as any);
  const proc = diag?.process ?? ({} as any);

  const Row = ({ label, ok, detail }: { label: string; ok: boolean | null; detail?: string }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 4px", borderBottom: "1px solid var(--border)" }}>
      <span style={{ fontSize: 13 }}>{ok === null ? "⚪" : ok ? "🟢" : "🔴"}</span>
      <b style={{ fontSize: 13, flex: 1 }}>{label}</b>
      {detail && <span className="ndm-card-sub" style={{ fontSize: 11.5 }}>{detail}</span>}
    </div>
  );

  return (
    <div className="ndm">
      <style>{NDMCSS}</style>
      <NdmTabs active="settings" />

      <div className="ndm-page-h">
        <div>
          <h1>Settings &amp; Diagnostics</h1>
          <p>Live health of every background subsystem — the numbers the acceptance report checks.</p>
        </div>
        <div className="ndm-row-actions">
          <NdmSoundBell />
          <button className="ndm-btn" onClick={load}>{diag ? "Refresh" : "Load"}</button>
        </div>
      </div>

      {err && <div className="ndm-err" style={{ marginBottom: 10 }}>{err}</div>}

      {!diag && !err && <div className="ndm-empty">Loading diagnostics…</div>}
      {diag && (
        <>
          <div className="ndm-strip">
            <Stat label="SNMP engine" value={diag.snmp?.connected ? "connected" : "no backend"} color={diag.snmp?.connected ? "var(--online)" : "var(--danger)"} sub={`${diag.snmp?.deviceCount ?? 0} SNMP device(s)`} />
            <Stat label="Poller" value={p.lastBeat ? "beating" : p.scheduled ? "scheduled" : "not scheduled"} color={p.lastBeat ? "var(--online)" : "var(--warning)"} sub={p.lastBeat ? `last beat ${fmtTime(p.lastBeat)}` : "no beat on this process"} />
            <Stat label="Open alerts" value={a.openCount ?? 0} color={a.openCount ? "var(--danger)" : "var(--online)"} sub={`${a.last24h ?? 0} raised in 24h`} />
            <Stat label="Syslog (24h)" value={diag.syslog?.last24h ?? 0} sub={diag.syslog?.listening?.length ? `${diag.syslog.listening.join(", ")} bound` : "no listener bound here"} />
          </div>

          {/*
            Which process answered matters. On a web node the poller genuinely
            does not run, and without saying so the zeros below read as a fault
            when they are correct behaviour.
          */}
          <div className="ndm-hint" style={{ marginBottom: 12 }}>
            Answered by <b>{proc.role}</b> process{proc.instance != null ? ` #${proc.instance}` : ""} — {proc.note}
          </div>

          <div className="ndm-card" style={{ marginBottom: 12 }}>
            <div className="ndm-card-h">
              <b>System health</b>
              <span className="ndm-card-sub">counts come from the database, so they are identical on every process and survive restarts</span>
            </div>
            <Row label="SNMP backend available" ok={!!diag.snmp?.connected} detail={`${diag.snmp?.deviceCount ?? 0} SNMP device(s) of ${diag.devices?.total ?? 0} enabled`} />
            <Row
              label="Poll loop"
              ok={proc.primary ? !!p.lastBeat : null}
              detail={
                p.lastBeat
                  ? `last beat ${fmtTime(p.lastBeat)} · ${p.sweeps ?? 0} sweeps · ${p.dueLastSweep ?? 0} device(s) due last sweep`
                  : proc.primary ? "scheduled but has not run yet" : "runs on the worker, not here"
              }
            />
            <Row label="Alerts" ok={(a.openCount ?? 0) === 0} detail={`${a.openCount ?? 0} open · ${a.last24h ?? 0} raised in 24h`} />
            <Row label="Events" ok={(diag.events?.open ?? 0) === 0} detail={`${diag.events?.open ?? 0} open · ${diag.events?.last24h ?? 0} in 24h`} />
            <Row label="Monitoring split" ok={null} detail={`${diag.devices?.snmp ?? 0} SNMP · ${diag.devices?.ping ?? 0} ping/HTTP`} />
          </div>

          <div className="ndm-card" style={{ marginBottom: 12 }}>
            <div className="ndm-card-h"><b>Sound</b></div>
            <Row label="Alert sound chain" ok={true} detail="poller → event → rule → alert → SSE → browser audio" />
            <Row label="Interfaces with sound ON" ok={null} detail={String(s.enabledInterfaces ?? 0)} />
            <Row label="Devices with sound ON" ok={null} detail={String(s.devicesOn ?? 0)} />
            <Row
              label="Devices muted"
              ok={s.devicesMuted ? false : null}
              detail={s.devicesMuted ? `${s.devicesMuted} device(s) raise no sound at all, even for CRITICAL` : "none"}
            />
            <div className="ndm-hint" style={{ marginTop: 8 }}>
              Per-port DOWN/UP alerts and sounds are set on each port (Devices → open a device → Ports). Test buttons on every
              port drive the REAL pipeline: event → rule → alert → SSE → browser sound.
            </div>
          </div>

          <div className="ndm-card" style={{ marginBottom: 12 }}>
            <div className="ndm-card-h"><b>Interface policy</b><span className="ndm-card-sub">physical + VLAN by default; PPPoE/PPP/dynamic/tunnel excluded unless explicitly enabled</span></div>
            <div className="ndm-strip">
              <Stat label="Monitored" value={i.monitored ?? "—"} color="var(--online)" />
              <Stat label="Excluded" value={i.excluded ?? "—"} />
              <Stat label="Enabled rules" value={diag.rules?.enabled ?? "—"} />
              <Stat label="Total rules" value={diag.rules?.total ?? "—"} />
            </div>
          </div>

          <div className="ndm-card">
            <div className="ndm-card-h"><b>Syslog listeners</b></div>
            {diag.syslog?.listening?.length ? (
              <div className="ndm-row-actions" style={{ flexWrap: "wrap" }}>
                {diag.syslog.listening.map((l: string) => <span key={l} className="ndm-pill" style={{ cursor: "default" }}>{l} listening</span>)}
              </div>
            ) : (
              <div className="ndm-card-sub">
                {diag.syslog?.configured?.length
                  ? `Configured (${diag.syslog.configured.join(", ")}) but not bound on this process — the listener belongs to the worker.`
                  : "No listeners active — enable them under Alerts & Rules → Syslog server."}
              </div>
            )}
            <div className="ndm-card-sub" style={{ marginTop: 8 }}>
              {diag.syslog?.last24h ?? 0} message(s) received in the last 24 hours.
            </div>
            <div className="ndm-hint" style={{ marginTop: 8 }}>As of {fmtTime(diag.asOf)}</div>
          </div>

          <ForwardingCard />
          <ArchiveCard />
        </>
      )}
    </div>
  );
}

/** Bytes → human. Returns "—" for nothing, never a misleading "0 B". */
const fmtBytes = (n?: number | null) => {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
};

const BLANK: Partial<ForwardTarget> = { name: "", host: "", port: 514, protocol: "UDP", enabled: true, condition: "" };

/**
 * Syslog forwarding — relay the received stream to another collector.
 *
 * Hidden entirely for non-ISP accounts: the API returns 403 and there is
 * nothing useful to show a reseller, so an empty panel with an error would be
 * noise rather than information.
 */
function ForwardingCard() {
  const [rows, setRows] = React.useState<ForwardTarget[] | null>(null);
  const [hidden, setHidden] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState<Partial<ForwardTarget> | null>(null);

  const load = React.useCallback(async () => {
    try { setRows(await ndm.forwardTargets()); setErr(""); }
    catch (e: any) {
      if (/403|forbidden|ISP-level/i.test(e?.message || "")) { setHidden(true); return; }
      setErr(e?.message || "Could not load forwarding targets.");
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      if (draft.id) await ndm.updateForwardTarget(draft.id, draft);
      else await ndm.createForwardTarget(draft);
      setDraft(null);
      await load();
      setErr("");
    } catch (e: any) { setErr(e?.message || "Save failed."); }
    finally { setBusy(false); }
  };

  const remove = async (t: ForwardTarget) => {
    if (!confirm(`Stop forwarding to ${t.host}:${t.port}?\n\nReceiving, storing and alerting are unaffected — only the relay to this destination stops.`)) return;
    setBusy(true);
    try { await ndm.deleteForwardTarget(t.id); await load(); }
    catch (e: any) { setErr(e?.message || "Delete failed."); }
    finally { setBusy(false); }
  };

  if (hidden) return null;

  return (
    <div className="ndm-card" style={{ marginTop: 12 }}>
      <div className="ndm-card-h">
        <b>Syslog forwarding</b>
        <span className="ndm-card-sub">relay every received line to a SIEM, archive or head-office collector</span>
        <button className="ndm-btn" style={{ marginLeft: "auto" }} onClick={() => setDraft({ ...BLANK })}>
          Add target
        </button>
      </div>

      {err && <div className="ndm-err" style={{ margin: "8px 0" }}>{err}</div>}

      {rows === null && <div className="ndm-empty">Loading…</div>}
      {rows?.length === 0 && !draft && (
        <div className="ndm-empty">
          No forwarding targets. Syslog is still received, stored and alerted on — nothing is being relayed off this box.
        </div>
      )}

      {!!rows?.length && (
        <table className="ndm-tbl">
          <thead>
            <tr>
              <th>Name</th><th>Destination</th><th>Filter</th><th>Sent</th><th>Failed</th><th>Last error</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} style={{ opacity: t.enabled ? 1 : 0.55 }}>
                <td>
                  <b>{t.name || t.host}</b>
                  {!t.enabled && <span className="ndm-pill" style={{ marginLeft: 6 }}>disabled</span>}
                </td>
                <td><code>{t.host}:{t.port}</code> <span className="ndm-card-sub">{t.protocol}</span></td>
                <td className="ndm-card-sub">{t.condition || "all messages"}</td>
                <td>{t.sentCount ?? 0}</td>
                <td style={{ color: t.failCount ? "var(--danger)" : undefined }}>{t.failCount ?? 0}</td>
                <td className="ndm-card-sub" title={t.lastError || ""} style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.lastError || "—"}
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button className="ndm-btn" onClick={() => setDraft({ ...t })}>Edit</button>{" "}
                  <button className="ndm-btn" onClick={() => void remove(t)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {draft && (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 10, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input className="ndm-in" placeholder="Name (optional)" value={draft.name ?? ""}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={{ flex: "1 1 160px" }} />
            <input className="ndm-in" placeholder="Host or IP" value={draft.host ?? ""}
              onChange={(e) => setDraft({ ...draft, host: e.target.value })} style={{ flex: "1 1 180px" }} />
            <input className="ndm-in" type="number" placeholder="Port" value={draft.port ?? 514}
              onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} style={{ width: 90 }} />
            <select className="ndm-in" value={draft.protocol ?? "UDP"}
              onChange={(e) => setDraft({ ...draft, protocol: e.target.value as "UDP" | "TCP" })} style={{ width: 90 }}>
              <option value="UDP">UDP</option>
              <option value="TCP">TCP</option>
            </select>
          </div>
          <input className="ndm-in" placeholder='Filter (optional) — e.g. SEV&lt;=3; NOT CONTAINS "login"'
            value={draft.condition ?? ""} onChange={(e) => setDraft({ ...draft, condition: e.target.value })} />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
            <input type="checkbox" checked={draft.enabled ?? true}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            Enabled
          </label>
          <div className="ndm-hint">
            Same clause syntax as SYSLOG_MATCH alert rules, AND-ed with <code>;</code>. Leave the filter empty to relay
            everything — including lines from devices this panel does not manage, which is normally what a downstream
            collector expects.
          </div>
          <div className="ndm-row-actions">
            <button className="ndm-btn" disabled={busy || !draft.host} onClick={() => void save()}>
              {busy ? "Saving…" : draft.id ? "Save changes" : "Add target"}
            </button>
            <button className="ndm-btn" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Syslog archive — the on-disk audit copy, which is a different thing from the
 * database feed the Syslog tab shows. Read-only here: the archive is configured
 * by environment variables on the server, so presenting editable fields would
 * be a lie about what this screen can change.
 */
function ArchiveCard() {
  const [st, setSt] = React.useState<ArchiveStatus | null>(null);
  const [files, setFiles] = React.useState<ArchiveFile[] | null>(null);
  const [hidden, setHidden] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [showFiles, setShowFiles] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      try { setSt(await ndm.archiveStatus()); }
      catch (e: any) {
        if (/403|forbidden|ISP-level/i.test(e?.message || "")) setHidden(true);
        else setErr(e?.message || "Could not read archive status.");
      }
    })();
  }, []);

  const openFiles = async () => {
    setShowFiles(true);
    if (files) return;
    try { setFiles(await ndm.archiveFiles()); }
    catch (e: any) { setErr(e?.message || "Could not list archive files."); }
  };

  const download = async (name: string) => {
    try { await ndm.downloadArchive(name); }
    catch (e: any) { setErr(e?.message || "Download failed."); }
  };

  if (hidden) return null;

  return (
    <div className="ndm-card" style={{ marginTop: 12 }}>
      <div className="ndm-card-h">
        <b>Syslog archive</b>
        <span className="ndm-card-sub">complete raw lines on disk — the audit copy, kept longer and untruncated</span>
      </div>

      {err && <div className="ndm-err" style={{ margin: "8px 0" }}>{err}</div>}
      {!st && !err && <div className="ndm-empty">Loading…</div>}

      {st && !st.enabled && (
        <div className="ndm-empty">
          {st.note || "Archiving is switched off."}
          <div className="ndm-hint" style={{ marginTop: 6 }}>
            Enable it by removing <code>SYSLOG_ARCHIVE=off</code> from the backend environment and restarting.
          </div>
        </div>
      )}

      {st?.enabled && (
        <>
          <div className="ndm-strip">
            <Stat label="Files" value={st.fileCount ?? 0} sub={`oldest ${st.oldestFile || "—"}`} />
            <Stat label="On disk" value={fmtBytes(st.totalBytes)} sub={`ceiling ${fmtBytes(st.maxBytes)}`} />
            <Stat label="Retention" value={`${st.retentionDays} days`} sub="whichever limit bites first" />
            <Stat
              label="Lines dropped"
              value={st.linesDropped ?? 0}
              color={st.linesDropped ? "var(--danger)" : "var(--online)"}
              sub={st.linesDropped ? "disk could not keep up" : "none"}
            />
          </div>

          <Row2 label="Directory" value={<code>{st.directory}</code>} />
          <Row2 label="Layout" value={st.perSource ? "one folder per sending device" : "one file per day"} />
          <Row2 label="Lines written" value={String(st.linesWritten ?? 0)} />
          <Row2 label="Last write" value={st.lastWriteAt ? fmtTime(st.lastWriteAt) : "nothing written yet"} />
          {!!st.buffered && <Row2 label="Buffered" value={`${st.buffered} line(s) waiting to flush`} />}
          {st.lastError && (
            <div className="ndm-err" style={{ marginTop: 8 }}>
              Last write error: {st.lastError}
            </div>
          )}
          {st.readable === false && (
            <div className="ndm-err" style={{ marginTop: 8 }}>
              The archive directory could not be read. Check that the backend user owns <code>{st.directory}</code>.
            </div>
          )}

          <div className="ndm-row-actions" style={{ marginTop: 10 }}>
            <button className="ndm-btn" onClick={() => void openFiles()}>
              {showFiles ? "Reload file list" : "Browse files"}
            </button>
          </div>

          {showFiles && files === null && <div className="ndm-empty">Loading files…</div>}
          {showFiles && files?.length === 0 && (
            <div className="ndm-empty">No archive files yet — nothing has been received since archiving was enabled.</div>
          )}
          {showFiles && !!files?.length && (
            <table className="ndm-tbl" style={{ marginTop: 8 }}>
              <thead><tr><th>File</th><th>Size</th><th>Modified</th><th></th></tr></thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.name}>
                    <td><code>{f.name}</code></td>
                    <td>{fmtBytes(f.size)}</td>
                    <td className="ndm-card-sub">{fmtTime(f.modifiedAt)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button className="ndm-btn" onClick={() => void download(f.name)}>Download</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="ndm-hint" style={{ marginTop: 8 }}>
            The Syslog tab queries the database copy, which truncates long messages and is aged out to keep the UI fast.
            These files hold the complete line as received, with our own receive timestamp added — that is the copy to
            reach for during an investigation, when the device&apos;s own clock is the thing you cannot trust.
          </div>
        </>
      )}
    </div>
  );
}

function Row2({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, padding: "7px 4px", borderBottom: "1px solid var(--border)", fontSize: 12.5 }}>
      <b style={{ flex: 1 }}>{label}</b>
      <span className="ndm-card-sub">{value}</span>
    </div>
  );
}