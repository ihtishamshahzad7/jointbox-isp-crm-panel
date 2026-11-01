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
import { apiSend, type NasRecord } from "./lib";
import { isSnmpVersionFormValue, snmpVersionFormValue, type SnmpVersionFormValue } from "./snmp-version";
import { Btn, DefList, Field, Modal, Panel, StatusChip } from "./ui";

const MASK = "••••••••";

type ConfigForm = {
  shortname: string;
  nasIp: string;
  description: string;
  isActive: boolean;
  apiEnabled: boolean;
  apiPort: number | string;
  apiUsername: string;
  apiPassword: string;
  apiPollSec: number | string;
  incomingPort: number | string;
  secret: string;
  snmpEnabled: boolean;
  snmpPort: number | string;
  snmpCommunity: string;
  snmpVersion: SnmpVersionFormValue;
  snmpPollSec: number | string;
  snmpTimeoutMs: number | string;
  snmpRetries: number | string;
  monitoredPorts: string;
  snmpV3User: string;
  snmpV3SecLevel: string;
  snmpV3AuthProto: string;
  snmpV3AuthPass: string;
  snmpV3PrivProto: string;
  snmpV3PrivPass: string;
};

export function ConfigTab() {
  const { nas, loadNas, refreshReach } = useNasDetail();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Form initialized per record; password/secret fields masked when set.
  const [form, setForm] = useState<ConfigForm | null>(null);
  const openEdit = () => {
    setSaveErr(null); setSaved(false);
    setForm({
      shortname: nas?.shortname ?? "",
      nasIp: nas?.nasIp ?? "",
      description: nas?.description ?? "",
      isActive: nas?.isActive ?? false,
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
      snmpVersion: snmpVersionFormValue(nas?.snmpVersion),
      snmpPollSec: nas?.snmpPollSec ?? 30,
      snmpTimeoutMs: nas?.snmpTimeoutMs ?? 1000,
      snmpRetries: nas?.snmpRetries ?? 3,
      monitoredPorts: nas?.monitoredPorts ? (() => { try { return JSON.parse(nas.monitoredPorts).join(", "); } catch { return nas.monitoredPorts; } })() : "",
      // SNMPv3 (USM). Passphrases are masked — a masked value is left unchanged.
      snmpV3User: nas?.snmpV3User ?? "",
      snmpV3SecLevel: nas?.snmpV3SecLevel ?? "authPriv",
      snmpV3AuthProto: nas?.snmpV3AuthProto ?? "SHA",
      snmpV3AuthPass: nas?.hasSnmpV3AuthPass ? MASK : "",
      snmpV3PrivProto: nas?.snmpV3PrivProto ?? "AES",
      snmpV3PrivPass: nas?.hasSnmpV3PrivPass ? MASK : "",
    });
    setEditing(true);
  };

  const save = async () => {
    const formData = form;
    if (!formData) return;
    setSaving(true); setSaveErr(null);
    try {
      const body: Record<string, string | number | boolean> = {
        shortname: formData.shortname,
        nasIp: formData.nasIp,
        description: formData.description,
        isActive: formData.isActive,
        apiEnabled: formData.apiEnabled,
        apiPort: Number(formData.apiPort) || 8728,
        apiUsername: formData.apiUsername,
        apiPollSec: Number(formData.apiPollSec) || 60,
        incomingPort: Number(formData.incomingPort) || 3799,
        snmpEnabled: formData.snmpEnabled,
        snmpPort: Number(formData.snmpPort) || 161,
        snmpVersion: formData.snmpVersion,
        snmpPollSec: Number(formData.snmpPollSec) || 30,
        snmpTimeoutMs: Number(formData.snmpTimeoutMs) || 1000,
        snmpRetries: Number(formData.snmpRetries) || 3,
        monitoredPorts: formData.monitoredPorts ?? "",
      };
      // SNMPv3 identity + protocols are only meaningful on v3.
      if (formData.snmpVersion === "3") {
        body.snmpV3User = formData.snmpV3User;
        body.snmpV3SecLevel = formData.snmpV3SecLevel;
        body.snmpV3AuthProto = formData.snmpV3AuthProto;
        body.snmpV3PrivProto = formData.snmpV3PrivProto;
      }
      // Masked values are sent but the backend treats them as "unchanged".
      if (formData.apiPassword) body.apiPassword = formData.apiPassword;
      if (formData.secret) body.secret = formData.secret;
      if (formData.snmpCommunity) body.snmpCommunity = formData.snmpCommunity;
      if (formData.snmpV3AuthPass) body.snmpV3AuthPass = formData.snmpV3AuthPass;
      if (formData.snmpV3PrivPass) body.snmpV3PrivPass = formData.snmpV3PrivPass;

      const r = await apiSend<NasRecord>(`/nas/${nas?.id}`, "PUT", body);
      if (!r) throw new Error("Save failed — no response from server");
      setSaved(true);
      await Promise.allSettled([loadNas(), refreshReach({ silent: true })]);
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof ConfigForm,>(key: K, value: ConfigForm[K]) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
  };

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
            <Field label="SNMP version"><select value={form.snmpVersion} onChange={(e) => { if (isSnmpVersionFormValue(e.target.value)) set("snmpVersion", e.target.value); }}><option>1</option><option>2c</option><option>3</option></select></Field>
            <Field label="SNMP port"><input type="number" className="nd-mono" value={form.snmpPort} onChange={(e) => set("snmpPort", e.target.value)} /></Field>
            <Field label="SNMP community"><input type="password" className="nd-mono" value={form.snmpCommunity} onChange={(e) => set("snmpCommunity", e.target.value)} placeholder={MASK} /></Field>
            <Field label="Poll interval (s)"><input type="number" value={form.snmpPollSec} onChange={(e) => set("snmpPollSec", e.target.value)} /></Field>
            <Field label="Timeout (ms) / retries"><div style={{ display: "flex", gap: 8 }}>
              <input type="number" value={form.snmpTimeoutMs} onChange={(e) => set("snmpTimeoutMs", e.target.value)} />
              <input type="number" value={form.snmpRetries} onChange={(e) => set("snmpRetries", e.target.value)} />
            </div></Field>
            <Field label="Monitored interfaces" hint="Comma-separated names/indexes, e.g. ether1, vlan100. Blank = all."><input className="nd-mono" value={form.monitoredPorts} onChange={(e) => set("monitoredPorts", e.target.value)} placeholder="all interfaces" /></Field>

            {form.snmpVersion === "3" && (
              <>
                <div className="nd-group-label" style={{ gridColumn: "1 / -1" }}>SNMPv3 (USM) — authPriv recommended</div>
                <Field label="v3 username"><input className="nd-mono" value={form.snmpV3User} onChange={(e) => set("snmpV3User", e.target.value)} /></Field>
                <Field label="Security level"><select value={form.snmpV3SecLevel} onChange={(e) => set("snmpV3SecLevel", e.target.value)}><option value="authPriv">authPriv (recommended)</option><option value="authNoPriv">authNoPriv</option><option value="noAuthNoPriv">noAuthNoPriv</option></select></Field>
                <Field label="Auth protocol"><select value={form.snmpV3AuthProto} onChange={(e) => set("snmpV3AuthProto", e.target.value)}><option value="SHA">SHA</option><option value="MD5">MD5</option></select></Field>
                <Field label="Auth passphrase" hint="Masked = keep current."><input type="password" className="nd-mono" value={form.snmpV3AuthPass} onChange={(e) => set("snmpV3AuthPass", e.target.value)} placeholder={MASK} /></Field>
                <Field label="Privacy protocol"><select value={form.snmpV3PrivProto} onChange={(e) => set("snmpV3PrivProto", e.target.value)}><option value="AES">AES</option><option value="DES">DES</option></select></Field>
                <Field label="Privacy passphrase" hint="Masked = keep current."><input type="password" className="nd-mono" value={form.snmpV3PrivPass} onChange={(e) => set("snmpV3PrivPass", e.target.value)} placeholder={MASK} /></Field>
              </>
            )}
            {form.snmpVersion === "2c" && form.snmpEnabled && (
              <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "#B45309" }}>
                SNMPv2c sends the community in clear text. Prefer SNMPv3 (authPriv) on untrusted networks.
              </div>
            )}
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