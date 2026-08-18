"use client";

/**
 * API permission diagnosis for one NAS.
 *
 * Three real signals are combined:
 *  1. reach.apiPortOpen        — TCP :apiPort reachable (the router is up)
 *  2. details loaded           — authenticated API session succeeded
 *  3. details.apiErrors        — per-command RouterOS !trap failures
 *
 * When RouterOS policies block commands the state is "API: ⚠ LIMITED" — the
 * device is still ONLINE, and the operator gets three busy paths instead of a
 * wall of raw protocol text: Fix Instructions, Retest API, Edit Credentials.
 * Raw RouterOS errors are always collapsed behind "View technical error".
 */
import React, { useState } from "react";
import { useNasDetail } from "./context";
import { parseApiErrors, PERM_COMMANDS } from "./lib";
import { Btn, Modal, Panel, StatusChip } from "./ui";

export type PermissionLevel = "ok" | "limited" | "no-creds" | "unreachable" | "checking";

export function permissionLevel(opts: {
  hasCreds: boolean; apiPortOpen?: boolean | null; detailsLoaded: boolean; errorCount: number;
}): PermissionLevel {
  if (!opts.hasCreds) return "no-creds";
  if (!opts.apiPortOpen) return "unreachable";
  if (!opts.detailsLoaded) return "checking";
  return opts.errorCount > 0 ? "limited" : "ok";
}

export function PermissionPanel({ onEditCredentials, onGoto }: {
  /** Open the device-edit dialog (Configuration tab). */
  onEditCredentials?: () => void;
  onGoto?: (tab: string) => void;
}) {
  const { nas, reach, details, refreshReach, loadDetails } = useNasDetail();
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [showFix, setShowFix] = useState(false);

  const hasCreds = !!nas?.apiUsername && !!nas?.apiPassword;
  const errorCount = details?.apiErrors?.length ?? 0;
  const level = permissionLevel({
    hasCreds,
    apiPortOpen: reach ? reach.apiPortOpen : null,
    detailsLoaded: !!details,
    errorCount,
  });
  const { failed, raw } = parseApiErrors(details?.apiErrors);

  const retest = async () => {
    setBusy(true);
    try {
      await Promise.all([refreshReach({ silent: true }), loadDetails({ silent: true })]);
    } finally {
      setBusy(false);
    }
  };

  // Matrix rows — every value is real.
  const rows: Array<{ label: string; ok: boolean; text: string; why?: string }> = [
    {
      label: "TCP :apiPort",
      ok: !!reach?.apiPortOpen,
      text: reach?.apiPortOpen ? "Reachable" : "Not reachable",
      why: nas ? `port ${nas.apiPort ?? 8728}` : undefined,
    },
    {
      label: "API login",
      ok: !!details,
      text: details ? `Authenticated as "${nas?.apiUsername}"` : "Not authenticated",
      why: details ? `v${details.version || "?"}` : undefined,
    },
    {
      label: "RouterOS policies",
      ok: errorCount === 0,
      text: errorCount === 0 ? "Full read access" : `${errorCount} command(s) blocked`,
      why: errorCount === 0 ? "read + radius + ppp policies" : undefined,
    },
  ];

  const banner: { text: string; detail: string } | null =
    level === "limited"
      ? { text: `API is LIMITED — RouterOS policies block ${errorCount} command(s).`, detail: "The router is online and authenticated, but reading some data requires extra policies." }
      : level === "no-creds"
        ? { text: "API is NOT CONFIGURED — no credentials on this device.", detail: "Add an API username/password to enable live device data." }
        : level === "unreachable"
          ? { text: "API is UNREACHABLE — the router is not answering on the API port.", detail: "Check the device itself, firewall rules and the apiPort value." }
          : null;

  return (
    <Panel title="API permission health" sub="Separate from device reachability — a limited API still means the router is online.">
      {level === "checking" ? (
        <div className="nd-perm-loading">Checking API session…</div>
      ) : banner ? (
        <div className="nd-alert" style={level === "no-creds" ? { borderColor: "rgba(100,116,139,.4)", background: "rgba(100,116,139,.07)" } : undefined}>
          <span className="nd-alert-ic">⚠</span>
          <div>
            <b>{banner.text}</b> {banner.detail}
            <div className="nd-alert-actions">
              {level === "limited" && <Btn size="xs" onClick={() => setShowFix(true)}>Fix Instructions</Btn>}
              <Btn size="xs" onClick={retest} disabled={busy}>{busy ? "Retesting…" : "Retest API"}</Btn>
              {(onEditCredentials ?? onGoto) && (
                <Btn size="xs" variant="ghost" onClick={() => (onEditCredentials ? onEditCredentials() : onGoto?.("configuration"))}>
                  Edit Credentials
                </Btn>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="nd-perm-ok">
          <StatusChip level="ok" text="API fully operational" detail="Authenticated; no RouterOS command blocked." />
        </div>
      )}

      {/* Matrix */}
      <table className="nd-table" style={{ marginTop: 10 }}>
        <thead>
          <tr><th style={{ width: "34%" }}>Check</th><th>Status</th><th>Detail</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td style={{ fontWeight: 700 }}>{r.label}</td>
              <td>
                <StatusChip level={r.ok ? "ok" : "bad"} text={r.ok ? "OK" : "FAIL"} dotPulse={false} />
              </td>
              <td className="nd-mono">{r.text}{r.why ? <span className="nd-perm-why"> · {r.why}</span> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Failed commands — always collapsed until explicitly expanded. */}
      {errorCount > 0 && (
        <div className="nd-perm-fail">
          <button className="nd-perm-toggle" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "▾ Hide" : "▸ View"} technical error{errorCount > 1 ? `s (${errorCount})` : ""}
            <span className="nd-mono">RouterOS protocol</span>
          </button>
          {showRaw && (
            <div className="nd-perm-raw">
              <code>{raw.join("\n")}</code>
              <div className="nd-perm-raw-hint">Raw !trap responses from the router, surfaced for debugging.</div>
            </div>
          )}
          {showRaw && failed.size > 0 && (
            <div className="nd-perm-blocks">
              Blocked reading:{" "}
              {PERM_COMMANDS.filter((c) => failed.has(c.label) || failed.has(c.needed)).map((c) => c.cmd).join("  ·  ")}
            </div>
          )}
        </div>
      )}

      {/* Fix instructions — RouterOS commands for the operator, never run for them. */}
      {showFix && (
        <FixInstructionsModal onClose={() => setShowFix(false)} failed={failed} />
      )}
    </Panel>
  );
}

function FixInstructionsModal({ onClose, failed }: { onClose: () => void; failed: Set<string> }) {
  const { nas } = useNasDetail();
  const userName = nas?.apiUsername ?? "<api-user>";
  const handler = String(nas?.nasIp || "0.0.0.0").split("/")[0];

  // NOTE: config commands are documentation for the operator — the app never
  // executes RouterOS changes; this panel only inspects.
  const blockedList = failed.size > 0
    ? PERM_COMMANDS.filter((c) => failed.has(c.label) || failed.has(c.needed)).map((c) => c.cmd)
    : PERM_COMMANDS.map((c) => c.cmd);

  const commands = [
    `/user add name=${userName} group=full password=<set-one>`,
    "",
    "# Give the panel's API user exactly the policies it needs (least privilege):",
    "/user group add name=panel-read policy=read,radius,ppp,test",
    `/user set ${userName} group=panel-read`,
    "",
    `# Then restrict that API user to this device (API runs only from ${handler}):`,
    "/ip firewall filter add chain=input protocol=tcp dst-port=8728 src-address=" + handler + " action=accept",
    "/ip firewall filter add chain=input protocol=tcp dst-port=8728 action=drop",
    "",
    "# Verify — the panel should now read all sections:",
    "/user group print",
  ];

  return (
    <Modal title="Fix RouterOS API permissions" sub="Run these on the router (winbox SSH). The panel never changes router config — this is the exact setup it needs." onClose={onClose} width={620}>
      <div className="nd-fix-intro">
        The API user <b>{userName || "…"}</b> is authenticated but RouterOS policies block some reads.
        Blocked paths:
      </div>
      <div className="nd-fix-blocked">
        {blockedList.length ? blockedList.map((c, i) => <code key={i}>{c}</code>) : <code>/… all prints</code>}
      </div>
      <pre className="nd-fix-cmd">{commands.map((c) => c || "\n").join("\n")}</pre>
      <div className="nd-fix-foot">
        <span>Read-only group <b>panel-read</b> with <b>read,radius,ppp,test</b> is the minimum the panel needs.</span>
        <Btn size="xs" onClick={() => { void navigator.clipboard?.writeText(commands.join("\n")); }}>
          Copy commands
        </Btn>
      </div>
    </Modal>
  );
}

export const PermCss = `
.nd-perm-loading{color:var(--muted);font-size:12px;padding:8px 0}
.nd-perm-ok{padding:4px 0}
.nd-perm-why{color:var(--muted);font-weight:400}
.nd-perm-fail{margin-top:8px;border-top:1px dashed var(--border);padding-top:8px}
.nd-perm-toggle{display:flex;align-items:center;gap:8px;width:100%;background:none;border:none;color:var(--muted);
  font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit;text-align:left}
.nd-perm-toggle:hover{color:var(--text)}
.nd-perm-toggle span{margin-left:auto;font-size:10px;font-weight:500}
.nd-perm-raw{margin-top:8px;background:#0B1120;border:1px solid #1E293B;border-radius:8px;padding:10px 12px;
  max-height:180px;overflow:auto;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;color:#F87171;line-height:1.7;white-space:pre-wrap}
.nd-perm-raw-hint{color:#64748B;font-size:10px;margin-top:6px;font-family:inherit}
.nd-perm-blocks{margin-top:6px;font-size:10.5px;color:var(--muted)}
.nd-fix-intro{font-size:12px;line-height:1.6;margin-bottom:6px}
.nd-fix-blocked{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}
.nd-fix-blocked code{font-family:'JetBrains Mono',monospace;font-size:10px;background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:2px 6px;color:var(--muted)}
.nd-fix-cmd{background:#0B1120;border:1px solid #1E293B;border-radius:8px;padding:12px 14px;font-size:11px;line-height:1.75;
  color:#7CC0FF;overflow-x:auto;margin:0;font-family:'JetBrains Mono',ui-monospace,monospace;white-space:pre}
.nd-fix-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;font-size:11px;color:var(--muted)}
`;