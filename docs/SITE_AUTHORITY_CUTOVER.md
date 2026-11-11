# Pars Server — website data authority and admin console

## Data ownership

**Pars Server's Fastify/PostgreSQL backend is canonical.** Users, wallets,
wallet transactions, orders, invoices, subscriptions and customer servers are
written to and read from the site's own database. The worker owns provisioning,
billing schedules and server synchronization. Cloud infrastructure providers
remain external suppliers, **not** business-data owners.

The project owner has confirmed there are **no real legacy Python platform
balances, orders or servers to migrate**. Therefore no export/import or fake
reconciliation receipt is needed. In site mode, an old `PLATFORM_API_URL`
setting is ignored. The startup guard still rejects **existing Python-linked
accounts**, because a saved binding could indicate another writer; remove
unused test bindings and stop the old Python financial/ordering worker first.

### Configuration

Set the same value for API and worker:

```env
DATA_AUTHORITY=site
PLATFORM_API_URL=
```

`DATA_AUTHORITY=auto` keeps backwards-compatible behavior on old installs,
and `platform` explicitly enables the bridge. Do not run site and Python
financial writers simultaneously. Keep provider credentials in an untracked,
server-owned `configuration.toml`; in production the API and worker mount it
read-only at `/etc/tofan-cloud/configuration.toml`.

For new isolated installs use `docker-compose.site.yml`, which has **no
Python network dependency**. The normal production release script also
supports site mode when configured in the server-owned environment. If its
deployed-version metadata indicates a historical Python-backed release,
it intentionally refuses a silent automated source switch; select the site
mode through a separately reviewed manual deployment.

The site keeps monetary ledger values as integer **rials** and displays
**toman** by explicit conversion; never use Python IRT wallet amounts as
site rial ledger inputs. The native wallet idempotency controls must remain
active even with an initially empty database.

## Minimal admin interface

The new Penpot-based RTL admin interface is accessible at `/admin` through
the existing site authentication. Only active users with `role=admin` may
access its API or pages. It is read-only for this first release.

| Route | Data |
| --- | --- |
| `/admin` | Registered users, paid orders, servers and recent activity |
| `/admin/orders`, `/admin/orders/:id` | Orders, state, invoices and events |
| `/admin/users`, `/admin/users/:id` | User profile, wallets, transactions, linked servers |
| `/admin/users/:id/servers` | Paginated inventory for one user |
| `/admin/servers`, `/admin/servers/:id` | Server status, IP, resources, provider and owner |

Backend endpoints: `GET /api/admin/console/*` and
`GET /api/v1/admin/console/*`. Lists support bounded page size, search
and status filtering. No credentials, password hashes, platform tokens or
TOTP secrets are sent in the admin DTOs.

Frontend: `src/admin/`.
Backend: `backend/src/modules/admin/console.ts`.
Mode selection: `backend/src/modules/integration/authority.ts`.

A production admin must be provisioned from an existing authenticated site
account using a reviewed admin-role assignment. Never run the development
`seed.ts` in production: it creates demo accounts, credits a demo wallet and
sets a synthetic FX rate.

## CI and deployment policy

Every push to `staging` or `main` runs validations and publishes immutable
SHA-tagged web/backend Docker images. **Push does not start or modify the
stopped shared server.** A deployment now requires GitHub Actions
`workflow_dispatch` with a matching branch/environment (production also
requires explicit confirmation and environment approval).

The CI verifies frontend pages and administrator authorization, backend
typecheck/lint/unit and database integration tests, schema migrations, site
Compose syntax, release Bash syntax, isolated recovery and image smoke tests.
`/admin` is checked as an SPA route and the unauthenticated admin API is
required to return HTTP 401.

Checks from a developer machine:

```bash
npm run build && npm run lint && npm test
cd backend
npm run build && npm run typecheck && npm run lint
npm run test:unit && npm run test:integration
```

Integration tests require PostgreSQL/Redis; local runs without these services
skip them and **cannot** substitute for green GitHub CI.

## Known limitations

The UI/API are read-only; user wallet adjustments, server power operations
and provider ordering must use the existing separately protected backend
flows. The existing Telegram/Python bot must be disabled for monetary writes
or rewired as an API client of this site before it can receive new paid
transactions. The first-party online recharge replacement is outside this
admin-only scope.

The former Penpot design page is `New File 2 → 05 · Admin`; exact pixel
parity could not be independently verified while the Penpot browser plugin
was suspended.
