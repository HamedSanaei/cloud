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
  × FX rate (native currency → IRR; USD = USDT → IRR)
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

### Dollar/Tether pricing

- USD and USDT are pegged **1:1** for pricing only. Both resolve the canonical
  `USDT → IRR` history; historical fiat `USD → IRR` rows are not used.
- The public AbanTether `USDTIRT.buy_price` quote is in **toman** and is multiplied
  by **10** to obtain rials. Decimal scaling preserves sub-cent provider prices.
- `USDT_RATE_API_BASE_URL` defaults to `https://api.abantether.com`;
  `USDT_RATE_MAX_AGE_SECONDS` defaults to **300**. No exchange API key is needed.
  An expired/missing quote is refreshed once per process/database concurrently.
  Missing, inactive, zero or unavailable market data refuses dollar pricing
  (`503 usdt_rate_unavailable`); there is no stale/fiat-dollar fallback.
- Admin rate/history endpoints accept `currency=USDT`; `USD` aliases that same
  pair. A manually supplied Tether rate has the same freshness lifetime.
- Wallets, debits and invoices remain integer IRR in the existing ledger and
  **toman in the customer interface**. No dollar wallet or historical unit
  migration is introduced; accepted quote snapshots are unchanged.


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
- Hourly funding protection runs before and after renewal. It compares each
  **payment wallet** with the sum of one hour of its active hourly servers,
  including queued starts. Strictly less than that amount, including zero,
  persists a billing block and queues a real provider `power_off`; exactly one
  aggregate hour is sufficient. Unrelated wallets cannot subsidize this wallet.
- Automatic shutdown does not wait for grace expiry and does not fake an off
  state in the database. Provider status reads confirm the physical state;
  accepted asynchronous commands remain pending until their state is observed.
- Confirmed-off hourly subscriptions pause renewal charges. A funded manual
  start resumes renewal; existing unexpired paid time is retained.
- Daily/monthly prepaid periods keep their normal boundary and
  `RENEWAL_GRACE_DAYS` policy. Grace expiry also queues a provider shutdown
  instead of only changing the internal server status.

## Power controls and low-balance warnings

- Server list/detail DTOs expose `power.canPowerOn`, `canPowerOff`, `canReboot`,
  `billingBlocked`, `requiredBalanceToman` and `pendingAction`.
- The panel removes power-on while hourly funding is insufficient and restores
  it after enough credit reaches the payment wallet. The API and worker both
  recheck funds; reboot cannot bypass the restriction. Top-up never
  automatically starts a stopped VM or revives a rejected old start request.
- Server controls refresh every 30 seconds, on window focus and after actions.
  In-flight/unknown commands prevent conflicting power actions. New power
  cycles use new operations rather than reusing an old succeeded command.
- The minute-level sweep forecasts the next **72 hours** per payment wallet
  from all active servers' actual renewal dates and the hourly safety reserve.
  Daily/monthly prepaid time is respected. A shortage strictly before that
  horizon creates one warning per user, repeated no more than every **6 hours**.
- The warning includes affected server names, shortage timing, a toman top-up
  estimate, shutdown/deletion risk and a wallet link. Delivery is the existing
  **panel notifications** channel (`GET /api/notifications`, including body/type);
  no SMS/email/Telegram delivery or automatic deletion is implied.
- `users.low_balance_warned_at` persists the cooldown across workers/restarts.
  The user lock and conditional timestamp update prevent concurrent duplicates;
  reading notifications or topping up does not reset that cooldown.
- The notification bell refreshes every minute, on focus and when opened.
  Messages and the top-up link remain accessible on narrow mobile screens.

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