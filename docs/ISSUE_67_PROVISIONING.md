# Issue #67 — provisioning rejection and captured funds

## Observed production evidence

Read-only inspection on 2026-11-15 found one recent failed Hetzner order for
`cax11:EUR`, `nbg1`, ARM system image `387894171`. The deployed release was
`46fc0ea5933c8677a2cf219eec3371de47d490f6`.

- The API, PostgreSQL and Redis were healthy; the worker was running normally.
- The worker claimed the order once. Catalog reads returned HTTP 200, then
  creation returned HTTP **412**. The adapter classified that response as
  `resource_unavailable`, a definitive provider rejection. The job completed its
  failure path rather than crashing or repeatedly sending create requests.
- No local server row was created. A read-only search by the exact operation
  label found no matching provider resource in either configured project.
- One purchase debit of **39,000 IRR (3,900 toman)** remained captured, with no
  order refund. The failure handler marked the order failed but did not settle
  its payment. The customer DTO omitted the failure reason and payment status.
- A later read-only server-type lookup still reported CAX11/Nuremberg available.
  That advertisement did not guarantee acceptance of the actual create request.
  No provider create request was repeated to probe capacity.

The retained historical data does not include the provider's original human
error text. The proven upstream reason is `412 resource_unavailable`; a narrower
explanation about a particular capacity pool or account restriction cannot be
established from that screenshot or the old records. See the official error
contract: https://docs.hetzner.cloud/reference/cloud.

## Changes

Hetzner's definitive rejection now carries explicit non-acceptance evidence, HTTP
status and an allowlisted provider code into the provisioning operation. A
sanitized `provision.rejected` event records the order/operation reference and
provider code without credentials, request bodies or raw provider errors.

For new operations with that persisted proof, failed provisioning returns the
exact original purchase debit to the same owner's current wallet. Settlement
requires no server or subscription for the order, exactly one matching purchase,
no prior order refund, and the expected failed operation/order state. Ledger
credit, order refund state, invoice voiding, operation receipt and audit are
transactional. Concurrent job replays can finish interrupted settlement but
cannot resend the provider request or issue another refund.

Unknown provider outcomes, general legacy failures, inconsistent ledger entries
and orders with existing resources are not auto-refunded. They remain available
for operator investigation. A timeout must never justify another create or an
automatic refund: a real resource may already exist.

Failed customer rows display a safe Persian explanation, the order reference,
actual billing status and a support link. Selecting another plan/datacenter is
offered only for an unavailable-capacity failure with no outstanding captured
payment. Uncertain outcomes explicitly tell the customer not to order again.

## Verification and live-data boundary

Regression fixtures exercise the reported CAX11/Nuremberg/ARM request with both
provider acceptance and a 412 refusal despite catalog availability. Existing
ambiguous-response and account-failover tests remain in place. PostgreSQL tests
exercise exact/idempotent refunds, replay recovery, existing-resource and ledger
mismatch guards, legacy failures, ownership and unknown outcomes. UI tests cover
refund/captured/no-charge messages and safe next steps.

No production balance, order, queue or provider resource was modified. The old
order has no new non-acceptance proof marker and is deliberately not backfilled
by job replay. An operator must review its exact resource/ledger evidence before
an explicitly approved historical refund. No live order was placed to test stock;
an actual billable provisioning acceptance test requires separate authorization
and real capacity at the chosen location. This PR does not claim to create
provider capacity, automatically move customers to another location or guarantee
that the provider accepts every catalog-advertised plan.
