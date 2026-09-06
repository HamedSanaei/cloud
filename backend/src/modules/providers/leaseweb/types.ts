/**
 * Raw Leaseweb API payload types.
 *
 * These mirror the official API responses (developer.leaseweb.com). They are
 * intentionally loose where the schema varies per account/entity — the
 * normalizer only reads fields it can prove exist. Billing enums are NEVER
 * hardcoded here: they flow through from the API responses.
 */

// ---- Ordering API (ordering/v1) -------------------------------------------

export interface LswOrderingProduct {
  id?: string
  name?: string
  category?: string
  description?: string
  [k: string]: unknown
}

export interface LswOrderingProductsResponse {
  products?: LswOrderingProduct[]
  metadata?: Record<string, unknown>
  [k: string]: unknown
}

export interface LswOrderingProductDetail extends LswOrderingProduct {
  configuration?: {
    operatingSystems?: Array<{ id?: string; label?: string } | string>
    locations?: Array<{ id?: string; label?: string } | string>
    serviceLevels?: Array<{ id?: string; label?: string } | string>
    billingCycles?: Array<{ id?: string; label?: string; price?: { amount?: number | string; currency?: string } } | string>
    contractTerms?: Array<{ id?: number | string; label?: string } | number | string>
    diskUpgrades?: unknown[]
    addons?: unknown[]
    [k: string]: unknown
  }
  price?: { amount?: number | string; currency?: string }
  pricing?: Record<string, unknown>
  [k: string]: unknown
}

export interface LswOrderRequest {
  operatingSystem?: string
  location?: string
  serviceLevelAgreement?: string
  billingCycle?: string
  contractTerm?: number | string
  diskUpgrade?: unknown
  controlPanel?: unknown
  quantity?: number
  [k: string]: unknown
}

export interface LswOrderResponse {
  orderId?: string
  id?: string
  state?: string
  status?: string
  productId?: string
  [k: string]: unknown
}

// ---- VPS management API (vps/v1) ------------------------------------------

export interface LswVirtualServer {
  id?: string
  name?: string
  state?: string
  ipAddresses?: Array<{ ip?: string; version?: string | number }>
  ips?: Array<{ ip?: string; version?: string | number }>
  operatingSystem?: { id?: string; label?: string } | string
  [k: string]: unknown
}

export interface LswVirtualServersResponse {
  virtualServers?: LswVirtualServer[]
  [k: string]: unknown
}

export interface LswActionResponse {
  status?: string
  [k: string]: unknown
}