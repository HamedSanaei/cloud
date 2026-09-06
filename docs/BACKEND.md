# Cloud Server — Backend

Production-grade backend for the Cloud Server hosting platform. The backend is
provider-agnostic: Leaseweb is the first provider, but orders, billing,
wallets, invoices, subscriptions and server management never reference
provider-specific logic.

```
Customer browser
      │  HTTPS (Cloudflare)
      ▼
Host nginx (reverse proxy, 127.0.0.1:${CLOUD_PORT})
      │  /api/* -> cloud-api (internal Docker network)
      ▼
┌────────────────────────────────────────────────────────┐
│  cloud-api   (Fastify, port 8000 internal only)        │
│  cloud-worker (BullMQ workers, same codebase)          │
│  cloud-postgres (PostgreSQL 17, NO host port)          │
│  cloud-redis   (Redis 7, NO host port)                 │
└────────────────────────────────────────────────────────┘
```

Only `cloud-web` (nginx serving the SPA) binds to the host
(`127.0.0.1:${CLOUD_PORT}`). PostgreSQL, Redis and the API are reachable only
inside the internal Docker network.

## Stack

| Concern        | Choice                                   |
| -------------- | ---------------------------------------- |
| Runtime        | Node.js 24+, TypeScript                  |
| HTTP           | Fastify 5 (schema validation via Zod)    |
| Database       | PostgreSQL 17 + Drizzle ORM              |
| Queue          | Redis 7 + BullMQ                         |
| Passwords      | Argon2id (`argon2`)                      |
| Money          | integer rials (customer) / integer cents (provider) |
| Logging        | pino structured logs                     |
| API docs       | OpenAPI/Swagger at `/docs`               |

## Layout

```
backend/
  src/
    config.ts            env parsing (Zod), secret redaction helpers
    logger.ts            pino logger
    db/
      schema.ts          full Drizzle schema
      index.ts           pool + DbClient / DbOrTx types
      migrate.ts         explicit migration runner (backend/drizzle/*.sql)
    lib/
      errors.ts          domain errors (AppError hierarchy)
      money.ts           integer money helpers (never floats)
      idempotency.ts     idempotency-key persistence
      dto.ts             API DTO mappers (serverToDto, ticketToDto, ...)
    http/
      auth.ts            requireUser / requireAdmin from bearer or cookie
      validate.ts        Zod body/query/params parsing
    modules/
      audit/             writeAudit — every sensitive action is logged
      auth/              register/login/logout/refresh, sessions
      users/             profile endpoints
      wallets/           wallets + immutable ledger
      catalog/           provider catalog sync + normalized offers
      pricing/           FX rates + pricing rules + price engine
      quotes/            price quotes (single-use, TTL 15 min)
      orders/            order state machine + safe paid ordering
      invoices/          invoices + items, price snapshots
      subscriptions/     MONTHLY subscriptions + renewal
      servers/           internal server entity + actions
      providers/         CloudProvider interface + registry
        leaseweb/        types, HTTP client, mock + live providers, fixtures
      provisioning/      job handlers (provision, reconcile, sync, renewal)
      health/            /api/health/live + /api/health/ready
      admin/             admin endpoints (users, wallets, pricing, ops, audit)
      frontend/          /api compat routes for the current SPA layer
    jobs/
      queue.ts           BullMQ queues (cloud prefix)
      workers.ts         worker wiring
    app.ts               Fastify assembly
    index.ts             API entrypoint
    worker.ts            worker entrypoint
    scripts/seed.ts      local seed (admin, demo user, FX rate, wallet credit)
  drizzle/               committed SQL migrations
  test/                  unit + integration suites (vitest)
```

## Money model

- Customer money: **integer rials** (IRR). Display in تومان = rials / 10
  (presentation only).
- Provider money: **integer cents** in the provider currency (e.g. EUR).
- FX rates are stored as decimal strings (`620000.5`) and applied with exact
  BigInt math (`applyRateDivisor`). Never `Number` arithmetic on money.
- Every price is computed server-side from the stored offer + pricing rules.
  **The browser never sends prices.**

## Order state machine

```
draft ─► quoted ─► awaiting_payment ─► paid ─► queued ─► provisioning ─► active
           │            │               │         │            │
           ▼            ▼               ▼         ▼            ▼
        cancelled    cancelled        failed   failed      requires_review
                                                             │    │
                                          (reconcile found   │    │ (not found)
                                           server)          ▼    ▼
                                                           active  failed
all states: -> refunded / requires_review (from active/failed)
```

Transitions are enforced by `canTransition` in
`src/modules/orders/service.ts`; every transition is persisted in
`order_events`.

## Safe paid ordering (critical path)

1. Authenticated user, validated offer, valid single-use quote.
2. One DB transaction:
   - `SELECT ... FOR UPDATE` on the quote row (single-use lock),
   - create order + order items + invoice (price snapshot),
   - debit wallet exactly once (row lock + unique idempotency key),
   - mark order `paid`.
3. **Commit** — never hold the transaction during provider HTTP calls.
4. Enqueue `provision` job.
5. Worker creates the provider operation row (unique business key) *before*
   contacting Leaseweb, claims it with an atomic compare-and-set, then calls
   the provider.
6. On success: server record + subscription + order `active`.
7. On timeout-after-dispatch (or any outcome that may have been processed):
   operation → `UNKNOWN`, order → `requires_review`, reconciliation
   scheduled. **No re-order, no auto-refund, no heuristic auto-attach.**

## Reconciliation safety (P0)

An UNKNOWN provider result is only auto-resolved when the provider returns
`RecoveryResult.MATCHED` — conclusive proof (an external id captured from the
original response before the ambiguity, verified to exist at the provider).
Hostname/product/location similarity, “single candidate”, timestamps and
prices are **evidence only** (`candidateProviderServerIds`,
`candidateHostnames`, … recorded with `automaticAttachmentRefused: true`);
the operation stays under review until an operator resolves it via the admin
endpoints (`mark-match` / `mark-rejected` / `reopen-for-retry` — see
docs/LEASEWEB.md). Execution idempotency (unique `business_key`) and
provider-side order idempotency are different things; Leaseweb VPS ordering
currently provides only the former.

## Database tables

`users`, `sessions`, `audit_logs`, `wallets`, `wallet_transactions`,
`fx_rates`, `pricing_rules`, `providers`, `provider_locations`,
`provider_products`, `product_sync_runs`, `quotes`, `orders`, `order_items`,
`order_events`, `invoices`, `invoice_items`, `subscriptions`,
`subscription_events`, `renewal_attempts`, `servers`, `provider_operations`,
`idempotency_keys`, `notifications`, `tickets`, `charge_requests`.

Key uniqueness constraints:

- `(provider, provider_server_id)` on servers
- `business_key` on provider_operations (one provider order per order, ever)
- `(wallet_id, idempotency_key)` on wallet_transactions
- `invoice_number`, `order_number`
- `(user_id, idempotency_key)` on orders

## Running locally

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres + Redis on 127.0.0.1
cd backend
cp .env.example .env                            # adjust if needed
npm ci
npm run db:migrate
npm run seed                                    # admin + demo user + FX rate
npm run dev                                     # API on :8000
npm run dev:worker                              # worker (second terminal)
```

Frontend dev uses the Vite proxy `/api -> http://localhost:8000`.

## Tests

```bash
cd backend
npm run test:unit          # pure logic (money, pricing, providers, state machine)
npm run test:integration   # needs DATABASE_URL (+ REDIS_URL for some paths)
```

Integration suites cover: auth/sessions/permissions, wallet ledger +
idempotency + concurrency, orders + full vertical slice, provisioning safety
(two workers cannot double-order, retryable vs permanent failures,
UNKNOWN→reconciliation) and cross-user isolation.

## Production notes

- Migrations are explicit SQL files under `backend/drizzle`; they are applied
  by the API/worker entrypoints (idempotent) — never auto-generated at startup
  in production.
- `LEASEWEB_MODE` defaults to `mock`. Real ordering additionally requires
  `LEASEWEB_ORDERING_ENABLED=true` (see docs/LEASEWEB.md).
- Secrets: `DATABASE_URL`, `REDIS_URL`, `AUTH_SECRET`, `LEASEWEB_API_KEY` come
  from the environment (server-side `/opt/tofan/cloud/.env`); they are never
  logged, never committed, never exposed via any endpoint.
- Health: `GET /api/health/live` (always 200 when the process is up),
  `GET /api/health/ready` (checks PostgreSQL).