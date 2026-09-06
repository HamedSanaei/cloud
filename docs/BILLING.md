# Billing, Wallet & Subscriptions

## Money strategy (deliberate)

| Currency context | Storage                                  | Display              |
| ---------------- | ---------------------------------------- | -------------------- |
| Customer ledger  | **integer rials** (IRR) in `*_rial` columns | تومان = rials / 10 (truncation, display only) |
| Provider prices  | **integer cents** in provider currency (`provider_amount_cents` + `provider_currency`) | – |

Rules:

- **Never use floating point for money.** All conversions go through
  `src/lib/money.ts` (BigInt-based exact math: `applyRateDivisor`,
  `percentOf`, `roundTo`, `toCents`).
- Prices are always computed server-side from stored offers + pricing rules.
  The browser never sends amounts.
- Every order/invoice keeps a **price snapshot** (provider amount, FX rate,
  markup, tax). Later FX changes never mutate past orders.

## Pricing engine

`src/modules/pricing/service.ts`:

```
provider_base_cost (cents)
  × FX rate (EUR → IRR, decimal string, admin-set)
  + fixed markup (rials)
  + percent markup
  + tax percent
  → round to unit (default 1,000 rials)
```

- FX rates live in `fx_rates` (append-only history; latest per pair is
  active). `POST /api/v1/admin/fx-rates`.
- Pricing rules per provider in `pricing_rules`. `PUT /api/v1/admin/pricing`.
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

## Subscriptions & renewal (MONTHLY)

- Every provisioned server gets a MONTHLY subscription at the order's paid
  price (`subscriptions.price_rial`, `billing_interval = 'MONTHLY'`).
  The schema already supports quarterly/semiannual/annual later.
- `handleRenewalSweep` (worker, every 30 min, row-locked so two workers can't
  double-invoice):
  1. finds subscriptions due within `RENEWAL_LOOKAHEAD_DAYS` (default 3),
  2. generates an open invoice + renewal attempt,
  3. if `auto_renew` (default), debits the default wallet idempotently
     (`renewal:<invoice_id>`) and extends the period; on success marks the
     invoice paid,
  4. on insufficient funds: renewal attempt `insufficient_funds`, invoice
     stays open, subscription enters grace (`RENEWAL_GRACE_DAYS`, default 3),
     user notified,
  5. after grace expiry the subscription is suspended and the server marked
     `suspended`.
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