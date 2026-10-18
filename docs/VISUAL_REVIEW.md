# Penpot comparison — browser evidence and remaining limits

## Source

`test/visual/penpot-reference.json` contains geometry/style read from the
provided Penpot file, page `02 · Screens`, all 16 boards at 1440 × 900.
It is **not** a screenshot baseline generated from the implementation.
`test/visual/regions.json` maps 23 selected regions on six critical pages to
their Penpot shapes. Numeric tolerance is 1 CSS pixel for browser rounding.

## Executed in the browser (2026-10-18)

Using the isolated, synthetic-data preview with integration enabled, at
1440 × 900, measured DOM geometry/radii and selected background colors were
compared directly against the design values:

| Page | Regions | Result |
| --- | ---: | --- |
| Dashboard | 7 | Passed |
| Wallet | 5 | Passed (transactions height 250.67 vs reference 250) |
| Servers, empty state | 3 | Passed |
| Invoices, empty-state fixture | 3 | Passed |
| Charge requests, empty state | 3 | Passed |
| Create server, initial step | 2 | Passed |

Examples of measured vs reference: dashboard wallet `(48,344,366.02,132)`
vs `(48,344,366,132)`; recent servers `(438.02,344,689.98,300)` vs
`(438,344,690,300)`; server list filter `(48,210,1080,138)`;
server empty card `(340,410,500,260)`; wizard `(48,198,1080,500)`.
Shared sidebar is now `(1192,0,248,900)`, topbar `(0,0,1192,72)`.
Desktop page titles use 28px / 700 Vazirmatn; white cards, 14px metric radii,
16px main-card radii and the reference shadow (0 4px 14px -4px, #0f172a at
10% opacity) follow the reference. List empty-state title, description and
action spacing was also corrected against the exported design.

After the user reactivated Penpot, fresh PNG exports of all six boards were
obtained. Dashboard, Wallet, Servers, Invoices, Charge requests and the initial
Create server screen were manually compared with screenshots in the current
browser. Final DOM checks confirmed the 23 regions remained within tolerance,
the title weight was 700 and card shadows matched the reference on all six
pages. The charge-request empty state now retains its reference CTA, routing
safely to the shared wallet (measured action y=611.67 vs design y=612).

At 390 × 844, the six critical routes plus the landing were also checked for
horizontal page overflow (none). The six-stage wizard remains present. This
is responsive geometry/behavior evidence, not mobile screenshot approval.

These checks caught and corrected reversed dashboard columns, an inflated
wallet/server row, 260px instead of 248px navigation, 74px instead of 72px
header, oversized metric cards, missing centered list-empty cards, and wizard
actions incorrectly embedded in the main card.

The unit tests validate selector/reference mapping and comparator failure
behavior. They do **not** run a browser and are not substitutes for the above
browser observations or a pixel-diff suite.

## Not yet approved / not claimed passed

- A repeatable screenshot/overlay/pixel-diff suite has not been run. The user
  explicitly selected current-browser-only checking and declined headless
  Playwright. No headless capture was used. The manual comparison plus measured
  DOM regions is not an automated pixel-regression pass. No screenshot of the
  implementation has been auto-approved as a Penpot baseline; PNG/diff artifacts
  were not saved by this browser-only review.
- The other ten dashboard boards, all authentication states, every wizard
  stage, dark mode and every responsive breakpoint are not covered by the
  23-region desktop result. They must not be described as pixel-perfect.
- Intentional functional differences need visual review: actual provider/OS
  inventory instead of empty design inventory; six purchase stages instead of
  the design's five (explicit billing period); a shared wallet/recharge action
  instead of creating a second legacy wallet; preserved filter reset/refresh
  controls; Telegram/admin settings submenu and current avatar; Lucide icons
  instead of the design's placeholder glyphs.
- The canonical invoice capability is explicitly unavailable in the real UI.
  Its Penpot empty-state fixture tests layout only, not actual invoice support.
- The connected Penpot file currently exposes Foundations, Components,
  Screens and Authentication, but no landing board. Landing pixel conformance
  requires that missing design page/board to be available; current landing
  screenshots cannot be declared a comparison against a nonexistent baseline.

## Release safety

Targeted local validation: `npm test` (19), backend platform-integration and
health-readiness Vitest tests (21), platform website-bridge and console-settings
pytest tests (22), and `python -m unittest discover -s deploy/tests -v` (6)
passed. Website build, frontend/backend lint and TypeScript checks passed;
platform changed-file Ruff checks and API/bot/worker import smoke passed.
These cover UI routing, final-only purchase behavior, financial/auth boundaries
and compatibility preflight ordering, not a live rollout or full release suite.
The platform's current `make staging-check` script expands into release gates,
contrary to its documented staging policy; the earlier attempt stopped at a
pre-commit cache PermissionError. This task does not claim that gate passed.

Visual review is not evidence that the integration was deployed. Website
readiness/preflight now requires both versioned feature advertisements and
401 `unauthorized` responses from the two new unauthenticated endpoint probes.
The old healthy canonical API fails this gate before writers are stopped.
Publishing and end-to-end testing of the real canonical endpoints still need
deployment authorization and a permitted test account. A real token must never
be revoked or customer funds touched by a readiness check.
