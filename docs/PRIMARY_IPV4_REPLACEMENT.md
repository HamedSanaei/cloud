# Primary IPv4 replacement

In site-authority mode an active account can request a replacement on a server
it owns. The Hetzner adapter uses the stored owning project and server ID. It
requires an assigned, unblocked, auto-delete Primary IPv4 without delete
protection or custom reverse DNS in the same location. Asiatech is unsupported.
Hetzner bills Primary IPs separately. The replacement may briefly leave two
billable addresses in the project. The storefront fee covers the one-time
operation and does not change the server subscription.

The default is 1,500,000 rial (150,000 toman). The store accepts a positive
whole-toman price between 1 and 100,000,000 toman, stored in integer rial by
provider. Set `PRIMARY_IPV4_SUPER_ADMIN_IDS` in the API environment to the
comma-separated UUIDs of authorized active admin accounts, then select
**تعرفهٔ تعویض IPv4** under store settings. Price history records the operator,
old/new price and date. A new request uses the current quote version; an
accepted request keeps its quoted fee.

The server's billing wallet is debited and the operation recorded in the same
transaction. The debit is the reservation and becomes the final fee when the
replacement is confirmed. Failure or an indeterminate outcome releases it with
a separate, idempotent refund. If an indeterminate operation later succeeds,
the refund stays in place. Hourly restart funding still applies.

## Recovery

1. Take the operation ID from the customer's Network or Operations tab. Review
   the stored owning project, old IP ID, last step and any Action ID. On the
   exact owning Hetzner project, look for the replacement using the label
   `parserver-ip-operation=<operation-id>`. Check the provider action history
   for in-flight actions before making changes.
2. The worker reconciles matching provider evidence and progresses without
   repeating an ambiguous mutation. A rejected attach restores the original
   address and power state, then removes the replacement. A successful change
   confirms the new assignment and intended power state before removing the
   old IP. A running VM state confirms provider power, while guest/SSH/DNS
   reachability depends on the customer's configuration.
3. For an unresolved rollback, restore the original address and intended power
   state and remove the operation's unassigned replacement in that project.
   After checking the provider history, an authorized super admin can call
   `POST /api/v1/admin/settings/primary-ipv4-operations/{operationId}/confirm-rollback`
   with `confirm: true` and an audit `note`. The API rechecks the original
   address, power state and absence of the tagged replacement before releasing
   the server operation lock. A timeout on its own never releases the lock.

Provider reference: [Hetzner Primary IP FAQ](https://docs.hetzner.com/cloud/servers/primary-ips/faq/).
