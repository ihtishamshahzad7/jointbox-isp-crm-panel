# Reseller / Franchise Capability Checklist

What each tier in the Jointbox hierarchy **can** and **cannot** do. Use it to
onboard a new franchise or dealer, to answer "why can't I see X", and to verify
the panel enforces the boundaries it promises.

**Hierarchy:** ISP (owner) → Franchise (RESELLER) → Dealer (SUB_RESELLER) →
Retailer (RETAILER). Staff (SALES) and Auditor (read-only) are special accounts
that sit *inside* an existing account rather than forming a new selling tier.

Every capability below is scoped to the account's **own subtree** and enforced on
the server — never only hidden in the interface.

---

## 1. Account & hierarchy

- [ ] Each tier can create exactly **one** tier directly beneath it
      (ISP→Franchise, Franchise→Dealer, Dealer→Retailer). To create the level
      below that, switch into the child with **Act as** first.
- [ ] A Retailer is the last selling tier — it creates customers, not sub-accounts.
- [ ] Any account can create **Staff (SALES)** to help run its own business.
- [ ] Only the **ISP owner** can create an **Auditor** (read-only) account.
- [ ] A child never sees its parent's other children (siblings are invisible).
- [ ] A child cannot see or edit its own wallet balance rules, commission, or permissions.

## 2. Wallet & money flow

- [ ] Every selling account has a **prepaid wallet**; staff and auditors do not.
- [ ] Activating or renewing a subscriber **debits the owner's wallet** at their
      buy price and cascades the margin up the chain automatically.
- [ ] A parent tops up a child's wallet; the top-up **debits the parent's** wallet.
- [ ] An account cannot activate a customer once its wallet (plus any credit
      limit) is exhausted — the attempt is refused, not queued.
- [ ] A parent may grant a child a **credit limit** (overdraft) so it can keep
      selling slightly past zero.
- [ ] Upstream pricing is hidden: a child never sees what its parent pays.

## 3. Pricing & packages

- [ ] The ISP publishes packages; a Franchise/Dealer **resells** them at its own
      sell price via **Reseller Pricing**.
- [ ] A price row is what **that** account pays; its margin is the child's price
      minus its own.
- [ ] A parent can let a child **set its own sell prices**, or keep that control.
- [ ] Only the ISP can create, edit, or delete the underlying **package catalogue**
      (hard floor — cannot be widened by an empty permission table).
- [ ] Per-tier price inheritance flows down the tree until overridden.

## 4. Subscribers

- [ ] An account manages only the subscribers in its own subtree.
- [ ] Create, activate, renew (full / set-days / until-date / use-balance / on-credit),
      change package (pro-rata), suspend, and put on hold.
- [ ] Credit extensions are capped at **two unsettled** per subscriber.
- [ ] Notes can be attached to any subscriber, user, package, IP pool or NAS.

## 5. Reporting & visibility

- [ ] Dashboards, analytics, and reports show only the account's own subtree.
- [ ] A Franchise sees its whole downline aggregated; a Dealer sees only its own.
- [ ] Password/CNIC bulk export is **ISP-owner only** and always audit-logged.

## 6. Network & operations

- [ ] Live network, static IPs, outages, and topology are scoped to the subtree.
- [ ] Only the ISP manages NAS/routers, IP pools, and platform settings
      (ISP-only write floor).

## 7. Permissions & security

- [ ] Access is enforced server-side on every request, not just in the UI.
- [ ] A parent can **deny** specific capabilities to an individual child user.
- [ ] Auditors are read-only everywhere: every non-GET request is refused.
- [ ] If a dealer ever sees data outside its subtree, treat it as a bug.

## 8. Money-integrity controls (ISP owner)

- [ ] Refunds (full/partial) post offsetting entries and claw back commission.
- [ ] Large staff refunds can require **ISP approval** above a set threshold.
- [ ] The **accounting period** can be locked to block backdating into a closed month.
- [ ] Bulk/long work runs through the durable **background job queue**.

---

### Quick tier matrix

| Capability | ISP | Franchise | Dealer | Retailer | Staff | Auditor |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Create tier below | ✅ | ✅ | ✅ | — | — | — |
| Create staff | ✅ | ✅ | ✅ | ✅ | — | — |
| Own wallet | ✅ | ✅ | ✅ | ✅ | — | — |
| Set sell prices | ✅ | if granted | if granted | if granted | — | — |
| Edit package catalogue | ✅ | — | — | — | — | — |
| Manage NAS / pools / settings | ✅ | — | — | — | — | — |
| Refund / period lock / approvals | ✅ | — | — | — | — | 👁 view |
| Read-only everywhere | — | — | — | — | — | ✅ |

✅ = allowed · — = not allowed · 👁 = can view, cannot act
