# Server usability follow-up (#89–#92)

- Search checks authorized fleet data only: name/location, local/canonical/server
  IDs, order IDs, tracking IDs and the customer-facing failure reference. Search
  trims surrounding whitespace and ignores Latin letter case; status/location
  filters still apply. No new lookup endpoint or ownership rule is introduced.
- Deleted/offline overview uses recorded specifications when provider facts are
  absent and labels them historical. Missing data stays unavailable. Historical
  IPs are still suppressed, and no metrics/provider fetch is added.
- `MetricChart` supplies time/value axes, units, an explicit timezone, localized
  series legends with matching line colors/styles, and a keyboard-accessible
  sample table. Null/nonfinite values and missing sample intervals break lines;
  they never become zero. Dates use the account timezone with the existing saved
  preference/Tehran fallback. Mobile plots/tables scroll inside their cards.
- Protection confirmation snapshots the one changed flag and its before/after
  states, explains its effect and names it on the final button. Typed hostname
  and acknowledgement remain mandatory. Updated/stale protection state requires
  a new confirmation; the untouched flag must still match the displayed input.

Validation: full frontend suite (313 tests) plus the final focused suite (43 tests,
including the added stale-confirmation case), Typecheck, ESLint and production
build passed locally. No backend, billing, migration or provider action changes.

For current-browser fixture review, run `npm run preview:design -- --servers`, set
`SERVER_LIST_CDP` to the already-running loopback browser CDP endpoint, then run
`node test/visual/server-monitoring.mjs`. `PLAYWRIGHT_MODULE` optionally selects an
installed/bundled Playwright module. No browser is launched. API responses are
synthetic and mutations/external requests are blocked. It checks 1h/24h charts in
light/dark at 1440/390px, legend-to-line colors, tables, card bounds, historical
overview and protection dialogs. Screenshots are saved in ignored
`.vite/monitoring-review/`; review did not use a real account or VPS.
