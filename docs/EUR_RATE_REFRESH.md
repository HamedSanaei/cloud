# Automated EUR pricing — issue #101

Owner-approved source and cadence: AbanTether's `EUR` market, every 30 minutes,
always direct. No USD/USDT substitution or proxy fallback is permitted for EUR.

## Source and money

- GET `https://api.abantether.com/api/v1/manager/otc/ticker?coin=EUR`.
- Require `data.markets.EURIRT`, symbol exactly `EUR`, active=true, and a positive,
  bounded decimal `buy_price`. This is the same buy/ask convention as existing
  USDT pricing. The published IRT price is **toman**, converted to IRR by ×10.
- Conversion uses integer arithmetic with the existing six-decimal FX precision;
  only excess precision rounds upwards. No floating-point marketing price,
  guessed rate, EURT, fiat-dollar or USDT substitute is inserted.
- One genuine observation appends one EUR→IRR history row plus an atomic audit
  entry `pricing.fx_rate.refreshed`, including source and conversion. `createdAt`
  is the local observation time; the ticker provides no exchange timestamp.
- Existing retail pricing, exact IRR ledger debits, future hourly pricing and
  paid-month snapshots remain unchanged. Historical hourly renewal selects the
  actual historical FX row; a new observation never backfills a missed hour.

## Scheduling, failures and recovery

The canonical website Worker upserts the single BullMQ scheduler
`eur-fx-refresh` on queue `pricing.eur-refresh`, every 1800000 ms. Its first
background run is 30 minutes after registration. Existing worker readiness,
maintenance/backup writer gate and shutdown behavior also cover this queue.
Platform-authority mode still leaves financial/provider jobs to its authority.
No new secret, environment variable, migration or external cron is required.

API reads can recover a missing or expired EUR rate immediately without waiting
for the first background tick. In-process single-flight plus a PostgreSQL
transaction advisory lock serialize API/Worker refreshes. The transaction
rechecks recent observations; a one-minute coalescing window prevents duplicate
observations from concurrent processes/retries without skipping the next
half-hour tick because of HTTP latency. No existing row is retimestamped.

Requests have a ten-second deadline, no cache and no redirects. Invalid data,
inactive/wrong markets, zero/negative/overflow prices, network/TLS/HTTP errors
produce no new FX row. Background jobs retry three times with exponential
one-minute backoff; sanitized error events (`pricing.eur_refresh_failed`,
`job.failed`) appear in the existing admin system logs before the old rate
expires. No raw provider response or credentials are logged.

The existing **24-hour EUR maximum age is retained**, not extended: during a
temporary source outage an existing still-valid observation remains usable with
its original timestamp. Missing/expired EUR with a failed fresh fetch refuses
pricing with `eur_rate_unavailable` (503), and the public price page explains
unavailability. Future-dated rows are excluded. Recovery appends a real observed
rate; it does not modify customer balances or previously paid invoices.

## Direct-only network policy

All `abantether` HTTP traffic, including existing USDT requests, uses the explicit
direct Undici Agent with public-DNS validation and certificate verification.
Saved proxy assignments, HTTP(S)/ALL_PROXY environment settings and unreadable
encrypted proxy settings cannot route it through a proxy. Backend validation
rejects new AbanTether proxy assignments and proxy-profile diagnostics; the admin
card exposes only a direct connection test. Legacy saved routes are ignored,
without rewriting encrypted settings or credentials. Other services retain
their existing proxy policies and fail-closed behavior.

The existing `USDT_RATE_API_BASE_URL` is reused for the common AbanTether API
origin; no production env edit is needed. The production destination policy
continues to allow only the exact fixed HTTPS authority, never arbitrary URLs.

## Verification and release

On 2026-11-18, a read-only direct request from the production host
`213.177.178.82` (`curl --noproxy '*'`, normal SSL verification) successfully
returned an active `EURIRT` market with decimal `buy_price`. No production FX,
wallet, provider resource or configuration was changed during that check.

Regression coverage includes exact conversion, concurrent API/Worker clients,
history/audit uniqueness, half-hour refresh, failed fetch/recovery, invalid or
future data, no USDT substitution, restored public retail/SSR prices, and the
direct-only route/diagnostic/UI policy. Existing renewal/funding/monthly snapshot
tests run unchanged. DB integration runs only against disposable CI databases.

After approved publication, verify Worker readiness and the single scheduler,
then the EUR history/audit source/time and another genuine observation after
30 minutes. Check `/api/public/home-prices` and initial homepage/Hetzner HTML
against the authoritative retail quote without submitting an order. Review
admin logs on failure. Do not claim live restoration solely from PR CI.

Rollback uses the prior API/Worker image pair through the normal deployment
process, leaving genuine FX history and customer financial records intact.
The old worker has no processor for this new queue, so remove only its
`eur-fx-refresh` scheduler under rollback authorization to avoid pending jobs;
never clear other queues or delete data/history. No DB migration reversal is needed.
