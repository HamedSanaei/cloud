# Server list: issues #72 and #73

UI implementation of the owner's Penpot handoff. Provisioning, authorization,
payments, wallet balances, reconciliation and refunds are unchanged.

## Exact Penpot sources

File: `c269caa0-e456-818c-8008-89e8e8e7477b`.
Screen page: `46894305-24e0-802f-8008-f0f341372876`.
Components page: `46894305-24e0-802f-8008-f0f5f51146e4`.

The four library components were inspected through Penpot Custom MCP Hamed,
including their main-instance geometry, typography, fills and PNG exports.

| Component (ParsServer / ServerList) | Library component ID | Main board ID | React implementation |
| --- | --- | --- | --- |
| CompactFailedRow / Light | `c8f3c8cb-0d4c-807f-8008-f392140fd845` | `c8f3c8cb-0d4c-807f-8008-f392140f8366` | `ServerTableRow` |
| CompactFailedRow / Dark | `c8f3c8cb-0d4c-807f-8008-f3922edfebc2` | `c8f3c8cb-0d4c-807f-8008-f3922edf9cba` | `ServerTableRow` + dark tokens |
| FailureDetailsPanel / Light | `c8f3c8cb-0d4c-807f-8008-f392512b2f37` | `c8f3c8cb-0d4c-807f-8008-f39250d3a4bd` | `FailureDetailsPanel` |
| FailureDetailsPanel / Dark | `c8f3c8cb-0d4c-807f-8008-f3925195a271` | `c8f3c8cb-0d4c-807f-8008-f392512cc09b` | `FailureDetailsPanel` + dark tokens |

Screen boards used for comparison:

| Screen | Board ID |
| --- | --- |
| Desktop light compact | `c8f3c8cb-0d4c-807f-8008-f390a0b4245f` |
| Desktop light expanded | `c8f3c8cb-0d4c-807f-8008-f39135528661` |
| Desktop dark compact | `c8f3c8cb-0d4c-807f-8008-f391074a5124` |
| Desktop dark expanded | `c8f3c8cb-0d4c-807f-8008-f3914dd021a6` |
| Mobile light cards | `c8f3c8cb-0d4c-807f-8008-f3918166c9bf` |
| Mobile dark expanded | `c8f3c8cb-0d4c-807f-8008-f391a185f30c` |

Handoff comments: [#72](https://github.com/HamedSanaei/cloud/issues/72#issuecomment-6902107316)
and [#73](https://github.com/HamedSanaei/cloud/issues/73#issuecomment-6902110816).

## Mapping and accessibility

- Primary desktop rows are 89px, matching CompactFailedRow. Full text is in a
  separate five-column detail row, controlled by a native button with stable
  `aria-controls`, `aria-expanded` and a visible keyboard focus outline.
- The panel keeps the complete API message, exact financial outcome, next step,
  tracking reference and existing support/allowed alternative links. Missing
  financial data is explicitly unknown; the UI never infers a completed refund.
- Pending rows offer read-only tracking. Existing local detail links and platform
  management callbacks/disabled authorization explanations remain intact.
- Real platform/server IDs and tracking references replace Penpot mock values.
  Machine IDs and IPs use bidi isolation, exact-value copy controls and manual
  selection when clipboard access fails. Historical deleted IPs stay unavailable.
- Existing semantic theme variables supply surfaces and text. The small scoped
  success/warning/action inks match the handoff palette. Control borders and
  focus outlines deliberately use stronger existing palette colors to meet
  contrast requirements; decorative panel borders retain the design colors.
- Mobile uses stacked cards with labelled cells, full-width disclosure and an
  inset panel. Desktop/tablet keeps table headers and horizontal table scrolling.
  Variable-length API guidance may increase the expanded panel height.

## Reproducible validation

```text
npm test
npm run typecheck
npm run lint
npm run build
```

`server-list-contrast.test.tsx` checks the actual production palette declarations
for both themes (normal text 4.5:1; meaningful borders/focus 3:1), including badges,
warning text, muted metadata, primary/secondary/hover and disabled controls.
`server-list-disclosure.test.tsx` covers keyboard operation, independent panels,
unknown financial outcomes, exact reference copying/manual fallback, navigation
and platform authorization. Existing failure/billing, filters, IP and lifecycle
tests continue to run.

For current-browser visual review, start the isolated synthetic preview:

```text
npm run preview:design -- --server-list
```

Then set `SERVER_LIST_CDP` to the **already-running** local browser's CDP endpoint
and run `node test/visual/server-list.mjs`. The script never launches a browser or
connects to production. It opens a temporary tab in the current browser, blocks
non-preview requests, checks the fixture-only response header and closes its own
tab afterward. `PLAYWRIGHT_MODULE` can point at an installed/bundled
`playwright-core` module when workspace browser dependencies are unavailable.

The review generates compact/expanded PNGs, mobile viewport screenshots and
measurements under ignored `.vite/server-list-review/`. Assertions cover desktop
row heights, mobile card bounds, overflow, keyboard disclosure/focus, actual
rendered text contrast and search. Screenshots are reviewed against the boards
above; this is **not** a claim of pixel-identical automated Penpot image diffs.

Validation on 2026-11-16: 258 frontend tests passed, Typecheck/Lint/production build
passed; current running Edge browser (CDP, no headless launch), light/dark at
1440/390/320px passed. Screenshots were inspected, including expanded panels in
both themes. Fixtures include failed/refunded, failed/captured, failed/not-charged,
queued, provisioning, ready with long IPv6, terminated, delete-failed and disabled
platform management. OS dark
preference is tested without a saved theme override.
