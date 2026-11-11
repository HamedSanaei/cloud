#!/bin/sh
# Install as /etc/letsencrypt/renewal-hooks/deploy/50-parserver-nginx
# only when activating this certificate. Certbot supplies RENEWED_DOMAINS.
set -eu

case " ${RENEWED_DOMAINS:-} " in
  *" parserver.ir "*) ;;
  *) exit 0 ;;
esac

# Never reload invalid configuration, and never restart application services.
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
