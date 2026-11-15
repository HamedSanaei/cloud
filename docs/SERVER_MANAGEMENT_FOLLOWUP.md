# Customer server management follow-up (#77–#83)

- **#77:** Confirmed deletion (lifecycle or provider state) replaces live monitoring
  with a localized unavailable message. No metrics/range/retry controls mount.
  The API also rejects confirmed-deleted metrics before cache/provider access.
- **#78:** Resize quotes persist `currentDiskGb` and `resultingDiskGb`, derived
  from the inspected disk and validated target/disk option. Preview and final
  typed confirmation reuse that quote. Missing outcome data blocks confirmation;
  dispatch rechecks the quoted disk outcome if present. Nominal plan disk sizes
  are not treated as the actual disk when expansion is unchecked.
- **#79:** A labelled keyboard entry calls public noVNC `focus()`. Tab remains a
  guest key. `Ctrl + Alt + Escape` returns focus to page controls and releases
  guest modifiers; a visible focus outline and adjacent instructions explain it.
- **#80:** Expand/collapse increases the viewer's width and height without
  replacing its DOM node, requesting a grant, reconnecting, or resizing the guest.
- **#81:** Quotes/confirmation disclose possible startup. Confirmed resize
  metadata stores the validated baseline and observed final power state. History
  reports observed startup without guessing whether the provider or another actor
  initiated it. No new power-on action is dispatched.
- **#82:** The proxy deadline uses shared close code `4008`. The client uses that
  explicit reason (and its own deadline) for expiry wording; unexpected loss,
  security errors and manual closure retain separate messages.
- **#83:** Unclaimed credentials show originating action, request time and
  operation ID. Rescue credentials are also available in the Rescue panel.
  The reveal dialog retains the same context. Claimed/acknowledged or unconfirmed
  entries remain excluded; opening the list does not claim or display secrets.

## Validation and rollout

Local: frontend suite (295), backend unit suite (286), both Typechecks/Lints and
production frontend build passed. Database integration assertions are included
in `backend/test/integration/customer-server-management.test.ts`; local Docker
was unavailable, so database tests require CI's ephemeral PostgreSQL/Redis.
No customer database or provider server is used for these checks.

`test/visual/server-console.mjs` additionally connects to an **already-running**
local browser via `SERVER_LIST_CDP`, starts a loopback-only fixture and synthetic
RFB peer, and drives the actual noVNC client. It checks keyboard entry, guest Tab,
focus return, desktop expansion, mobile bounds and expiry code handling. It never
launches a browser or contacts a VPS. Set `PLAYWRIGHT_MODULE` if using a bundled
Playwright installation. Screenshots go to ignored `.vite/console-review/`.
At a 1536×687 viewport the expanded 1280×800 synthetic framebuffer rendered at
approximately 825×516 CSS pixels (64% instead of the reported 37.5%).

The API changes are additive and need no migration or new settings. Deploy the
backend before the frontend: the frontend deliberately refuses a resize quote
that lacks validated disk/power fields. Existing accepted operation retries keep
their persisted idempotent payload; old operation histories do not infer startup.
This PR does not change provider ownership, wallet/debit policy, secret delivery
authorization, console lifetime or provider-side operations.
