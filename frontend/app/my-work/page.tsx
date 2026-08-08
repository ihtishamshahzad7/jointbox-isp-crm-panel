"use client";

import Hub from "../components/hub";
import MyBusiness from "../my-business/page";
import QuickConnect from "../quick-connect/page";
import Renewals from "../renewals/page";

/**
 * My Work — the franchise/dealer daily loop in one place: see the business,
 * add a customer, renew the ones falling due. These three are used together
 * all day, so they belong behind one sidebar entry rather than three.
 */
export default function MyWorkHub() {
  return (
    <Hub
      storageKey="mywork"
      tabs={[
        { id: "business", label: "My Business",   hint: "Wallet, customer health, this month's revenue and dues.", render: () => <MyBusiness /> },
        { id: "connect",  label: "Quick Connect", hint: "Add and activate a customer in one screen.", render: () => <QuickConnect /> },
        { id: "renewals", label: "Renewals",      hint: "Due this week and expired — one tap to renew and collect.", render: () => <Renewals /> },
      ]}
    />
  );
}
