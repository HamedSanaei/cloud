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

Use the **existing** directory/port when they differ from these defaults. Full
bootstrap refuses occupied ports. On an existing site, use `--recovery-only` to
install recovery without probing the web port or changing secrets/metadata.

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
Bootstrap requires Docker Compose v2, Python 3, Systemd, OpenSSL, `flock`, GPG
and curl. Full bootstrap creates private secrets only when absent. Recovery-only
bootstrap requires the existing directory and installs just the recovery scripts
and `tofan-cloud-reconcile.service`. Neither mode starts the unit immediately,
restarts Docker, prunes resources, or overwrites existing secrets.

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

### Automatic infrastructure recovery

PostgreSQL and Redis use `restart: always` in canonical and generated production
Compose; web/API/worker retain `unless-stopped` so deliberately drained writers
stay drained. Compose declarations do not prove the policy of existing containers.
`reconcile-runtime.sh` inspects the actual policy and updates existing container
IDs in place. It never creates, recreates, removes, or migrates a container/database.

Recovery requires both exact service names, Compose project/service/working-dir
labels, canonical named volumes and their ownership labels, matching local volume
mountpoints, writable data mounts, and configured healthchecks. PostgreSQL must
already contain a PostgreSQL 17 `PG_VERSION` and nonempty `global/pg_control` at
the canonical PGDATA. Missing containers, missing/mismatched volumes, noncanonical
PGDATA, or unproven initialization fail closed **before either service changes**.
Do not bypass this refusal with `compose up`: inspect the historical containers,
volume identities and encrypted recovery records privately. Fresh installations
require explicitly reviewed infrastructure provisioning; deployment is not a
database initialization path.

The script takes `${COMPOSE_DIR}/.deployment.lock`, the same lock as deployment.
An active release may delay recovery up to 600 seconds; health/Docker operations
then have a shared 180-second deadline. `--check` is strictly read-only and fails
unless both services are healthy with `always`. Deployment reconciles before
image pulls/writer downtime and checks again before marking success; normal
activation and rollback start only application services with `--no-deps`.
Infrastructure containers/volumes/networks are not recreated by releases.

The Systemd oneshot is enabled under both `multi-user.target` and `docker.service`,
ordered after Docker and requiring it, with `PartOf=docker.service` and
`RemainAfterExit=yes`. Host boot starts it after Docker; Docker service restarts
stop/restart it as well. Failure retries after 15 seconds without changing
unrelated Docker projects. Installation uses `enable`, **not** `enable --now`.

#### Backend startup

API startup gates PostgreSQL, Redis and required canonical platform connectivity
before migrations and listening. Temporary failures receive 12 sequential
attempts, exponential delays starting at one second and capped at ten seconds
(85 seconds of backoff, plus bounded connection/query time). Required platform
feature probes preserve transient unavailability; invalid contracts, authentication,
configuration and permanent SQL/schema failures fail immediately. No indefinite
migration retry or fallback financial authority is introduced.

CLI, API and legacy worker migrations share a database-scoped advisory lock on
the **same checked-out PostgreSQL session** used by Drizzle. The session is
destroyed on completion/failure; retries cannot overlap a previous attempt or
leak locks into the pool. Migration statements have a 120-second server timeout.
Failed startup closes dependency/queue/worker handles. Unified-mode legacy
workers remain disabled rather than becoming another billing authority.

Structured `startup_retry`, `startup_ready` and `startup_failed` events expose
stage, attempt, delay, failure class and allowlisted codes, not exception messages,
SQL, connection URLs or credentials. API health has a 120-second startup grace;
deployment waits up to 300 seconds for API health.

Run `node backend/test/startup-recovery-smoke.mjs --integration` locally with
Node 24, installed backend dependencies and local Docker. It starts the actual
API with both dependencies stopped, recovers them without restarting the API,
checks readiness, and exercises PostgreSQL migration serialization using only
uniquely named disposable containers. Release CI runs this API smoke plus the
backend unit/integration suites.

#### Roll out to the existing site without a Docker restart

1. Run release CI first. Retain the existing private `.env`, databases, volume
   names, networks, image metadata and verified encrypted backup/restore records.
2. From the tested release's `deploy/scripts` directory on the authorized host:

   ```bash
   sudo env COMPOSE_DIR=/opt/tofan/cloud bash server-bootstrap.sh --recovery-only
   sudo systemctl restart tofan-cloud-reconcile.service
   sudo env COMPOSE_DIR=/opt/tofan/cloud \
     bash /opt/tofan/cloud/scripts/reconcile-runtime.sh --check
   sudo systemctl status tofan-cloud-reconcile.service --no-pager
   sudo journalctl -u tofan-cloud-reconcile.service -n 50 --no-pager
   ```

   This restarts only the recovery oneshot, not Docker or healthy containers.
   A drifted policy is updated in place; only stopped, verified infrastructure
   containers are started. If identity/data checks fail, stop and investigate;
   do not replace containers or reset data.
3. Deploy the exact tested SHA through the existing protected release lane.
   CI transfers and verifies the complete deploy/reconcile bundle. Generated
   production Compose now declares `always`; encrypted backups and schema-aware
   rollback protections remain in force. On later recovery-code updates, repeat
   recovery-only bootstrap to update the installed boot-time copy as well.
4. Check service health, runtime policies, API readiness and stable restart counts.
   Do not restart production Docker merely to test this change.

#### Explicit maintenance override

Create `/opt/tofan/cloud/.maintenance` **before** planned infrastructure downtime,
under the deployment lock. Recovery then exits successfully without contacting
Docker; deployment and strict checks fail. This suppresses the reconciler only:
Docker's `always` policy still applies after a daemon restart. If maintenance
must survive reboot, an authorized operator must additionally change the two
verified containers' policies to `no` and stop them during that maintenance
window. Never disable another project's policies. After maintenance, remove the
sentinel and restart `tofan-cloud-reconcile.service`; reconciliation restores
`always`, starts the original containers and waits for health.

#### Local verification and incident evidence

`python3 -m unittest discover -s deploy/tests -v` exercises drift, stopped
dependencies, locks, maintenance, volume/data refusals and Docker failures.
`DRILL_ALLOW_DIND=1 bash deploy/tests/runtime-recovery-drill.sh` creates a labeled
disposable Docker-in-Docker daemon, seeds PostgreSQL/Redis markers, exercises
policy/manual-stop recovery and restarts **only that dedicated daemon** twice.
It verifies original container IDs, mounts/configuration, volumes and persisted
markers, runs recovery-only bootstrap without changing fixture secrets/metadata
or starting services, and validates the generated unit with `systemd-analyze`.
The drill requires Linux/WSL, Bash, `systemd-analyze`, local Docker with privileged
container support, and image/package access. CI requires it before publishing.

The October 25 incident establishes observed runtime policy `no`, not how it was
set. Repository inspection found no existing operation setting the persistent
production PostgreSQL/Redis policy to `no`. Existing deployment stops target
API/worker only; backup verification uses temporary restore databases, not
container policy changes; CI's default-policy containers are disposable smoke
and Compose one-off containers, not the persistent infrastructure. A Docker audit
trail or external maintenance history would be needed to attribute the drift.


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

## Integration release prerequisites

Before changing the live configuration, run `deploy/scripts/backup-verify.py`
on the deployment host with the confirmed website/platform paths and a NEW
recovery output directory. It encrypts configuration and effective container
metadata with the existing server-owned backup key, dumps both databases,
restores each dump into a temporary database in its existing PostgreSQL
container and removes only that freshly created recovery database. A manifest
records encrypted checksums and successful restores. Never publish the archives
or backup key. Archive verification is not a license to overwrite production data.

The canonical platform must create the Compose-owned production bridge and
`cloud-platform-api` alias first. Website deployment preflights the actual API
contract, IRT/USDT policy, real live-authentication configuration, and residual
legacy balances/contracts BEFORE stopping application writers or migrating.
Missing SMTP, ParsGreen or Google credentials are deployment blockers, not
reasons to use log delivery or fabricated values. Existing session and encryption
keys must be preserved. Re-run the same exact-SHA pipeline after the operator
securely supplies the missing server configuration.
