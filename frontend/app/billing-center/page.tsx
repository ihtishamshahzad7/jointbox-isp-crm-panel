"use client";

import Hub from "../components/hub";
import Accounting from "../accounting/page";
import Invoices from "../invoices/page";
import Payments from "../payments/page";
import Vouchers from "../vouchers/page";
import Pricing from "../pricing/page";
import Gateways from "../gateways/page";
import Earnings from "../earnings/page";
import Reversals from "../reversals/page";
import WalletManager from "../accounting/wallets";

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
        { id: "wallets",    label: "Wallets",            hint: "Add or reclaim balance for a downline account — with the full transaction record of who moved what.", render: () => <WalletManager /> },
        { id: "earnings",   label: "Collections",        hint: "What you collected, by day, package and method.", render: () => <Earnings /> },
        { id: "invoices",   label: "Invoices",           hint: "What has been billed, paid and outstanding.", render: () => <Invoices /> },
        { id: "payments",   label: "Payments",           hint: "Money received against those invoices.", render: () => <Payments /> },
        { id: "gateways",   label: "Online Gateways",    hint: "Stripe, bKash, JazzCash and other payment providers.", render: () => <Gateways /> },
        { id: "vouchers",   label: "Vouchers",           hint: "Prepaid codes for top-ups and activations.", render: () => <Vouchers /> },
        { id: "pricing",    label: "Reseller Pricing",   hint: "What each account pays, and the margin at every tier.", render: () => <Pricing /> },
        { id: "reversals",  label: "Disputes & Reversals", hint: "Reversed commissions and the audit trail behind them.", render: () => <Reversals /> },
      ]}
    />
  );
}
