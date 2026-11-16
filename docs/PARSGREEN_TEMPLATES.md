# ParsGreen transactional SMS

The source of truth is `backend/src/modules/auth/parsgreen-templates.ts`. On 2026-11-16 the owner confirmed registration **and approval of the shortened dynamic business patterns and domain-bound OTP**, then separately confirmed dynamic password-recovery and account-operation approval. This is an **owner attestation**, not an automated query of the provider portal. The two old rejected texts (ticket reply and incident detected, recorded 2026-11-12) are superseded only by the newly approved shortened patterns; their old text must not be reused.

## Sender priority

1. Dedicated service line `PARSGREEN_PRIMARY_FROM`, default **9998883511**.
2. If it explicitly rejects/is unavailable, the existing `PARSGREEN_FROM` service route gets the **same approved rendered pattern**, once.
3. Business-message transport timeouts or undecodable responses are **unknown**, not safe rejection: no blind retry/failover. An accepted response is provider acceptance, **not handset delivery**. OTP retains the previously authorized bounded primary/fallback behavior with the **same code**, not a second challenge. A primary timeout can therefore cause two copies of that OTP; neither grants a second session.

The ParsServer login OTP now uses `پارس سرور: کد ورود %%؛ محرمانه` followed by exactly `@parserver.ir #%%`, with no trailing newline. On the trusted frontend origin, WebOTP remains enabled. Other origins do not enable WebOTP. An explicitly configured approved pattern for other HTTPS frontends remains supported. Never change a provider pattern/domain without renewed approval.

## Independent controls

Active store Super Admin policy is the existing `systemAdmin`/site-authority policy (this installation has `admin`/`user`, not a separate invented role or admin-ID list). Open **مدیریت → تنظیمات فروشگاه → پیامک‌های پارس‌گرین**.

* All 20 new business switches start **off**. The four supported auth channels start **on**, retaining existing mobile registration/login. No historical notification campaign runs on deployment.
* Values live in PostgreSQL `sms_preferences`, one version per key. Stale saves return 409 and cannot overwrite another switch. Audit records contain actor, previous/new enabled/approval, version and time.
* Enabled, dynamic provider approval, code readiness and configured transport are separate. An unapproved/rejected pattern never sends. Approval is tied to a SHA-256 of the exact registered pattern: a later text change blocks delivery until the admin explicitly re-attests approval.
* Disabling an auth channel or changing approval requires the current admin password, `تأیید تغییر امنیت پیامک`, and current TOTP when configured. OTP is never bypassed. Email login/recovery remains independent. Phone-only customers must contact support if their SMS channel is disabled.
* Provider approval may be revoked in this UI as soon as the operator learns of a provider-side change. There is no provider approval-status API polling in this implementation.

## Delivery and timing

`enqueueSms` runs inside the successful business transaction. The outbox unique key is `(event_id, template key, user_id)`. It stores a masked recipient and phone hash, plus private rendering inputs in the database; history APIs never return those inputs or raw phone. Only active users with a currently verified Iranian mobile are eligible. Changing the profile phone clears verification.

The existing scheduled server-sync sweep drains up to five events per job after transaction commit. A disabled/config-blocked/unapproved/missing-recipient event is terminal and never becomes a catch-up send. Pending events re-check current settings, pattern digest and verified phone just before sending. The send holds a shared preference lock over the bounded provider request: a concurrent disable waits for an already-started send, and once disable returns no later sender can cross that boundary with the old setting. It cannot retract a provider-accepted message.

A row is claimed durably as `sending` before the network call. Rejection is terminal; an ambiguous result or a sending claim orphaned for five minutes becomes `unknown` and is **not automatically retried**. This intentionally favors avoiding duplicates over claiming exactly-once handset delivery. Operators must investigate unknowns rather than blindly resetting them. No delivery receipt API is implemented. Backup/restore must preserve preferences **and outbox**; replaying an older backup containing pending rows requires an operator review before enabling the worker.

## Event matrix

All rows use their own saved switch and approval. `backend/test/integration/sms-events.test.ts` drives these producers against ephemeral PostgreSQL and mock provider/SMS transports; CI emits `SMS_MATRIX` lines with keys/segment counts only.

| Key | Successful producing transition | Initial enabled |
|---|---|---|
| ticketCreated | committed support ticket | off |
| ticketReplied | persisted staff reply; request UUID prevents replay | off |
| ticketClosed | persisted closed transition | off |
| incidentDetected | admin-confirmed incident record; one open incident per server | off |
| incidentResolved | resolution of that existing incident | off |
| serviceSuspended | expired-grace subscription suspension | off |
| serverStoppedNoCredit | provider-observed stopped state with billing-block marker, never queued command | off |
| walletLowBalance | existing 72-hour forecast warning, shared six-hour cooldown | off |
| serviceExpiring | active prepaid service ending within 24 hours; once per period end; no hourly spam reminder | off |
| serviceRenewed | settled renewal invoice and extended period, including hourly if enabled | off |
| provisioningDelayed | order still paid/queued/provisioning 15 minutes after payment; once per order | off |
| serverActivated | provider-backed active observation and atomic subscription activation | off |
| orderPaymentFailed | definitive wallet-payment rejection on a durable unpaid order; not gateway timeout or insufficient funds on an order that never existed | off |
| invoiceIssued | committed initial/renewal invoice | off |
| orderRefunded | committed order-referenced refund ledger entry | off |
| walletCredited | committed positive wallet transaction, exact amount and resulting balance | off |
| orderPaid | committed confirmed order payment | off |
| orderCreated | committed order | off |
| newLogin | newly persisted authenticated session; not token refresh | off |
| passwordChanged | successful reset/change transaction | off |
| phoneVerification | existing phone registration OTP | on |
| phoneLogin | existing verified-phone login OTP, including compact domain variant | on |
| passwordRecovery | `/auth/password/forgot/phone` and the password reset flow; verified active phone only | on |
| accountOperation | `/auth/account/operation/start` then `/auth/account/password`; bound to user/session/password-change purpose and existing credentials | on |

No incident is invented from a provider timeout. The incident form requires an explicit admin-confirmed report/resolution. Staff ticket reply/close is available in the ticket detail modal; customers can read persisted replies. A failed wallet top-up has no server order reference and does **not** masquerade as `orderPaymentFailed`; its existing wallet-payment error remains separate.

## Length and cost

Run `npm --prefix backend run sms:audit`. The tool prints **synthetic samples only**. UTF-16 length is counted after substitution: ≤70 = one part; otherwise `ceil(length / 67)`. Boundaries 70/71/134/135, surrogate pairs, ZWNJ/newlines and long IPv6/IDs are covered in tests. All 24 normal synthetic samples fit one part; the previous domain-bound runtime OTP was 86 units/two parts and the new one is 56/one part.

Real UUID ticket IDs, long service names, large amounts and IPv6 can make an approved pattern multipart. Do not truncate references/security instructions to hide that cost. The example generic fallbacks proposed in #95 have **not** been separately confirmed approved, so none are sent. Outbox history shows the real rendered business-message segment estimate; low-level transport logs count every actual primary/fallback text without recording text/code/phone/credentials. Auth catalog estimates are for the displayed approved variant; provider-route logs are authoritative for manual/legacy variants.

## Rollout and recovery

Migration `0013_sms-control-outbox` only adds tables and a nullable quote snapshot; it transfers/deletes no customer money or existing records. Back up the database with `pg_dump` as usual. The application backup schema-head check will reject incompatible binaries on restore. Defaults are lazy, durable and repeatable; enabling one event does not enable others. Configure the existing real signature and legacy sender; never use fabricated settings to pass readiness. This PR does not deploy, send live test messages, or perform provider operations.

For OTP expiry, resend keeps the original attempt budget and expiry. After expiry the server returns `410 challenge_expired`; the UI provides an explicit start-over path. Starting before original expiry cannot reset SMS attempts. Email recovery remains available when SMS is disabled; configured TOTP is still required for sensitive password changes.

### Online restore freshness

The backup safety fingerprint covers all SMS preferences and outbox sending state, preventing rewind of a pending/accepted/unknown delivery. Its only SMS exclusion is a permanently terminal `newLogin` + `skipped_disabled` notice: authorizing recovery creates new sessions and these non-sendable session notices must not masquerade as financial changes. This matches the existing exclusion of transient session rows. `pg_dump` still archives every row; the SMS-outbox safety count excludes only those disabled login notices. The isolated recovery smoke test proves that a synthetic **accepted** login receipt still blocks restore, while ordinary re-authentication with login notifications disabled allows the existing restore/recovery protocol. No wallet/order/credential/approval freshness check is removed.
