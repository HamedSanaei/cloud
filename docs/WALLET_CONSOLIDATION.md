# Single-wallet cutover

Migration `0012_single-wallet` keeps one IRR wallet per site user. It selects the
oldest wallet marked default, then uses creation time and UUID as tie-breakers.
If none was marked default, it selects the oldest wallet. A database trigger
provisions a wallet when a user is inserted, including imports. An active-wallet
unique index fences concurrent inserts.

The migration runs as one transaction under the exclusive writer gate and
locks the financial tables. It sums each account's balance in PostgreSQL integer
precision, archives source wallets at zero and inserts a `wallet.consolidated`
audit manifest per merged account. The manifest retains the source balances,
canonical ID, currency, operation ID and pre/post total. Ledger rows, including
their wallet IDs, stay byte-for-byte unchanged. No deposit or debit is created.

Live orders carry the canonical wallet to subscriptions and renewals. Open
payment intents and pending adjustments are rewired. Completed payments and
adjustments keep their historical references. Provider callback tokens remain
valid. IP replacement operations retain the original request wallet; refunds
resolve its owner-checked alias. A replay checks the owner's archived and active
ledger rows under the canonical wallet lock. An exact match returns the
original row, and reuse of a key with different amount, type or reference fails.

## Preflight and cutover

1. Run `npm run db:wallet-preflight` from `backend`, or `node dist/db/wallet-preflight.js`
   in the backend image, using the target database read-only credentials. Save
   the report in restricted storage. It includes per-user wallet IDs and exact
   balances, reference and ledger counts, duplicate keys, open payments and
   charges, subscriptions, unresolved renewals and provider operations. Review
   every blocker and confirm pending callbacks remain retryable. Keep the site
   and any external financial authority distinct.
2. Verify a restorable encrypted pre-cutover backup in an isolated database.
   Compare the preflight's balances and outstanding references with the restore.
   Set `WALLET_CONSOLIDATION_APPROVED=true` for the controlled production release
   only after this review. Production migrations refuse to merge existing
   multiple wallets without explicit approval. The standard deploy validates
   the encrypted dump before running the migration and drains API and worker writes.
3. Compare the post-cutover wallet totals and record counts with the preflight.
   Reconcile each `wallet.consolidated` manifest, then confirm one unmerged wallet
   per user and archived balances of zero. Review outstanding payments, renewals,
   IP fees and adjustments before lifting maintenance. Remove the approval
   variable after cutover. Track merged-account progress via the manifest count;
   the migration commits all accounts together or none, and can be rerun after a
   failed or interrupted attempt without moving funds twice.

The migration refuses cross-owner references, negative or non-IRR balances and
totals outside the exact application integer range. Fix and document those on
the source system before retrying. Duplicate legacy idempotency keys are
reported and preserved. An unmatched historical key reuse is surfaced as a
conflict for reconciliation.

## Recovery

A failed transaction leaves the original schema and balances in place. Correct
the preflight blocker and rerun. If validation fails after commit, keep writers
stopped and restore the verified encrypted backup to an isolated database.
Compare users, ledger, payments, open operations and balances before any cutback.
If writes resumed after cutover, reconcile those events with the provider and
ledger before choosing a recovery point. A schema-only downgrade could make
archived wallets spendable or lose post-cutover payments.
