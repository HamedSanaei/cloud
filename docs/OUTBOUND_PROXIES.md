# Outbound proxies

Manage outbound proxies in **مدیریت → تنظیمات فروشگاه → شبکه و پراکسی خروجی**.
The existing active admin account can use this page immediately. There is no
additional admin-ID list, proxy encryption key, migration or server setting to
configure.

## Using the panel

1. Add a named SOCKS5, HTTP CONNECT or HTTPS CONNECT proxy with host, port,
   optional username/password and timeout. New profiles start disabled.
2. Test it against a service selected from the approved destinations. Profile
   tests do not send provider credentials or mutate provider resources.
3. Enable the profile and assign it to the desired integration. Test the
   integration connection to check the effective route. Hetzner and Leaseweb use
   their existing configured credentials for read-only location/region queries.
4. Select Direct or disable the integration route to stop using its proxy.
   Disabling a profile that is still assigned to an enabled route blocks that
   route. Reassign/disable those routes before deleting the profile.

All routes start Direct. Google OAuth, Resend SMTP, Hetzner, Leaseweb, ParsGreen
and TabaPay can be assigned independently. AbanTether always uses Direct.

## Integration coverage matrix (#215)

| Integration and code path | Protocol and destination | Direct / proxy | Non-mutating diagnostic | Failure policy |
| --- | --- | --- | --- | --- |
| Hetzner API, inventory, renewals, provisioning and reconciliation ([adapter](../backend/src/modules/providers/hetzner/live.ts)) | HTTPS `api.hetzner.cloud:443` | Both | `GET /v1/locations` | Closed |
| Hetzner console ([relay](../backend/src/modules/servers/console-transport.ts)) | WSS `console.hetzner.cloud` / `web-console.hetzner.cloud:443` | Same Hetzner route | Actual authenticated console handshake with recorded status. API probe only verifies HTTPS | Closed |
| Leaseweb API, worker and ([CLI](../backend/src/scripts/leaseweb-cli.ts)) ([client](../backend/src/modules/providers/leaseweb/client.ts)) | HTTPS `api.leaseweb.com:443` | Both | `GET /publicCloud/v1/regions` | Closed or explicit GET/HEAD fallback |
| Google token exchange and UserInfo ([callback](../backend/src/modules/auth/google.ts)) | HTTPS `oauth2.googleapis.com/token`, `openidconnect.googleapis.com/v1/userinfo` | Both | Unauthenticated `GET /tokeninfo` and `GET /v1/userinfo` accept the expected 400 and 401 respectively. No token, OAuth code or secret is used | Closed |
| Resend email OTP and operation authorization ([delivery](../backend/src/modules/auth/delivery.ts), [transport](../backend/src/modules/outbound/smtp.ts)) | `smtp.resend.com`, implicit TLS on 465/2465 and required STARTTLS on 587/2587 for proxied connections | Both for approved Resend settings. Other configured SMTP servers retain their existing Direct option | TLS/EHLO without SMTP auth or mail | Closed |
| ParsGreen SMS in API and notification worker ([delivery](../backend/src/modules/auth/delivery.ts)) | HTTPS `login.parsgreen.com:443` | Direct by default. Proxy supported if explicitly assigned | `HEAD /Api/SendSMS.asmx` | Closed or explicit GET/HEAD fallback. SMS is never retried through Direct |
| TabaPay create/verify and gateway diagnosis ([adapter](../backend/src/modules/payments/tabapay.ts)) | HTTPS `api.tabapay.ir:443` | Direct by default. Proxy supported if explicitly assigned | `HEAD /` | Closed or explicit GET/HEAD fallback. Payment requests never fall back |
| AbanTether market FX ([refresh and scheduler](../backend/src/modules/pricing/market-fx.ts)) | HTTPS `api.abantether.com:443` | Direct only, even if old proxy settings exist | Read-only ticker | Direct |
| Internal Platform and readiness ([adapter](../backend/src/modules/integration/platform.ts)), PostgreSQL/Redis, migration and backup tools | Internal configured HTTP(S), PG and Redis | Existing internal connections | Existing health checks | Existing policy |
| Browser OAuth authorization, browser payment redirect, public badges and incoming callbacks | Browser HTTPS or inbound HTTP(S) | Outside server egress | Existing application flow | Existing policy |

The Google flow uses token exchange and UserInfo. ServerCloud does not fetch
Google discovery or JWKS at runtime. Asiatech has no outbound adapter. The
API, worker, scheduler and the provider CLI share the same database-backed
policy for the calls they perform.

## Storage and request safety

Proxy credentials remain encrypted and masked automatically. The application
uses its existing `AUTH_SECRET` with a purpose-specific HKDF key for AES-256-GCM;
there is no separate proxy key. API and worker already receive this configuration.
Backups include the encrypted settings and require the same existing application
secret when restored. Credentials are never read back into the edit form.

The page uses the existing admin authentication, single-use sensitive-action
proofs and audits. Deactivated/demoted accounts are rejected. Revisions prevent
lost edits. API, worker and Leaseweb CLI read the same settings for new requests
and retire old connection pools when a revision changes.

Only fixed approved HTTPS and Hetzner console WSS authorities on port 443, and
the fixed SMTP destination and TLS ports above, can be proxied. Proxy addresses
and direct DNS answers must be public; local, private, metadata and special-use
addresses are rejected and resolved addresses are pinned for socket creation.
Redirects and arbitrary test URLs are rejected. SOCKS5 resolves the approved
upstream hostname remotely. Upstream TLS and HTTPS-proxy TLS stay verified.
Use a trusted proxy with public-destination egress rules: the app cannot inspect
an IP chosen by the remote resolver. SOCKS5/HTTP proxy credentials are not
transport-encrypted; HTTPS CONNECT protects that client-to-proxy leg.

An enabled Hetzner route applies to API, worker and inventory requests, including
the console grant and the VNC WebSocket. The browser connects to the authenticated
same-origin relay. Each new provider request and console connection reads the
current policy. An open console uses its original route until the next session
check, which closes it when the settings revision changes. The network panel
shows the latest console result and last failure without including console
tickets or proxy credentials.

Enabled Hetzner, Google and SMTP routes fail closed on any proxy error. Other integrations can
optionally fall back on GET/HEAD within the original deadline. Mutations never
fall back or retry. Hetzner/Leaseweb unknown outcomes and reconciliation remain
authoritative. Tests never order a server, charge a wallet, create a payment or
send a message.

## Validation and rollout

Tests cover real loopback CONNECT/SOCKS5/authentication/TLS, public-destination
policy, mutation safety, database authorization/encryption/revocation and panel
behavior. Test certificates are generated temporarily with OpenSSL. CI also
checks both Compose sources and the existing API/worker authentication wiring.
Deploy with routes unchanged, then save the profile, test each approved
destination, and enable only the successful service routes individually. Test
each effective route after saving. If an effective route fails verification,
switch that integration back to its prior route. Before rolling back to a
version that ignores proxy settings, return the affected routes to Direct.
