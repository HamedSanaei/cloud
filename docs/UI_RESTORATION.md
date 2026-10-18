# Independent Penpot screens and canonical integration

The integration data source must never select the page component. `App.tsx`
always maps dashboard, wallet, invoices, charge requests, servers and the guided
checkout to their own screens. `/platform` is a compatibility redirect to
`/settings/telegram`, not a replacement console.

- Public landing: `/` (also linked from the panel). Authenticated users can
  still visit it; the primary action opens their dashboard/checkout.
- Panel settings submenu: `/settings/telegram` for pairing/revocation and
  `/settings/platform-admin` for canonical, server-authorized superadmin tools.
- Server controls, destructive confirmation and operation receipts belong to
  the server page. Success is not inferred from command acceptance.
- The six-step checkout retains the Penpot flow plus the existing explicit
  billing-period step. In unified mode `/catalog/storefront` is a presentation
  projection of canonical offers; OS images are fetched for the chosen offer.
  Only supported, actually priced periods are shown. USD minor-unit snapshots
  remain intact and go to `/platform/orders` with a stable retry key. IRT
  display prices are estimates, not a second pricing/settlement engine.
- The canonical purchase contract does not accept a custom server name; the
  UI states that initial naming is automatic rather than silently ignoring a
  name. Legacy mode retains its original name field.
- Unified mode supports one shared wallet. Additional legacy wallets cannot
  be created through this interface. Recharge uses the canonical gateway flow.
- Official invoices are not exposed by the current canonical API. The invoice
  page clearly distinguishes this unsupported capability from an empty list,
  failed request, or fabricated invoice. Charge requests read actual payment
  sessions, scoped to the authenticated owner (latest 50), using frozen credit
  currency/amount when present. No settlement occurs on read.
- Landing styles use `landing-section-heading` and scoped button selectors;
  they must not override reusable panel headings/buttons.

## Validation / preview

`npm test` covers route independence with integration enabled, six-stage
checkout, final-only submission and confirmed disconnect. The frontend CI runs
these tests. Backend bridge tests cover authoritative catalog projection,
currency boundaries, fail-closed revocation and legacy mutation blocking.

`npm run preview:design` serves **synthetic fixtures only** at
`http://127.0.0.1:5174`. It is loopback-only, visibly labelled, and never connects
to the real API, Telegram, payments or providers. It is not a deployment or
proof of production connectivity. Normal development remains `npm run dev`.

## Safe rollout (requires separate authorization)

1. Deploy/test the platform's additive `POST /v1/console/link/revoke` and
   `GET /v1/console/charge-requests` endpoints first. No schema migration is
   required. Keep unrelated health/startup work separate in review.
   Its `/v1/console/link/contract` must advertise both
   `website-link-revoke:v1` and `website-charge-requests:v1`. Website preflight,
   startup cutover validation and readiness reject missing feature versions.
   Preflight also probes both endpoints **without a bearer**, requiring a real
   `401 unauthorized` response: a healthy old API, missing route (404), or
   unprotected endpoint (200) cannot pass. No real token is revoked by a probe.
2. Deploy website backend and frontend together. Existing financial cutover,
   encrypted credentials, ownership and mutation guards remain active.
3. Verify independent pages and actual account reads with a permitted test
   account. Never use a real purchase, wallet adjustment or destructive server
   operation as an automatic UI smoke test.
4. Disconnect revokes the current canonical bearer before erasing its encrypted
   website credential. The identity binding remains, preventing account/fund
   reassignment through unlink/relink. If the authority is unavailable, report
   failure and retain the credential for a safe retry.
5. Before an eventual platform downgrade, roll the website back to a compatible
   image first. Contract version 1 alone no longer proves compatibility with
   the website's additive feature requirements. Review the actual endpoint
   behavior using an authorized non-customer test identity before enabling the
   website; unit tests and the no-bearer probes do not establish deployment or
   end-to-end success.

See `docs/VISUAL_REVIEW.md` for separate design-conformance evidence and the
uncompleted pixel-diff approval. Shared branding is `BRAND_NAME` / `BrandMark`
in `src/components/Brand.tsx`. Both top and bottom landing CTAs respect the
authentication state; no logged-in CTA points back to login/registration.

No commit, push, deployment, migration or production data change is performed
by the local restoration/preview workflow.
