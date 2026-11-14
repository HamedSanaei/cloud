# Customer server management: issues #17 and #18

> Historical verification snapshot: references to uncommitted code and no deployment describe the local QA session BEFORE this change was submitted. CI/PR/merge and release status must be checked separately. No real Hetzner destructive actions were exercised; unavailable account-scoped features require follow-up.

Status: local implementation on `codex/server-management-17-18`; no commit, push, PR, deployment, real provider mutations or real financial changes. Neither issue is claimed closed. This document separates implemented behavior, executed checks and remaining acceptance work.

## Penpot mapping

File: `c269caa0-e456-818c-8008-89e8e8e7477b`.
Screens page: `46894305-24e0-802f-8008-f0f341372876`.
Components page: `46894305-24e0-802f-8008-f0f5f51146e4`.

Penpot MCP audit retrieved all 31 boards and 921 shapes, including geometry, text, fonts and fills. References are 1440×900 desktop and 390×844 mobile. Preserve the existing Topbar/Sidebar, Vazirmatn, RTL, #2869E8 primary, #EEF6FF page background, #D9E2EC borders, white surfaces and 14px card radii. New CSS is scoped to server components. Typography uses 14px body labels and larger headings/metrics for readability; real timestamps and safety explanations can increase card heights. The existing responsive application shell is retained rather than fixing the entire viewport to 1440px.

| Penpot screen | Board ID | Route/state | React implementation |
|---|---|---|---|
| H18 / 01 / Servers Queued | `46894305-24e0-802f-8008-f0f341833dbc` | `/servers` | ResourceListPage → ServerTableRow / LifecycleBadge |
| H18 / 02 / Servers Provisioning | `46894305-24e0-802f-8008-f0f37fd668ea` | `/servers` | ResourceListPage → ServerTableRow / LifecycleBadge |
| H18 / 03 / Servers Ready + Toast | `46894305-24e0-802f-8008-f0f38531f213` | `/servers` | ResourceListPage → ServerTableRow / LifecycleBadge |
| H18 / 04 / Provisioning Failure + Unknown | `46894305-24e0-802f-8008-f0f3912b61f1` | `/servers` | ResourceListPage → ServerTableRow / LifecycleBadge |
| H17 / 05 / Server Overview | `46894305-24e0-802f-8008-f0f3f02f322a` | `/servers/:id?tab=overview` | ServerDetailsPage / ServerOverview |
| H17 / 06 / Monitoring and Traffic | `46894305-24e0-802f-8008-f0f3faabed03` | `/servers/:id?tab=monitoring` | ServerMonitoring / MetricChart |
| H17 / 07 / Power and Operation History | `46894305-24e0-802f-8008-f0f408a8bdd5` | `/servers/:id?tab=operations` | ServerPowerActionButton / ServerOperationStatus |
| H17 / 08 / Resize / Price Preview | `46894305-24e0-802f-8008-f0f454af6e2e` | `/servers/:id?tab=resize` | ServerResize |
| H17 / 09 / OS Rebuild and Credentials | `46894305-24e0-802f-8008-f0f45eba7427` | `/servers/:id?tab=access` | ServerAccess |
| H17 / 10 / Console and Advanced | `46894305-24e0-802f-8008-f0f46b27d633` | `/servers/:id?tab=console` | ServerConsole |
| H17 / 11 / Delete Confirmation | `46894305-24e0-802f-8008-f0f4b995a744` | `/servers/:id → delete confirmation` | DestructiveConfirmation |
| H17 / 12 / Deletion Lifecycle and Billing | `46894305-24e0-802f-8008-f0f4c2a02a14` | `/servers/:id (all tabs)` | LifecycleBadge / ServerBillingTerminationState |
| H17 / 13 / Force Power Confirmation | `46894305-24e0-802f-8008-f0f4cf9be744` | `/servers/:id?tab=operations → force action` | DestructiveConfirmation |
| H18 / M01 / Mobile Server Provisioning | `46894305-24e0-802f-8008-f0f5136c54db` | `/servers` | ResourceListPage → ServerTableRow / LifecycleBadge |
| H17 / M02 / Mobile Server Overview | `46894305-24e0-802f-8008-f0f519dbd48f` | `/servers/:id?tab=overview` | ServerDetailsPage / ServerOverview |
| H17 / M03 / Mobile Delete Confirmation | `46894305-24e0-802f-8008-f0f522a50ffe` | `/servers/:id → delete confirmation` | DestructiveConfirmation |
| H17 / 14 / Snapshots Backups and Volumes | `46894305-24e0-802f-8008-f0f6ec447896` | `/servers/:id?tab=storage` | ServerStorage (read-only resources) |
| H17 / 15 / Network Security and Rescue | `46894305-24e0-802f-8008-f0f6efbaf3fa` | `/servers/:id?tab=network` | ServerNetwork |
| H17 / 16 / One Time Password Reveal | `46894305-24e0-802f-8008-f0f704a29136` | `/servers/:id?tab=access → confirmed operation` | OneTimePassword |

| Penpot component | Component ID | React implementation |
|---|---|---|
| LifecycleBadge / Provisioning | `46894305-24e0-802f-8008-f0f5f56c3c47` | LifecycleBadge |
| LifecycleBadge / Ready | `46894305-24e0-802f-8008-f0f61e2c494b` | LifecycleBadge |
| LifecycleBadge / Failed | `46894305-24e0-802f-8008-f0f61e39a34c` | LifecycleBadge |
| LifecycleBadge / OutcomeUnknown | `46894305-24e0-802f-8008-f0f61e46068a` | LifecycleBadge |
| ServerTableRow / Provisioning | `46894305-24e0-802f-8008-f0f61e80709c` | ServerTableRow |
| ServerResourceMetricCard | `46894305-24e0-802f-8008-f0f61e9796b6` | ServerResourceMetricCard |
| ServerPowerActionButton | `46894305-24e0-802f-8008-f0f61eaa9ba5` | ServerPowerActionButton |
| ProvisioningToast / Accepted | `46894305-24e0-802f-8008-f0f61ecb06ff` | ToastProvider + WizardPages (info) |
| ProvisioningToast / Ready | `46894305-24e0-802f-8008-f0f61eedacc3` | ToastProvider + useServerFleet (success) |
| ServerOperationStatus | `46894305-24e0-802f-8008-f0f61f2bbf9f` | ServerOperationStatus |
| ServerBillingTerminationState | `46894305-24e0-802f-8008-f0f61f5811d4` | ServerBillingTerminationState |
| DestructiveConfirmation / ServerDelete | `46894305-24e0-802f-8008-f0f61fb62267` | DestructiveConfirmation |

Reusable components are in `src/components/servers/`. Toast presentation uses one global React-Toastify container through the existing ToastProvider API; its lifecycle claims are centralized in `src/lib/serverLifecycle.ts`.

## Backend and frontend behavior

The website-owned Hetzner path uses the website server UUID and an explicit `owning-project:provider-server-id` composite. Never submit an order UUID or raw provider ID as a management ID. Every route authorizes the owner before provider/cache access. Admin inventory has no new customer mutation route. Disabled-for-new-orders accounts remain usable only for their already-owned server references; credentials never fall back to another project.

The shared-platform path retains canonical `platformServerId` and its existing delegated-management UI. Provisioning polling uses the canonical platform reference; it does not call the website-owned Hetzner management endpoints. No bot repository changes are included.

### Provisioning contract

`backend/src/contracts/server-lifecycle.ts` is the shared pure TypeScript source.

```ts
type ProvisioningState = 'queued' | 'provisioning' | 'ready' | 'failed'
  | 'requires_review' | 'outcome_unknown' | 'cancelled'
interface ServerTracking {
  source: 'site' | 'platform'
  reference: string
  orderId: string | null
  serverId: string | null
  operationId: string | null
  state: ProvisioningState
  createdAt: string
  updatedAt: string
}
```

- POST `/api/servers` preserves Idempotency-Key and returns a tracking row, not false readiness. Before a real server exists its row ID is `order:<uuid>`; tracking.serverId stays null.
- GET `/api/servers` recovers owned pending orders after navigation/reload, including uncertain and failed records; at most 50 no-server pending/history rows are appended.
- GET `/api/servers/provisioning/:orderId` returns the correlated authoritative row.
- GET `/api/servers/provisioning/platform/:platformServerId` is intercepted by the shared-platform integration only. Site-only mode rejects that path.
- Create acceptance shows an informational toast, remembers a user-scoped pending row immediately, and navigates to /servers. No success toast is tied to HTTP 200/201.
- Only provider-observed activation makes a site server ready. Real UUID/resources replace the row using stable source:reference identity. Unknown resource fields are empty in the contract and shown as “در حال دریافت”.
- Targeted polling starts at 3s, backs off to 30s, stops after 60 rounds, pauses hidden-page network polling, aborts on unmount and restarts on focus/manual refresh. Failed reads retain unresolved rows and never create a second order.
- IndexedDB transactions serialize terminal notification claims across tabs, remounts and reconnects. Existing ready servers establish a baseline without a new-build toast. No polling transition creates a charge.
- Notification guarantees require working IndexedDB. When storage is denied, checkout/tracking still work and terminal toasts are suppressed to avoid duplicates. Browser termination between durable claim and toast rendering cannot provide transactional exactly-once screen delivery; backend state remains authoritative.
- Lifecycle events invalidate dashboard/server counters and wallet summaries independently of toast availability.

### Management API

All paths below also exist under /api/v1. All return authenticated, no-store responses.

| Endpoint | Contract |
|---|---|
| GET /servers/:id/management | Owned server DTO, nullable current provider facts, subscription status, immutable original provider quote, last 30 operations, session-bound credential availability; 15s provider-read cache |
| GET /servers/:id/metrics?window=1h\|6h\|24h | CPU/network/disk real samples, null for missing/NaN; 60s cache, 12 requests/min, bounded samples |
| GET /servers/:id/images | Current-project available system images of compatible architecture |
| GET /servers/:id/resize-options | Available current-location/architecture provider types that also have a published retail offer |
| POST /servers/:id/resize-preview | {offerId, upgradeDisk}; stopped-server/disk/storage validation, backend retail quote, immutable baseline and expiry; no immediate charge |
| POST /servers/:id/management/actions | Discriminated strict body with action, confirm:true, exact hostname, action-specific fields; Idempotency-Key required |
| POST /servers/:id/credentials/claim | {operationId}; confirmed, encrypted, unexpired output for initiating user/session; atomic once-only claim |
| POST /servers/:id/credentials/ack | Clear any remaining encrypted output for initiating session |
| POST /servers/:id/console | Cookie session, owner and provider capability required; one-use 90s grant and ephemeral password |
| WS /servers/:id/console/:grantId | Cookie/session/owner/Origin validation, atomic grant consumption, server-side upstream relay, five-minute maximum |

Actions: power_on→poweron, shutdown→shutdown, power_off→poweroff, reboot→reboot, reset→reset, delete→DELETE server, resize→change_type, rebuild, reset_password, enable_rescue, disable_rescue, detach_iso, change_protection. New ISO attachment is explicitly rejected because ownership/catalog authorization is not implemented.

Operations are persisted before dispatch. One incompatible unresolved operation is allowed per owned server. A user-scoped stable idempotency key binds a request hash; a changed request with the same key is rejected. Workers atomically claim pending work and do not redispatch running/unknown work. They store the provider Action ID and require its command/status plus final VM state. Unknown action identity remains unknown rather than guessing success or retrying a destructive command.

Power Off regression causes addressed:
1. Fractional traffic (e.g. 0.25 GB) was written into an integer PostgreSQL column during synchronization. The compatibility column now stores floor(GB); precise byte usage remains in allowlisted metadata.
2. An accepted provider HTTP response or an observed VM state alone must not finish a newly tracked Action. Action ID/status and final target state are reconciled separately.
3. Legacy previously accepted on/off operations that lost Action IDs can recover only after observing the explicit target state; reboot is never inferred from “running”.

### Resize and billing

Resize uses the original owning project, stopped VM, location availability, matching architecture/storage type and no disk shrink. upgrade_disk is explicit. Only a server-scoped, user-scoped, unexpired backend quote can be submitted; client prices and changed preview flags are rejected. A dispatch-time baseline check prevents applying an obsolete preview.

A confirmed resize changes the subscription price for future invoices and records before/after price in an immutable subscription event. Settled invoices and ledger entries are never recalculated. There is no immediate resize debit or automatic proration. The original provider quote is labeled separately from the customer price; it is not a claim of the provider's current invoice rate.

### Deletion and financial locking

`deletion_requested → deleting → terminated`, or `delete_failed/outcome_unknown`.

- Request creation immediately sets a durable renewal fence under the same user lock used by renewal processing. This holds new renewals while deletion is unresolved; it does not claim provider billing stopped.
- Exact hostname plus warning acknowledgement is mandatory. Delete protection is checked live.
- Only authenticated provider 404/not_found proves absence; 403, timeouts, Action acceptance or Action success alone do not prove deletion.
- Confirmed absence atomically marks the server terminated, cancels its subscription/auto-renew, cancels pending renewal attempts/stale actions, voids only unpaid invoices, and wipes transient credentials.
- Previously paid invoices and wallet ledger entries are retained. No automatic refund/proration is introduced. Independent Volume/Snapshot/IP resources can survive; the UI warns about this and does not claim their charges stopped.
- Replayed delete requests do not issue a second provider DELETE. Interrupted workers reconcile without speculative resubmission.
- A stale queued start after termination is rejected. Loss of funding before start dispatch terminally fails that operation without calling Hetzner.
- Power Off does not stop Hetzner compute charges. The project's existing hourly customer-billing/suspension policy remains separate from provider billing.

### Legacy power operations without a receipt

The customer's Delete section shows the blocking operation ID, request time, live power state, recheck, and support link. In Admin → Servers → server details, **بررسی عملیات برق بدون رسید** reads state and action history through the owning Hetzner project. Match the original dispatch to a terminal Action ID and record how it was matched. The API verifies the server resource, command, dispatch window, terminal status, and that the receipt has not been used before. It records the evidence and audit entry once and releases the lock without reissuing the power command. If the history has no match, ask Hetzner support for a verifiable Action ID and leave the operation unresolved. A current power state or an empty action list cannot establish the original outcome.

### Credentials and console

New reset/rebuild/rescue secrets use AES-256-GCM with an HKDF-derived context-specific key from AUTH_SECRET. They are bound to server/user/session/operation, expire in five minutes, and are consumed atomically after provider-confirmed completion. Claiming wipes ciphertext and the browser keeps plaintext only in memory for at most 60 seconds; hidden/unmounted views clear it. Existing passwords are not presented as retrievable. There are no secrets in histories, persistent browser storage or backup table data.

Console grants contain an encrypted allowlisted wss://*.hetzner.cloud URL, never returned to the browser. noVNC connects only to the authenticated same-origin relay. Origin/session/ownership, bounded buffers, expiry, logout/maintenance rechecks and cleanup are enforced. The initial grant is consumed under the normal writer gate; its coordination lock is then released so a long-lived console cannot pin recovery. Existing connections close on maintenance checks (up to 30s) or the five-minute limit. Host ingress and container nginx need the included WebSocket upgrade routes; otherwise the UI shows genuine connection failure.

## Database and rollout (not executed on production)

New additive migration: `backend/drizzle/0010_customer-server-management.sql`, matching schema/journal/snapshot. Adds termination fencing columns and the encrypted transient server_secrets table. Existing server enum and paid financial records are retained.

1. Review the diff, stable AUTH_SECRET, actual Hetzner project credentials/permissions and owning composites. Do not invent credentials or provider rates.
2. Take and restore-verify a current database/config backup under the repository's deployment procedure. New transient server_secrets rows are excluded from backup data; they must never be restored as live grants.
3. Apply migrations with the existing exclusive deployment/migration locks before starting the new API/worker. Keep old/new worker concurrency controlled.
4. Deploy matching backend API and worker, then the frontend and reviewed nginx/host-ingress configuration. Run nginx -t before reload; this task did not reload any real service.
5. Confirm API readiness, internal routing, authenticated WS Origin behavior and no duplicate workers. Review console origin allowlist against the actual provider response before enabling it.
6. Verify a dedicated authorized resource with explicit operator approval for any actual power/rebuild/delete action. Check the paid ledger before/after and cancellation only on proven absence. None of these live actions are authorized by this task.
7. Roll back application images if necessary while retaining the additive schema and financial audit records; never drop the migration or recover old transient grants merely to roll back UI code.

## Acceptance boundaries

Implemented and mock/integration-tested: provisioning correlation/visibility, conservative lifecycle toasts, core power commands, resize, rebuild submission/image validation, one-time credentials, console authorization/relay, deletion reconciliation and renewal fencing, rescue/ISO detach/protection.

Explicitly unavailable (not simulated working): customer creation/restoration/deletion of snapshots and backups, volume mutations, firewall/private-network/floating-IP mutations and new ISO attachment. Their independent ownership, pricing and retention policy are absent in the current storefront schema; project-wide inventory is not proof of customer authorization. Attached resource IDs/status are read-only. These capabilities require a separately reviewed ownership/billing model before customer mutations can be enabled.

Provider does not supply a traffic-period boundary in the inspected server response; UI says unavailable. Real provider permission availability and real console connectivity have not been live-tested. Shared-platform endpoints are contract-tested/mocked, not newly deployed. Therefore #17 remains open for these acceptance decisions and authorized live validation. #18 has automated coverage and local visual QA, but full independent acceptance/sign-off is not claimed.

## Verification record

See `SERVER_MANAGEMENT_VERIFICATION.md` for actual command results and local Chrome screenshots. Fixture preview: `node scripts/preview-design.mjs --servers` (loopback only, synthetic data, no real APIs). Test fixtures are isolated from production imports.
