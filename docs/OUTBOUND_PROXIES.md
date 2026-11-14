# Outbound integration routing (Issue #46)

This feature does not change incoming Nginx traffic, browser networking, internal
Platform API traffic, Google OAuth or SMTP. It is not a public proxy endpoint.
Deployment alone leaves every integration **Direct**. No production profile,
credential or assignment is created by a migration or seed.

## Operator preparation

1. Keep the existing, independently generated `STORE_SECRET_KEY` stable and pass
   the same key to API and worker. The Compose files and deployment generator do
   this explicitly. Never replace a live key just to enable this feature.
2. Add the UUIDs of the intended **active admin** accounts to
   `OUTBOUND_PROXY_SUPER_ADMIN_IDS` (comma-separated). An empty list grants nobody
   network administration, including otherwise privileged ordinary admins.
3. Open **مدیریت → تنظیمات فروشگاه → شبکه و پراکسی خروجی**. Register a named
   SOCKS5, HTTP CONNECT or HTTPS CONNECT profile. New profiles start disabled.
   Hosts are hostnames/IPs, never URLs; use a public proxy address. Username and
   password are optional together, are encrypted, and are never read back.
4. Test a profile against one of the fixed integration choices. This can test a
   disabled profile without enabling or assigning it. Profile tests omit provider
   credentials; HTTP 401/403 can prove connectivity without proving API access.
5. Enable the profile, then explicitly assign/enable a route for each chosen
   integration. Run **آزمون اتصال** to test the *effective assignment*. Hetzner and
   Leaseweb tests use an enabled configured account, when available, for read-only
   location/region requests. ParsGreen uses HEAD, never sends a test SMS.

Implemented adapters: Hetzner, Leaseweb, ParsGreen, TabaPay and AbanTether ticker.
ParsGreen and domestic payment/rate APIs remain Direct unless explicitly assigned.
Asiatech has no implemented outbound adapter here, so no misleading route switch
is offered for it. A future integration must add a fixed ID, exact approved HTTPS
authority, non-mutating diagnostic endpoint, adapter hook and regression tests.
Do not add arbitrary customer-controlled URL destinations.

## Policy and failure behavior

- `enabled=false` on an integration route means an explicit Direct selection.
  Assigning an enabled route requires an existing enabled profile.
- Disabling a *profile* still used by a required route **blocks** that route; it
  never implicitly leaks requests through a direct connection. To intentionally
  return to Direct, disable/unassign the integration route. A disabled profile
  can be saved even when its DNS is unavailable, so outages cannot prevent
  emergency disablement. Every attempted connection still validates its address.
- Default `closed` policy never falls back. Optional `read-only-direct` permits
  one direct fallback for GET/HEAD transport failures within the original deadline.
  Policy violations, upstream HTTP errors and expired/cancelled requests do not
  trigger fallback. POST/PUT/PATCH/DELETE never fall back or auto-retry.
- Existing Hetzner `ProviderUnknownError`, Leaseweb `unknown` mutation outcomes,
  operation receipts, reconciliation and payment idempotency remain authoritative.
  A proxy timeout is not permission to send a second create/order/payment.
- Fixed exact HTTPS authorities on port 443 only; no URL credentials, HTTP,
  custom test destinations or redirects. Direct connections validate **all** DNS
  answers and pin the public address at socket creation. Proxy addresses are also
  resolved, validated and pinned; loopback, metadata, private, mapped-private and
  other special-use ranges are rejected. No process-global proxy environment is
  installed.
- SOCKS5 sends the approved destination hostname to the proxy (remote DNS), not a
  locally resolved target IP. CONNECT similarly names the approved destination.
  Upstream TLS validates its original hostname and trust chain. HTTPS proxy TLS
  also validates the proxy hostname; there is no insecure TLS toggle.
  The proxy operator must additionally enforce public-destination egress ACLs at
  its resolver/host: this application cannot inspect a remote resolver's chosen
  IP. Only use trusted proxies. SOCKS5/HTTP proxy authentication itself is not
  encrypted on the client-to-proxy leg; use HTTPS CONNECT when that protection is
  required. Upstream HTTPS remains end-to-end verified for all three types.
- Profile deadlines are 1–30 seconds, combined with the adapter's existing
  cancellation/deadline and an overall 30-second budget, including policy/DNS work.
  Pools are bounded (four connections, no mutation pipelining). Settings changes
  create a new revision; new requests in API and worker independently read it
  from PostgreSQL and retire previous pools gracefully. In-flight requests retain
  their snapshot; changing a route cannot cancel an already accepted operation.
- Production entrypoints (API, worker and Leaseweb CLI) install the DB-backed
  reader. An uninitialized non-test process fails closed instead of bypassing
  stored policy. Do not instantiate provider adapters in a new entrypoint without
  installing and closing its outbound client.

## Security, audit and status

The existing single-use, session/action/payload-bound sensitive-operation proof
is required for profile edits, deletion, route changes and diagnostics. Both proof
issuance and operation execution check the explicit allowlist and active admin
role; proof consumption also rechecks the database account. Updates serialize on
a PostgreSQL advisory transaction lock and require the viewed revision, preventing
lost updates. Referenced enabled profiles cannot be deleted; disable/reassign the
routes first. Empty credential fields preserve the existing secret; explicit
credential removal or replacement rotates the revision/pools.

The entire settings document is AES-256-GCM encrypted in `settings` under
`network.outbound.v1` with revision-bound authenticated context. Existing encrypted
backup/restore includes this record; restore requires the original stable store
key. Missing/unreadable settings encryption blocks routing instead of falling
back. No new database schema/migration is needed. Public API responses expose only
`authenticated: true/false` and never plaintext or ciphertext credentials.

Audits contain actor IDs, operation, integration/profile IDs, revision and outcome;
they exclude hosts, credentials and authenticated requests. Runtime event records
use fixed route/error categories, never raw exceptions, headers, bodies or URLs.
Diagnostics retain successful-test time, latest sanitized category, HTTP status,
latency and **actual route** (including explicit read fallback). Status from an
older settings revision is marked stale in the UI. Tests do not provision a VPS,
create a payment, charge a wallet or send a message.

## Validation and rollback

- Backend unit tests include real loopback HTTP/HTTPS CONNECT and authenticated
  SOCKS5 servers plus an ephemeral, explicitly trusted test certificate. They
  exercise remote DNS, certificate rejection, internal redirects and ambiguous
  provider mutations. `openssl` must be installed on the test machine (available
  on the Linux CI runner; Git for Windows supplies a local fallback).
- PostgreSQL integration tests exercise super-admin/proof enforcement, masking,
  encryption, concurrent API/worker policy reads, stale revisions, revocation,
  credential rotation/removal, deletion and safe diagnostics. CI runs these with
  ephemeral PostgreSQL; never point the test suite at a customer database.
- Frontend tests verify access gating, masked edits, exact proof payloads,
  independent domestic assignments, Direct selection and diagnostic reporting.
- Dependencies pin a maintained Undici 7 release compatible with Node 24's native
  fetch dispatcher. Undici 8's dispatcher handler API is incompatible with that
  native fetch; actual tunnel tests catch this incompatibility.

To stop using the feature, explicitly set all assigned routes to Direct first,
then disable/retire profiles. Do not roll back the code to a version that ignores
the DB policy while any integration still requires a proxy. No production routing
change or immediate deployment is authorized by this issue's implementation.
