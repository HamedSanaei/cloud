# Store administration and recovery — Issue #9

## Activation and authorization

UI: `/admin/settings/{gateway,logs,backups,finance}`. API: identical routes under
`/api/admin/settings` and `/api/v1/admin/settings`. Requires site authority.
All active admins can access store settings. The API verifies active admin status
rather than a fixed UUID allowlist. The current active admin session grants access
with no second password or TOTP challenge.

Set secrets through the protected host environment/secret manager, never Git or
`VITE_*`. Migration **0009** adds four tables; no balances or existing data are
rewritten. Defaults leave system backups/restore disabled.

```dotenv
STORE_SECRET_KEY=<independent random 32-byte key as 64 hex characters>
SYSTEM_BACKUP_KEY=<different independent random 32-byte key as 64 hex characters>
SYSTEM_INSTANCE_ID=<stable unique deployment UUID>
SYSTEM_BACKUP_ENABLED=true
SYSTEM_RESTORE_ENABLED=false
SYSTEM_BACKUP_MAX_MB=64
SYSTEM_BACKUP_MAX_TOTAL_MB=1024
SYSTEM_BACKUP_RETENTION_DAYS=30
SYSTEM_LOG_RETENTION_DAYS=30
```

Keep both keys, AUTH_SECRET, the instance ID, provider configuration, merchant
environment fallback and a compatible release independently backed up off-host.
Changing external keys/configuration can make old backups unusable. No real
keys, host settings, customer data or Production runtime were changed for this PR.

Store settings require an authenticated active admin session but no additional
password prompt or TOTP enrollment. Sensitive action proofs are issued automatically
per requested action and remain bound to the current session and exact payload.
Each sensitive action uses a short-lived single-use grant bound to actor, current
admin session, action, canonical payload and current account credential version;
it expires after five minutes and is consumed transactionally once.
Download grants expire after **60 seconds**. No proof/credential is put in URLs
or browser storage. Backend role/MFA/payload checks are independent of the UI.

## Gateway and credential rotation

`tabapay.active` is an authoritative DB override; env values are used only before
an override exists. Changes apply to subsequent requests without restart.
Merchants are immutable AES-256-GCM encrypted versions with per-record nonce/AAD.
GET returns only masked suffixes, fingerprints, dates and effective domain/URLs.
The independent `STORE_SECRET_KEY` stays outside the DB; never rotate it without
a separately reviewed re-encryption/recovery procedure.

Rotation serializes with creation of payment intents, preserves the previous
environment/current credential and selects credentials by the payment's original
fingerprint for Verify and callback signatures. Previous versions are not deleted.
Disabling the gateway blocks **new creation**, while old payments remain verifiable.
Rollback selects a saved credential version. Do not rotate env fallback out of
band while legacy pending payments still need it.

The non-financial diagnostic makes only a HEAD reachability request, sends no
merchant and creates no transaction. The [official API](https://tabapay.ir/docs/api)
does not document a transaction-free merchant/domain validation endpoint. The UI
therefore explicitly distinguishes local UUID validity, network reachability,
provider domain confirmation and browser Referer behavior; it never claims the
provider approved the domain. Actual issuer codes -10/-11/-30 are categorized as
credential errors and -27 as domain mismatch in sanitized payment failure audits.
The payment link now uses `rel=noopener` and `referrerPolicy=origin` (related #7).
No real gateway form/payment was created to validate the merchant in this PR.

## Financial adjustments

Search uses complete case-insensitive email or normalized Iranian mobile
(Persian/Arabic/Latin digits, 09/+98/98). It does not do fuzzy/prefix matching.
Select exact identity and owned wallet. Amounts are positive safe integer **Rial**,
with mandatory reason, tracking reference and explicit confirmation. Requests use
a stable actor-scoped idempotency key; changing the payload under that key conflicts.

The wallet is locked **before** inserting its FK into the adjustment table, avoiding
key-share upgrade deadlocks. Only `creditWallet`/`debitWallet` and the existing
immutable ledger perform credits/debits. Debit rechecks the seven-day commitments
under that same lock. Failure rolls back the grant, request, balance and ledger.
The legacy `/admin/wallets/:walletId/{credit,debit}` endpoints now require the same
proof, exact user, reason/reference, confirmation and stable key; old weak payloads
are intentionally rejected. There is no alternate timestamp-keyed credit path.

All manual wallet adjustments complete directly for an authenticated active admin.
Ownership, wallet commitments, input validation and idempotency still prevent
invalid balances and repeated posting. History shows target identity/wallet, request/reference, actor,
approver and actual before/after balances; these are transactionally audited.

## Logs

The panel combines append-only Audit with a bounded sanitized event mirror from
API failures, structured logger events and worker jobs. It is not a raw Docker
log viewer. Only whitelisted structured metadata is exposed: no raw error text,
request bodies, OTPs, headers, cookies, JWTs, merchants or customer contact data.
Server-generated correlation UUIDs are returned as `X-Request-ID`; request query
strings/headers are omitted from Pino request serialization. Timezone is displayed.

Filters cover time, severity, service, actor and action; search covers event/
request IDs, with pagination/details. JSON exports are limited to 1,000 sanitized
records, use session-bound action proofs, and are audited; viewing logs and financial history is audited.
Operational rows expire by the configured retention, cleaned in bounded batches.
The mirror has a 100-write in-flight limit and skips maintenance; bursts/database
outages can drop mirror events. Transactional financial/security audits are awaited
and never use this lossy mirror. Audit is not automatically deleted. Full process
logs remain under the existing protected Docker logging policy.

## Backups, restore and operational prerequisites

The API image includes PostgreSQL **17** client tools. Backup/restore requires
matching client/server major versions, a schema head matching the running release,
and a trusted DB owner with `CREATEDB` for rehearsal (no host/root/Docker socket).
Use a role scoped to this application's schemas; do not grant server-program execution.

Durable artifacts/manifests live in the private `system-data` volume at
`/var/lib/parserver/system`, with 0700 directory / 0600 files. Only authenticated
AES-GCM `.psb` archives from this instance/configuration are accepted; arbitrary
SQL, raw/foreign pg_dump files, filenames and server paths are never input to a
restore command. [PostgreSQL warns that restores execute source-controlled code](https://www.postgresql.org/docs/current/app-pgrestore.html),
so authenticating the source is mandatory, not just checking a file extension.

`pg_dump -Fc` uses a single exported repeatable-read snapshot for data, metadata
and financial/security fingerprints. Persistent files are encrypted and fsynced
before being marked complete. Plaintext intermediates exist only in private
**RAM-backed `/dev/shm`** directories, verified as tmpfs, never in the persistent
backup volume. API Compose sets `shm_size: 1gb`; size/time limits fail closed.
Host swap/storage encryption remains an operator prerequisite. Metadata includes
checksum, size, timestamp, PG/schema version and row counts. Each tool is limited
to ten minutes. Encrypted storage has a total budget and retention; active and
unresolved recovery safety backups are protected.

Download is an authenticated one-use **POST**, not a shareable query-string link;
the response stays encrypted and has an attachment filename. Upload is bounded
and authenticated before buffering. The inner Nginx permits at most 65 MiB only
on the upload route; ordinary API JSON remains capped at 256 KiB. Review/apply the
equivalent upload limit and streaming proxy directive in the **actual host ingress**
before release, preserving its existing listeners/certificates. Checked-in ingress
templates were updated; no live ingress was changed. Larger configured backups
also require separately adjusted ingress/shm/resource limits.

Rehearsal restores into a generated, isolated temporary DB, validates schema,
financial/security fingerprints and wallet/ledger consistency, and drops that DB.
The UI shows current/backup counts and the data-loss warning. A plan lasts 15 minutes;
changed counts invalidate it. Restore requires `SYSTEM_RESTORE_ENABLED`, typed
`RESTORE DATABASE` and successful rehearsal. The initiating admin's active role
is rechecked before execution; no second approval is needed.

Restore automatically refuses financial/security/configuration drift or unresolved
orders/payments/provider operations. It does **not** rewind a newer ledger and
hope external payments/VPS state match. Such recovery requires separately approved
offline reconciliation, matching provider evidence and a compatible release.
External provider state changed outside this app must also be reconciled by the operator.

API requests (including GET callbacks), jobs and migrations use session-pinned
PostgreSQL advisory writer locks through a separate bounded pool. Restore drains
writers, creates a fresh pre-operation backup and actually rehearses it before
the first destructive statement. A durable maintenance marker is written first;
`pg_restore --clean --if-exists --single-transaction` then restores the trusted
archive. Postchecks precede release. Audit rows newer than the archive are merged
back; auth sessions/challenges/step-up grants are excluded from dumps so restored
revoked access cannot return. Administrators must sign in again after restore.

Worker jobs are delayed without burning retry attempts during maintenance.
Readiness returns 503 while the marker exists; liveness remains available. Deploy
uses a dedicated guard container holding the operation lock for preflight,
migration, health checks and rollback. It is not another API/worker/Telegram poller.
No gates were removed or weakened.

## Failure and offline recovery

On a restore error, the verified pre-operation backup is restored and checked.
If rollback is uncertain or the process crashes, the persistent marker keeps
writers blocked across restart; interrupted work is marked, **never auto-replayed**.
Do not remove `maintenance.lock` to make health green.

Inspect through the matching image/config/private volume, then, only with separate
operator authorization, explicitly roll back to the operation's recorded safety file:

```sh
node dist/scripts/system-recovery.js <operation-uuid>
node dist/scripts/system-recovery.js <operation-uuid> --confirm-rollback
```

The second command acquires both locks, authenticates/rehearses the safety backup,
restores it transactionally, verifies the result, writes an audit and clears the
marker. If PostgreSQL/permissions are unavailable, retain the private artifacts and
operator evidence; inspect any generated `parserver_restore_*` scratch DBs before
manually removing an orphan. Never run an uploaded SQL file to repair the system.

RPO is the timestamp of the latest **verified** retained backup; manual backups
are not PITR/WAL archiving or an automatic schedule. RTO for Production is not yet
measured: establish it with a realistic isolated dataset and all external secrets
before enabling live Restore. Full disaster recovery with missing databases/volumes
requires the operator's off-host archives, keys and offline reconciliation; this UI
is not a bypass for those prerequisites. No wallet, order, invoice or VPS side
effect is synthesized by these tools.

## Validation

- Backend integration cases cover isolated PostgreSQL, including all new
  access, grant/session/payload replay, credential rotation/callback, normalized
  search, duplicate/racing financial adjustment, funding and sanitized log cases.
- Built-image real-tool smoke tests cover encrypted backup/upload/download,
  tampered/raw-file refusal, rehearsal, two-person restore, a lost success ACK
  followed by actual rollback, durable interruption/offline recovery, drift
  refusal, logout semantics and temporary DB/file cleanup. They run in CI too.
- Frontend/backend typecheck, lint/build and migration schema checks; new UI
  regression cases are included in existing CI. Local unit tests were not run.
- Current Chrome synthetic preview: four sections, identity selection and review,
  focus containment, persisted admin theme, light/dark and 390px mobile without
  horizontal overflow. No real merchant, payment, customer or provider was used.
- PR only; no merge, deployment, live backup/restore or customer balance change.
