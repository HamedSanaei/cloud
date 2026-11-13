# Website wallet payments and support tickets

## Payment configuration and deployment

The site-authority wallet now offers TabaPay recharge. Before either creation or
gateway navigation, the form tells the customer to turn off VPN/filter breakers.
Amounts are entered in **Toman**, converted once to integer **Rial** on the API,
and must be between 10,000 and 50,000,000 Toman (issuer limits).

Configure API-only secrets in the host's protected deployment `.env`:

```dotenv
TABAPAY_ENABLED=true
TABAPAY_MERCHANT=<existing merchant UUID; never commit>
TABAPAY_SANDBOX=false
FRONTEND_URL=https://parserver.ir
```

The checked-in Compose files and generated deployment Compose pass these values
to the API. Configuration validation runs during the existing deployment
preflight before services stop. An enabled gateway requires a valid merchant;
production/staging also require HTTPS and forbid sandbox. Local development may
use sandbox; real credentials must stay in ignored `backend/.env.local`.
No `VITE_*` secret is needed. With the gateway disabled, the form gives an explicit
configuration error instead of pretending to accept a payment.

Migration **0008** is additive: new `wallet_payments` table, unique payment keys,
gateway tokens/references and nullable ticket server fields. Apply through the
existing backup/migration/deployment workflow; do not change customer balances
or migrate either legacy platform ledger as part of this feature. After any
payments exist, preserve the table and ledger during rollback. Do not downgrade
the schema, remove the merchant, or disable its callback while payments are in
flight. Use a forward fix and existing deployment rollback/schema guards.

On the current host, payment environment values were prepared using the existing
merchant already stored on that host, after a protected, byte-verified `.env`
backup. No restart, production migration, deployment or real payment was performed
by this PR. The live runtime gains this capability only after review and release.

## Endpoints and verification

All following endpoints exist at both `/api` and `/api/v1`:

- `GET /wallets/recharge/options`: authenticated, owned wallet list and availability.
- `POST /wallets/recharges`: authenticated `{walletId, amountToman}` with required
  `Idempotency-Key`; creates a durable attempt before calling the issuer.
- `GET /wallets/recharges/:id`: receipt/status, restricted to its owner.
- `POST /wallets/recharges/:id/verify`: owner-triggered server-side verification.
- `GET|POST /payments/tabapay/callback`: public issuer callback. The registered
  callback URL is `FRONTEND_URL/api/v1/payments/tabapay/callback`.

The client uses only the fixed HTTPS issuer origin `https://api.tabapay.ir`.
Requests follow the [official TabaPay contract](https://tabapay.ir/docs/api):
multipart `/v1/create` and `/v1/verify`, with sandbox-only equivalents locally.
The browser's amount/status is never authoritative. Credit requires server-side
verification of the **stored token, frozen gross Rial amount**, success status,
response code 1 or 2 and nonzero Shaparak reference. `finalAmount` after fees is
not the wallet credit amount.

POST notifications require the documented merchant-MD5 signature (standard
`Authorize` header, or literal `HTTP_AUTHORIZE` when the ingress forwards it).
Do not loosen ingress header handling or authentication to accept unsigned
notifications. GET return and authenticated owner verification still reverify
with the issuer. POST acknowledges success only after the ledger commit.

Payment row locking, ledger idempotency and a unique issuer reference prevent
duplicate credit across callback replay, concurrent verification and distinct
attempts. Audits cover intent creation and successful credit, in the same DB
transactions. A changed merchant fingerprint blocks verification rather than
silently attributing an old payment to new credentials.

### Recovery

Network failure during create is **unknown**, not success or a safe retry.
Repeated requests with the same key return the existing attempt and never issue
another create. No automated recreates or background reconciliation are claimed.
The customer can track the receipt at `/wallet?payment=<id>`; pending payments
can be verified again. A no-token/ambiguous create needs support reconciliation
with the issuer. Never manually credit from a screenshot or unverified callback.
Support should use the durable attempt/audit ID, keep credentials private and
resolve issuer evidence before any separately authorized financial adjustment.

## Support tickets and global selects (Issue #4)

`GET /api/tickets/servers` lists only the authenticated owner's eligible site
servers. A separate optional **سرور مربوطه** field defaults to **سفارشی ندارم**;
labels include hostname and IP/identifier. Category remains independent. No
servers or a failed list fetch does not prevent a general ticket.

Ticket creation validates ownership/availability inside the transaction. The
nullable server FK uses `ON DELETE SET NULL`; a server snapshot preserves the
original name, ID, provider and IP for historical support. Customer ticket detail
is owner-only. `/api/admin/console/tickets` is admin-only and provides paginated
support access with owner email, description and the saved server association;
the admin UI links to the server when it still exists.

`src/dropdown.css` applies shared light/dark surface, foreground, border,
highlight, selected, disabled, focus and scrollbar colors globally to native
selects/options. It inherits the app's explicit color-scheme, retains native RTL
and keyboard semantics, and honors forced-colors system colors. New shared
Select controls receive the same rules automatically.

## Validation performed for this change

- Frontend/backend builds, typechecking and lint; Drizzle schema check.
- Migration applied/reapplied on an isolated disposable PostgreSQL cluster.
- Eight targeted integration cases: concurrent intent and verify replay, real
  ledger amount, cross-user access, signed/forged notifications, amount mismatch,
  duplicate issuer reference rollback, retry payload/bounds, unknown create,
  general/owned/foreign/deleted ticket servers and owner/admin visibility.
- Current Chrome only, loopback synthetic preview: ticket category/server and
  timezone selection by keyboard; computed option colors in both themes; recharge
  VPN notice; 390px mobile forms with no horizontal overflow. Normal/selected
  text tokens exceed 4.5:1 and borders exceed 3:1 against their surfaces.
- Native expanded-menu screenshots were not exposed by the browser extension;
  their computed option colors and native keyboard selection were checked.
  Firefox, Safari, OS-level theme overrides and forced-colors rendering were not
  exercised and remain additional browser QA.

Local unit tests were **not run**, as requested. Existing CI gates remain intact.
No live charge, VPS operation or customer data modification was used for testing.
