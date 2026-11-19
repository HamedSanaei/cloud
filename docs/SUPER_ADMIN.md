# Super Admin rollout

1. Take a verified backup and apply the committed migrations through the normal
   release pipeline. Migration 0017 promotes the sole active legacy `admin`
   when there is no active `super_admin`, and records the promotion in Audit.
2. Refresh the owner's existing session. Check that the settings menu appears
   on desktop and mobile and that `/api/admin/settings/capabilities` reports
   `allowed: true`. Open TabaPay, proxy settings, and Hetzner margin without
   changing their values. Confirm the deployed web and API SHA.

Installations with multiple active legacy admins and no active Super Admin
require independent owner verification. The migration grants no access in this
case. Use the `super_admin_missing` event and its active-admin count to identify
the state. From the API container, a verified database operator can run
`node dist/scripts/bootstrap-super-admin.js` in an interactive terminal and
select the verified active administrator by email. The command records the
promotion in Audit and refuses to run when an active Super Admin exists.
Installations with no active admin must first recover an authorized admin account.

An active Super Admin can grant or revoke the role under **تنظیمات فروشگاه → نقش
مدیران** with their current password, TOTP if enrolled, and explicit confirmation.
Every active Super Admin has the same access. A role change invalidates pending
authorization proofs. The API reads the current role from the database on each
request. The last active Super Admin cannot be demoted through the panel.

For application rollback, use a release that understands the role and traffic
ledger. Before returning to a build without these schema changes, pause writers
and reconcile billing after cutover with the database operator. Keep the new
schema and retain the ledger. Restoring an older database snapshot would also
revert later wallet entries and requires the existing reviewed recovery process.
