# Local verification — issues #17 and #18

> Historical verification snapshot: references to uncommitted code and no deployment describe the local QA session BEFORE this change was submitted. CI/PR/merge and release status must be checked separately. No real Hetzner destructive actions were exercised; unavailable account-scoped features require follow-up.

Branch: `codex/server-management-17-18`. Base/current committed HEAD: `cee587d11120c736c8963d78b0df2c1da9f59081`. Changes are uncommitted; no PR, push or deployment was performed. Verification was performed on the user's local machine, using isolated fixture services and current Chrome, without contacting real provider mutation endpoints.

Implementation, all Penpot IDs and API/state documentation: [CUSTOMER_SERVER_MANAGEMENT.md](CUSTOMER_SERVER_MANAGEMENT.md).

## Executed automated checks

| Check | Actual result |
|---|---|
| Root `npm run typecheck` | Passed |
| Root `npm run lint` | Passed after correcting the console lifecycle ref cleanup |
| Root `npm test` | **94 passed**, 16 files |
| Root `npm run build` | Passed; noVNC is a separate dynamically imported bundle |
| Backend `npm run typecheck` | Passed |
| Backend `npm run lint` | Passed; also enforced inside the Docker build |
| Backend `npm run test:unit` | **190 passed**, 25 files |
| Backend `npm run test:integration` | **100 passed**, 18 files, real isolated PostgreSQL 17 |
| Backend targeted management regression after final DTO change | **10 passed**; covers queued deletion in the fleet response |
| Backend `npm run db:check` | Passed |
| Migration through the integration harness and real built-image recovery scenario | Passed on disposable databases; never run against production |
| Real-tool system recovery smoke | Passed: pg_dump/pg_restore, encrypted backup, authenticated upload/download, rehearsal, restore approval, rollback, offline recovery, deployment exclusion, paused-worker retry policy, financial drift refusal and cleanup |
| Transient server secrets excluded from restored backup | Verified with an encrypted fixture row: restored server_secrets is empty |
| Backend production Docker build | Passed, non-root image with PostgreSQL client and all migrations |
| Frontend production Docker build | Passed, including the shared TypeScript contract in the root build context |
| Container nginx `nginx -t` | Passed using the checked-in config |
| Both host-ingress templates `nginx -t` | Passed in an isolated nginx container using an explicitly synthetic self-signed certificate and fixture substitution of CLOUD_PORT=8540; no production certificate/config changes |
| `git diff --check` | Passed |

Backend tests explicitly disabled real Leaseweb, Hetzner, Asiatech, email, SMS and payment credentials. New integration tests use only https://provider.test with fixture tokens and an injected WebSocket transport. PostgreSQL was exposed only on loopback in a task-labeled container. Recovery smoke creates and removes its own labeled PostgreSQL/Redis/network resources. No actual order, provider operation, financial debit or customer dataset was modified.

Final local image IDs (not deployed): backend `sha256:319f5eb5b6544c5995785ec29e2a04141103fd55e40837e753859df15a4db899`; frontend `sha256:41c283043a12da018c49e133ef9a3bc1e0386fa81f5be4111b0458ea7c91f28d`.

The task PostgreSQL container and fixture preview were stopped after verification. Automatic approval review rejected cleanup of the synthetic nginx certificate/config fixture files without a more detailed reason. They remain in ignored `node_modules/.cache/codex-server-ux-nginx-fixture`; they contain no real certificate, customer data or production key. No alternate deletion mechanism was used.

### Regression coverage

- Immediate accepted pending row even with a deferred list request, no premature success, provider-confirmed row replacement, concurrent pending/unknown builds, aborted StrictMode effects, targeted request cleanup.
- IndexedDB serial terminal claims across tabs, uncertain/review outcomes, terminal failure once, remount/reconnect claims and unavailable browser storage.
- Order UUID vs website server UUID vs canonical platform server UUID; other customer visibility and authority boundaries.
- Distinct Hetzner power commands and allowlisted payloads; original owning project, no credential fallback, fractional traffic sync regression, Action ID plus actual power state.
- Delete replay/lost response, authoritative absence vs forbidden access, renewal races, paid-ledger retention, subscription cancellation, stale jobs, live protection and funding loss before start dispatch.
- Backend resize quote/baseline, off-state constraints, rejection of client pricing and changed flags, idempotent replay after quote-cache expiry, only future subscription price changes.
- Real metrics with missing/NaN preserved as null, legitimate zero preserved as zero, cache behavior and window validation.
- Rebuild image eligibility and confirmed one-time encrypted credential handling; wrong-session/repeated claims rejected. A delayed browser credential response is not shown after the tab becomes hidden.
- Console cookie/session/Origin/owner authorization, one-use grants and binary relay; rejected duplicate upgrades do not reconnect to the provider.
- Typed server-name confirmation plus acknowledgement; force/soft operations separated, no success on operation acceptance and no customer buttons for unauthorized shared-project resources.

## Current Chrome visual checks

Browser verification used the existing Chrome instance, a loopback-only synthetic preview, desktop 1440×900 and mobile 390×844 viewport overrides. Overrides were reset afterwards. No headless browser or real authenticated customer account was used.

Inspected the server list's pending/ready rows, overview metrics/facts/billing, real fixture metric curves, forced-power confirmation, desktop/mobile deletion confirmation, focus trapping and Escape cancellation. Mobile document width remained within the viewport; tab-strip overflow is intentionally horizontal. Reduced-motion rules were reviewed in scoped CSS; an OS-level reduced-motion mode was not changed during QA.

The visual comparison is manual against actual Penpot geometry/tokens; it is **not** an automated pixel-diff baseline or proof that every board is pixel-identical. Important intentional differences are readable 14px labels, actual authorized data and wrapping safety explanations. Remaining full-board acceptance/sign-off is recorded rather than assumed from test success.

| View | Screenshot |
|---|---|
| Desktop overview | [server-overview-desktop.jpg](qa/server-management/server-overview-desktop.jpg) |
| Mobile overview | [server-overview-mobile.jpg](qa/server-management/server-overview-mobile.jpg) |
| Desktop provisioning | [servers-provisioning-desktop.jpg](qa/server-management/servers-provisioning-desktop.jpg) |
| Mobile provisioning | [servers-provisioning-mobile.jpg](qa/server-management/servers-provisioning-mobile.jpg) |
| Desktop monitoring | [server-monitoring-desktop.jpg](qa/server-management/server-monitoring-desktop.jpg) |
| Desktop delete confirmation | [server-delete-desktop.jpg](qa/server-management/server-delete-desktop.jpg) |
| Mobile delete confirmation | [server-delete-mobile.jpg](qa/server-management/server-delete-mobile.jpg) |

Reproduce the fixture preview with `node scripts/preview-design.mjs --servers`, then visit `http://127.0.0.1:5176/servers`. The preview banner explicitly labels all data synthetic; it does not connect to real services.

## Resolved verification failures and remaining warnings

- Updated the pre-existing auth/retail fixture to read tracking.orderId instead of assuming a pending row ID is an order UUID.
- Preserved the existing shared-platform management button label expected by its navigation/security tests.
- Used noVNC's supported root export instead of a package-private deep import.
- New fast integration cases initially hit the real per-IP action rate limit; each simulated customer now has a distinct documentation-range source IP. No rate limiter or security gate was disabled.
- Production frontend emits the existing Vite >500kB main-chunk warning (about 560kB minified); noVNC itself is lazy-loaded (~187kB). This is a performance warning, not a failing build.
- Fastify's existing disableRequestLogging/router-option deprecations and the optional legacy nginx ingress template's listen-http2 deprecation remain. Their gates/configuration are intact.
- Docker reports that this machine uses its legacy builder; successful image builds do not imply deployment.

## Outstanding acceptance

No real VPS power/rebuild/delete test, real provider account permission audit or real console connection has been performed; these require a separately authorized resource. Snapshot/backup/volume/network/floating-IP/new-ISO mutations remain explicitly unavailable pending customer ownership and billing policy, as detailed in the implementation document. Shared-platform endpoints were not deployed. No issue closure or production readiness claim is made.
