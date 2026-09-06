# Leaseweb Provider Integration

Leaseweb is the **first** provider behind the platform's `CloudProvider`
abstraction (see `backend/src/modules/providers/provider.interface.ts`).
The platform's customers never talk to Leaseweb directly:

```
Customer → Cloud platform (order → wallet → invoice → provisioning) → Leaseweb API
```

## Official sources

- Product: https://www.leaseweb.com/en/products-services/cloud/virtual-private-server
- Developer portal: https://developer.leaseweb.com/
- API base: `https://api.leaseweb.com`
- VPS ordering API docs: https://kb.leaseweb.com/kb/leaseweb-vps/ordering-api-for-vps/

Authentication is the `X-LSW-Auth: {LEASEWEB_API_KEY}` header. The key is
tied to a sales organization: **products and locations returned by the API
depend on the account**. The catalog is therefore always synced from what the
API actually returns — nothing is hardcoded as permanent truth.

## Account requirements

The official Ordering API requires an eligible, verified Leaseweb customer:

- completed KYC,
- correct Sales Organization,
- API ordering permission,
- invoice / non-prepayment eligibility.

Without these, order calls fail with provider errors and the operation is
recorded as a permanent failure — the platform never pretends an offer exists.

## Configuration

| Env var                     | Default                  | Meaning                                      |
| --------------------------- | ------------------------ | -------------------------------------------- |
| `LEASEWEB_MODE`             | `mock`                   | `mock` (safe) or `live`                      |
| `LEASEWEB_API_BASE_URL`     | `https://api.leaseweb.com` | API base URL                               |
| `LEASEWEB_API_KEY`          | *(empty)*                | Live API key (never committed, never logged) |
| `LEASEWEB_ORDERING_ENABLED` | `false`                  | Must be `true` to place real paid orders     |

Live ordering requires **both** `LEASEWEB_MODE=live` **and**
`LEASEWEB_ORDERING_ENABLED=true`. Catalog reads may work in live mode while
ordering stays disabled.

## Modes

### mock (default)

`MockLeasewebProvider` (`src/modules/providers/leaseweb/mock.ts`) simulates
the Ordering API and VPS management in memory:

- realistic catalog fixtures (2–8 vCPU, NVMe, IPv4/IPv6, monthly options),
- provisioning creates deterministic VPS records,
- test hooks simulate retryable failures, permanent rejections and the
  dangerous **timeout-after-dispatch** case (server exists at provider, our
  response was lost) so reconciliation can be exercised without money.

CI always runs in mock mode — **no test command can place a real order.**

### live

`LiveLeasewebProvider` (`src/modules/providers/leaseweb/live.ts`) uses
`LeasewebClient` (`src/modules/providers/leaseweb/client.ts`) — a centralized
typed client with timeouts, correlation IDs (`X-Correlation-Id`), structured
error mapping (retryable vs permanent vs unknown) and strict log redaction of
the API key.

Implemented against the official endpoints:

- `GET /ordering/v1/products/vps` — list VPS products (per location)
- `GET /ordering/v1/products/vps/{vpsId}?location=...` — product details,
  billing cycles, contract terms, OS options (the source of allowed values —
  **never guess enums**)
- `POST /ordering/v1/products/vps/{vpsId}/order` — place order
- VPS management APIs for list/get/power/reboot (capability-checked)

## Ordering workflow (safe)

1. Catalog sync snapshots the provider's offers into normalized tables.
2. A customer quote freezes the provider price + FX + markup snapshot.
3. Paid order → `provision` job → provider operation row (unique business
   key) **before** any provider call → provider order.
4. Provider order/VPS IDs are stored in `provider_order_id` /
   `provider_server_id` columns — never used as our business IDs.
5. `UNKNOWN` results (network failure after dispatch) are **never**
   re-ordered or refunded automatically; the operation is reconciled against
   provider inventory.

## Catalog sync

`POST /api/v1/admin/providers/leaseweb/catalog/sync` (admin) or the
`catalog.sync` job. Sync results land in `providers`,
`provider_locations`, `provider_products` (+ raw response in JSONB for
auditing). Billing options (`billingCycle`, `contractTerm`) are consumed from
the API response; monthly plans are exposed only where the API/account allows
them, otherwise a clear availability reason is returned.

## Reconciliation (safety contract)

`handleReconcile` (worker) asks the provider through `reconcileOrder()`, which
returns one of:

- `MATCHED` — the provider supplied **conclusive** evidence linking the
  external resource to THIS internal operation. Today this only happens when
  a provider-issued id was captured from the original order response BEFORE
  the ambiguity and is then verified to exist at the provider
  (`/vps/v1/virtualServers/{id}`). Safe to attach.
- `NO_MATCH` — exact-id lookup proves the resource does not exist.
- `AMBIGUOUS` — ownership cannot be proven. Candidate evidence
  (server ids, hostnames, timestamps) is recorded on the operation for the
  operator, but **nothing is attached automatically**.
- `UNSUPPORTED` — the provider cannot answer.

### Hostname matching is NOT ownership proof

A discovered Leaseweb VPS is **never** automatically attached to an UNKNOWN
order based on:

- hostname (identical or similar),
- same product family / VPS size / location / price / currency,
- same billing cycle / contract term,
- “there is only one candidate in the account”,
- “a VPS appeared around the same timestamp”.

All of these may be presented to an operator as **reconciliation evidence**
(`candidateProviderServerIds`, `candidateHostnames`, `candidateCreatedAt`,
with `automaticAttachmentRefused: true`), but the operation stays `UNKNOWN`
and the order stays `requires_review` until a human decides.

### Leaseweb order safety

Leaseweb VPS Ordering does not currently provide a client-side idempotency
identity sufficient for safe automatic recovery after ambiguous POST results.
Therefore:

- the internal provider-operation ledger (unique `business_key`) prevents our
  own duplicate worker execution — **execution idempotency**;
- a fresh checkout always represents a fresh provider purchase — provider
  account inventory is never used as get-before-create dedup;
- an UNKNOWN order outcome is never automatically re-POSTed;
- heuristic candidate matching never auto-attaches;
- ambiguous outcomes require operator review.

**Execution idempotency ≠ provider-side order idempotency.** The former
protects against our own bugs (two workers, retries, double clicks); the
latter — the provider being able to recognize a re-sent request — does not
exist yet for Leaseweb VPS ordering, so every dispatch of an order POST is
potentially a new purchase.

### UNKNOWN POST outcome handling

For the mutating order POST (`postMutating` in `leaseweb/client.ts`):

| Outcome                                             | Classification      | Action                                    |
| --------------------------------------------------- | ------------------- | ----------------------------------------- |
| HTTP 2xx with order id                              | success             | attach, order active                      |
| HTTP 4xx validation/authorization                   | definitive rejection| permanent failure (no retry)              |
| HTTP 429 on the mutating endpoint                   | **unknown**         | no retry → review + reconcile             |
| HTTP 5xx                                            | **unknown**         | no retry → review + reconcile             |
| read timeout / connection drop / protocol error     | **unknown**         | no retry → review + reconcile             |
| refused before transmission (e.g. DNS / ECONNREFUSED when provably pre-send) | retryable (job-level, guarded) | bounded retry with backoff |

GET requests keep normal safe retry semantics (5xx/429 retryable) — they
cannot create resources.

### Correlation IDs

- Outbound: every request carries `X-Correlation-Id` (client-generated).
- Inbound: Leaseweb's `APIGW-CORRELATION-ID` response header is captured and
  persisted on the provider operation (`provider_correlation_id`), together
  with the client request id (`provider_request_id`) and the operation's
  `response_metadata` (status, error category, timestamps). The correlation
  id is also written to logs. This gives Leaseweb support a concrete
  identifier during UNKNOWN-order investigations.

### Manual reconciliation

Admin endpoints (audited):

- `POST /admin/provider-operations/:id/mark-match` — operator explicitly
  confirms the external provider server id (`providerServerId` required);
  completes the order deterministically.
- `POST /admin/provider-operations/:id/mark-rejected` — operator confirms no
  server was created; the order fails. Wallet funds are NOT touched
  automatically; refund is a separate explicit admin action.
- `POST /admin/provider-operations/:id/reopen-for-retry` — reopens only a
  proven-`failed` (non-permanent) operation. **UNKNOWN operations can never
  be reopened for retry** — the original POST may have been processed.
- `POST /admin/provider-operations/:id/retry` — same guard: refuses `unknown`.

### Financial state during UNKNOWN

The wallet is debited at purchase time (in the same transaction as the
order/invoice). During an UNKNOWN outcome the funds stay captured:

- no automatic refund (we cannot prove creation failed),
- no second charge (single order, single idempotent debit),
- no subscription activation from a heuristic candidate,
- manual `mark-match` keeps the purchase (server delivered),
- `mark-rejected` + an explicit admin refund releases the funds exactly once
  (idempotent ledger key), if the operator determines no server was created.

## Testing without purchasing

```bash
# everything below runs entirely in mock mode
docker compose -f docker-compose.dev.yml up -d
cd backend && npm ci && npm run db:migrate && npm run seed
npm run dev          # terminal 1
npm run dev:worker   # terminal 2

curl http://localhost:8000/api/health/ready
# register/login, then:
curl http://localhost:8000/api/v1/catalog/vps
```

The integration suite (`backend/test/integration/provisioning.test.ts`)
covers double-order prevention, retryable/permanent failures and
UNKNOWN→reconciliation — all against the mock provider.

## Troubleshooting

- **Catalog empty** — sync must run first (admin endpoint or seed).
- **`provider_permanent_error` on order** — account/eligibility issue at
  Leaseweb; inspect the provider operation via the admin API
  (`GET /api/v1/admin/provider-operations`).
- **Order stuck in `requires_review`** — reconcile manually
  (`POST /api/v1/admin/provider-operations/:id/reconcile` if available) and
  check the audit trail.
- **404 on `/api/v1/catalog/vps`** — FX rate or pricing rules not configured
  (admin `POST /api/v1/admin/fx-rates`).

## Read-only live setup (account discovery)

Connect the backend to the real Leaseweb account **without placing any paid
order**. Everything here is GET-only; the paid order endpoint is guarded
locally.

Required environment (server or local shell, **never committed**):

```bash
LEASEWEB_MODE=live
LEASEWEB_API_KEY=...        # set via env / secret manager — never printed
LEASEWEB_ORDERING_ENABLED=false
```

The guard: `LiveLeasewebProvider.createServer()` throws a permanent local
safety error before any HTTP request when `LEASEWEB_ORDERING_ENABLED != true`
(verified by `backend/test/unit/leaseweb-ordering-guard.test.ts` — provider
HTTP POST count stays 0). Catalog GETs (`syncCatalog`) are allowed.

Operations CLI (`npm run leaseweb -- <command>`):

- `doctor` — connectivity/auth/catalog check (GET only), reports ordering
  guard status; never prints the API key.
- `sync-offers` — idempotent catalog sync into `provider_products` +
  diagnostics on `product_sync_runs` (monthly-eligible, missing price/billing,
  http errors). Re-running never duplicates rows; changed prices/options are
  updated in place.
- `list-monthly [--json]` — every monthly-invoicing option with the **exact
  provider** `billingCycle` / `contractTerm` values, provider base price and
  commercial classification (MONTH-TO-MONTH vs MONTHLY BILLING / LONGER
  CONTRACT — never collapsed into one "monthly").
- `price-preview [--json]` — provider EUR cost → active EUR→IRR FX → markup →
  tax → final IRR + toman (all integer math).

Retail safety:

- Newly synced offers default to `enabled=false` — catalog availability is
  **not** retail-sale approval. An admin must review price, FX, markup and
  monthly terms, then enable the offer explicitly.
- Quotes are refused when the catalog is older than `CATALOG_MAX_AGE_MINUTES`
  (default 1440); existing quotes/orders keep their frozen snapshots.
- Products that disappear from the provider are marked unavailable for new
  quotes; historical orders/invoices/servers are never deleted.

Billing cycle vs contract term — the two are independent provider values and
both are stored verbatim per offer (`billingOptions[].billingCycle` /
`contractTerm`). "Monthly invoicing" is not proof of a month-to-month
contract. Use `list-monthly --json` and confirm the actual `contractTerm`
before advertising "cancellable monthly".

The real account returns values only for **our** sales organization/account —
no plan price or enum is hardcoded anywhere.

## Billing classification contract

Every stored billing option carries a central-classifier verdict
(`backend/src/modules/providers/billing.ts`) — applied at catalog sync, for
mock and live alike. The classifier NEVER looks at a `monthly` flag: the
legacy mock-only `monthly: true` field was removed and is not evidence.
Classification is derived only from the exact provider-returned values.

Categories:

- `MONTH_TO_MONTH` — monthly invoicing AND ≤1-month contract commitment
  (provider-proven values only).
- `MONTHLY_BILLING_LONG_TERM_COMMITMENT` — monthly invoicing with a longer
  contract commitment (e.g. billing cycle monthly + 12-month term). NOT
  month-to-month.
- `NON_MONTHLY_BILLING` — provably not monthly invoicing.
- `UNKNOWN` — cycle or term unrecognized/unprovable; never assumed monthly.

Recognized spellings for months: numbers (`12`), `monthly`/`1M`/`1 month`,
and `NM`/`N months` term forms. Anything else → `UNKNOWN` until the operator
adds the observed provider value to the parser.

Each option records `classification`, `customerBillingInterval`
(`'MONTHLY' | null`), `monthToMonth` (`true | false | null`),
`eligibilityReason` and `source` (`leaseweb-api` for live).

### No fabricated combinations

The live adapter only exposes billing options the API **proves**: a cycle
embedding its own contract terms (proven pairings), or a priced cycle with no
term list at all (commitment unknown). An independent `billingCycles` list
plus an independent `contractTerms` list is NOT combined into a Cartesian
product — those products stay catalog-only until the real response shape is
observed and mapped in `buildBillingOptions` (`live.ts`). If the real API
uses different combination semantics, adjust that one function and keep the
classifier untouched.

## Going live (checklist)

1. Complete KYC + sales organization setup at Leaseweb.
2. Generate a read-only-scoped API key first and test catalog sync in
   `LEASEWEB_MODE=live` with `LEASEWEB_ORDERING_ENABLED=false`.
3. Verify the returned billing cycles/contract terms — especially monthly —
   match what you intend to sell.
4. Only then set `LEASEWEB_ORDERING_ENABLED=true` on the server
   (`/opt/tofan/cloud/.env`) and restart the stack.
5. Never enable it automatically, never commit the key.