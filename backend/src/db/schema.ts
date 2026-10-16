/**
 * Cloud Server platform — database schema.
 *
 * Money rules (see docs/BILLING.md):
 *  - Customer money is stored as INTEGER rial amounts (IRR). Never floats.
 *  - Provider (Leaseweb) money is stored as INTEGER cents in the provider
 *    currency (e.g. provider_amount_cents EUR).
 *  - The API layer converts to toman (10 rials) for display only.
 *
 * Conventions:
 *  - UUID primary keys for business entities (generated in DB).
 *  - Provider identifiers are NEVER primary keys — they live in
 *    provider_* columns with their own uniqueness constraints.
 *  - Every financial mutation is an append-only ledger row (wallet_transactions).
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const userRoleEnum = pgEnum('user_role', ['user', 'admin'])
export const userStatusEnum = pgEnum('user_status', ['active', 'pending', 'disabled'])

export const walletTxTypeEnum = pgEnum('wallet_tx_type', [
  'deposit',
  'purchase',
  'renewal',
  'refund',
  'manual_credit',
  'manual_debit',
  'adjustment',
])

export const quoteStatusEnum = pgEnum('quote_status', ['valid', 'accepted', 'expired', 'cancelled'])

export const orderStatusEnum = pgEnum('order_status', [
  'draft',
  'quoted',
  'awaiting_payment',
  'paid',
  'queued',
  'provisioning',
  'active',
  'failed',
  'cancelled',
  'requires_review',
  'refunded',
])

export const invoiceStatusEnum = pgEnum('invoice_status', ['draft', 'open', 'paid', 'void', 'refunded', 'overdue'])

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'grace',
  'suspended',
  'cancelled',
  'expired',
])

export const serverStatusEnum = pgEnum('server_status', [
  'provisioning',
  'active',
  'suspended',
  'terminated',
  'failed',
])

export const providerOpStatusEnum = pgEnum('provider_op_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
  'unknown',
  'needs_reconciliation',
])

export const providerModeEnum = pgEnum('provider_mode', ['mock', 'live'])
export const billingIntervalEnum = pgEnum('billing_interval', ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'HOURLY', 'DAILY'])

// ---------------------------------------------------------------------------
// Users & auth
// ---------------------------------------------------------------------------
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    mobile: text('mobile'),
    nationalCode: text('national_code'),
    role: userRoleEnum('role').notNull().default('user'),
    status: userStatusEnum('status').notNull().default('active'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    mobileVerifiedAt: timestamp('mobile_verified_at', { withTimezone: true }),
    totpSecretEncrypted: text('totp_secret_encrypted'),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    recoveryCodesHash: jsonb('recovery_codes_hash').$type<string[]>(),
    timezone: text('timezone').default('Asia/Tehran'),
    lowBalanceWarnedAt: timestamp('low_balance_warned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
    uniqueIndex('users_mobile_unique_idx').on(t.mobile),
    index('users_role_idx').on(t.role),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sessions_token_hash_idx').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
)

export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    kind: varchar('kind', { length: 40 }).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    identifier: text('identifier').notNull(),
    codeHash: text('code_hash').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    resendCount: integer('resend_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    resendAfter: timestamp('resend_after', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_challenges_token_hash_idx').on(t.tokenHash),
    index('auth_challenges_identifier_idx').on(t.identifier),
    index('auth_challenges_expiry_idx').on(t.expiresAt),
  ],
)

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 30 }).notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('oauth_accounts_provider_subject_idx').on(t.provider, t.providerAccountId),
    index('oauth_accounts_user_idx').on(t.userId),
  ],
)

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 100 }).notNull(),
    targetType: varchar('target_type', { length: 50 }),
    targetId: uuid('target_id'),
    metadata: jsonb('metadata'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_action_created_idx').on(t.action, t.createdAt), index('audit_actor_idx').on(t.actorId)],
)

// ---------------------------------------------------------------------------
// Wallets & ledger (append-only)
// ---------------------------------------------------------------------------
export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    currency: text('currency').notNull().default('IRR'),
    balanceRial: bigint('balance_rial', { mode: 'number' }).notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('wallets_user_idx').on(t.userId)],
)

export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Signed: negative for debits, positive for credits.
    amountRial: bigint('amount_rial', { mode: 'number' }).notNull(),
    type: walletTxTypeEnum('type').notNull(),
    referenceType: varchar('reference_type', { length: 50 }),
    referenceId: uuid('reference_id'),
    idempotencyKey: text('idempotency_key'),
    balanceBeforeRial: bigint('balance_before_rial', { mode: 'number' }).notNull(),
    balanceAfterRial: bigint('balance_after_rial', { mode: 'number' }).notNull(),
    description: text('description'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('wallet_tx_wallet_idx').on(t.walletId, t.createdAt),
    index('wallet_tx_user_idx').on(t.userId),
    // Idempotency: one ledger row per (wallet, idempotency_key).
    uniqueIndex('wallet_tx_idempotency_idx').on(t.walletId, t.idempotencyKey).where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
)

// ---------------------------------------------------------------------------
// Pricing: FX rates + pricing rules
// ---------------------------------------------------------------------------
export const fxRates = pgTable(
  'fx_rates',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    fromCurrency: varchar('from_currency', { length: 8 }).notNull().default('EUR'),
    toCurrency: varchar('to_currency', { length: 8 }).notNull().default('IRR'),
    // EUR -> IRR, e.g. 620000.000000 (rials per euro).
    rate: numeric('rate', { precision: 20, scale: 6 }).notNull(),
    setBy: uuid('set_by').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('fx_pair_created_idx').on(t.fromCurrency, t.toCurrency, t.createdAt)],
)

export const pricingRules = pgTable(
  'pricing_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: varchar('provider', { length: 50 }).notNull().default('leaseweb'),
    markupPercent: numeric('markup_percent', { precision: 10, scale: 4 }).notNull().default('25'),
    markupFixedRial: bigint('markup_fixed_rial', { mode: 'number' }).notNull().default(0),
    taxPercent: numeric('tax_percent', { precision: 8, scale: 4 }).notNull().default('0'),
    roundingToRial: bigint('rounding_to_rial', { mode: 'number' }).notNull().default(1000),
    enabled: boolean('enabled').notNull().default(true),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('pricing_rules_provider_idx').on(t.provider)],
)

// ---------------------------------------------------------------------------
// Catalog (provider products, normalized)
// ---------------------------------------------------------------------------
export const providers = pgTable('providers', {
  id: varchar('id', { length: 50 }).primaryKey(), // 'leaseweb'
  name: text('name').notNull(),
  mode: providerModeEnum('mode').notNull().default('mock'),
  enabled: boolean('enabled').notNull().default(true),
  healthStatus: text('health_status'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  capabilities: jsonb('capabilities').$type<string[]>(),
  config: jsonb('config'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const providerLocations = pgTable(
  'provider_locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: varchar('provider', { length: 50 })
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 20 }).notNull(),
    country: text('country'),
    city: text('city'),
    available: boolean('available').notNull().default(true),
    raw: jsonb('raw'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('provider_locations_code_idx').on(t.provider, t.code)],
)

export const providerProducts = pgTable(
  'provider_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: varchar('provider', { length: 50 })
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    providerProductId: varchar('provider_product_id', { length: 100 }).notNull(),
    locationId: uuid('location_id').references(() => providerLocations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: varchar('category', { length: 30 }).notNull().default('vps'),
    vcpu: integer('vcpu').notNull(),
    memoryMb: integer('memory_mb').notNull(),
    diskGb: integer('disk_gb').notNull(),
    trafficGb: integer('traffic_gb'),
    ipv4Count: integer('ipv4_count').notNull().default(1),
    ipv6Available: boolean('ipv6_available').notNull().default(true),
    // Arbitrary provider-defined option sets (billing cycles, contract terms,
    // OS images, SLA levels) — passed through from the provider API, never
    // hardcoded enums. Shape: { billingCycles: [...], contractTerms: [...],
    // operatingSystems: [...], serviceLevels: [...] }
    billingOptions: jsonb('billing_options'),
    operatingSystems: jsonb('operating_systems'),
    serviceLevels: jsonb('service_levels'),
    configurableOptions: jsonb('configurable_options'),
    providerCurrency: varchar('provider_currency', { length: 8 }).notNull().default('EUR'),
    // Provider list price in integer cents of providerCurrency (base, no options).
    providerPriceCents: bigint('provider_price_cents', { mode: 'number' }),
    available: boolean('available').notNull().default(true),
    // Retail-sale approval gate. Catalog sync marks NEW offers as NOT enabled
    // for sale; an admin must explicitly enable them after price/markup/FX and
    // monthly-terms review. Catalog availability != retail approval.
    enabled: boolean('enabled').notNull().default(false),
    /** Classifier: at least one provider billing option invoices monthly
     * (MONTH_TO_MONTH or MONTHLY_BILLING_LONG_TERM_COMMITMENT). The exact
     * per-option classification lives in billingOptions[].classification. */
    monthlyEligible: boolean('monthly_eligible').notNull().default(false),
    raw: jsonb('raw'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('provider_products_uniq_idx').on(t.provider, t.providerProductId, t.locationId),
    index('provider_products_cat_idx').on(t.provider, t.category, t.available, t.enabled),
  ],
)

export const productSyncRuns = pgTable(
  'product_sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: varchar('provider', { length: 50 }).notNull(),
    mode: providerModeEnum('mode').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('running'),
    productsSeen: integer('products_seen').notNull().default(0),
    locationsSeen: integer('locations_seen').notNull().default(0),
    combinationsSeen: integer('combinations_seen').notNull().default(0),
    monthlyEligible: integer('monthly_eligible').notNull().default(0),
    missingPrice: integer('missing_price').notNull().default(0),
    missingBillingOptions: integer('missing_billing_options').notNull().default(0),
    httpErrors: integer('http_errors').notNull().default(0),
    error: text('error'),
    raw: jsonb('raw'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('product_sync_runs_provider_idx').on(t.provider, t.startedAt)],
)

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------
export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => providerProducts.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').references(() => providerLocations.id, { onDelete: 'restrict' }),
    provider: varchar('provider', { length: 50 }).notNull(),
    providerProductId: varchar('provider_product_id', { length: 100 }).notNull(),
    providerCurrency: varchar('provider_currency', { length: 8 }).notNull(),
    // Exact provider cents, including fractional cents for hourly cloud prices.
    providerAmountCents: numeric('provider_amount_cents', { precision: 20, scale: 6, mode: 'number' }).notNull(),
    fxRate: numeric('fx_rate', { precision: 20, scale: 6 }).notNull(),
    markupPercent: numeric('markup_percent', { precision: 10, scale: 4 }).notNull(),
    markupFixedRial: bigint('markup_fixed_rial', { mode: 'number' }).notNull(),
    taxPercent: numeric('tax_percent', { precision: 8, scale: 4 }).notNull(),
    subtotalRial: bigint('subtotal_rial', { mode: 'number' }).notNull(),
    taxRial: bigint('tax_rial', { mode: 'number' }).notNull(),
    totalRial: bigint('total_rial', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull().default('IRR'),
    billingInterval: billingIntervalEnum('billing_interval').notNull().default('MONTHLY'),
    // The exact provider billing option chosen (billingCycle/contractTerm/...),
    // echoed back to the provider at order time.
    billingOption: jsonb('billing_option'),
    operatingSystem: text('operating_system'),
    serviceLevel: jsonb('service_level'),
    status: quoteStatusEnum('status').notNull().default('valid'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('quotes_user_status_idx').on(t.userId, t.status), index('quotes_expiry_idx').on(t.status, t.expiresAt)],
)

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderNumber: varchar('order_number', { length: 40 }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    walletId: uuid('wallet_id').references(() => wallets.id, { onDelete: 'restrict' }),
    quoteId: uuid('quote_id').references(() => quotes.id, { onDelete: 'restrict' }),
    status: orderStatusEnum('status').notNull().default('draft'),
    totalRial: bigint('total_rial', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull().default('IRR'),
    billingInterval: billingIntervalEnum('billing_interval').notNull().default('MONTHLY'),
    provider: varchar('provider', { length: 50 }).notNull(),
    providerProductId: varchar('provider_product_id', { length: 100 }).notNull(),
    providerLocation: varchar('provider_location', { length: 20 }).notNull(),
    hostname: text('hostname').notNull(),
    operatingSystem: text('operating_system').notNull(),
    billingOption: jsonb('billing_option'),
    idempotencyKey: text('idempotency_key'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_number_idx').on(t.orderNumber),
    uniqueIndex('orders_idempotency_idx').on(t.idempotencyKey).where(sql`${t.idempotencyKey} IS NOT NULL`),
    index('orders_user_idx').on(t.userId, t.createdAt),
    index('orders_status_idx').on(t.status),
  ],
)

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 30 }).notNull().default('vps'),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull().default(1),
    unitAmountRial: bigint('unit_amount_rial', { mode: 'number' }).notNull(),
    totalRial: bigint('total_rial', { mode: 'number' }).notNull(),
    providerRef: text('provider_ref'),
    metadata: jsonb('metadata'),
  },
  (t) => [index('order_items_order_idx').on(t.orderId)],
)

export const orderEvents = pgTable(
  'order_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    fromStatus: orderStatusEnum('from_status'),
    toStatus: orderStatusEnum('to_status').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('order_events_order_idx').on(t.orderId, t.createdAt)],
)

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceNumber: varchar('invoice_number', { length: 40 }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    subscriptionId: uuid('subscription_id'),
    status: invoiceStatusEnum('status').notNull().default('draft'),
    subtotalRial: bigint('subtotal_rial', { mode: 'number' }).notNull(),
    taxRial: bigint('tax_rial', { mode: 'number' }).notNull(),
    discountRial: bigint('discount_rial', { mode: 'number' }).notNull().default(0),
    totalRial: bigint('total_rial', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull().default('IRR'),
    description: text('description'),
    // Historical price snapshot at issue time.
    snapshot: jsonb('snapshot'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('invoices_number_idx').on(t.invoiceNumber),
    index('invoices_user_idx').on(t.userId, t.issuedAt),
    index('invoices_status_idx').on(t.status, t.dueAt),
  ],
)

export const invoiceItems = pgTable(
  'invoice_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull().default(1),
    unitAmountRial: bigint('unit_amount_rial', { mode: 'number' }).notNull(),
    totalRial: bigint('total_rial', { mode: 'number' }).notNull(),
    referenceType: varchar('reference_type', { length: 50 }),
    referenceId: uuid('reference_id'),
  },
  (t) => [index('invoice_items_invoice_idx').on(t.invoiceId)],
)

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Plain uuid column (no FK) to avoid a circular FK with `servers` —
    // referential integrity is enforced by servers.subscription_id and by the
    // application. (drizzle cannot type a two-way circular FK.)
    serverId: uuid('server_id'),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    billingInterval: billingIntervalEnum('billing_interval').notNull().default('MONTHLY'),
    priceRial: bigint('price_rial', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull().default('IRR'),
    autoRenew: boolean('auto_renew').notNull().default(true),
    status: subscriptionStatusEnum('status').notNull().default('active'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull().defaultNow(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    nextInvoiceAt: timestamp('next_invoice_at', { withTimezone: true }).notNull(),
    nextDueAt: timestamp('next_due_at', { withTimezone: true }).notNull(),
    graceUntil: timestamp('grace_until', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('subscriptions_due_idx').on(t.status, t.nextDueAt),
    index('subscriptions_user_idx').on(t.userId),
  ],
)

export const subscriptionEvents = pgTable(
  'subscription_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    event: varchar('event', { length: 50 }).notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('subscription_events_sub_idx').on(t.subscriptionId, t.createdAt)],
)

export const renewalAttempts = pgTable(
  'renewal_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 30 }).notNull(), // pending | succeeded | insufficient_funds | failed
    amountRial: bigint('amount_rial', { mode: 'number' }).notNull(),
    error: text('error'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('renewal_attempts_sub_idx').on(t.subscriptionId, t.attemptedAt)],
)

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------
export const servers = pgTable(
  'servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, { onDelete: 'set null' }),
    provider: varchar('provider', { length: 50 }).notNull(),
    providerServerId: text('provider_server_id'),
    providerOrderId: text('provider_order_id'),
    providerProductId: varchar('provider_product_id', { length: 100 }).notNull(),
    providerLocation: varchar('provider_location', { length: 20 }).notNull(),
    hostname: text('hostname').notNull(),
    status: serverStatusEnum('status').notNull().default('provisioning'),
    operatingSystem: text('operating_system').notNull(),
    ipv4: text('ipv4'),
    ipv6: text('ipv6'),
    vcpu: integer('vcpu').notNull(),
    memoryMb: integer('memory_mb').notNull(),
    diskGb: integer('disk_gb').notNull(),
    trafficLimitGb: integer('traffic_limit_gb'),
    trafficUsedGb: integer('traffic_used_gb').notNull().default(0),
    providerMetadata: jsonb('provider_metadata'),
    billingPowerBlocked: boolean('billing_power_blocked').notNull().default(false),
    billingPowerBlockedAt: timestamp('billing_power_blocked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    terminatedAt: timestamp('terminated_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  },
  (t) => [
    // One internal server per order.
    uniqueIndex('servers_order_idx').on(t.orderId),
    // Provider server IDs are unique per provider once known (partial).
    uniqueIndex('servers_provider_server_idx')
      .on(t.provider, t.providerServerId)
      .where(sql`${t.providerServerId} IS NOT NULL`),
    index('servers_user_idx').on(t.userId, t.createdAt),
    index('servers_provider_idx').on(t.provider, t.status),
  ],
)

// ---------------------------------------------------------------------------
// Provider operations (idempotent provider call tracking)
// ---------------------------------------------------------------------------
export const providerOperations = pgTable(
  'provider_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: varchar('provider', { length: 50 }).notNull(),
    kind: varchar('kind', { length: 30 }).notNull(), // catalog_sync | provision | reconcile | server_sync | server_action
    action: varchar('action', { length: 50 }), // power_on | power_off | reboot | ...
    referenceType: varchar('reference_type', { length: 30 }).notNull(), // order | server
    referenceId: uuid('reference_id').notNull(),
    // e.g. leaseweb:provision:order:<orderId> — unique, prevents double orders.
    businessKey: varchar('business_key', { length: 200 }).notNull(),
    status: providerOpStatusEnum('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    requestMetadata: jsonb('request_metadata'),
    responseMetadata: jsonb('response_metadata'),
    /** Client-side request id sent to the provider (X-Correlation-Id). */
    providerRequestId: text('provider_request_id'),
    /** Provider-side correlation id from the response (e.g. APIGW-CORRELATION-ID). */
    providerCorrelationId: text('provider_correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('provider_ops_business_key_idx').on(t.businessKey), index('provider_ops_ref_idx').on(t.referenceType, t.referenceId)],
)

// ---------------------------------------------------------------------------
// Idempotency keys (generic HTTP idempotency, e.g. Idempotency-Key header)
// ---------------------------------------------------------------------------
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: varchar('scope', { length: 100 }).notNull(), // e.g. user:<id>
    key: varchar('key', { length: 200 }).notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('idempotency_keys_scope_key_idx').on(t.scope, t.key)],
)

// ---------------------------------------------------------------------------
// Notifications & support (minimal, real)
// ---------------------------------------------------------------------------
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body'),
    type: varchar('type', { length: 30 }).notNull().default('info'),
    read: boolean('read').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
)

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    department: varchar('department', { length: 30 }).notNull().default('technical'),
    description: text('description'),
    status: varchar('status', { length: 30 }).notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tickets_user_idx').on(t.userId, t.createdAt)],
)

export const chargeRequests = pgTable(
  'charge_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    number: varchar('number', { length: 40 }).notNull(),
    amountRial: bigint('amount_rial', { mode: 'number' }).notNull(),
    status: varchar('status', { length: 30 }).notNull().default('pending'),
    invoiceNumber: text('invoice_number'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('charge_requests_number_idx').on(t.number), index('charge_requests_user_idx').on(t.userId)],
)

// ---------------------------------------------------------------------------
// Settings (admin-configurable key/value)
// ---------------------------------------------------------------------------
export const settings = pgTable('settings', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Referenced type used by subscriptions before servers is declared — TypeScript
// ordering: servers is declared after subscriptions but the reference uses a
// string callback, which is fine at runtime.
