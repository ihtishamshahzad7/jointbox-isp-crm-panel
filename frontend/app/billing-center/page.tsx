"use client";

import Hub from "../components/hub";
import Accounting from "../accounting/page";
import Invoices from "../invoices/page";
import Payments from "../payments/page";
import Vouchers from "../vouchers/page";
import Pricing from "../pricing/page";
import Gateways from "../gateways/page";

/**
 * Money in one place — the ledger, what was billed, what was collected, and
 * the prices that drive both.
 */
export default function BillingCenter() {
  return (
    <Hub
      storageKey="billing"
      tabs={[
        { id: "accounting", label: "Accounting",         hint: "Wallets, ledger and reseller settlement.", render: () => <Accounting /> },
        { id: "invoices",   label: "Invoices",           hint: "What has been billed, paid and outstanding.", render: () => <Invoices /> },
        { id: "payments",   label: "Payments",           hint: "Money received against those invoices.", render: () => <Payments /> },
        { id: "gateways",   label: "Online Gateways",    hint: "Stripe, bKash, JazzCash and other payment providers.", render: () => <Gateways /> },
        { id: "vouchers",   label: "Vouchers",           hint: "Prepaid codes for top-ups and activations.", render: () => <Vouchers /> },
        { id: "pricing",    label: "Reseller Pricing",   hint: "What each account pays, and the margin at every tier.", render: () => <Pricing /> },
      ]}
    />
  );
}
