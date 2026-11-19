# Super Admin rollout

1. Take a verified backup and apply the committed migrations in each environment.
2. Verify the existing owner's identity and confirm their active `admin` account
   UUID against the target environment. From the site's API container, run
   `node dist/scripts/bootstrap-super-admin.js <verified-admin-uuid>` once.
   The command requires database operator access and records an audit event.
   It refuses to run when an active Super Admin exists. The API logs
   `super_admin_missing` when protected settings have no active owner.
3. Sign in as that account and check `/api/admin/settings/capabilities` and
   `/admin/settings/hetzner-margin`. Verify that the margin is readable and
   unchanged. Check that ordinary admins retain their console and receive 403
   from protected settings. Review both the web and API deployed SHA.

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
