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
import Accountability from "../accounting/accountability";
import ProfitReport from "../accounting/profit-report";
import MarginChain from "../accounting/margin-chain";

/**
 * Money in one place — the ledger, what was billed, what was collected, and
 * the prices that drive both.
 */
export default function BillingCenter() {
  return (
    <Hub
      storageKey="billing"
      tabs={[
        { id: "profit", label: "Profit Report", hint: "What you earned from your downline's activations — by day, week, month, year or a custom range, with the line items. Reporting only: profit never touches a wallet.", render: () => <ProfitReport /> },
        { id: "margin-chain", label: "Margin Chain", hint: "Every sale, and what each tier took from it — so you can see where margin is being absorbed. Tiers above your account are not shown.", render: () => <MarginChain /> },
        { id: "accountability", label: "Profit & Accountability", hint: "Are you earning? Profit by day/week/month, balance flow, and what each child earns you.", render: () => <Accountability /> },
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
