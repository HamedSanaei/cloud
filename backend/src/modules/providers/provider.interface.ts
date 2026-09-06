/**
 * CloudProvider abstraction.
 *
 * The platform is provider-agnostic: orders, billing, wallets, subscriptions
 * and servers never reference provider-specific logic. New providers (Proxmox,
 * Hetzner, ...) implement this interface and register themselves.
 *
 * Not every provider supports every operation — check `supports()` and throw
 * NotSupportedError otherwise. Provider IDs are never our business IDs; they
 * are stored in provider_* columns with their own uniqueness constraints.
 *
 * # Recovery contract (UNKNOWN order outcomes)
 *
 * After a paid provider order whose outcome is ambiguous (e.g. timeout after
 * dispatch), `reconcileOrder()` is asked whether the provider can prove which
 * external resource belongs to THIS internal operation.
 *
 * RecoveryResult.MATCHED means the provider supplied evidence that
 * CONCLUSIVELY links the external resource/order to this exact internal
 * provider operation — never "it looks similar", never "there is only one
 * candidate", never "the hostname matches".
 *
 * Providers without a reliable client reference (currently Leaseweb VPS
 * Ordering) MUST return AMBIGUOUS with candidate evidence when they cannot
 * prove ownership. The caller then keeps the operation under review and
 * requires an operator decision.
 */

export type ProviderCapability =
  | 'catalog'
  | 'provision'
  | 'power_on'
  | 'power_off'
  | 'reboot'
  | 'reinstall'
  | 'snapshots'
  | 'console'
  | 'traffic'
  | 'terminate'
  | 'reconcile'

/**
 * Commercial classification of a provider billing option. Never guessed:
 * derived only from provider-returned evidence (see modules/providers/billing.ts).
 */
export type CommercialType =
  | 'MONTH_TO_MONTH'
  | 'MONTHLY_BILLING_LONG_TERM_COMMITMENT'
  | 'NON_MONTHLY_BILLING'
  | 'UNKNOWN'

export interface BillingClassification {
  classification: CommercialType
  /** 'MONTHLY' only when monthly invoicing is proven. */
  customerBillingInterval: 'MONTHLY' | null
  /** true only when month-to-month (monthly billing AND <=1-month commitment). */
  monthToMonth: boolean | null
  /** Why the classifier decided this — always populated. */
  eligibilityReason: string
  /** Evidence origin, e.g. 'leaseweb-api' or 'mock-fixture'. */
  source: string
}

export interface ProviderBillingOption {
  /** Provider-defined billing cycle id, exactly as the API returns it. */
  billingCycle: string
  /** Human label, e.g. "Monthly". */
  label?: string
  /** Provider-defined contract term (months or id), exactly as returned. */
  contractTerm?: number | string
  /** Period this option bills for, in months — only when provable. 1 = monthly. */
  periodMonths?: number
  /** Total provider price for this option/period, integer cents. */
  amountCents?: number
  /** Original provider amount string when the API returns a decimal. */
  amount?: string
  /** Classifier output (added at catalog sync, not by the provider adapter). */
  classification?: CommercialType
  customerBillingInterval?: 'MONTHLY' | null
  monthToMonth?: boolean | null
  eligibilityReason?: string
  source?: string
}

export interface ProviderOsOption {
  id: string
  label?: string
  family?: string
}

export interface ProviderSlaOption {
  id: string
  label?: string
}

export interface ProviderOffer {
  provider: string
  providerProductId: string
  location: string
  name: string
  vcpu: number
  memoryMb: number
  diskGb: number
  trafficGb: number | null
  ipv4Count: number
  ipv6Available: boolean
  providerCurrency: string
  /** Base list price in integer cents (may be null when only per-option prices exist). */
  providerPriceCents: number | null
  billingOptions: ProviderBillingOption[]
  operatingSystems: ProviderOsOption[]
  serviceLevels: ProviderSlaOption[]
  raw?: unknown
}

export interface ProviderOrderRequest {
  productId: string
  location: string
  operatingSystem: string
  billingOption: ProviderBillingOption
  serviceLevel?: ProviderSlaOption
  hostname?: string
  quantity?: number
}

export type ProviderOrderState = 'pending' | 'active' | 'failed' | 'unknown'

export interface ProviderOrderResult {
  providerOrderId: string
  state: ProviderOrderState
  providerServerId?: string
  metadata?: Record<string, unknown>
}

export type ProviderServerState = 'provisioning' | 'active' | 'suspended' | 'terminated' | 'failed' | 'unknown'

export interface ProviderServerView {
  providerServerId: string
  state: ProviderServerState
  hostname?: string
  ipv4?: string
  ipv6?: string
  vcpu?: number
  memoryMb?: number
  diskGb?: number
  trafficUsedGb?: number
  metadata?: Record<string, unknown>
}

export type RecoveryResolution = 'MATCHED' | 'NO_MATCH' | 'AMBIGUOUS' | 'UNSUPPORTED'

/**
 * Result of asking the provider to reconcile an UNKNOWN order outcome.
 *
 * - MATCHED: conclusive proof (provider-issued id captured BEFORE the
 *   ambiguity, verified to exist at the provider). Safe to attach.
 * - NO_MATCH: the provider can prove the resource does not exist
 *   (only trustworthy when the provider exposes an exact id lookup).
 * - AMBIGUOUS: the provider cannot prove ownership. `candidates` are
 *   operator-facing EVIDENCE ONLY — they must never trigger auto-attach.
 * - UNSUPPORTED: provider cannot answer this question.
 */
export interface RecoveryResult {
  resolution: RecoveryResolution
  /** Conclusive external server id (only when MATCHED). */
  providerServerId?: string
  /** Conclusive external order id (only when MATCHED). */
  providerOrderId?: string
  /** Evidence for operators when AMBIGUOUS. */
  candidates?: Array<{
    providerServerId?: string
    hostname?: string
    createdAt?: string
    state?: string
  }>
  /** Human explanation, e.g. why automatic matching was refused. */
  reason?: string
}

export interface ProviderActionResult {
  ok: boolean
  metadata?: Record<string, unknown>
}

export class NotSupportedError extends Error {
  readonly capability: ProviderCapability
  constructor(capability: ProviderCapability) {
    super(`Provider does not support capability: ${capability}`)
    this.name = 'NotSupportedError'
    this.capability = capability
  }
}

export interface CloudProvider {
  readonly id: string
  readonly name: string
  readonly capabilities: ProviderCapability[]
  supports(capability: ProviderCapability): boolean
  /** Guard helper: throws NotSupportedError when capability is missing. */
  require(capability: ProviderCapability): void

  // Catalog
  syncCatalog(): Promise<{ offers: ProviderOffer[]; locations: Array<{ code: string; country?: string; city?: string }>; raw: unknown }>

  // Provisioning
  createServer(req: ProviderOrderRequest): Promise<ProviderOrderResult>
  getServer(providerServerId: string): Promise<ProviderServerView>
  listServers(): Promise<ProviderServerView[]>

  // Management actions
  powerOn(providerServerId: string): Promise<ProviderActionResult>
  powerOff(providerServerId: string): Promise<ProviderActionResult>
  reboot(providerServerId: string): Promise<ProviderActionResult>

  /**
   * Reconcile an UNKNOWN order outcome. See the Recovery contract above.
   * Provider implementations decide what counts as conclusive proof.
   */
  reconcileOrder?(input: {
    /** External ids captured from the response BEFORE the ambiguity, if any. */
    knownProviderOrderId?: string
    knownProviderServerId?: string
    /** What we requested (evidence only — never used as proof). */
    requested?: {
      productId?: string
      location?: string
      operatingSystem?: string
      hostname?: string
      billingOption?: ProviderBillingOption
    }
  }): Promise<RecoveryResult>
}