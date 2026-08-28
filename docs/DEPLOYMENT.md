# tofan-cloud — Production Deployment

This document describes the production CI/CD pipeline and Docker deployment for
the **Cloud** console (a static React + TypeScript + Vite SPA served by nginx).

It is designed to run **alongside Vendora** on the same Linux server without
touching it — isolated project name, network, container, directory and port.

---

## 1. Architecture

```
Developer pushes to main
        │
        ▼
GitHub Actions  (workflow: pipeline.yml)
        │  npm ci → typecheck → build
        │  Docker multi-stage build (BuildKit)
        ▼
GHCR  ghcr.io/hamedsanaei/cloud:sha-<commit>   (immutable, lowercased)
        │  latest  (convenience only)
        ▼
SSH deploy over GitHub Actions Secrets
        │  pull immutable SHA image
        ▼
/opt/tofan/cloud/compose.yml → docker compose up
        ▼
tofan-cloud nginx container   (non-root, isolated network)
        ▼
127.0.0.1:${CLOUD_PORT}  (localhost ONLY — default 8540, never public)
        ▼
existing host nginx/reverse proxy (NVH: inspect Vendora's first)
        ▼
Cloudflare  →  https://cloud.tofanservice.ir
```

```
Browser → Cloudflare → Host nginx/reverse proxy → 127.0.0.1:${CLOUD_PORT} → tofan-cloud container
```

| Component | Value |
|---|---|
| Container / compose project | `tofan-cloud` |
| Docker network | `tofan-cloud_net` |
| Deployment directory | `/opt/tofan/cloud` |
| Local-only port | `127.0.0.1:${CLOUD_PORT}` (default `8540`) |
| GHCR image (immutable) | `ghcr.io/hamedsanaei/cloud:sha-<commit>` |
| GHCR image (rolling) | `ghcr.io/hamedsanaei/cloud:latest` |
| Health endpoint | `http://127.0.0.1:${CLOUD_PORT}/healthz` → `ok` |
| Public URL | `https://cloud.tofanservice.ir` |

> **The port is never assumed free on the server.** `8540` was free on the local
> dev machine only. The one-time bootstrap **fails safely** if the selected port
> is occupied and tells you to pick another `CLOUD_PORT` (see §4). `CLOUD_PORT`
> is read from the environment everywhere (`docker-compose.yml`,
> `.github/workflows/pipeline.yml`, `deploy/scripts/*.sh`) and is easy to
> change.

---

## 2. CI/CD pipeline

A single unified workflow drives CI and deployment:

`.github/workflows/pipeline.yml` — **Cloud Production Pipeline**

It supports three triggers: `pull_request`, push to `main`, and
`workflow_dispatch`.

Job flow:

- **Pull Request:** `test-build` → stop (no image push, no deployment).
- **Push to `main`:** `test-build` → `build-push` → `deploy-production`.
- **workflow_dispatch:** `test-build` → `build-push` → `deploy-production`.

- `test-build` runs for pull requests, push to `main`, and `workflow_dispatch`:
  `npm ci` → `npm run typecheck` → `npm run build`, builds the production
  Docker image and smoke-tests it (`/healthz` returns `ok`, `/dashboard`
  returns HTTP 200). It does **not** push to GHCR and does **not** deploy.
- `build-push` does **NOT** run on pull requests. It builds and pushes the
  immutable `sha-<commit>` tag (and the convenience `latest` tag) to GHCR
  using `GITHUB_TOKEN`. Production always deploys the immutable SHA tag.
- `deploy-production` does **NOT** run on pull requests. It pushes the
  reusable script `deploy/scripts/deploy.sh` to the server and runs it over
  SSH with automatic rollback. It uses the GitHub Environment `production`,
  where the deployment secrets are stored. Only one production deployment
  runs at a time (`concurrency: cloud-production`, `cancel-in-progress:
  false`); a deploy already in progress is never interrupted.

---

## 3. GHCR access model — PUBLIC vs PRIVATE

**This deployment supports both, and documents them clearly:**

- **PUBLIC package (default, no extra secrets):** if
  `ghcr.io/hamedsanaei/cloud` is configured as a public (internet-visible)
  GHCR package, the server pulls it **anonymously**. `deploy.sh` tries
  `docker pull` with no credentials first. No registry secret is needed on the
  server. You must set the package to **Public** in GitHub → Packages → package
  → Package settings.

- **PRIVATE package (optional):** if you keep the package private, create two
  GitHub Actions **Secrets**:
  - `GHCR_USERNAME` — a GitHub username that has *at least* `read:packages`
    access to this package (ideally a dedicated machine user, not your main).
  - `GHCR_TOKEN` — a **fine-grained PAT** with only the `read:packages`
    permission for this repo.

  At deploy time the workflow stages `GHCR_TOKEN` into a **temporary `0600`
  file** on the server, and `deploy.sh` runs:
  ```bash
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin
  docker pull ghcr.io/hamedsanaei/cloud:sha-<commit>
  ```
  The token is **never echoed**, never written to the repo, and the temp file
  is **deleted** at the end of the same deploy command.

**Credential rotation (private GHCR):**
1. Revoke the old `GHCR_TOKEN` in GitHub → Settings → Developer settings →
   Personal access tokens.
2. Create a new fine-grained token with `read:packages` only.
3. Update the `GHCR_TOKEN` (and `GHCR_USERNAME`, if changed) Action Secrets.
4. On the server, run `sudo docker logout ghcr.io` once to clear the cached
   credential, then trigger a re-deploy.

The final choice is yours; **both paths are correct**. If you do not create
`GHCR_USERNAME`/`GHCR_TOKEN`, the deployment assumes a **public** package and
anonymous pull.

---

## 4. Initial server bootstrap (one time, manual)

Run **once** on the production server (as `root`). The bootstrap:
- verifies Docker + Docker Compose exist,
- verifies the selected `CLOUD_PORT` is free (`ss -lntp` + `docker ps`) — if it
  is occupied it **fails safely** (never kills the process) and tells you to
  pick another port,
- creates `/opt/tofan/cloud` with restrictive permissions,
- installs/updates **only** the Cloud deploy script,
- does **not** modify Vendora, run `docker prune`, remove containers/networks/
  images, or open any port publicly.

```bash
# fetch the script (or copy it from your checkout), then as root:
sudo env CLOUD_PORT=8540 bash server-bootstrap.sh
```

Example output you should see:
```
[ok] docker + docker compose available
[ok] port 8540 is free
[ok] installed deploy.sh -> /opt/tofan/cloud/scripts/deploy.sh
[ok] created empty deployed.version
```

If the port is busy the script refuses (nothing changed) and instructs you to
re-run with a different `CLOUD_PORT`. Do **not** kill the process holding it —
re-use the port only after investigating who owns it, or choose another.

Then:
- Ensure `DEPLOY_USER` can run `docker` (add to the `docker` group or use root).
- No Git is required on the server (the workflow scp's the deploy script).

---

## 5. GitHub Actions secrets required

Add these to **Settings → Secrets and variables → Actions** (repository-level):

| Secret | Purpose |
|---|---|
| `DEPLOY_HOST` | Production server hostname or IP |
| `DEPLOY_PORT` | SSH port (`22` if unset) |
| `DEPLOY_USER` | SSH user that can run `docker` |
| `DEPLOY_SSH_KEY` | Private key for `DEPLOY_USER` — the workflow validates it with `ssh-keygen -y` |
| `DEPLOY_KNOWN_HOSTS` | Server `known_hosts` entry(s); host keys verified, **no** `ssh-keyscan`, **no** `StrictHostKeyChecking=no` |
| `GHCR_USERNAME` | **Only for a PRIVATE GHCR package** — user with `read:packages` |
| `GHCR_TOKEN` | **Only for a PRIVATE GHCR package** — fine-grained PAT, `read:packages` only |

`GITHUB_TOKEN` handles the GHCR **push** (no PAT needed).

---

## 6. SSH deploy key rotation

1. Generate a new key:
   ```bash
   ssh-keygen -t ed25519 -C "ci-deploy-cloud" -f ~/.ssh/tofan_cloud_deploy
   ```
2. Add the public key to `~/.ssh/authorized_keys` of `DEPLOY_USER`.
3. Get the **known_hosts** entry safely:
   ```bash
   ssh-keyscan -H -T 10 <DEPLOY_HOST>   # view once, verify the fingerprint out-of-band
   ```
   Do not script this into the pipeline.
4. Replace `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS` in GitHub Secrets.
5. After confirming the new key works, remove the old public key server-side.

---

## 7. Host reverse proxy (existing ingress — inspect first)

**Inspect how Vendora is currently exposed before changing anything.** Look for
the running reverse proxy / web server (nginx/Caddy/Traefik/Apache) and its
site configurations:
```bash
nginx -v 2>&1; caddy version 2>/dev/null; systemctl list-units --type=service | grep -i -E 'nginx|caddy|traefik|apache'
ss -lntp | grep -E ':(80|443)\b'
ls -la /etc/nginx/sites-enabled/ 2>/dev/null
docker ps --format '{{.Names}}\t{{.Ports}}'
```
Do **not** install a second reverse proxy and do **not** modify Vendora's vhost.

For **nginx**, a dedicated site config is provided, ready to adapt:
`deploy/ingress/cloud.tofanservice.ir.conf`. It proxies **only** to
`http://127.0.0.1:${CLOUD_PORT}` and preserves `Host`, `X-Real-IP`,
`X-Forwarded-For`, `X-Forwarded-Proto`. Place it, then validate and **reload**:

```bash
sudo nginx -t                       # MUST pass before reload
sudo systemctl reload nginx         # reload only — never a full restart
```

For Caddy you would add one site block; for Traefik add a router. The key is:
reuse the existing ingress, bound only to loopback, never `0.0.0.0` for the app.

---

## 8. Cloudflare configuration

Configure DNS exactly:

| Field | Value |
|---|---|
| Type | `A` |
| Name | `cloud` |
| Target | production server **public IP** |
| Proxy status | **Proxied** (orange cloud enabled) |

- **SSL/TLS mode:** **Full (strict)** once the origin has a valid certificate;
  until then use **Full**. **Never use Flexible SSL.**
- Do **not** cache `index.html` long-term; the app already sends `no-cache`.
- Static `/assets/*` may be cached aggressively (the app sends `immutable`).

---

## 9. Public health-check policy (STRICT after bootstrap)

The **first** deployment may happen before DNS/reverse-proxy/Cloudflare exist.
Only that initial bootstrap may skip public verification.

- **Initial bootstrap only:** trigger `workflow_dispatch` and set
  `skip_public_healthcheck: true`, **or** run `deploy.sh` manually with
  `SKIP_PUBLIC_HEALTHCHECK=1`. Output explicitly notes that the public path was
  skipped and that a strict re-deploy is required once DNS is live.
- **All normal deployments (default):** `SKIP_PUBLIC_HEALTHCHECK=0`; the
  workflow requires **both**
  - `https://cloud.tofanservice.ir/healthz`
  - `https://cloud.tofanservice.ir/dashboard`
  to return success. A failed public check **marks the deployment failed,
  rolls back to the previous image, verifies that previous image locally, and
  exits non-zero** (failing the GitHub Actions job). This is **not** optional/
  best-effort after setup.

---

## 10. Deployment flow & rollback (what `deploy.sh` does)

1. Reads the previously deployed image from `/opt/tofan/cloud/deployed.version`.
2. `docker pull` the new immutable `sha-...` image (anonymous, or authenticated
   via GHCR creds if present) — fails fast if the pull fails.
3. Writes `/opt/tofan/cloud/compose.yml` pinned to that exact SHA.
4. `docker compose up -d --no-deps` (recreates the `tofan-cloud` container).
5. Waits for the Docker healthcheck to report `healthy`.
6. Verifies **local** endpoints (bypass Cloudflare):
   - `curl -fsS http://127.0.0.1:${CLOUD_PORT}/healthz`
   - `curl -fsS -o /dev/null http://127.0.0.1:${CLOUD_PORT}/dashboard`
7. Verifies **public** endpoints according to §9.
8. On success writes the new SHA + image to `deployed.version` and prints a
   traceability summary.

**Rollback (automatic):** if the container fails to start, becomes unhealthy,
or fails a local or a strict public health check, `deploy.sh` restarts the
**previous** image, waits for it to become healthy, verifies it locally, then
exits non-zero so the GitHub Actions job **fails** and clearly reports that the
fresh deploy was rolled back. An `ERR` trap also guards against unexpected
mid-deploy failures. Production is never left offline by a bad deploy.

The **previous image is not removed** until the new deploy is fully verified.

---

## 11. Daily operations

```bash
# Container status
docker ps -a --filter "name=tofan-cloud"
docker compose -f /opt/tofan/cloud/compose.yml ps

# Logs
docker compose -f /opt/tofan/cloud/compose.yml logs -f tofan-cloud

# What's deployed (traceability)
cat /opt/tofan/cloud/deployed.version
docker inspect tofan-cloud --format '{{.Config.Image}}'

# Health checks (local, bypass Cloudflare)
curl -fsS http://127.0.0.1:8540/healthz          # -> ok
curl -fsS -o /dev/null http://127.0.0.1:8540/dashboard   # SPA route

# Public
curl -fsS https://cloud.tofanservice.ir/healthz
curl -fsS https://cloud.tofanservice.ir/dashboard

# Quick status summary
sudo bash /opt/tofan/cloud/scripts/status.sh
```
Substitute `8540` with your chosen `CLOUD_PORT` if you changed it.

---

## 12. Manual redeploy (workflow_dispatch)

Actions → *Cloud Production Pipeline* → *Run workflow*:
- Runs from `main` with the exact `sha-<commit>` of that commit.
- The `skip_public_healthcheck` input defaults to `false` (strict). Use it
  `true` only for the very first bootstrap.

To roll to a specific older SHA, push a revert/empty commit on `main` and the
workflow deploys its `sha-<commit>` image; old images stay on GHCR and on the
server for rollback.

---

## 13. Recovery when a GitHub Actions deployment fails

Common causes and fixes:
- **SSH secrets missing/wrong** → check `DEPLOY_HOST`/`DEPLOY_PORT`/`DEPLOY_USER`/
  `DEPLOY_SSH_KEY`/`DEPLOY_KNOWN_HOSTS`.
- **Image push failed** → not enough `packages: write`, or first-time GHCR package
  creation needs a re-run.
- **Pull failed on the server** → private package without `GHCR_USERNAME`/`GHCR_TOKEN`,
  or the token lacks `read:packages`. Set the secrets / make the package public.
- **Rollback in progress / failed** → job logs clearly print `[XX] ROLLBACK
  triggered` and the reason. If even rollback fails, manually re-point:
  ```bash
  sudo env CLOUD_PORT=8540 bash /opt/tofan/cloud/scripts/deploy.sh \
       ghcr.io/hamedsanaei/cloud:sha-<goodsha> https://cloud.tofanservice.ir
  ```
- **Public checks failed** → DNS/Cloudflare/ingress not matching; fix them and
  re-deploy. Confirmed healthy locally but failing publicly means the CDN/
  origin path is misconfigured, not necessarily the app.

Always confirm health before re-running CI:
```bash
sudo bash /opt/tofan/cloud/scripts/status.sh
```

---

## 14. Resource usage

The runtime container is nginx serving static files + gzip. It needs very little
CPU/RAM, no Node runtime, no Redis/database/PM2. Docker log rotation is set in
`compose.yml` (`max-size: 5m`, `max-file: 3`, compress).