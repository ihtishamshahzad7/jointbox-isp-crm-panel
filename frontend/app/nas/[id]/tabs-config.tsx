"use client";

/**
 * Configuration tab — read-only view of every device setting + an edit dialog.
 *
 * Secrets (RADIUS secret, API password, SNMP community) are ALWAYS displayed
 * masked. The edit form follows the backend contract: a masked value means
 * "unchanged", so sending the bullets back does not overwrite the real secret.
 * Saving calls PUT /nas/:id (real endpoint; FreeRADIUS is reloaded server-side
 * when the IP/secret/name changes).
 */
import React, { useState } from "react";
import { useNasDetail } from "./context";
import { apiSend } from "./lib";
import { Btn, DefList, Field, Modal, Panel, StatusChip } from "./ui";

const MASK = "••••••••";

export function ConfigTab() {
  const { nas, loadNas, refreshReach } = useNasDetail();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Form initialized per record; password/secret fields masked when set.
  const [form, setForm] = useState<any>(null);
  const openEdit = () => {
    setSaveErr(null); setSaved(false);
    setForm({
      shortname: nas?.shortname ?? "",
      nasIp: nas?.nasIp ?? "",
      description: nas?.description ?? "",
      isActive: nas?.isActive,
      apiEnabled: nas?.apiEnabled ?? true,
      apiPort: nas?.apiPort ?? 8728,
      apiUsername: nas?.apiUsername ?? "",
      apiPassword: nas?.apiPassword ? MASK : "",
      apiPollSec: nas?.apiPollSec ?? 60,
      incomingPort: nas?.incomingPort ?? 3799,
      secret: nas?.secret ? MASK : "",
      snmpEnabled: nas?.snmpEnabled ?? false,
      snmpPort: nas?.snmpPort ?? 161,
      snmpCommunity: nas?.snmpCommunity ? MASK : "",
      snmpVersion: nas?.snmpVersion ?? "2c",
      snmpPollSec: nas?.snmpPollSec ?? 30,
      snmpTimeoutMs: nas?.snmpTimeoutMs ?? 1000,
      snmpRetries: nas?.snmpRetries ?? 3,
      syslogEnabled: nas?.syslogEnabled ?? false,
      syslogPort: nas?.syslogPort ?? 514,
    });
    setEditing(true);
  };

  const save = async () => {
    setSaving(true); setSaveErr(null);
    try {
      const body: any = {
        shortname: form.shortname,
        nasIp: form.nasIp,
        description: form.description,
        isActive: form.isActive,
        apiEnabled: form.apiEnabled,
        apiPort: Number(form.apiPort) || 8728,
        apiUsername: form.apiUsername,
        apiPollSec: Number(form.apiPollSec) || 60,
        incomingPort: Number(form.incomingPort) || 3799,
        snmpEnabled: form.snmpEnabled,
        snmpPort: Number(form.snmpPort) || 161,
        snmpVersion: form.snmpVersion,
        snmpPollSec: Number(form.snmpPollSec) || 30,
        snmpTimeoutMs: Number(form.snmpTimeoutMs) || 1000,
        snmpRetries: Number(form.snmpRetries) || 3,
        syslogEnabled: form.syslogEnabled,
        syslogPort: Number(form.syslogPort) || 514,
      };
      // Masked values are sent but the backend treats them as "unchanged".
      if (form.apiPassword) body.apiPassword = form.apiPassword;
      if (form.secret) body.secret = form.secret;
      if (form.snmpCommunity) body.snmpCommunity = form.snmpCommunity;

      const r = await apiSend<any>(`/nas/${nas?.id}`, "PUT", body);
      if (!r) throw new Error("Save failed — no response from server");
      setSaved(true);
      await Promise.allSettled([loadNas(), refreshReach({ silent: true })]);
    } catch (e: any) {
      setSaveErr(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  return (
    <div className="nd-root">
      <Panel
        title="Device configuration"
        sub="Every setting for this NAS — secrets stay masked, edits hit the real device record"
        actions={
          <Btn size="sm" variant="primary" onClick={openEdit}>Edit configuration</Btn>
        }
      >
        <div className="nd-config-grid">
          <div>
            <div className="nd-group-label">General</div>
            <DefList rows={[
              ["Name", nas?.shortname || nas?.nasname || "—"],
              ["IP", <code key="ip" className="nd-mono">{nas?.nasIp ?? "—"}</code>],
              ["Type / device", `${nas?.type ?? "—"}${nas?.deviceType ? ` · ${nas.deviceType}` : ""}`],
              ["Active", nas?.isActive ? "Yes" : "No"],
              ["Description", nas?.description || "—"],
            ]} />
            <div className="nd-group-label">API (RouterOS)</div>
            <DefList rows={[
              ["Enabled", nas?.apiEnabled ? "Yes" : "No"],
              ["Port", `TCP :${nas?.apiPort ?? 8728}`],
              ["Username", nas?.apiUsername ? <code key="u" className="nd-mono">{nas.apiUsername}</code> : "not set"],
              ["Password", nas?.apiPassword ? MASK : "not set"],
              ["Poll interval", nas?.apiPollSec ? `${nas.apiPollSec}s` : "—"],
            ]} />
          </div>
          <div>
            <div className="nd-group-label">RADIUS</div>
            <DefList rows={[
              ["Shared secret", nas?.secret ? MASK : "not set"],
              ["CoA / incoming port", `UDP :${nas?.incomingPort ?? 3799}`],
              ["NAS identifier", nas?.nasIdentifier || "—"],
            ]} />
            <div className="nd-group-label">SNMP polling</div>
            <DefList rows={[
              ["Enabled", nas?.snmpEnabled ? "Yes" : "No"],
              ["Version", nas?.snmpVersion ?? "2c"],
              ["Port", `UDP :${nas?.snmpPort ?? 161}`],
              ["Community", nas?.hasSnmpCommunity ?? !!nas?.snmpCommunity ? MASK : "not set"],
              ["Poll / timeout / retries", `${nas?.snmpPollSec ?? 30}s · ${nas?.snmpTimeoutMs ?? 1000}ms · ${nas?.snmpRetries ?? 3}`],
            ]} />
            <div className="nd-group-label">Syslog</div>
            <DefList rows={[
              ["Enabled", nas?.syslogEnabled ? "Yes" : "No"],
              ["Port", `UDP :${nas?.syslogPort ?? 514}`],
            ]} />
          </div>
        </div>
      </Panel>

      {editing && form && (
        <Modal
          title={`Edit ${nas?.shortname || nas?.nasname || `NAS #${nas?.id}`}`}
          sub="Blank = unchanged for secrets; saving triggers FreeRADIUS reload when IP/secret/name change."
          onClose={() => setEditing(false)}
          width={720}
        >
          <div className="nd-config-form">
            <Field label="Name" required><input value={form.shortname} onChange={(e) => set("shortname", e.target.value)} /></Field>
            <Field label="NAS IP" required><input className="nd-mono" value={form.nasIp} onChange={(e) => set("nasIp", e.target.value)} /></Field>
            <Field label="Description"><input value={form.description} onChange={(e) => set("description", e.target.value)} /></Field>
            <Field label="Active"><select value={form.isActive ? "1" : "0"} onChange={(e) => set("isActive", e.target.value === "1")}><option value="1">Yes</option><option value="0">No</option></select></Field>

            <Field label="API enabled"><select value={form.apiEnabled ? "1" : "0"} onChange={(e) => set("apiEnabled", e.target.value === "1")}><option value="1">Yes</option><option value="0">No</option></select></Field>
            <Field label="API port"><input type="number" className="nd-mono" value={form.apiPort} onChange={(e) => set("apiPort", e.target.value)} /></Field>
            <Field label="API username"><input className="nd-mono" value={form.apiUsername} onChange={(e) => set("apiUsername", e.target.value)} /></Field>
            <Field label="API password" hint="Masked value = keep current; type to replace."><input type="password" className="nd-mono" value={form.apiPassword} onChange={(e) => set("apiPassword", e.target.value)} placeholder={MASK} /></Field>
            <Field label="API poll interval (s)"><input type="number" value={form.apiPollSec} onChange={(e) => set("apiPollSec", e.target.value)} /></Field>

            <Field label="RADIUS shared secret" hint="Must match the router's RADIUS config exactly."><input type="password" className="nd-mono" value={form.secret} onChange={(e) => set("secret", e.target.value)} placeholder={MASK} /></Field>
            <Field label="CoA / incoming port"><input type="number" className="nd-mono" value={form.incomingPort} onChange={(e) => set("incomingPort", e.target.value)} /></Field>

            <Field label="SNMP enabled"><select value={form.snmpEnabled ? "1" : "0"} onChange={(e) => set("snmpEnabled", e.target.value === "1")}><option value="1">Yes</option><option value="0">No</option></select></Field>
            <Field label="SNMP version"><select value={form.snmpVersion} onChange={(e) => set("snmpVersion", e.target.value)}><option>1</option><option>2c</option><option>3</option></select></Field>
            <Field label="SNMP port"><input type="number" className="nd-mono" value={form.snmpPort} onChange={(e) => set("snmpPort", e.target.value)} /></Field>
            <Field label="SNMP community"><input type="password" className="nd-mono" value={form.snmpCommunity} onChange={(e) => set("snmpCommunity", e.target.value)} placeholder={MASK} /></Field>
            <Field label="Poll interval (s)"><input type="number" value={form.snmpPollSec} onChange={(e) => set("snmpPollSec", e.target.value)} /></Field>
            <Field label="Timeout (ms) / retries"><div style={{ display: "flex", gap: 8 }}>
              <input type="number" value={form.snmpTimeoutMs} onChange={(e) => set("snmpTimeoutMs", e.target.value)} />
              <input type="number" value={form.snmpRetries} onChange={(e) => set("snmpRetries", e.target.value)} />
            </div></Field>

            <Field label="Syslog enabled"><select value={form.syslogEnabled ? "1" : "0"} onChange={(e) => set("syslogEnabled", e.target.value === "1")}><option value="1">Yes</option><option value="0">No</option></select></Field>
            <Field label="Syslog port"><input type="number" className="nd-mono" value={form.syslogPort} onChange={(e) => set("syslogPort", e.target.value)} /></Field>
          </div>

          {saveErr && <div className="nd-config-err">{saveErr}</div>}
          {saved && (
            <div className="nd-config-ok">
              <StatusChip level="ok" text="Saved" dotPulse={false} /> Configuration updated.
            </div>
          )}

          <div className="nd-config-foot">
            <span className="nd-config-note">RADIUS secret stays masked in the API — the panel never shows it in full.</span>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="ghost" onClick={() => setEditing(false)}>Cancel</Btn>
              <Btn variant="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save configuration"}</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export const ConfigCss = `
.nd-config-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 28px}
@media (max-width:900px){.nd-config-grid{grid-template-columns:1fr}}
.nd-config-form{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
@media (max-width:720px){.nd-config-form{grid-template-columns:1fr}}
.nd-config-err{margin-top:10px;color:#D34053;font-size:12px}
.nd-config-ok{margin-top:10px;font-size:12px;color:var(--text)}
.nd-config-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;padding-top:12px;border-top:1px solid var(--border)}
.nd-config-note{font-size:10.5px;color:var(--muted);line-height:1.5}
`;