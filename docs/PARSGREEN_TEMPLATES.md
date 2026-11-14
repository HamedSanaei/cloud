# ParsGreen SMS templates — Pars Server

Source: operator-supplied ParsGreen WhiteText screen, 2026-11-12.
Canonical exact samples and event keys: backend/src/modules/auth/parsgreen-templates.ts.
Agents must update BOTH files when a message, approval status or event changes.

## Approval semantics

These are message samples from the ParsGreen panel, NOT ParsGreen API template IDs.
An approved-sample status means that the specific literal sample was marked
«تایید» in the supplied table. It does NOT prove that dynamic replacements
(ticket number, IP, amount, date, service, etc.) are approved for WhiteText
delivery to blacklisted recipients. Obtain approved dynamic patterns and their
official API identifiers/method before sending transactional events in production.

- rejected: the panel explicitly marked «عدم تایید». Do not use live.
- unknown: the panel supplied no approval status. Treat as unapproved.
- Duplicate rows (ticketClosed and walletCredited) were recorded only once.
- Fixture values such as 192.0.2.x, cloud-01, invoice IDs, amounts and dates
  must NEVER be sent as if they were real customer data.
- %% is exactly the marker in the rejected samples. Its meaning as a provider
  variable syntax has not been confirmed.

| Catalog key | Event | Status | Dynamic values |
| --- | --- | --- | --- |
| ticketClosed | ticket.closed | approved-sample | ticketNumber |
| ticketReplied | ticket.replied | REJECTED | ticketNumber |
| ticketCreated | ticket.created | approved-sample | ticketNumber |
| incidentResolved | service.incident_resolved | approved-sample | serviceName |
| incidentDetected | service.incident_detected | REJECTED | serviceName |
| serviceSuspended | service.suspended | approved-sample | serviceName |
| serverStoppedNoCredit | server.stopped_no_credit | approved-sample | serviceName |
| walletLowBalance | wallet.low_balance | approved-sample | serviceName |
| serviceExpiring | service.expiring | approved-sample | serviceName, endDate |
| serviceRenewed | service.renewed | approved-sample | serviceName, endDate |
| provisioningDelayed | server.provisioning_delayed | approved-sample | orderNumber |
| serverActivated | server.activated | approved-sample | serviceName, serverIp |
| orderPaymentFailed | order.payment_failed | approved-sample | orderNumber |
| invoiceIssued | invoice.issued | approved-sample | invoiceNumber, amount |
| orderRefunded | order.refunded | approved-sample | amount, orderNumber |
| walletCredited | wallet.credited | approved-sample | amount, balance |
| orderPaid | order.paid | approved-sample | orderNumber, amount |
| orderCreated | order.created | approved-sample | orderNumber |
| newLogin | account.new_login | approved-sample | ip |
| passwordChanged | account.password_changed | approved-sample | none |

The full original Persian message is retained in the TypeScript catalog; keep
texts in sync with the ParsGreen panel after approvals or modifications.

## Authentication SMS (separate from notification templates)

- POST /api/v1/auth/register/phone/start receives an Iranian number and
  optional name, creates a pending account, sends an SMS OTP and completes
  registration only after POST /api/v1/auth/challenge/verify succeeds.
- POST /api/v1/auth/phone/start is LOGIN ONLY, requiring a verified mobile.
  Email registration via /auth/register/start uses email OTP and does not
  require a mobile number.
- Numbers are stored as +989... and sent to ParsGreen SendGroupSMS as 09....
- Current sender is sendSmsOtp in backend/src/modules/auth/delivery.ts, using
  PARSGREEN_SIGNATURE, PARSGREEN_FROM and PARSGREEN_ENDPOINT.
- Four approved OTP **samples** are recorded in `PARSGREEN_AUTH_SAMPLES`:
  phoneVerification, phoneLogin, passwordRecovery and accountOperation.
  The first, third and fourth were supplied by the operator; phoneLogin was
  also visible as approved in the current WhiteText panel on 2026-11-12.
  The displayed sample is not proof of the stored approved dynamic pattern.
  The panel guide explicitly uses `%%` for variable parts and requires all
  other text to match exactly. The stored patterns were not exposed by the
  displayed table. Confirm them before substituting a generated OTP.
- The legacy runtime OTP text (`کد ورود پارس سرور: ...` followed by a safety
  notice) differs from all four approved examples. It has NOT been switched
  to one of those examples on the assumption of dynamic approval. Confirm
  WhiteText/blacklist support and the exact pattern before live verification.
- A successful SOAP API response does not prove delivery to the phone.
- AUTH_DELIVERY_MODE=log is developer-only and must not be used in production.
  Live requires proper SMTP and ParsGreen settings. Never commit secrets.

## Issue #11: saved panel evidence and remaining delivery prerequisite

The operator-supplied `سامانه جامع پیامک.html` was inspected on 2026-11-14.
Its WhiteText table contains approved static OTP samples, but no `patternId`,
`otpType`, dynamic stored pattern, or OTP-specific routing contract. ASP.NET
`ctl24`–`ctl27` control names are row indices, not provider template IDs.
Do not commit this authenticated panel export or its companion files.

The saved panel FAQ says WhiteText is matched by the provider against the
submitted message and variable sections must use `%%`; no special sending
code is required. It recommends SendOtp for OTP, but this does not establish
the approved parameters or blacklist coverage of this particular account.
The official [SendOtp contract](https://login.parsgreen.com/Api/SendSMS.asmx?op=SendOtp)
accepts `signature`, `mobile`, `Lang`, `otpType`, `patternId` and returns the
provider-generated `otpCode`. Substituting the app-generated code or treating
the returned code as a client-visible value would be incorrect.

This PR implements SMS auto-verification and an independent three-failure
budget, preserved with the original TTL through resend/restart. It does not
claim the delivery/latency part of #11 is resolved. Obtain the approved dynamic
WhiteText pattern or the account's SendOtp parameters and service/blacklist
confirmation from ParsGreen support before changing the live sender. Then
perform consented handset/DLR tests and record acceptance and delivery latency
separately; no live SMS was sent during this change.

## SOAP failure diagnosed on 2026-11-12

- Production used `http://tempuri.org/` in both the body namespace and
  SOAPAction. ParsGreen rejected the request with HTTP 500 / SOAP Client
  fault before processing its recipient or message. An operator-authorized
  single OTP attempt reproduced the failure; no successful send was claimed.
- [Official SendGroupSMS contract](https://login.parsgreen.com/Api/SendSMS.asmx?op=SendGroupSMS)
  specifies namespace `http://ParsGreen.com/` and SOAPAction
  `"http://ParsGreen.com/SendGroupSMS"`. The local adapter and regression
  fixtures now use this exact contract. `retStr` remains an empty ArrayOfString.
- A read-only GetSMSNumbers request from the server succeeded over HTTPS
  with the corrected namespace/action and confirmed the configured sender
  was in the returned list. No credentials or sender inventory were logged.
- The sender now checks both `SendGroupSMSResult=1` and `success=1` for its
  single recipient. Rejections log only HTTP status, numeric result/count
  and a fixed reason; never raw SOAP, OTP, phone, signature or exception.
  There is no automatic resend after a timeout.
- Publication and a post-fix handset delivery test are still required; local
  tests and the read-only probe do not establish live OTP delivery.

## Future agent update checklist

1. Check the current actual template text and status in ParsGreen. Never
   promote an approved literal example into an unapproved dynamic pattern.
2. Update the TypeScript catalog text, event, variables, status and this document.
3. Obtain the real provider template ID/parameter syntax (if applicable) and
   add a server-side adapter; keep credentials out of source control.
4. Add mocked tests for rendering, recipient normalization, failure handling,
   rate limits and rejected-template safeguards.
5. Add idempotent event-driven notification dispatch, retries and observability
   when order/billing/ticket emitters are integrated. This catalog currently
   records available panel messages, not automated send hooks.
6. With authorization, test real OTP delivery to an actual handset before
   claiming that phone login is operational in production.

## Phone login autofill rollout

`PARSGREEN_APPROVED_PHONE_LOGIN_PATTERN` defaults to empty. Set it only after
ParsGreen confirms the exact dynamic WhiteText pattern for this account, the
configured service line, `SendGroupSMS` and the required blacklist coverage.
The approved literal sample does not provide that confirmation. See #21.

Use the provider-approved text verbatim, with one `%%` for the generated OTP in
the body and the final line `@parserver.ir #%%`. The live login URL is
`https://parserver.ir/login`. The final line must match `FRONTEND_URL`'s HTTPS
hostname exactly, with no trailing text or newline. In the Compose `.env` file,
use a double-quoted value with `\n` between lines. Start and resend use this
format for phone login requests from the configured origin. Requests without
that origin use the existing SMS.

After approval, validate with consented numbers on Android Chrome (accept or
deny the WebOTP prompt) and iOS Safari (tap the keyboard suggestion). Check
manual entry and resend on both. Keep the variable empty until confirmation.

- [Android WebOTP](https://developer.chrome.com/docs/identity/web-apis/web-otp)
- [iOS domain-bound SMS autofill](https://developer.apple.com/documentation/security/enabling-autofill-for-domain-bound-sms-codes)
