# Server checkout and datacenter sales

`/admin/datacenters` controls retail availability of Hetzner and Leaseweb using
the existing `providers.enabled` column. Only an active superadmin may change
it. Changes are transactional, idempotent and recorded as
`provider.sales_changed` with the provider ID and before/after flags in audit
metadata. Catalog synchronization preserves this choice.

Disabling sales hides the datacenter from the public landing and customer
storefront, including when an administrator opens the customer wizard. The wizard
revalidates restored selections, and the API rejects stale customer checkout.
The authenticated admin catalog preview uses `?adminPreview=true`. Existing
operator tools can still buy where the provider's runtime ordering policy permits.
Provider registration, provisioning capability, credentials,
runtime ordering switches, product approval/availability and catalog freshness
remain mandatory. Existing servers and their renewals are unaffected.

## Minimum wallet coverage for new servers

In site mode, **Super Admin → Settings → Finance** saves the creation coverage
policy in `billing.minimum_creation_coverage_days` (1–30 whole days, default 7).
The effective value is read from PostgreSQL, returned by the storefront, and
audited with the previous and new values. The payment wallet must cover:

- Hourly: configured days × 24 × the frozen per-hour quote total.
- Daily: configured days × the frozen per-day quote total for historical
  daily billing commitments.
- Monthly: the full prepaid monthly quote total.

Existing paid/queued/provisioning/ambiguous orders and active server renewals
falling within the configured horizon are included for the **same payment wallet**.
For already-paid orders, only uncharged periods count toward the commitment.
The check runs under that wallet's row lock, before any order/invoice/debit or
provisioning enqueue. Failed checkout rolls back, leaving no purchase or charge.
Deferred payments use the same gate and persist the selected payment wallet.
This check creates no extra charge or ledger hold. Normal period billing continues,
and admin purchases use the same funding requirement.

## Issue #3

The client formerly sent `idempotencyKey` in both JSON and the request header.
The `/servers` endpoint uses a strict JSON schema, which rejected that extra
field before checking funds. The client now sends the key only in the header.

Order creation serializes equal keys with a transaction-scoped advisory lock.
Owner-checked replay happens before consuming the quote and never creates a
second order/invoice/debit. A paid replay also recovers a failed queue enqueue;
the queue job ID is derived from the order and provider-operation claims still
guard the actual provider call.

Insufficient funds is a distinct `insufficient_funds` response with integer-rial
balance, order total, required balance, shortfall and effective coverage days.
`funding_policy_changed` asks the user to review fresh terms before retrying.
Checkout renders Persian guidance, not arbitrary validation/provider messages.
Plans are sorted by the selected billing period's final retail price. Location
cards show full names and local flag assets for Hetzner countries.

The recharge action uses the existing `/wallet` route. A per-user, per-tab draft
preserves selections and the request key for two hours; returning revalidates
against current catalog and wallet data. `/wallet?returnTo=server-checkout`
offers a fixed return link (no arbitrary return URL). A payment receipt opened
in the same tab also offers that link while the user's draft is valid.

Before a site-authority checkout sends the final request, it saves the same
request key in the draft. After an interrupted response the wizard reads the
authenticated, owner-scoped receipt by that key before showing funding guidance.
Looking up the receipt does not submit an order.

For a provision operation explicitly rejected by the superadmin, **Settings →
Finance → Link refund to rejected order** accepts the order UUID and the UUID
of the completed credit adjustment. The API verifies the original purchase,
customer, payment wallet and exact posted credit, then records the relationship
in the order history. A credit can be linked once. Linking does not write a
second credit or rewrite the existing ledger entry.

Site-authority mode supports online TabaPay recharge through the website's own
ledger. See [wallet payments and support tickets](WALLET_PAYMENTS_AND_TICKETS.md)
for configuration, verification, migration and recovery. Platform-mode charging
retains its existing behavior and never mixes the two ledgers.

## Verification

- Frontend: `npm test`, `npm run lint`, `npm run build`.
- Backend: `npm test`, `npm run lint`, `npm run typecheck` with an explicitly
  isolated PostgreSQL test database and mocked providers (never production).
- Integration cases: one-rial shortage, exactly enough, simultaneous equal and
  distinct requests, cross-user replay refusal, deferred payment, active-server
  commitments, failed enqueue recovery, admin authorization, stale quote/payment
  rejection, catalog visibility and preservation of the sales switch after sync.
- Current Chrome: isolated fixture preview at
  `npm run preview:design -- --checkout` (loopback port 5175). Desktop and 390px
  mobile checkout/admin layouts, RTL button positions, no page-wide horizontal
  overflow, zero balance and wallet return were inspected. This is visual QA,
  not a real order or payment. No provider-side VPS operation was executed.

The original checkout changes required no migration. The wallet/ticket extension
requires migration 0008 as described in the linked document. PRs target staging;
merging triggers the existing deployment workflow. Creating a PR does not deploy it.
