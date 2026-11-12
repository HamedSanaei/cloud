# Inventory of all Hetzner Cloud servers

The website's PostgreSQL remains canonical for customers, order ownership,
wallets, billing and website-created servers. Hetzner is read only for
**provider inventory**: all servers in every Hetzner Cloud project with an
API token configured, including machines created directly in Hetzner Console.

The admin-only `GET /api/admin/console/hetzner/inventory` endpoint lists
all configured projects using the existing multi-account Hetzner adapter and
`meta.pagination.next_page`, then atomically updates the site's
`hetzner_inventory` table. If a project cannot be read, it fails without
marking its missing servers as deleted. Previously observed machines remain
recorded but are not shown as present after a complete sync where they are
missing. Each record is keyed by `accountId:hetznerServerId` to prevent
cross-project ownership confusion. It deduplicates website-created servers by
their *exact* provider server ID, without inferring customer ownership from
hostnames or IP addresses.

Only logged-in **administrators** can see all provider projects on
`/admin/servers` and `/servers`. Ordinary users continue seeing only
their site-owned machines on `GET /api/servers`; external machines are
never silently assigned, charged, powered on/off, or added to customer orders.

## Private provider configuration

Each Hetzner Cloud API token is **scoped to a project**, so one token
cannot list servers from other projects. Configure all relevant projects
in the existing server-owned `configuration.toml` (never Git):

```toml
[providers.hetzner]
enabled = false
ordering_enabled = false

[providers.hetzner.accounts.production]
enabled = true
state = "active"
priority = 100
api_token = "REPLACE_WITH_READ_ONLY_PROJECT_TOKEN"

[providers.hetzner.accounts.internal]
enabled = true
state = "active"
priority = 200
api_token = "REPLACE_WITH_ANOTHER_PROJECT_TOKEN"
```

`enabled=false` prevents enabling Hetzner's provisioning flow while
the **inventory-only** admin endpoint can still perform GETs. Generate
read-only project tokens in Hetzner Console -> Project -> Security -> API
Tokens. The config is mounted read-only into the website API and worker
using `CLOUD_CONFIG_FILE` during the site-mode deploy. A missing or
invalid project token causes a visible error rather than a misleading
empty fleet. No token is returned by the API or written to PostgreSQL.

This feature covers **Hetzner Cloud servers**. Hetzner Robot/dedicated
servers require their separate Robot Web Service API and are not part of
`GET /v1/servers`.
