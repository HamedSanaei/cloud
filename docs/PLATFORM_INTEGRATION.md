# Unified website and Telegram platform

The canonical money, prices, payments, orders and servers live in the Python
`cloud-server-platform` backend. This website keeps its existing login methods
and sessions, then links an authenticated web account to one Telegram platform
account. See that repository's `docs/WEBSITE_INTEGRATION.md` for the Python API,
bot commands, event delivery and optional guest SSH setup.

## Safe activation

1. Back up both databases. Reconcile old website wallet balances, held funds,
   invoices, active subscriptions/servers and queued provider work with the
   platform ledger first. **No automatic balance sum, currency reinterpretation,
   server ownership reassignment or dual-write migration is performed.** Existing
   assets must be migrated through reviewed, audited ledger/import procedures;
   do not clear balances or mark real contracts cancelled simply to pass a gate.
2. Drain/stop old website billing/provider workers during a maintenance window.
   All web instances must switch together; do not run mixed legacy/unified modes
   against the same database. Retain historical data for audit and rollback review.
3. Run `npm run db:migrate` in `backend/` to apply `0006_platform-links.sql`.
4. Configure **both** web API and web worker with the SAME non-empty
   `PLATFORM_API_URL` pointing to the Python API origin. Use trusted internal
   networking or HTTPS. It must be reachable from the backend, not the browser.
   Production plain HTTP is accepted only for loopback or the explicitly named
   private `cloud-platform-api` host. No path/query/credentials in this origin.
   Avoid port collisions (web API defaults to 8000; give Python a distinct origin).
5. Start the Python API/bot/worker using their shared DB/Redis/private config.
   Start the web API with `npm run dev` and frontend with `npm run dev` in the
   repository root (or use normal image deployment outside development).

The web API startup refuses unified cutover while nonzero local balances, live
servers/subscriptions, outstanding invoices/orders or unsettled provider work
remain. The web worker idles in unified mode instead of running a second billing
or provisioning authority. This is a guard, not a migration tool. Do not disable
unified mode after accepting canonical transactions without another reconciliation.

Leave `PLATFORM_API_URL` empty to keep legacy behavior. Do NOT publish it as a
`VITE_*` credential or put a canonical token in localStorage. `AUTH_SECRET` must
remain stable and protected because it derives the link-encryption key. Rotating
it requires re-linking accounts (there is no transparent key rotation here).

## User workflow

- Sign into the website normally. In private bot chat complete onboarding and
  send `/website`. Enter the five-minute one-time code in **پلتفرم مشترک**.
- Wallet, server, invoice and create-server routes show the shared panel when
  unified mode is enabled. The dashboard's balance/metrics read canonical data.
- Recharge creates a canonical gateway invoice/link; only existing authoritative
  payment settlement credits the wallet. Opening a link never credits money.
- The offer list uses the bot's sellability/currency policy and formatted price.
  Checkout revalidates expected price/currency server-side. Existing identity,
  terms, wallet, capacity and provider checks are not bypassed; finish onboarding
  in the bot if required.
- Server management, image selection, signed destructive confirmations,
  one-time password claim/ack and operation history use the canonical backend.
  A submitted/accepted request is not displayed as completed provisioning.
- Verified platform superadmins can search/select users and append reasoned,
  idempotent wallet adjustments in IRT. A website admin role does not grant this.

## Security and cutover boundaries

`platform_links` has unique web and platform user identities. A linked identity
cannot silently be replaced with a different platform account, including during
concurrent connections. Platform credentials are encrypted AES-256-GCM with
web-user associated data and only used server-side. Browser requests use existing
web session/CSRF controls. Proxy paths are allowlisted and private tokens are not
returned to the browser. API bodies with pairing codes/passwords must not be logged.

In unified mode legacy financial/compute/admin mutations fail closed; they never
fall through to the local ledger. Read adapters exist for dashboard/wallet/fleet
and notifications. Unsupported legacy views point to the shared panel rather than
mixing historical and current sources. Old web admin pages intentionally cannot
write canonical data; use shared admin controls or the bot.

## Operator test server

**leaseweb-test**, **Public IPv4 217.20.121.89**, provider **Id 12717238**, is
owned and funded by the operator, with configured active superadmin access.
An explicit canonical grant may additionally expose it to a linked platform
user without changing ownership. The panel's **شناسایی و اتصال
leaseweb-test** button (or bot `/testserver`) verifies its live ID + IP in exactly
one account and imports only local metadata; it never orders another VPS. Power,
reinstall and password reset are explicit actions with visible receipts/notices.
The new bridge requires `website-server-delegation:v1`; publish the matching
platform (including additive migration 0061) before the website. Grant/revoke
endpoints are superadmin-only and cannot be authorized by a website role alone.
`view` is mandatory; this phase permits only explicitly selected read operations.
Power, reinstall, delete, credentials/console, SSH-port and billing rights are
not implied and cannot be delegated in this phase. Match the requested website
account to its existing `platform_links.platform_user_id`, not by platform email.
No live grant or resource registration is performed by the source change.

Projected list rows carry both `id` and explicit `platformServerId`, equal to the
canonical platform `server_id`. Management controls use `platformServerId`,
never a provider resource number or legacy web database row. Detail responses
are checked against that UUID. `credentialsAllowed=false` hides credential
controls for delegates; failed refresh/revocation clears stale capabilities and
secrets. Server authorization remains authoritative even if a client ignores UI.

Deletion of this shared fixture is blocked in this panel. SSH port testing requires
the separately installed/pinned guest helper described in the Python documentation;
it is not enabled just by linking an account.

These changes do not deploy either service, transfer existing funds/assets or run
power/reinstall/password/port operations on the actual server. After configuring
both environments, test with non-financial reads first, then explicitly confirmed
test-VPS actions. Never use a customer-funded production server for smoke tests.

## Operational contract and release checks

- Set `APP_ENV` explicitly to the same role as the canonical Python
  `app.environment`. Both services require Console contract `1`; requests carry
  `X-Platform-Contract` and `X-Platform-Environment`. A mismatched environment,
  header identity, foreign wallet/display currency, missing confirmation key or
  disabled USD=USDT domestic settlement prevents readiness/cutover.
- Configure a valid padded Base64 32-byte
  `security.provider_credential_encryption_key` in the Python private TOML for
  management/one-time credential storage. Use a distinct persistent key per
  environment; never regenerate it during a release. Callback keys must contain
  at least 32 random characters. The website needs no provider keys or shared
  master API credential.
- Display and settlement use IRT (toman); USD/USDT remain provider/catalog
  bases at 1:1. Domestic payment conversion uses the current permitted Tether
  rate, with exact rial/toman scaling and recorded FX evidence. Missing/stale
  settlement rates do not trigger a foreign-currency fallback.
- Operations distinguish queued/running dispatch from observed success/failure.
  HTTP 202 is not success. Provider reads reconcile power/boot/image/password
  evidence, and final receipt/credentials/customer notice commit atomically.
  Uncertain outcomes are never automatically dispatched a second time.
- Staging is an automatic fast release lane for the SAME live Production
  website, canonical DB/Redis and original Telegram bot. Both applications use
  environment `production` and `cloud-platform-production-bridge`; never start
  a second bot poller. The manual main lane retains explicit approval.
- The encrypted backup/restore drill was exercised on synthetic local data:
  six baseline Drizzle migrations, encrypted backup, migration `0006`, repeat
  migration, restore to a clean DB and re-upgrade preserved the original wallet
  amount and its single ledger transaction.
- Local browser/API/Redis smoke exercised real `/website` handler pairing,
  shared toman credit, rejection of reused pairing codes, idempotent adjustment
  replay and denial of ordinary-user fixture registration. Telegram transport
  and remote deployment still require the release Environment's SSH secrets.
  The operator chose to configure those secrets personally. A local smoke does
  not prove delivery through the original Telegram account or live deployment.
- The actual pruned backend Docker image was smoke-tested against isolated
  PostgreSQL/Redis, including Docker health on a non-default API port and nginx
  proxy/SPA routing. Tests now use structured JSON logging: the development-only
  `pino-pretty` transport must not be loaded from a production-pruned image.
  The frontend's vulnerable `source-map-js` dependency was patched within its
  existing semver range; the resulting npm audit reported no vulnerabilities.
