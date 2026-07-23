"use client";

import React from "react";
import { Wizard, Field } from "../components/wizard";

/**
 * PackageWizard — Add Package, split into steps.
 *
 * In its own file for the same reason as the subscriber wizard: the packages
 * page is 1,400 lines, and restructuring large JSX in place has broken this
 * build twice. Owning no state keeps Cancel, Save and the edit path unchanged.
 *
 * The old single-page form put billing, speed, quota and pool config in one
 * grid, which hid the two decisions that actually matter: the pool name has to
 * match the router exactly, and the speed values are what RADIUS sends as the
 * rate limit. Both get their own step and their own explanation.
 */

type Pool = { id: number | string; name: string };

export function PackageWizard({
  form, setForm, onSave, onCancel, saving, pools,
}: {
  form: any;
  setForm: (fn: (p: any) => any) => void;
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
  pools: Pool[];
}) {
  const set = (k: string) => (e: React.ChangeEvent<any>) =>
    setForm((p: any) => ({ ...p, [k]: e.target.value }));

  const poolName = pools.find((p) => String(p.id) === String(form.poolId))?.name;

  return (
    <Wizard
      busy={saving}
      onCancel={onCancel}
      onFinish={onSave}
      finishLabel="Create package"
      steps={[
        {
          id: "basics",
          title: "Basics",
          hint: "What the plan is called and what it costs. This price is your base — every reseller is priced separately from it.",
          validate: () => {
            if (!form.name.trim()) return "A package name is required.";
            if (form.price === "" || Number(form.price) < 0) return "Enter a price. Use 0 for a free or internal plan.";
            return null;
          },
          summary: () => [
            ["Name", form.name],
            ["Base price", form.price],
            ["Service type", form.serviceType],
            ["Description", form.description],
          ],
          render: () => (
            <>
              <Field label="Package name" required hint="Shown to you and to every reseller.">
                <input value={form.name} onChange={set("name")} placeholder="Home 4 Mbps" />
              </Field>
              <Field label="Base price" required
                hint="Your own cost basis. Resellers pay whatever you set for them in Reseller Pricing.">
                <input type="number" value={form.price} onChange={set("price")} />
              </Field>
              <Field label="Service type">
                <select value={form.serviceType} onChange={set("serviceType")}>
                  {["RESIDENTIAL", "BUSINESS", "CORPORATE", "EDUCATIONAL", "GOVERNMENT"].map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </Field>
              <Field label="Description">
                <input value={form.description} onChange={set("description")} />
              </Field>
              <Field label="Invoice description" hint="Appears on the customer's invoice line.">
                <input value={form.invoiceDescription} onChange={set("invoiceDescription")} />
              </Field>
            </>
          ),
        },
        {
          id: "billing",
          title: "Billing cycle",
          hint: "How long one purchase lasts before it needs renewing.",
          validate: () => (Number(form.duration) > 0 ? null : "Duration must be at least 1."),
          summary: () => [
            ["Cycle", `${form.duration} ${form.durationType}`],
            ["Auto renew", form.autoRenew ? "Yes" : "No"],
            ["Status", form.isActive ? "Active" : "Inactive"],
          ],
          render: () => (
            <>
              <Field label="Duration" required hint="30 with MONTHLY is the usual setup.">
                <input type="number" value={form.duration} onChange={set("duration")} />
              </Field>
              <Field label="Duration type">
                <select value={form.durationType} onChange={set("durationType")}>
                  {["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "HALF_YEARLY", "YEARLY"].map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </Field>
              <Field label="Auto renew"
                hint="Renews automatically at expiry if the wallet can cover it.">
                <select value={form.autoRenew ? "1" : "0"}
                  onChange={(e) => setForm((p: any) => ({ ...p, autoRenew: e.target.value === "1" }))}>
                  <option value="0">Disabled</option>
                  <option value="1">Enabled</option>
                </select>
              </Field>
              <Field label="Status" hint="Inactive hides it from new sign-ups; existing customers keep running.">
                <select value={form.isActive ? "1" : "0"}
                  onChange={(e) => setForm((p: any) => ({ ...p, isActive: e.target.value === "1" }))}>
                  <option value="1">Active</option>
                  <option value="0">Inactive</option>
                </select>
              </Field>
            </>
          ),
        },
        {
          id: "speed",
          title: "Speed & quota",
          hint: "These become the RADIUS rate limit sent to the router. Getting them wrong here is what customers feel.",
          validate: () => {
            if (!(Number(form.downloadSpeed) > 0)) return "Download speed must be greater than zero.";
            if (!(Number(form.uploadSpeed) > 0)) return "Upload speed must be greater than zero.";
            return null;
          },
          summary: () => [
            ["Speed", `${form.downloadSpeed} / ${form.uploadSpeed} Mbps`],
            ["Data quota", form.dataQuotaGb ? `${form.dataQuotaGb} GB` : "unlimited"],
            ["After quota", form.fupDownloadSpeed
              ? `${form.fupDownloadSpeed} / ${form.fupUploadSpeed || "—"} Mbps`
              : "no throttle"],
          ],
          render: () => (
            <>
              <Field label="Download (Mbps)" required>
                <input type="number" value={form.downloadSpeed} onChange={set("downloadSpeed")} />
              </Field>
              <Field label="Upload (Mbps)" required>
                <input type="number" value={form.uploadSpeed} onChange={set("uploadSpeed")} />
              </Field>
              <Field label="Data quota (GB)" hint="Blank means unlimited.">
                <input type="number" value={form.dataQuotaGb} onChange={set("dataQuotaGb")} />
              </Field>
              <Field label="FUP download (Mbps)"
                hint="Speed after the quota is used. Blank means no throttle.">
                <input type="number" value={form.fupDownloadSpeed} onChange={set("fupDownloadSpeed")} />
              </Field>
              <Field label="FUP upload (Mbps)">
                <input type="number" value={form.fupUploadSpeed} onChange={set("fupUploadSpeed")} />
              </Field>
            </>
          ),
        },
        {
          id: "pool",
          title: "IP pool",
          hint: "Where the customer's address comes from.",
          summary: () => [["Address pool", poolName ?? "router decides"]],
          render: () => (
            <>
              <Field label="IP pool"
                hint="Sent to the router as Framed-Pool. The name must exist on the router exactly as written.">
                <select value={form.poolId} onChange={set("poolId")}>
                  <option value="">— Router decides (no Framed-Pool sent) —</option>
                  {pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>

              {/*
                This is the fault that caused the reconnect loop on this very
                system: a pool named in the panel that did not exist on the
                MikroTik. The customer authenticates, gets no usable address,
                and drops every few seconds — which looks like a RADIUS problem
                and is not. Worth saying at the point of choosing.
              */}
              <div className="pw-warn">
                {poolName ? (
                  <>
                    <b>Check that “{poolName}” exists on the router.</b>
                    <span>
                      Run <code>/ip pool print</code> on the MikroTik. If the name is missing or
                      spelled differently, customers on this package will connect and then
                      disconnect in a loop with no usable IP.
                    </span>
                  </>
                ) : (
                  <>
                    <b>No pool selected.</b>
                    <span>
                      RADIUS will send no Framed-Pool and the router will assign from its own
                      PPPoE profile. That is fine if the profile has a pool configured — check
                      before you rely on it.
                    </span>
                  </>
                )}
              </div>
              <style>{`
                .pw-warn{grid-column:1/-1;display:flex;flex-direction:column;gap:4px;
                  padding:12px 14px;border-radius:11px;font-size:12px;line-height:1.7;
                  background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.4)}
                .pw-warn b{color:#FCD34D}
                .pw-warn span{color:var(--muted)}
                .pw-warn code{background:rgba(0,0,0,.3);padding:1px 5px;border-radius:4px}
              `}</style>
            </>
          ),
        },
      ]}
    />
  );
}
