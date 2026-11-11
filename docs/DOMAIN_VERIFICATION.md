# Domain ownership verification

The empty file `public/5138023.txt` must be served at
`https://parserver.ir/5138023.txt` with HTTP 200 and a zero-byte body.
Vite copies it into `dist/5138023.txt`; the frontend Nginx configuration uses
an exact location so a missing file returns 404 rather than the SPA HTML.

For the current runtime on `213.177.178.82`, the host ingress serves a persistent
copy from `/var/www/parserver-verification/5138023.txt`. Both parserver.ir
virtual hosts (HTTP and HTTPS) have the following exact location:

```nginx
location = /5138023.txt {
    root /var/www/parserver-verification;
    default_type text/plain;
    add_header Cache-Control "no-store";
    try_files $uri =404;
}
```

Preserve this location when replacing host ingress configuration. It requires
no application deployment, container restart, or database changes. Before any
ingress change, back up the existing virtual-host files, run `nginx -t`, and
reload only after validation. A configuration backup is kept under
`/var/backups/parserver-verification/` on the host.

Verify both HTTP and HTTPS: a 200 response containing HTML is not sufficient.
Only click the issuer's upload-verification button after checking a zero-byte
response at the public URL.
