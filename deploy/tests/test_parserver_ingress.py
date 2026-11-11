"""Prepared ingress safety boundaries, not a live certificate/rollout test."""
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class ParsServerIngress(unittest.TestCase):
    def test_bootstrap_exposes_only_the_acme_webroot(self):
        config = (ROOT / "deploy/ingress/parserver.ir.bootstrap.conf").read_text(encoding="utf-8")
        self.assertIn("location ^~ /.well-known/acme-challenge/", config)
        self.assertIn("root /var/www/parserver-acme;", config)
        self.assertIn("try_files $uri =404;", config)
        self.assertIn("return 503;", config)
        self.assertNotIn("proxy_pass", config)
        self.assertNotIn("ssl_certificate ", config)

    def test_tls_preserves_existing_passthrough_and_private_application_listener(self):
        config = (ROOT / "deploy/ingress/parserver.ir.conf").read_text(encoding="utf-8")
        self.assertIn("listen 9443 ssl;", config)
        self.assertNotIn("listen 443", config)
        self.assertIn("proxy_pass http://127.0.0.1:8540;", config)
        self.assertIn("/etc/letsencrypt/live/parserver.ir/fullchain.pem;", config)
        self.assertIn("/etc/letsencrypt/live/parserver.ir/privkey.pem;", config)
        self.assertIn("location ^~ /.well-known/acme-challenge/", config)
        self.assertIn("proxy_set_header X-Forwarded-Proto $scheme;", config)

    def test_renewal_hook_checks_domain_and_config_before_reload(self):
        script = (ROOT / "deploy/scripts/renew-parserver-nginx.sh").read_text(encoding="utf-8")
        self.assertIn("set -eu", script)
        self.assertLess(script.index("RENEWED_DOMAINS"), script.index("/usr/sbin/nginx -t"))
        self.assertIn('*) exit 0 ;;', script)
        self.assertLess(script.index("/usr/sbin/nginx -t"), script.index("/usr/bin/systemctl reload nginx"))
        self.assertNotIn("systemctl restart", script)


if __name__ == "__main__":
    unittest.main()
