# Billing, Wallet & Subscriptions

## Money strategy (deliberate)

| Currency context | Storage                                  | Display              |
| ---------------- | ---------------------------------------- | -------------------- |
| Customer ledger  | **integer rials** (IRR) in `*_rial` columns | تومان = rials / 10 (truncation, display only) |
| Provider prices  | Exact decimal currency strings; quote `provider_amount_cents` is `numeric(20,6)` for fractional cents | Provider currency is preserved |

Rules:

- **Never use floating point for money.** All conversions go through
  `src/lib/money.ts` and `src/modules/pricing/periods.ts` (scaled BigInt
  conversions, markup and rounding). Sub-cent cloud prices are not truncated.
- Prices are always computed server-side from stored offers + pricing rules.
  The browser never sends amounts.
- Every order/invoice keeps a **price snapshot** (provider amount, FX rate,
  markup, tax). Later FX changes never mutate past orders.

## Pricing engine

`src/modules/pricing/service.ts`:

```
provider_base_cost (cents)
  × FX rate (the offer's currency → IRR, decimal string, admin-set)
  + fixed markup (rials)
  + percent markup
  + tax percent
  → round to unit (default 1,000 rials)
```

- FX rates live in `fx_rates` (append-only history; latest per pair is
  active). `POST /api/v1/admin/fx-rates` accepts `{currency: "EUR" | "GBP" | ..., rate: "..."}`; `GET` filters with `?currency=GBP`. EUR remains the default for existing callers.
- Pricing rules per provider in `pricing_rules`; Leaseweb Cloud uses the `leaseweb.hourly` rule. `PUT /api/v1/admin/pricing`.
- Quotes expire after `QUOTE_TTL_MINUTES` (default 15) and are **single-use**
  (row-locked at order time).

## Wallet & ledger

- Each user has a wallet (`wallets.balance_rial`).
- **The balance is never mutated directly.** Every operation appends an
  immutable `wallet_transactions` row with `balance_before_rial`,
  `balance_after_rial`, type, reference and idempotency key.
- Debits/credits lock the wallet row (`SELECT ... FOR UPDATE`) and run in the
  same DB transaction as the order/invoice. Negative balances are impossible.
- Duplicate idempotency keys return the original transaction — a double click
  can never double-charge.
- Types: `deposit`, `purchase`, `renewal`, `refund`, `manual_credit`,
  `manual_debit`, `adjustment`.

## Orders & invoices

- `createOrderFromQuote` creates order + items + invoice + wallet debit in
  one transaction. Statuses: `draft → quoted → awaiting_payment → paid →
  queued → provisioning → active` (see BACKEND.md for the full state machine).
- Invoices carry `subtotal/tax/discount/total` in rials plus the JSON snapshot
  of the quote; states `draft/open/paid/void/refunded/overdue`.
- Unpaid orders can be paid later from any wallet
  (`POST /api/v1/orders/:id/pay`) — idempotent.

## Subscriptions & renewal (HOURLY / DAILY / MONTHLY)

- A subscription begins only after the provider reports the server running.
  Its interval is copied from the paid order, not inferred from provider invoicing.
- Hourly cloud offers support hourly retail or a daily block of exactly 24 native hours.
  The provider still receives its original hourly billing option.
- Prepaid monthly VPS offers remain monthly; no monthly price is divided into
  invented hourly/daily offers. Longer commitments are not sold as month-to-month.
- `handleRenewalSweep` runs every minute and only bills periods actually due.
  The subscription row lock, invoice creation/reuse, wallet debit and period
  advancement share one transaction. Concurrent sweeps cannot double-charge.
- Renewal uses the original order wallet (default wallet only for historical
  orders without one). An unpaid period reuses its open invoice; repeated
  insufficient-funds checks do not restart grace or spam notifications.
- On insufficient funds, the subscription enters `RENEWAL_GRACE_DAYS` of grace.
  After grace expiry it is suspended and the internal server marked `suspended`.
- **We do not invent Leaseweb lifecycle APIs.** If the provider cannot
  auto-suspend/terminate, an admin/manual intervention state is used instead
  (capability-checked via the provider abstraction).

## Idempotency

- `Idempotency-Key` header on order/payment POSTs (orders store
  `(user_id, idempotency_key)` unique).
- Wallet transactions unique `(wallet_id, idempotency_key)`.
- Provider operations unique `business_key` — one provider order per order
  even across worker retries.
- Invoices/orders unique numbers (`ORD-YYYYMM-######`, `INV-YYYYMM-######`).

## Audit

Every sensitive action (`wallet.debit/credit`, `order.created/paid`,
`provider.order.started/completed/failed`, `server.power_on`, `admin.*`) is
written to `audit_logs`. Secrets/passwords are never logged.