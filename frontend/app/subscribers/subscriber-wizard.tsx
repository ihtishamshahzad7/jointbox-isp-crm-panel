"use client";

import React from "react";
import { Wizard, Field } from "../components/wizard";

/**
 * SubscriberWizard — the Add Subscriber form, split into steps.
 *
 * Kept in its OWN FILE deliberately. The subscribers page is 3,000+ lines and
 * is the screen the operator works in every day; restructuring its JSX in
 * place has broken the build twice already. As a separate component the worst
 * case is that this one file fails to compile, and reverting is a one-line
 * change rather than an untangling job.
 *
 * It owns no state. `form` and `setForm` stay on the page so that Cancel,
 * Save, and the edit path all keep working exactly as before.
 */

type Opt = { id: number | string; label: string };

export function SubscriberWizard({
  form, setForm, onSave, onCancel, saving,
  packages, nasOptions, areas, salespeople,
  /** What this account pays for the chosen package — shown before saving. */
  costFor,
}: {
  form: any;
  setForm: (fn: (p: any) => any) => void;
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
  packages: Opt[];
  nasOptions: Opt[];
  areas: Opt[];
  salespeople: Opt[];
  costFor?: (packageId: string) => number | null;
}) {
  const set = (k: string) => (e: React.ChangeEvent<any>) =>
    setForm((p: any) => ({ ...p, [k]: e.target.value }));

  const pkgName = packages.find((p) => String(p.id) === String(form.packageId))?.label ?? "";
  const cost = costFor?.(form.packageId) ?? null;
  const sell = form.sellPrice !== "" ? Number(form.sellPrice) : null;
  const margin = cost != null && sell != null ? sell - cost : null;

  return (
    <Wizard
      busy={saving}
      onCancel={onCancel}
      onFinish={onSave}
      finishLabel="Create + sync RADIUS"
      steps={[
        {
          id: "who",
          title: "Customer",
          hint: "Who the service belongs to. Only the name is required to get started.",
          validate: () => (form.fullName.trim() ? null : "A full name is required."),
          summary: () => [
            ["Name", form.fullName],
            ["Phone", form.phone],
            ["Email", form.email],
            ["CNIC", form.identity],
            ["Address", form.address],
          ],
          render: () => (
            <>
              <Field label="Full name" required>
                <input value={form.fullName} onChange={set("fullName")} />
              </Field>
              <Field label="Phone" hint="Used for renewal and expiry notifications.">
                <input value={form.phone} onChange={set("phone")} />
              </Field>
              <Field label="Email">
                <input value={form.email} onChange={set("email")} />
              </Field>
              <Field label="CNIC / Identity" hint="Left blank, one is generated automatically.">
                <input value={form.identity} onChange={set("identity")} />
              </Field>
              <Field label="Address">
                <input value={form.address} onChange={set("address")} />
              </Field>
            </>
          ),
        },
        {
          id: "login",
          title: "Login",
          hint: "These exact values are written to FreeRADIUS. If the customer cannot dial in, this is the first place to look.",
          validate: () => {
            if (!form.username.trim()) return "A PPPoE username is required — it is the RADIUS identity.";
            if (/\s/.test(form.username)) return "Usernames cannot contain spaces — PPPoE will not match it.";
            if (!form.password.trim()) return "A password is required, or authentication is rejected.";
            return null;
          },
          summary: () => [
            ["Username", form.username],
            ["Password", form.password ? "•".repeat(Math.min(form.password.length, 10)) : ""],
            ["Medium", form.connectionType],
            ["Auth method", form.authMethod],
          ],
          render: () => (
            <>
              <Field label="PPPoE username" required hint="Written to radcheck. No spaces.">
                <input value={form.username} onChange={set("username")} />
              </Field>
              <Field label="Password" required>
                <input value={form.password} onChange={set("password")} />
              </Field>
              <Field label="Connection medium" hint="The physical link — cable, fibre, wireless.">
                <select value={form.connectionType} onChange={set("connectionType")}>
                  {["FTTH", "ADSL", "G4_LTE", "WIRELESS", "FIBER"].map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </Field>
              <Field label="Authentication" hint="How they log in. PPPoE is standard.">
                <select value={form.authMethod} onChange={set("authMethod")}>
                  <option value="PPPOE">PPPoE — dial-up login (standard)</option>
                  <option value="HOTSPOT">Hotspot — captive portal</option>
                  <option value="STATIC">Static IP — fixed address</option>
                  <option value="DHCP">DHCP — MAC based</option>
                </select>
              </Field>
            </>
          ),
        },
        {
          id: "service",
          title: "Service",
          hint: "What they are buying and which router serves them.",
          validate: () => {
            if (!form.packageId) return "Choose a package — without one there is nothing to bill or sync.";
            if (!form.nasId) return "Choose the router this customer dials into.";
            return null;
          },
          summary: () => [
            ["Package", pkgName],
            ["Router", nasOptions.find((n) => String(n.id) === String(form.nasId))?.label ?? ""],
            ["Area", areas.find((a) => String(a.id) === String(form.areaId))?.label ?? ""],
            ["Salesperson", salespeople.find((s) => String(s.id) === String(form.salespersonId))?.label ?? ""],
            ["Install date", form.installationDate],
          ],
          render: () => (
            <>
              <Field label="Package" required>
                <select value={form.packageId} onChange={set("packageId")}>
                  <option value="">— Select package —</option>
                  {packages.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </Field>
              <Field label="Router / NAS" required hint="Only routers available to your account are listed.">
                <select value={form.nasId} onChange={set("nasId")}>
                  <option value="">— Select router —</option>
                  {nasOptions.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
                </select>
              </Field>
              <Field label="Area">
                <select value={form.areaId} onChange={set("areaId")}>
                  <option value="">— Select area —</option>
                  {areas.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </Field>
              <Field label="Salesperson">
                <select value={form.salespersonId} onChange={set("salespersonId")}>
                  <option value="">— Select —</option>
                  {salespeople.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </Field>
              <Field label="Installation date">
                <input type="date" value={form.installationDate} onChange={set("installationDate")} />
              </Field>
              <Field label="Status">
                <select value={form.status} onChange={set("status")}>
                  {["ACTIVE", "INACTIVE", "SUSPENDED", "EXPIRED"].map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </Field>
            </>
          ),
        },
        {
          id: "money",
          title: "Billing",
          hint: "What this customer pays you, and what the activation will cost your wallet.",
          summary: () => [
            ["Customer pays", sell != null ? String(sell) : "your default retail price"],
            ["Costs your wallet", cost != null ? String(cost) : "—"],
            ["Your margin", margin != null ? String(margin) : "—"],
            ["Static IP", form.staticIpAddress],
          ],
          render: () => (
            <>
              <Field label="Retail price"
                hint="What this customer pays. Blank uses your default price for the package.">
                <input type="number" value={form.sellPrice} onChange={set("sellPrice")} />
              </Field>
              <Field label="Static public IP"
                hint="Optional. Overrides the package pool with this exact address.">
                <input value={form.staticIpAddress} onChange={set("staticIpAddress")} />
              </Field>
              <Field label="Static IP monthly price" hint="Billed on its own cycle.">
                <input type="number" value={form.staticIpPrice} onChange={set("staticIpPrice")} />
              </Field>

              {/*
                The wallet consequence, stated BEFORE saving.
                Every prepaid failure in this panel has been discovered at the
                moment of activation, when the customer is already sitting
                there. Showing the cost while the price is being typed turns
                that into a decision rather than a surprise.
              */}
              {cost != null && (
                <div className="wz-cost">
                  <b>This activation will deduct {cost} from your wallet.</b>
                  <span>
                    That is what you pay for {pkgName || "this package"} — not what you charge.
                    {margin != null && (
                      margin < 0
                        ? ` At ${sell} you would LOSE ${Math.abs(margin)} every cycle.`
                        : ` At ${sell} you keep ${margin} per cycle.`
                    )}
                  </span>
                </div>
              )}
              <style>{`
                .wz-cost{grid-column:1/-1;display:flex;flex-direction:column;gap:4px;
                  padding:12px 14px;border-radius:11px;font-size:12px;line-height:1.7;
                  background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.4)}
                .wz-cost b{color:#FCD34D}
                .wz-cost span{color:var(--muted)}
              `}</style>
            </>
          ),
        },
        {
          id: "extra",
          title: "Documents",
          hint: "Optional. Everything here can be added later from the subscriber's profile.",
          summary: () => [
            ["Photo", form.photoUrl ? "uploaded" : ""],
            ["CNIC front", form.cnicFrontUrl ? "uploaded" : ""],
            ["CNIC back", form.cnicBackUrl ? "uploaded" : ""],
            ["Coordinates", form.latitude && form.longitude ? `${form.latitude}, ${form.longitude}` : ""],
          ],
          render: () => (
            <>
              <Field label="Latitude"><input value={form.latitude} onChange={set("latitude")} /></Field>
              <Field label="Longitude"><input value={form.longitude} onChange={set("longitude")} /></Field>
              <Field label="Document URL"><input value={form.documentUrl} onChange={set("documentUrl")} /></Field>
              <Field label="Photo URL" hint="Or upload from the profile page after saving.">
                <input value={form.photoUrl} onChange={set("photoUrl")} />
              </Field>
              <Field label="CNIC front URL">
                <input value={form.cnicFrontUrl} onChange={set("cnicFrontUrl")} />
              </Field>
              <Field label="CNIC back URL">
                <input value={form.cnicBackUrl} onChange={set("cnicBackUrl")} />
              </Field>
            </>
          ),
        },
      ]}
    />
  );
}
