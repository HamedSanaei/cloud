# Cloud console — shared live runtime, staging and main release lanes

The React frontend, Fastify API, BullMQ worker, PostgreSQL and Redis form one web
release. The Python platform is the canonical wallet, pricing, server and
notification authority in unified mode. See [PLATFORM_INTEGRATION.md](PLATFORM_INTEGRATION.md)
and the native repository's `docs/WEBSITE_INTEGRATION.md` before cutover.

## Release policy

`.github/workflows/pipeline.yml` runs on pushes and pull requests targeting
`main` or `staging`, and on explicit manual requests.

| Event | CI and immutable image build | Deployment |
|---|---|---|
| Pull request | Frontend/backend lint, typecheck, tests, migration validation, Docker build and smoke | None |
| Push to `staging` | Full gates, frontend/API images tagged with the exact full commit SHA | Automatic update of the original live Production runtime |
| Push to `main` | Full gates and immutable images | None |
| Manual request on `main` | Full gates and images for that commit | Production only with affirmative confirmation and Environment approval |

No `latest` tag is published. Both web and API/worker images carry the same
revision; deployment verifies revision and integration-contract labels. After
any approval delay the workflow rechecks branch HEAD. A stale commit cannot
replace a newer branch release. Production Environment must restrict the branch
to `main` and require an authorized reviewer; Staging must restrict it to `staging`.

Frontend CI uses Node.js 24, the shared backend ESLint toolchain, TypeScript,
Vite build and actual built-image SPA/health checks. Backend CI uses isolated
PostgreSQL 17 and Redis 7, explicit test/mock configuration, unit and integration
tests, Drizzle migration application, lint/typecheck and a built-image readiness
smoke. It never contacts real provider APIs. Workflow/shell validation is a
required gate. Essential failures are not masked with `continue-on-error`.
CI requires ShellCheck before running actionlint. For local workflow verification
use Linux with ShellCheck installed; Windows-only actionlint can otherwise omit
the runner's shell diagnostics. Remote credential expansion must remain remote,
and the wrapper smoke checks cleanup on login/deployment success and failure.

## Shared target and private connectivity

`staging` is a fast release branch, **not an isolated runtime**. By operator policy,
both GitHub release Environments address the same website, native platform, DB,
Redis and Telegram bot. Do not create another stack, bot poller or financial authority.

| Setting | Shared live value/default |
|---|---|
| Directory (`COMPOSE_DIR`) | `/opt/tofan/cloud` |
| Compose project | `tofan-cloud` |
| Loopback web port (`CLOUD_PORT`) | `8540` |
| Canonical bridge network | `cloud-platform-production-bridge` |
| Web/native application environment | `production` |

Use the **existing** directory/port when they differ from these defaults. Bootstrap
checks port ownership and refuses conflicts; do not bootstrap over an active site.

The web API and native API share the production private bridge. Keep the
native API otherwise private, or use authenticated HTTPS through trusted ingress.
`PLATFORM_API_URL` is the native API **origin**, without a path, query or embedded
credentials. It belongs only in the web backend's private `.env`, never in
`VITE_*`. Both services must report contract `1`, the same deployment environment,
IRT wallet/display currency, disabled header identity and enabled, usable USD/USDT
settlement policy. An unset signing key or unavailable canonical API blocks
readiness; it must not silently select another financial authority.

## GitHub Environments, variables and credentials

Configure both **Settings → Environments → staging / production** for the SAME
authorized target. Branch restrictions differ; application identity and data do not.

| Name | Kind | Purpose |
|---|---|---|
| `DEPLOY_HOST` | Secret | Authorized target hostname/IP |
| `DEPLOY_PORT` | Secret | SSH port; defaults to 22 |
| `DEPLOY_USER` | Secret | Target account permitted to use Docker |
| `DEPLOY_SSH_KEY` | Secret | Dedicated deployment private key |
| `DEPLOY_KNOWN_HOSTS` | Secret | Host keys verified out of band |
| `DEPLOY_PATH` | Variable | Existing live deployment directory |
| `CLOUD_PORT` | Variable | Existing live loopback port |
| `PUBLIC_URL` | Variable | Original website HTTPS origin |

The workflow uses its scoped `GITHUB_TOKEN` for GHCR push and remote pull, with
`packages: write` only where needed. Registry login uses standard input and a
fresh temporary `DOCKER_CONFIG`; the token/config and temporary SSH files are
removed after the run. A separate long-lived PAT, public package or credentials
inside an image/Compose artifact are not required. Package access must allow the
workflow's repository token to read both packages.

Never print `.env`, TOML, pairing codes, bearer credentials or request bodies to
logs or upload them as artifacts. Rotate deployment keys by adding and verifying
the new public key/host fingerprint, updating the matching Environment secrets,
then removing the previous key. Do not disable strict host-key checking or trust
an unverified `ssh-keyscan` result inside a deployment.

## One-time bootstrap on an authorized target

Run manually as root, from the matching release's `deploy/scripts` directory:

```bash
sudo bash server-bootstrap.sh
```

`COMPOSE_DIR` and `CLOUD_PORT` can explicitly override the shared defaults.
Bootstrap requires Docker Compose v2, OpenSSL, `flock`, GPG and curl. It installs
only this project's scripts/directories, creates a private `.env` only when
missing, and generates database/auth/backup secrets only for a new installation. It does not
start an application, open a public application port, alter Vendora, prune
Docker, overwrite existing secrets or restart an unrelated service.

Complete the private `.env` before the first release:
- stable existing `AUTH_SECRET`, `DATABASE_URL`/`POSTGRES_PASSWORD` and `REDIS_URL`;
- a recoverable, securely retained `BACKUP_ENCRYPTION_KEY` (never store it beside
  exported backup artifacts);
- `APP_ENV=production`, `PLATFORM_API_URL`, secure cookie/auth-delivery settings
  and matching canonical runtime prerequisites;
- no provider credentials in the web image or web environment. Provider keys,
  multi-account/location configuration and FX policy remain in the native
  platform's server-owned private `configuration.toml`.

Preserve that file and its keys across releases. Rotating `AUTH_SECRET` without
an explicit token migration makes encrypted platform links unreadable.

## Safe activation, backup and rollback

`deploy/scripts/deploy.sh` is the shared release engine. CI builds images; the
target only pulls and runs them. Workflow concurrency plus a host `flock` prevents
overlapping releases, including direct operator invocations.

The engine validates role/directory ownership, immutable full-SHA image labels,
matching frontend/API revisions, integration contract and canonical readiness
before draining writers. It retains previous release metadata/Compose, drains
this web API/worker, creates an AES-256 encrypted PostgreSQL custom-format dump,
then migrates and validates the expected Drizzle head before starting dependent
API/worker/frontend containers. Backup failure stops before migration. Secrets
are passed through a private file descriptor, not command arguments or logs.

Activation requires container health, API readiness, local `/healthz`, an actual
`/dashboard` SPA response, public checks and sustained worker/container health.
Only a fully verified release updates `deployed.version`.

Rollback is **conditional**, not a database downgrade or guaranteed zero downtime:
- Before schema/authority advancement, a compatible previous image pair can be
  restored and must pass health checks; the failed deployment still exits nonzero.
- Once schema advances, or the previous release uses another financial authority
  or contract, the engine refuses to start incompatible old writers. Keep them
  drained and forward-fix, or perform an explicitly approved database restore.
- A backup restore must stop writers, preserve the failed database for diagnosis,
  restore into a separate database first and verify schema, balances, ledger
  cardinality and reconciliation before switching. Never blindly execute an old
  image or downgrade financial migrations against the new database.

Test backup **and restore**, not merely archive creation. The integration drill
applied web migrations 0000–0005, seeded isolated synthetic money, encrypted a
backup, applied 0006, repeated it without duplicate credit, and restored the
pre-migration schema/money in a separate local database. This is not a Production
backup or authorization to migrate a customer database.

## Ingress and public checks

Inspect the existing nginx/Caddy/Traefik/Apache setup and listeners before any
change. Never install a second reverse proxy or edit Vendora's virtual host.
`deploy/ingress/cloud.tofanservice.ir.conf` is the Production nginx example;
Staging needs its own explicit hostname and loopback upstream.

After an authorized nginx change, run `nginx -t` before a **reload**, not a restart.
Keep the application listener on `127.0.0.1`, preserve forwarded protocol/host/IP
headers, and expose only the existing ingress. For Cloudflare use Full (strict)
with a valid origin certificate; never Flexible SSL. Do not long-cache
`index.html`; hashed `/assets/*` can be immutable.

`PUBLIC_URL/healthz` and `PUBLIC_URL/dashboard` are required for normal releases.
`skip_public_healthcheck` / `SKIP_PUBLIC_HEALTHCHECK=1` is only an explicitly
selected first-bootstrap exception before DNS/ingress exists. Logs record the
skip; a strict release is required once ingress is available. Staging must never
fall back to the Production public origin.

## Status and recovery

For the existing live directory:

```bash
docker compose --project-name tofan-cloud \
  --env-file /opt/tofan/cloud/.env \
  -f /opt/tofan/cloud/compose.yml ps
sudo bash /opt/tofan/cloud/scripts/status.sh
```

Status reports actual image revisions and fails for runtime, revision or readiness mismatches.
Check `deployed.version`, image labels, API readiness, canonical contract, worker
health and customer outbox progress; a frontend HTTP 200 alone is insufficient.
The `staging` branch automatically updates this live runtime after CI. The main
lane remains manual, explicit and Environment-reviewed; a normal main push does
not deploy. Both lanes share a deployment job group and target lock. The website
and native engines additionally share `/var/lock/servercloud-platform-release.lock`,
using the same deployment OS user, so cross-repository migrations cannot overlap.
Do not push an empty/revert commit merely to force an unsafe rollback.

For failures, correct the actual missing Environment secret/target, package
permission, canonical readiness, database epoch or ingress cause. Retain encrypted
backups and release metadata. Never resolve a failed rollback by manually pointing
old images at an advanced database or by making tests/health checks optional.

## Runtime boundaries

Web API/worker use Node.js 24. PostgreSQL/Redis stay on isolated networks, without
public host ports. Redis uses persistent AOF and `noeviction`. Application
containers remain non-root with dropped capabilities and bounded rotated logs.
The worker has no HTTP listener; observe worker/container progress rather than
using the API HTTP probe as its healthcheck. Backend image readiness honors its
configured `PORT`, including the non-default CI smoke port.

In unified mode, catalog, provider logos/accounts/locations, hourly/daily offers,
wallets, operations and notices come from the canonical platform. Do not restore
an obsolete provider-TOML mount or legacy web financial worker as a fallback.
