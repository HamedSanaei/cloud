# پارس سرور — pending domain activation

## Recorded state, 2026-10-24

- New brand: **پارس سرور**; requested public origin: `https://parserver.ir`.
- `parserver.ir` returned NXDOMAIN from both 1.1.1.1 and 8.8.8.8. The owner
  confirmed registration approval is pending and asked to resume later.
- No active Nginx configuration, application environment, DNS or service was
  changed. Certbot is not installed yet; no certificate was issued and no
  automatic-renewal job is claimed active.
- The existing website and platform containers were already stopped (since
  2026-10-21). The owner explicitly asked to leave them stopped.
- Nginx configuration backup was created privately on Nethederland at
  `/root/parserver-ingress-backup.Vgz65ITa/nginx-before.tar.gz`. An extracted
  restore copy was compared with `/etc/nginx` successfully; the archive checksum
  is `63a02b023ad330c3a4012cae65796f6e54e95a5ede7779e836a20c71fd21e732`.
  This includes private keys; never download, commit or publish its contents.

## Prepared files, NOT enabled

- `deploy/ingress/parserver.ir.bootstrap.conf`: ACME webroot over HTTP, other
  requests return 503 until a real certificate exists.
- `deploy/ingress/parserver.ir.conf`: final HTTP challenge/HTTPS redirect and
  TLS virtual host, forwarding to existing loopback website port 8540.
- `deploy/scripts/renew-parserver-nginx.sh`: Certbot deploy hook; validates
  Nginx before reload and only handles certificates including `parserver.ir`.

Do not enable bootstrap and final configurations simultaneously. The final
config deliberately listens on **9443**, not 443: an unrelated existing
`vpnetiranbot.service` owns public port 443 and passes website TLS through to
Nginx. The new SNI currently reaches the old default certificate. Verify real
TLS/SNI routing again after activating the dedicated virtual host; do not move,
stop or reconfigure that unrelated service without separate approval.

## Resume after registration and DNS approval

1. Configure authoritative DNS: A `@` → `95.211.62.26`. Do not publish an AAAA
   record unless working IPv6 has been verified. Confirm delegation, A, CAA and
   external port-80 access. `www` is deliberately excluded until explicitly
   chosen and resolvable; add its DNS, server names and certificate SAN together.
2. Recheck runtime, listening ports and ingress ownership; take a **fresh**
   private config backup and verify its restoration. Preserve all old hosts.
3. With the owner's authorization, install distribution `certbot` (webroot
   plugin, no second web server). Create `/var/www/parserver-acme` and install
   only the bootstrap virtual host. Run `nginx -t`, then reload Nginx.
4. Verify an unpredictable challenge test file is available externally at
   `http://parserver.ir/.well-known/acme-challenge/<test-name>`, then remove
   only that test file. Supply the owner's real ACME contact email and approve
   the CA terms before requesting a real certificate. Example (replace email):

   ```bash
   certbot certonly --webroot -w /var/www/parserver-acme \
     --cert-name parserver.ir -d parserver.ir --email OWNER_EMAIL \
     --agree-tos --non-interactive
   ```

5. Only after successful issuance, replace bootstrap with the final virtual
   host. Validate Nginx and reload, not restart. Test public TLS with hostname
   validation and the expected issuer/SAN; never bypass certificate checking.
6. Install the deploy hook executable as
   `/etc/letsencrypt/renewal-hooks/deploy/50-parserver-nginx`. Enable/check the
   distribution `certbot.timer` (no duplicate cron). Run:

   ```bash
   systemctl enable --now certbot.timer
   systemctl list-timers --all certbot.timer
   certbot renew --cert-name parserver.ir --dry-run --run-deploy-hooks
   ```

   Check the renewal configuration retains webroot authentication and the dry
   run and reload hook actually succeed. A timer alone is not SSL readiness.
7. Starting the stopped application or publishing brand code requires fresh
   authorization. Do not start another Telegram poller, change customer data or
   run migrations as part of an ingress-only change.
8. Before application cutover, register
   `https://parserver.ir/api/v1/auth/google/callback` in the existing Google
   OAuth client's allowed redirect URIs. Preserve the old callback while it is
   in use. Prepare `FRONTEND_URL=https://parserver.ir`, matching
   `GOOGLE_REDIRECT_URI`, and intended CORS origins in the server-owned `.env`;
   keep cookie security, stable auth keys and bridge settings unchanged. Do not
   switch a running environment before Google accepts the new callback.
9. Keep the verified SMTP sending address/domain until a new sending domain is
   verified; only the display name becomes `پارس سرور`. Changing the sender to
   an unverified `@parserver.ir` address would break OTP delivery. Update the
   GitHub Environment `PUBLIC_URL` only with the agreed application cutover.
10. Verify HTTPS `/`, `/healthz`, `/dashboard`, API readiness, login callback,
    essential container health and the old hosts. On an ingress failure remove
    only the newly added symlink/config, validate and reload the previous
    configuration. Never restore an entire old Nginx tree over newer changes.

Existing internal identifiers (`serverhub-auth-totp-v1`, synthetic phone-account
email suffix, Compose project/image names and cookie/storage keys) are not UI
branding. They are preserved to avoid invalidating encrypted 2FA secrets,
creating duplicate accounts or losing sessions. Existing authenticator entries
retain their local names; newly created enrollment URIs show the new brand.
