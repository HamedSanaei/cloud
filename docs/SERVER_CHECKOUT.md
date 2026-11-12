# Server checkout and datacenter sales

`/admin/datacenters` controls retail availability of Hetzner and Leaseweb using
the existing `providers.enabled` column. Only an authenticated, active website
admin may change it. Changes are transactional, idempotent and recorded as
`provider.sales_changed` with the provider ID and before/after flags in audit
metadata. Catalog synchronization preserves this choice.

Disabling sales hides the datacenter from the public/user storefront and blocks
new quotes, stale-quote checkout and deferred order payments. An active admin
can still purchase. Provider registration, provisioning capability, credentials,
runtime ordering switches, product approval/availability and catalog freshness
remain mandatory. Existing servers and their renewals are unaffected.

## Seven-day funding gate

The payment wallet must cover the new server for at least seven days:

- Hourly: 168 times the frozen per-hour quote total.
- Daily: 7 times the frozen per-day quote total.
- Monthly: the full prepaid monthly quote total.

Existing paid/queued/provisioning/ambiguous orders and active server renewals
falling within the next seven days are included for the **same payment wallet**.
The check runs under that wallet's row lock, before any order/invoice/debit or
provisioning enqueue. Failed checkout rolls back, leaving no purchase or charge.
Deferred payments use the same gate and persist the selected payment wallet.
No additional seven-day charge or ledger hold is created; normal period billing
continues unchanged. Admin purchases follow the same funding requirement.

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
balance, order total, required balance, shortfall and seven-day coverage fields.
Checkout renders Persian guidance, not arbitrary validation/provider messages.
Plans are sorted by the selected billing period's final retail price. Location
cards show full names and local flag assets for Hetzner countries.

The recharge action uses the existing `/wallet` route. A per-user, per-tab draft
preserves selections and the request key for two hours; returning revalidates
against current catalog and wallet data. `/wallet?returnTo=server-checkout`
offers a fixed return link (no arbitrary return URL).

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
