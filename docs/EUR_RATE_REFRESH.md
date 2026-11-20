# AbanTether exchange rates for checkout

The website reads EUR from the active AbanTether EURIRT market and uses the
active USDTIRT market as the basis for USD-denominated provider prices.
The direct USD ticker was checked from Production and returned HTTP 404.
USD and USDT are distinct currencies. This is the retail pricing policy for
USD offers, with the USDT source explicitly recorded in the price snapshot.

## Refresh and validity

- EUR refreshes every 30 minutes. USDT refreshes at half of its configured TTL,
  capped at 30 minutes. The existing BullMQ FX queue runs one scheduler per market.
- AbanTether requests always use verified direct HTTPS. Each response must identify the
  requested, active market and include a positive bounded decimal buy price.
  The ticker reports toman. Multiplication by ten yields rial with six FX decimals.
- A missing or expired observation triggers a refresh on read. A short per-market
  PostgreSQL lease coalesces requests across API and Worker processes. HTTP runs
  outside the transaction. The observed rate and audit are committed together.
- A transient transport failure, HTTP 429 or HTTP 5xx gets one bounded retry.
  The worker uses exponential backoff. Other failed attempts have a short cooldown
  to prevent overlapping retries from overwhelming the source.
- EUR quotes use observations less than 24 hours old. USDT uses its configured TTL.
  New EUR and USD/USDT purchases use market observations. Rates entered through the
  existing manual admin route retain their existing role for historical EUR renewal.
  A new quote expires by the FX deadline and keeps the FX row, source and time.
  Paid invoices and the historical renewal rules retain their recorded evidence.

## Diagnosis and operational checks

The admin finance screen shows the latest source, rate, time, freshness deadline
and sanitized failure category for each market. A missing or expired rate during
refresh raises a critical in-app notification for active superadmins. Near-expiry
and consecutive failures raise warnings. Recovery clears the incident state.
Sanitized EUR and USDT failure events also appear in the system log.

On 2026-11-20 UTC, the deployed API container returned valid active EURIRT and
USDTIRT responses over direct TLS. The EUR history and audit showed half-hourly
success, while USDT had no dedicated scheduler. The live admin catalog error
was reproduced under a read-only DB connection. Leaseweb is hidden from normal
sales but visible to admins, and its GBP rate was expired. That single missing
rate caused the deployed admin storefront to reject otherwise valid EUR offers.
Partial catalog results now retain independently priced offers and report the
providers with temporarily unavailable prices.

After deployment, verify the worker has both schedules, that new EUR and USDT
observations and audits appear, and that the admin and regular storefronts
provide offers with current pricing even if an independent provider is blocked.
Confirm checkout recovery without submitting a real purchase.
