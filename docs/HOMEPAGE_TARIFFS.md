# Public homepage tariffs

The build prerenders the Persian homepage into `dist/home.html`. Nginx serves
that document at `/` and inserts the public tariff fragment with an internal
SSI request. It forwards neither account headers nor query parameters. The
same HTML is served to visitors and crawlers. If the upstream is unavailable,
the build's fallback shows the homepage, inquiry rates and an availability
message. The homepage alone has a canonical URL and is listed in the sitemap.
Other SPA pages receive `X-Robots-Tag: noindex`.

The website catalog provides the public Hetzner prices. The homepage uses the
same retail rules and FX calculations as checkout and respects enabled
providers, locations, purchasable periods and `CATALOG_MAX_AGE_MINUTES`.
Hourly prices apply to one hour. Monthly prices appear only for a published
monthly purchase period. A linked external catalog requires a customer's
session, so in platform-authority mode the anonymous homepage reports that no
public plans are available.

The homepage and endpoints use `Cache-Control: no-store`. Each request reads
current published data. Open tabs refresh once per minute while visible and
on reconnect or return to the tab. On a refresh failure, prices yield to the
availability message. If a CDN rule caches HTML explicitly, exempt `/` and
`/api/public/home-prices` so updates retain this freshness policy.

Under **تنظیمات فروشگاه → تعرفهٔ سرور ایران**, an active site administrator can
save and publish independently approved monthly unit rates in integer rial.
Use `null` for unconfirmed rates; a zero rate represents an explicitly
published zero charge. Set the contract's TB/TiB unit and tax treatment before
publishing. The table shows retail rates in toman. It does not create any Iran
billing, catalog inventory or provisioning behavior.

After deployment, inspect the homepage URL in Search Console and validate its
WebSite JSON-LD. Use real-user mobile CWV data for LCP, CLS and INP, and monitor
query impressions and clicks over time. The sitemap and canonical both use
`https://parserver.ir/`.
