# Customer recharge and payment integration

Cash and card payments work through Customers > Recharge, or Payments > Add record. Confirm actual receipt of funds, select the customer (including lookup by nine-digit payment ID), amount, payment date, billing month and method, then save. Administrator, Manager and Accountant can record payments. Other roles cannot activate customers through this payment flow.

Receipts for the current Pakistan billing month are accumulated against the customer monthly fee. At full payment the CRM customer becomes Active and expiry extends 30 days from the later of today and existing expiry. Renewal occurs once per customer/billing month. Partial payments are saved without premature activation. Zero-fee accounts need manual review. Past/future billing months are saved without automatic activation. Existing historical receipts are not replayed on deployment. Completed recharge receipts cannot be edited or deleted, preserving the payment and activation history. Provider receipts are immutable even before full recharge.

This currently activates the CRM customer record only. There is no router, PPPoE or RADIUS provisioning integration. Refund/reversal workflows and automatic expiry suspension are outside this change.

## Native merchant integration status

The user has 1LINK, Easypaisa and JazzCash merchant accounts and will provide onboarding documents later. Native adapters, provider credentials, sandbox/live selection and the externally reachable callback address remain pending. No live payment collection or merchant connectivity is claimed by this implementation.

## Trusted internal receipt bridge

POST `/api/payments/incoming` is an internal adapter contract, not a replacement for any provider-native API. An adapter must first verify the transaction with the merchant provider (authenticity, merchant, currency PKR, paid amount, customer reference and settled/successful payment state). It must send only confirmed receipts to this endpoint. Never expose a bridge signing secret to customers or frontend JavaScript.

The endpoint is disabled per provider unless a separate server environment secret of at least 32 characters is configured:

- 1LINK: `CRM_1LINK_BRIDGE_SECRET`
- Easypaisa: `CRM_EASYPAISA_BRIDGE_SECRET`
- JazzCash: `CRM_JAZZCASH_BRIDGE_SECRET`

These are dedicated adapter signing secrets, not merchant API passwords. Do not set them until a verified provider adapter is installed. They are not included in this repository.

Send JSON with `payment_id` (nine-digit customer ID string), `transaction_id` (unique provider transaction string), `amount` (PKR decimal), `status` (`paid`) and `paid_at` (ISO timestamp including timezone). Billing month is derived from paid_at in Asia/Karachi. Delayed receipts for prior months are saved but do not trigger current-month activation.

Headers:

- `X-CRM-Payment-Provider`: exactly `1LINK`, `Easypaisa` or `JazzCash`
- `X-CRM-Payment-Timestamp`: current Unix epoch seconds
- `X-CRM-Payment-Signature`: lowercase hex HMAC-SHA256 over the bytes `timestamp + "." + provider + "." + raw_request_body`, signed with that provider's bridge secret

Signatures expire after five minutes and reject timestamps more than 30 seconds ahead. TLS is required when exposing an adapter connection outside the local machine. The CRM currently binds localhost; external reachability/hosting is not set up by this change.

Transaction IDs produce stable receipt keys per provider. Exact delivery retries return the existing receipt without another payment or renewal. Reusing a transaction ID with different details is rejected. Payment insertion, customer activation, expiry and recharge audit are committed atomically. Customer locks serialize concurrent partial payments; monthly recharge uniqueness provides a second safeguard. Failed requests roll back and may be retried with the same transaction ID. Pending/failed notifications must not be sent as paid receipts.

Cash/card entry is manual. Online provider method names are reserved for verified adapter receipts, so a normal CRM request cannot impersonate an online confirmation.


## Permanent payment receipts

All confirmed receipts, including partial payments and cash/card entries, create a payment_receipts snapshot atomically. The snapshot is linked to both the customer payment ID and the payment record ID. GET /api/receipts/{payment_record_id} requires sign-in and Payments read permission. /receipt?id={payment_record_id} displays the snapshot for printing or browser Save as PDF. Existing payments are backfilled at migration with an imported/historical flag; their customer details reflect migration time. Saved receipts and associated payments are immutable through normal CRM operations. If receipt saving fails, the payment, recharge ledger entry, status change and expiry change all roll back together. Payment reversal/correction remains a separate future workflow.


Partial activation: Administrator, Manager and Accountant can choose "Activate now and carry unpaid amount to next bill" while recording a partial payment. The default keeps account status unchanged until the full due amount is paid. Full payment of the current monthly subscription plus prior unpaid invoiced balance automatically activates the customer. Approved partial activation renews expiry once, records the approving user and unpaid amount in recharge history, and preserves the decision on the payment receipt. The current invoice is saved when processing a current-month recharge so the debt is retained even when the operator never opened Print invoice. Later payments settle the balance without another renewal in the same month.

Invoices now show monthly charge, previous unpaid balance and total bill separately. Previous unpaid balance is calculated from earlier monthly charges minus receipts matched to those invoiced months, so settlements after printing also reduce future bill arrears. Carried amounts are not added again to monthly subscription charges or global invoice totals. For example: Rs 2,000 due, Rs 800 paid and partial activation approved leaves Rs 1,200 unpaid; the next Rs 2,000 bill shows Rs 3,200 total. Paying Rs 3,200 settles the debt and the following monthly bill returns to Rs 2,000. Uninvoiced months are not automatically charged as arrears.
