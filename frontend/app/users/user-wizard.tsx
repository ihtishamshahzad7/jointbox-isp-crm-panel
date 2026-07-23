"use client";

import React from "react";
import { Wizard, Field } from "../components/wizard";

/**
 * UserWizard — Add User / reseller account, in steps.
 *
 * Own file, same reason as the others: the page keeps its state, and a mistake
 * here cannot take the page down with it.
 *
 * The single-page version mixed identity, credentials, hierarchy and money in
 * one column, with the most consequential choice — account type — sitting
 * between "Password" and "Phone" as if it were of equal weight. It is not: it
 * decides where the account sits in the tree, what it can see, and who funds
 * it. It gets its own step.
 */
/**
 * Each role may create exactly ONE role beneath it. This mirrors the rule the
 * backend enforces in UsersService.create() — and it has to, because the first
 * version of this wizard offered "RESELLER" to everybody. A dealer picking the
 * only option on screen was rejected with "A Dealer can only create a Retailer
 * or a Staff account": the form offered a choice the server would never accept.
 */
const CHILD_ROLE: Record<string, { role: string; label: string; blurb: string } | null> = {
  SUPER_ADMIN:  { role: "RESELLER",     label: "Franchise", blurb: "A franchise buys from you and sells through its own dealers." },
  ADMIN:        { role: "RESELLER",     label: "Franchise", blurb: "A franchise buys from you and sells through its own dealers." },
  RESELLER:     { role: "SUB_RESELLER", label: "Dealer",    blurb: "A dealer buys from you and may have retailers of their own." },
  SUB_RESELLER: { role: "RETAILER",     label: "Retailer",  blurb: "A retailer buys from you and sells directly to customers." },
  RETAILER:     null, // the last commercial tier — staff only
};

const MY_LABEL: Record<string, string> = {
  SUPER_ADMIN: "ISP", ADMIN: "ISP", RESELLER: "Franchise",
  SUB_RESELLER: "Dealer", RETAILER: "Retailer",
};

export function UserWizard({
  form, setForm, onSave, onCancel, saving, currency = "PKR", myRole,
}: {
  form: any;
  setForm: (fn: (p: any) => any) => void;
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
  currency?: string;
  /** The signed-in account's role — decides what can be created below it. */
  myRole?: string;
}) {
  const set = (k: string) => (e: React.ChangeEvent<any>) =>
    setForm((p: any) => ({ ...p, [k]: e.target.value }));
  const toggle = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((p: any) => ({ ...p, [k]: e.target.checked }));

  const child = myRole ? CHILD_ROLE[myRole] ?? null : CHILD_ROLE.SUPER_ADMIN;
  const myLabel = MY_LABEL[myRole ?? ""] ?? "your account";
  const isStaff = form.role === "SALES";

  /**
   * Keep the form honest: if the only thing this account may create is staff,
   * or the stored role is one the server would reject, correct it rather than
   * letting the user submit something that cannot succeed.
   */
  React.useEffect(() => {
    if (!child && form.role !== "SALES") setForm((p: any) => ({ ...p, role: "SALES" }));
    else if (child && form.role !== "SALES" && form.role !== child.role) {
      setForm((p: any) => ({ ...p, role: child.role }));
    }
  }, [child, form.role, setForm]);

  return (
    <Wizard
      busy={saving}
      onCancel={onCancel}
      onFinish={onSave}
      finishLabel="Create account"
      steps={[
        {
          id: "who",
          title: "Person",
          hint: "Who this account belongs to.",
          validate: () => (form.name.trim() ? null : "A name is required."),
          summary: () => [["Name", form.name], ["Phone", form.phone]],
          render: () => (
            <>
              <Field label="Full name" required>
                <input value={form.name} onChange={set("name")} />
              </Field>
              <Field label="Phone">
                <input value={form.phone} onChange={set("phone")} />
              </Field>
            </>
          ),
        },
        {
          id: "contact",
          title: "Contact & location",
          hint: "Notification preferences and where they are based. All optional.",
          summary: () => [
            ["Status", form.isActive === false ? "Inactive" : "Active"],
            ["Notify", [form.smsEnabled === false ? null : "SMS", form.emailEnabled === false ? null : "Email"].filter(Boolean).join(" + ") || "none"],
            ["City", form.city || ""],
          ],
          render: () => (
            <>
              {/* Status + notification switches — the panel decides whether to
                  send this account SMS/email from these flags. */}
              <Field label="Account status" hint="Inactive accounts cannot sign in.">
                <label className="uw-check">
                  <input type="checkbox" checked={form.isActive !== false} onChange={toggle("isActive")} />
                  <span>{form.isActive !== false ? "Active — can sign in" : "Inactive — sign-in blocked"}</span>
                </label>
              </Field>
              <Field label="Notifications">
                <label className="uw-check">
                  <input type="checkbox" checked={form.smsEnabled !== false} onChange={toggle("smsEnabled")} />
                  <span>Send SMS notifications</span>
                </label>
                <label className="uw-check">
                  <input type="checkbox" checked={form.emailEnabled !== false} onChange={toggle("emailEnabled")} />
                  <span>Send email notifications</span>
                </label>
              </Field>

              <Field label="Address">
                <input value={form.address} onChange={set("address")} />
              </Field>
              <Field label="City">
                <input value={form.city} onChange={set("city")} />
              </Field>
              <Field label="Province / State">
                <input value={form.province} onChange={set("province")} />
              </Field>
              <Field label="Country">
                <input value={form.country} onChange={set("country")} />
              </Field>

              <style>{`
                .uw-check{display:flex;align-items:center;gap:8px;font-size:12.5px;
                  color:var(--text);cursor:pointer;padding:2px 0}
                .uw-check input{width:15px;height:15px;cursor:pointer}
                .uw-check span{color:var(--muted)}
              `}</style>
            </>
          ),
        },
        {
          id: "login",
          title: "Sign in",
          hint: "How they log into the panel. The email is their username.",
          validate: () => {
            if (!form.email.trim()) return "An email is required — it is how they sign in.";
            if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) return "That does not look like a valid email address.";
            if (!form.password || form.password.length < 8) return "Password must be at least 8 characters.";
            return null;
          },
          summary: () => [
            ["Email", form.email],
            ["Password", form.password ? "•".repeat(Math.min(form.password.length, 10)) : ""],
          ],
          render: () => (
            <>
              <Field label="Email" required hint="Used as the login. Must be unique.">
                <input value={form.email} onChange={set("email")} />
              </Field>
              <Field label="Password" required hint="At least 8 characters. They can change it later.">
                <input type="text" value={form.password} onChange={set("password")} />
              </Field>
            </>
          ),
        },
        {
          id: "role",
          title: "Account type",
          hint: "This decides what the account can do and where it sits in your tree. It cannot be changed casually later.",
          summary: () => [
            ["Type", isStaff ? "Staff (helper)" : "Reseller (downline)"],
            ["Sits under", "you"],
          ],
          render: () => (
            <>
              <Field label="Account type" required
                hint={child
                  ? `As ${myLabel}, the only account you can create below you is a ${child.label}.`
                  : `As ${myLabel} you are the last selling tier, so you can only create staff.`}>
                <select value={form.role} onChange={set("role")}>
                  {child && (
                    <option value={child.role}>{child.label} — sells on their own account</option>
                  )}
                  <option value="SALES">Staff — helps run YOUR account</option>
                </select>
              </Field>

              {/*
                The difference between these two is the thing people get wrong,
                and it is not recoverable by editing a field afterwards — one
                creates a separate business under you, the other creates a
                login into your own. Spelling it out at the point of choice.
              */}
              <div className="uw-note">
                {isStaff ? (
                  <>
                    <b>Staff work inside YOUR account.</b>
                    <span>
                      They see your subscribers, spend your wallet and act on your behalf.
                      They have no customers or balance of their own. Use this for an office
                      helper or an installer.
                    </span>
                  </>
                ) : (
                  <>
                    <b>A {child?.label ?? "reseller"} is a separate business under you.</b>
                    <span>
                      {child?.blurb} They get their own wallet, their own customers and their own
                      prices. You set what they pay you; they keep the difference. They cannot see
                      your other accounts, and their siblings cannot see them.
                    </span>
                  </>
                )}
              </div>

              <div className="uw-note plain">
                <b>Created directly under you.</b>
                <span>
                  To create the level below that — a dealer beneath this franchise — switch
                  into their account first using <b>Act as</b> in the top bar.
                </span>
              </div>

              <style>{`
                .uw-note{grid-column:1/-1;display:flex;flex-direction:column;gap:4px;
                  padding:11px 13px;border-radius:11px;font-size:11.5px;line-height:1.7;
                  background:rgba(108,60,225,.10);border:1px solid rgba(108,60,225,.4)}
                .uw-note b{color:#C4B5FD}
                .uw-note span{color:var(--muted)}
                .uw-note.plain{background:rgba(255,255,255,.03);border-color:var(--border)}
                .uw-note.plain b{color:var(--text)}
              `}</style>
            </>
          ),
        },
        {
          id: "money",
          title: "Wallet",
          hint: isStaff
            ? "Staff have no wallet of their own — they spend yours. Nothing to set here."
            : "Prepaid: they cannot activate a customer until this has balance.",
          skip: isStaff,
          summary: () => [["Opening balance", form.balance || "0"]],
          render: () => (
            <>
              <Field label={`Opening balance (${currency})`}
                hint="Comes out of your wallet. You can top them up any time afterwards.">
                <input type="number" value={form.balance} onChange={set("balance")} />
              </Field>
              <div className="uw-note plain">
                <b>Leaving this at zero is fine.</b>
                <span>
                  They can be set up, priced and given a router now, and funded when they are
                  ready to sell. Until then they can create customers but not activate them.
                </span>
              </div>
            </>
          ),
        },
        {
          id: "docs",
          title: "Documents",
          hint: "Optional. Can be added later from their profile.",
          summary: () => [
            ["Photo", form.photoUrl ? "set" : ""],
            ["CNIC front", form.cnicFrontUrl ? "set" : ""],
            ["CNIC back", form.cnicBackUrl ? "set" : ""],
          ],
          render: () => (
            <>
              <Field label="Profile picture URL">
                <input value={form.photoUrl} onChange={set("photoUrl")} />
              </Field>
              <Field label="CNIC — front URL">
                <input value={form.cnicFrontUrl} onChange={set("cnicFrontUrl")} />
              </Field>
              <Field label="CNIC — back URL">
                <input value={form.cnicBackUrl} onChange={set("cnicBackUrl")} />
              </Field>
            </>
          ),
        },
      ]}
    />
  );
}
