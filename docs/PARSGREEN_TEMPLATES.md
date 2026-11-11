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
| passwordChanged | account.password_changed | UNKNOWN | none |

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
- No approved OTP template is present in the user's supplied list. Confirm
  the sender/method supports authentication OTP to blacklisted numbers; if
  a dedicated WhiteText OTP API is required, obtain its documented credentials
  and template metadata before changing the transport. A successful SOAP API
  response does not prove delivery to the phone.
- AUTH_DELIVERY_MODE=log is developer-only and must not be used in production.
  Live requires proper SMTP and ParsGreen settings. Never commit secrets.

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
