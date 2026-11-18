# Hetzner retail server and traffic prices

The homepage and `/hetzner` share the same public tariff response and HTML.
A catalog sync restores both price options on offers that have current,
complete evidence for the type and location. Existing sales approvals and
available capacity checks still apply.

## Hourly and prepaid monthly

Hetzner bills the underlying Cloud resource hourly with a calendar-month cap
and prices primary IPv4 separately. Pars Server uses the exact combined server
and IPv4 cap at the same location and in the same account currency as the cost
basis for its own prepaid month. Pars Server's month starts at activation or
renewal and uses the existing calendar-month addition rule, clamped at month
end. This is a retail commitment from Pars Server. The provider still receives
its ordinary server-create request and bills on its own calendar.

The catalog records the monthly basis as `hetzner-prepaid-month`. Provisioning
revalidates the exact cap against the candidate account before dispatch. Where
either monthly component is absent, the table shows that a verified monthly
price is unavailable and offers hourly checkout if its own price is valid.

Hourly and monthly quotes independently use the configured FX, margin and tax
and the same single-rial ledger conversion. Checkout asks for a fresh
confirmation if the price has changed since review. An already accepted
request reuses its receipt. The existing renewal rules use the stored provider
cost basis, including a confirmed resize, and the FX and rule applicable to the
renewal. A paid month retains its price through the end of the term. No daily
retail option is offered.

## Traffic indication

The catalog reads `included_traffic` and `price_per_tb_traffic.gross` together
from Hetzner Cloud's exact server type and location. When needed it looks at the
same combination in `/pricing.server_types`. The quote records the catalog
observation time, FX time and pricing rule version. Public data contains the
retail indication and allowance without provider cost or credentials.

The indicative total per decimal TB (1,000 GB) uses the same approved FX,
percentage markup, tax and integer-rial pricing engine as the server. The fixed
server-period markup applies only to server prices. A missing or invalid
regional rate shows an unavailable state. Operators can resync the catalog and
check location evidence, FX freshness and whether the pricing rule is enabled.

Hetzner measures billable outbound traffic by calendar month and settles
provider overage in 100 MB blocks. The public per-TB price is an indication,
and Pars Server does not issue an overage invoice or debit the wallet for it.
Future consent and settlement are tracked in [#106](https://github.com/HamedSanaei/cloud/issues/106).

After publication, allow the scheduled catalog sync to complete or run the
existing Hetzner catalog sync from the admin panel. Check genuine hourly and
monthly values, location-specific traffic and the monthly link on both public
pages and at checkout. Existing catalog records show only verified prices until
they are refreshed.

References: [Cloud billing FAQ](https://docs.hetzner.com/cloud/billing/faq/),
[traffic accounting](https://docs.hetzner.com/robot/general/traffic/),
[Hetzner SDK per-location tariff fields](https://github.com/hetznercloud/hcloud-go/blob/main/CHANGELOG.md).
