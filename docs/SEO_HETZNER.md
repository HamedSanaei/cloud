# Public Hetzner pages — issue #100

## Scope and live readiness

The homepage targets cloud hosting in Iran and Hetzner. `/hetzner` is the single
canonical Persian Hetzner buying guide/comparison page. It targets «سرور هتزنر»,
«سرور ارزان هتزنر», «خرید سرور هتزنر», hourly and monthly comparisons. There are
no duplicate keyword doorway pages, fabricated discounts, reviews or ratings.
Both pages contain useful HTML before JavaScript; only sorting/filtering needs JS.
The homepage retains Iran tariffs, existing branding and trust seals.

**A passing PR does not mean production or Google's index has changed.** The
following read-only audit was made on 2026-11-17 against `parserver.ir` and Netiran
(`213.177.178.82`), deployed website SHA
`cae57fa03f2ba5fd50ec591a223115928eb3211a`:

| Observation | Result / cause |
| --- | --- |
| `/api/public/home-prices` | Iran and Hetzner null |
| Hetzner catalog | 91 products, 74 enabled/available; current successful sync, sales enabled |
| FX | Latest EUR approval 2026-10-15, 33 days old; existing 24-hour financial guard rejects it |
| Public error handling | Previously swallowed the FX error into null; now safe `pricing_unavailable` status and visible explanation |
| HTTP homepage | 200 from Arvan; host :80 hardcodes forwarded protocol to HTTPS |
| Unknown public route | 200 SPA soft-404 |
| `/favicon.ico` | 200 HTML rather than an icon |
| Host ingress | Nginx :80 and TLS :9443 behind existing :443 passthrough |

The approved follow-up for FX is [#101](https://github.com/HamedSanaei/cloud/issues/101).
The owner explicitly requested a separate issue instead of supplying a new rate.
**This PR does not change FX, its TTL, billing policy or any customer data.**
Real prices remain unavailable until that business-readiness blocker is resolved.
No Leaseweb/Hetzner order or provider management operation was executed.

## Price contract and conversion

- Public JSON and the internal SSI fragment use the same existing storefront
  pricing engine, provider availability and retail sales rules. The public
  projection excludes wholesale costs, rules, credentials and provider accounts.
- Prices are final retail IRR, displayed as toman with configured tax; addons are
  quoted separately. Native hourly/monthly periods are independent. A missing
  monthly price is never synthesized by multiplying hourly prices.
- `meta` contains checked time, earliest catalog/FX source timestamps and validity.
  Validity is at most 60 seconds and never outlives the underlying FX/catalog TTL.
  HTML/fragments/JSON are `no-store`; keep CDN caching disabled for these routes.
- The browser refreshes every 30 seconds while visible, and on reconnect/resume.
  An error, invalid response or null cannot overwrite a still-valid snapshot or
  extend its original expiry. Empty inventory **does** immediately remove offers.
  Expired prices disappear until a valid refresh; no claim of a guaranteed quote.
- SSR embeds escaped, validated JSON so the initial browser snapshot uses the
  same prices and expiration as the HTML. Provider strings are HTML-escaped.
- Offer links preserve `offer`, `period`, `location` through login/register and
  Google OAuth using a safe local `returnTo`. The existing authenticated wizard
  resolves the real offer/location, rechecks eligibility and requests the final
  quote. URL parameters cannot override authoritative pricing or inventory.
- Monthly paid periods stay fixed; future hourly charges and renewals use the
  approved rates of those periods. Display rounding never changes debits (#94).

## Indexability and assets

The image serves exactly `/` and `/hetzner` as indexable prerendered pages, with
distinct title, description, H1 and self-canonical (tracking queries excluded).
`/hetzner/` permanently redirects to `/hetzner`, preserving the query.
Only actual authenticated/auth route shapes receive the SPA shell with noindex.
Unknown paths, wrong case and missing assets return a real Persian HTTP 404.
Authenticated entity IDs remain subject to backend existence/access checks.
`robots.txt` permits crawlers to see noindex; the sitemap lists only public pages.

Existing WebSite data is retained. Real brand Organization and Hetzner breadcrumb
data are added. No Product/Offer/review/rating schema is invented. PNG artwork
is 1200×630, the favicon is a real multi-size ICO with a PNG alternative.
Reproduce PNGs on Windows with `build-tools/generate-brand-assets.ps1`; convert
favicon.png using Pillow `Image.open(...).save(..., sizes=[(16,16),(32,32),(48,48)])`.
No remote stock image, paid font or additional runtime dependency is required.

## Measured evidence and outstanding external checks

Same-machine production builds, same dependencies, gzip level 9, before/after:

| Public entry JavaScript (static import closure, excludes lazy chunks) | Before | After |
| --- | ---: | ---: |
| Raw bytes | 643720 | 307562 |
| Gzip bytes | 182411 | 97492 |

The public entry now defers the dashboard/admin app and its toast code/CSS until
a private route is opened. React/router dependencies in the shared static chunk
are **included** in the after total. The remote-console bundle remains lazy.
The before CSS was 132.33 kB; the public CSS is 99.02 kB, with 34.25 kB private CSS
deferred. Fonts already use `font-display: swap`; no speculative font changes.

Separate live observation before changes: compressed entry transfer 221161 bytes,
TTFB 0.163s, total 0.207s. This is one HTTP sample behind Arvan, **not** a CWV score
or a directly comparable build-compression measurement.

### Dependency audit remediation (2026-11-17)

The initial CI run failed GHSA-fc5q-39xc-vjpf in the existing picomatch 4.0.7
build/test dependency. No official patched release was available. Both dependency
trees now pin the published MIT-licensed **fork** `@ryotsu/picomatch@4.0.7-a` via
an npm alias override; this is not an official picomatch release. Lockfiles pin
the registry tarball's SHA-512 integrity. Its source is
[`3ab5a7627d480259e3d9ca67fbc14c125d374f0e`](https://github.com/ryotsu-kankichi/secured-picomatch/tree/3ab5a7627d480259e3d9ca67fbc14c125d374f0e).

The published tarball was compared with official 4.0.7: only parser/constants
code, package metadata and README differ; entry points, other matcher code and
license are unchanged. It has no dependencies or install lifecycle hooks. The
parser collapses equivalent repeated wildcard branches to avoid nested unbounded
repetition, and rejects unsafe complex forms; additional changes fix POSIX
brackets/punctuation and globstar newline/extension semantics.

Before replacement, the reported hostile inputs blocked the original matcher
past a three-second isolated-process deadline. The pinned fork completed the
same cases. `build-tools/check-glob-security.mjs` checks every installed matcher
copy, representative Vite/test/Windows glob semantics and hostile failing inputs
with a hard five-second child-process timeout. Both CI audit jobs require this
regression check **and** the unchanged full `npm audit --audit-level=low`; no
exception, severity downgrade or `continue-on-error` is used. Full application
tests/builds remain required. Revert the temporary alias to an official release
only after a verified upstream fix passes these checks, updating the identity
assertion as part of that reviewed change.

References: [advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf),
[fork's proposed upstream fix](https://github.com/micromatch/picomatch/pull/240).

**External checks blocked, not passed:**
- Mobile and desktop PSI requests returned daily API quota-exceeded responses.
  No Lighthouse score, LCP, INP or CLS has been measured for this change.
- No authenticated Search Console property access. Index status, Google-selected
  canonical, impressions, clicks, CTR, average position and field CWV are unknown.
- Current-browser inspection failed before opening any surface: `failed to write
  kernel assets ... os error 3`. Per owner instruction no headless browser was
  substituted. Visual checks at 320/390/1440px remain required before closure.
- Local Docker daemon is unavailable. Nginx HTTP/image tests and database-backed
  integration run on disposable CI services, never the developer's `.env` DB.

After an authorized release, run mobile/desktop Lighthouse/PSI on both public
URLs; save reports, timestamp, release SHA, device/throttling and lab-vs-field
results. Inspect layout, overflow, focus and CTA paths at 320/390/1440px using the
owner's current browser; retain screenshots. Validate JSON-LD in Google's Rich
Results Test/Schema validator (no claim of rich-result eligibility).

When GSC access exists, record the preceding complete 28 days, export each target
query's impressions/clicks/CTR/position by landing URL, country and device, and
record coverage, selected canonical and field CWV. Submit the sitemap, inspect
both URLs, compare equivalent complete periods after recrawl, and annotate the
release and FX-readiness dates. Do not infer ranking/indexation from CI or curl.

## Production-safe rollout and rollback

1. Review the PR's frontend/backend tests and disposable built-image HTTP checks.
   Do not merge this PR as a claim that #101 or external checks are complete.
2. Before any approved deployment, retain the current image digests, Compose,
   protected environment files and host Nginx config with the existing backup
   process; verify recovery. This change has **no schema migration**. Normal
   deploy preflight/migration/health/security gates remain enabled.
3. Resolve #101 through an owner-approved rate workflow independently. Never
   weaken the financial guard, retimestamp an old rate or insert a fake price.
4. Activate the host ingress separately under deployment authorization. Check
   current Arvan IP ranges against its official list and confirm it overwrites
   `X-Forwarded-Proto`. The prepared `deploy/ingress/parserver.ir.conf` trusts only
   the original socket peer in those ranges (`$realip_remote_addr`), otherwise
   uses the actual connection scheme. Preserve the production `:443` passthrough
   and `:9443` TLS topology; **do not replace it with a generic :443 listener**.
   Direct-IP :443/SNI certificate verification failed in the audit, so do not
   switch CDN origin ports blindly or use insecure TLS verification.
5. Host :80 must distinguish CDN HTTPS visitors from HTTP visitors; an
   unconditional redirect there can loop when the CDN uses HTTP to origin. Test
   edge protocol overwrite before activation; enable Force HTTPS at Arvan too.
   ACME and the real verification text file stay available. Validate the actual
   candidate with `nginx -t` and reload only after approval; no unrelated restarts.
6. Publish matching API/web images via existing deployment gates. Keep public
   routes/API/fragments out of CDN HTML caches; invalidate only their stale cached
   responses if necessary. Never cache credential-bearing requests globally.
7. Read-only post-deploy checks (record status, location, content type and SHA):
   - HTTP `/`, `/hetzner`, `/hetzner?utm_source=check`: one 301/308 to HTTPS,
     path/query preserved; HTTPS must not loop. Spoofed direct-origin protocol
     headers must not bypass the host's trust boundary.
   - HTTPS `/` and `/hetzner`: 200, one H1, self-canonical, no noindex; same useful
     HTML and prices for normal and Googlebot UAs without executing JavaScript.
   - `/hetzner/`: 308 canonical; random path, wrong case and missing assets:404.
   - Login/register, dashboard, existing server/admin deep links:200 + noindex;
     normal authentication and API/console authorization still work.
   - favicon is image/ICO bytes, share image image/png 1200×630, sitemap/robots
     valid. Existing trust seals and verification file still work.
   - JSON and SSR contain the same real eligible retail offers/periods, freshness,
     or the honest FX-unavailable state; compare amounts to a read-only quote.
     Check that refresh failures don't erase valid prices or keep expired ones.
   - Follow an offer anonymously through login/registration to the final quote;
     **do not submit/pay an order** merely to validate SEO.
8. On failure, restore the previous host ingress and validate/reload it, then
   restore the prior API/web image digests through the standard rollback. No DB
   reversal or customer balance manipulation is needed. Recheck runtime health,
   old routes and console access; retain the diagnostic evidence.

Do not close #100 until live redirects/pricing and outstanding browser/GSC/PSI
checks are recorded, or explicitly separated into agreed follow-ups.

References: [Google JavaScript SEO](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics),
[soft 404s](https://developers.google.com/search/docs/crawling-indexing/troubleshoot-crawling-errors),
[Core Web Vitals](https://developers.google.com/search/docs/appearance/core-web-vitals),
[Nginx try_files](https://nginx.org/en/docs/http/ngx_http_core_module.html#try_files),
[Nginx SSI](https://nginx.org/en/docs/http/ngx_http_ssi_module.html),
[official Arvan origin ranges](https://www.arvancloud.ir/fa/ips.txt).
