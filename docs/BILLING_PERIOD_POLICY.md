# Hourly/monthly retail policy (#94)

New catalog offers, quote API, server-create API and accepted-order validation permit only HOURLY/MONTHLY. Historical DAILY rows, provider contracts, paid time, invoices and ledger records are not rewritten. Legacy daily renewals retain their stored amount/24-hour cadence; there is no automatic conversion or consolidation migration.

## Authoritative amounts

Both comparison prices come from native provider billing options through the same backend retail engine. No daily-to-monthly multiplier is manufactured. Missing native periods show unavailable. The wizard shows both prices at period choice, on each plan and final review; current comparison prices in server details are separate from the paid period's amount. Public tariffs already use both native prices. Both required Persian hourly/monthly explanations are shown before checkout and in final review.

Provider currency decimals, fractional cents, FX, four-decimal markup and tax remain scaled BigInt rational values until the final ledger conversion. The supported unit is **one IRR**: positive fractions below one IRR are discarded deterministically. Subtotal is floored at IRR for invoice allocation; tax is the exact total minus that subtotal, preserving total = subtotal + tax. Existing `roundingToRial` is a cosmetic legacy rule and does **not** affect new debits, invoices or quotes. Customer DTOs expose exact `amountRial` and toman with one decimal. There is no additional display rounding.

## Accepted prepaid periods

The first prepaid hour/month uses the explicitly accepted quote. Hourly quotes expire no later than the next UTC clock-hour boundary and cannot be paid later using an expired quote. New orders reject historical daily quotes. Provider activation atomically creates subscription start/end and adds those dates to the accepted invoice snapshot. Provider delays never cause a second speculative debit of that first accepted period.

A paid monthly period never reprices when FX changes. One month means a **UTC calendar month**, same time of day, clamped to the destination month's last day (Jan 31 → Feb 28/29). The next period starts at actual settlement if overdue; active hourly renewals keep their scheduled boundary. UTC avoids DST/local-time ambiguity. Each following month clamps from its own accepted start date. Confirmed resize retains the paid HOURLY/MONTHLY amount and its invoice; the confirmed resize quote becomes the next period's cost basis.

## Hourly renewal and retries

The worker locks user/subscription and reuses an existing open renewal invoice before calculating another amount. A new invoice computes from the accepted native provider cost basis (or latest authoritatively confirmed resize quote), approved retail rules and FX history valid in that UTC billing hour. It records FX row ID/source/time, provider cost/currency, rules, exact subtotal/tax/total, calculation time, precision and final settled start/end. A settled invoice is immutable. Wallet debit, invoice item, renewal attempt and subscription paid amount use **invoice.totalRial**, with ledger idempotency `renewal:<invoice UUID>`.

For a delayed hourly posting, FX cannot come from a later UTC hour. The cutoff is the earlier of current time and the end of the scheduled UTC hour; select the newest eligible approved FX history row. No future-dated FX row is active. USDT/USD validity uses `USDT_RATE_MAX_AGE_SECONDS` (existing default 300s); operator-set other currency rates are explicitly valid for at most 24 hours. There must be a valid historical rate and rules not modified after that historical cutoff. Missing/stale inputs fail closed before a new debit/invoice; operators must resolve the blocked historical input, not fabricate a rate or rewrite settled charges. The next attempted new hour is repriced; an already issued invoice keeps its original snapshot even if prices change before retry.

Funding eligibility and the 72-hour warning/7-day new-server checks use current authoritative estimates or an existing fixed open invoice, across all servers paid from that wallet. These are **estimates at current rates, not a guaranteed seven-day hourly price**. They do not reserve or debit money. Existing locks, terminal/deletion guards, grace, confirmed shutdown and ledger idempotency remain in force. No live wallet changes or provider orders are part of development/CI.

## Validation

`exact-billing.test.ts` covers decimal precision, cosmetic-rule independence, month-end/leap-year/DST boundaries and legacy daily intervals. `retail-billing.test.ts` covers concurrent hourly charging, fresh FX changes, immutable paid monthly periods and invoices, retries, missing FX and blocked new daily orders. Existing funding/insufficient balance, provisioning, deletion and resize tests remain enabled. PostgreSQL integration tests must run only in an isolated ephemeral test database; `test/helpers.ts` truncates its configured database.
