# Dependency security update — 2026-10-25

Scope: the frontend and `backend/` npm projects in this repository. Validation
below was performed locally, without production deployment or production
migration. Existing brand, domain and UI changes are separate from this
dependency update. Publishing this update uses the normal CI/deployment pipeline.

## Framework and versions

This application uses React/Vite and Fastify. Neither npm dependency tree
contains Next.js, so no Next.js installation or framework migration is needed.
The [Next.js security bulletin](https://nextjs.org/blog/nextjs-security-update-october-14-2026)
was reviewed, but its Next.js-specific fixes are not applicable to this tree.

Direct dependencies were checked against the public npm registry's stable
`latest` tags. Both manifests and lockfiles were updated, including compatible
transitive dependencies. Selected installed versions:

| Package | Before | After |
| --- | --- | --- |
| react / react-dom | 19.2.8 | 19.3.1 |
| react-router-dom | 7.18.2 | 7.18.4 |
| lucide-react | 1.34.0 | 1.61.0 |
| vite | 8.2.2 | 8.3.5 |
| @vitejs/plugin-react | 6.1.0 | 6.1.2 |
| fastify | 5.12.3 | 5.12.7 |
| bullmq | 6.3.4 | 6.4.2 |
| drizzle-orm | 0.45.2 | 0.45.4 |
| drizzle-kit | 0.31.10 | 0.31.11 |
| nodemailer | 10.1.2 | 10.2.1 |
| zod | 4.5.4 | 4.6.7 |
| backend vitest | 5.0.0 | 5.0.5 |
| backend TypeScript | 5.9.3 | 6.0.3 |

The manifests/lockfiles contain the complete version list, including updated
Fastify plugins, React types, PostgreSQL client, logging and lint tools.

### TypeScript compatibility exception

Frontend TypeScript remains at the latest stable 7.0.2. Backend TypeScript is
held at `~6.0.3`, the latest supported stable minor for `typescript-eslint`
8.72.0, whose peer range is `>=4.8.4 <6.1.0`. The shared lint toolchain runs
from `backend/`. Dependency installation did not use `--force`,
`--legacy-peer-deps`, a peer override or a disabled lint rule. Revisit this hold when the latest stable lint toolchain
officially supports TypeScript 7. See the
[maintainer's compatibility policy](https://typescript-eslint.io/users/dependency-versions/).

### Legacy Drizzle loader

Even the latest stable Drizzle Kit retains `@esbuild-kit/esm-loader`, whose
`core-utils` dependency requests vulnerable esbuild 0.18.x. A narrowly scoped
override installs esbuild 0.28.2 under `@esbuild-kit/core-utils`. Other esbuild
consumers keep their compatible versions; Drizzle Kit was not downgraded and
no prerelease was installed. Compatibility was verified with both legacy
loader transform APIs and actual schema generation to a temporary directory.
No generated SQL was added to the application's migrations.

## Audit and CI

Before: frontend 1 vulnerable dependency (high); backend 10 (2 high,
8 moderate). After: `npm audit` reports **0** in both trees, including dev
dependencies; the backend production-only audit also reports 0.

The workflow now runs `npm audit --audit-level=low` for both projects after
installation. Advisory or audit-service failures stop the respective job.
Existing tests, migration validation, builds and deployment checks remain.

## Validation

- Frontend: build, typecheck, lint and all 42 tests passed.
- Backend: typecheck, lint, build and all 186 unit/integration tests passed
  against isolated local PostgreSQL 17 and Redis 7, with mock providers and
  test-only authentication delivery. No integration tests were skipped.
- The dependency-only staged snapshot was also exported and validated without
  the unrelated local UI/branding changes: frontend build/lint and 38 tests,
  backend typecheck/lint/build and 133 unit tests all passed.
- `drizzle-kit check` passed. All 7 committed migrations applied successfully
  to the temporary database. Startup reapplied the migrator idempotently.
- Drizzle schema generation covered all 30 tables, writing only to a fresh
  temporary directory. Sync and async legacy loader transforms passed.
- Both Dockerfiles built successfully using `npm ci` with the updated locks.
- Local Website and API containers reached Docker Healthy, with zero restarts.
  `/healthz`, SPA `/register`, and proxied `/api/health/ready` returned HTTP 200;
  readiness reported the database check as OK. Redis returned PONG.
- The production API image successfully loaded native argon2 and performed
  a hash/verify round trip.
- The local mock-provider worker reached `cloud worker ready` with zero
  restarts, scheduled BullMQ jobs in the isolated Redis instance and completed
  both server-sync and renewal-sweep jobs. The API-only HTTP health probe was
  disabled solely for this temporary worker smoke container; no application
  or production health checks were changed.

These results cover npm dependencies and local compatibility. Host packages,
container OS vulnerabilities and the separate Python platform are outside
this npm update. Production requires its normal authorized deployment.
