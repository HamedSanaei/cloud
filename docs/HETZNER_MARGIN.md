# Hetzner profit settings

Open **پنل ادمین → تنظیمات فروشگاه → تنظیم سود سرورهای هتزنر** with an active
site `super_admin` account. See the [Super Admin rollout](SUPER_ADMIN.md).
In platform authority mode the canonical service owns pricing.

The percentage accepts 0–1000% with up to four decimal places. The additional
fixed amount is optional (zero by default) and accepts up to 1,000,000 toman with
one decimal place. One tenth of a toman equals one rial. The fixed amount applies
to **each** offered billing period, including each hour on an hourly plan.

Preview changes before confirming. Sample rows show native hourly and monthly
options separately. They include provider cost, the applicable FX observation,
old and proposed retail totals, tax and pre-tax markup. The effective markup is
relative to the provider cost in whole rials. The backend checks proposed prices
for all eligible offers even when only a sample is displayed. Missing FX or
an unavailable catalog is shown explicitly. The rule editor itself never
submits a purchase or a provider operation.

The existing engine multiplies the native provider cost by the valid FX rate,
adds the fixed markup, applies percentage markup to that combined amount, then
applies the configured tax. Final charges use exact integer rials at the
existing ledger boundary. Display precision never changes wallet deductions.

Saving updates the existing Hetzner rule and appends the previous/new values,
actor, timestamp and rule version to the audit log in one transaction. The
confirmation is tied to the editor session and payload. A stale version must
be reloaded before editing again. New storefront requests and new creation or
resize quotes read the saved rule immediately. The public comparison refreshes
on its existing schedule.

An existing valid quote keeps its snapshot until its established expiry.
Accepted orders and paid invoices keep their agreed amounts. Existing
idempotency keys retain their original order or operation. Future monthly
renewals use the then-current rule without repricing a month already paid.
Late hourly billing uses the recorded rule and FX applicable to that hour.
If historical evidence is missing the charge remains blocked. This setting
does not alter Leaseweb rules or Iran tariffs.
