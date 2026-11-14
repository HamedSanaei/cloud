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

Available integrations are Hetzner, Leaseweb, ParsGreen, TabaPay and the AbanTether
rate API. All start Direct. ParsGreen remains Direct unless explicitly assigned;
its diagnostic uses HEAD and never sends an SMS. Google OAuth, SMTP, incoming
traffic and internal Platform API requests are unchanged. Asiatech is not listed
until its outbound adapter is implemented.

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

Only fixed approved HTTPS authorities on port 443 are supported. Proxy addresses
and direct DNS answers must be public; local, private, metadata and special-use
addresses are rejected and resolved addresses are pinned for socket creation.
Redirects and arbitrary test URLs are rejected. SOCKS5 resolves the approved
upstream hostname remotely. Upstream TLS and HTTPS-proxy TLS stay verified.
Use a trusted proxy with public-destination egress rules: the app cannot inspect
an IP chosen by the remote resolver. SOCKS5/HTTP proxy credentials are not
transport-encrypted; HTTPS CONNECT protects that client-to-proxy leg.

Default failure behavior blocks on proxy errors. The optional direct fallback is
limited to GET/HEAD and the original deadline. Mutations never fall back or retry:
Hetzner/Leaseweb unknown outcomes and reconciliation remain authoritative. Tests
never order a server, charge a wallet, create a payment or send a message.

## Validation and rollout

Tests cover real loopback CONNECT/SOCKS5/authentication/TLS, public-destination
policy, mutation safety, database authorization/encryption/revocation and panel
behavior. Test certificates are generated temporarily with OpenSSL. CI also
checks both Compose sources and the existing API/worker authentication wiring.
No new live routing is enabled by deploying this code. Before rolling back to a
version that ignores proxy settings, explicitly return assigned routes to Direct.