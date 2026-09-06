/**
 * Leaseweb operations CLI (npm run leaseweb -- <command>).
 *
 * Commands (all read-only unless stated):
 *   doctor        connectivity/auth/catalog check against the configured mode
 *   sync-offers   sync the provider catalog into normalized tables (idempotent)
 *   list-monthly  list monthly-compatible offers (--json for machine output)
 *   price-preview provider EUR cost -> FX -> markup -> IRR -> toman (--json)
 *
 * Safety:
 *  - `doctor` performs GET requests only. Paid ordering stays disabled unless
 *    LEASEWEB_ORDERING_ENABLED=true, and even then this CLI never orders.
 *  - The API key is read from config only; it is never printed, logged or
 *    written anywhere by this script.
 */
import { loadConfig, getConfig } from '../config.js'
import { createDb } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { registerConfiguredProviders, getProvider } from '../modules/providers/registry.js'
import { syncProviderCatalog } from '../modules/catalog/service.js'
import { computePriceFromRules, getActiveFxRate, getPricingRules } from '../modules/pricing/service.js'
import { eq } from 'drizzle-orm'
import type { ProviderBillingOption } from '../modules/providers/provider.interface.js'

function toman(rial: number): string {
  // 1 toman = 10 rials.
  return `${(rial / 10).toLocaleString('en-US')} تومان`
}

function eurCentsToEur(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function getMonthlyOptions(billingOptions: unknown): Array<ProviderBillingOption & { monthly: true }> {
  if (!Array.isArray(billingOptions)) return []
  return billingOptions.filter((b): b is ProviderBillingOption & { monthly: true } =>
    b !== null && typeof b === 'object' && (b as ProviderBillingOption).monthly === true,
  )
}

async function runDoctor() {
  const config = getConfig()
  const orderingEnabled = config.LEASEWEB_ORDERING_ENABLED
  console.log('Leaseweb doctor')
  console.log('  mode                 :', config.LEASEWEB_MODE)
  console.log('  ordering enabled     :', orderingEnabled ? 'YES' : 'NO')
  console.log('  paid POST safety guard:', orderingEnabled ? 'INACTIVE — live ordering allowed' : 'ACTIVE')

  if (config.LEASEWEB_MODE !== 'live') {
    console.log('  API reachable        : N/A (mock mode — no network calls)')
    console.log('  authentication       : N/A (mock mode)')
    console.log('  catalog access       : N/A (mock mode)')
    console.log('\nTo check the real account, run with LEASEWEB_MODE=live (read-only).')
    return 0
  }

  const provider = getProvider('leaseweb')
  const started = Date.now()
  try {
    const result = await provider.syncCatalog()
    const latency = Date.now() - started
    console.log('  API reachable        : OK')
    console.log('  authentication       : OK')
    console.log(`  catalog access       : OK (${result.offers.length} offers, ${result.locations.length} locations)`)
    console.log(`  API latency          : ${latency} ms`)
    console.log('  paid POSTs made      : 0 (read-only check only)')
    return 0
  } catch (err) {
    const e = err as { code?: string; details?: { providerCorrelationId?: string; httpStatus?: number }; message?: string }
    console.log('  API reachable        : FAIL')
    console.log(`  error code           : ${e.code ?? 'unknown'}`)
    if (e.details?.httpStatus) console.log(`  http status          : ${e.details.httpStatus}`)
    if (e.details?.providerCorrelationId) console.log(`  correlation id       : ${e.details.providerCorrelationId}`)
    console.log(`  message              : ${e.message ?? 'unknown'}`)
    console.log('\nRaise this correlation id with Leaseweb support if needed.')
    return 1
  }
}

async function runSyncOffers() {
  const provider = getProvider(getConfig().DEFAULT_PROVIDER)
  const { db, pool } = createDb()
  try {
    const result = await syncProviderCatalog(db, provider)
    const latest = await db.query.productSyncRuns.findFirst({
      where: (t) => eq(t.id, result.runId),
    })
    console.log(`Catalog sync OK (run ${result.runId})`)
    console.log(`  products/locations  : ${result.products} / ${result.locations}`)
    if (latest) {
      console.log(`  monthly-eligible    : ${latest.monthlyEligible}`)
      console.log(`  missing price       : ${latest.missingPrice}`)
      console.log(`  missing billing opts: ${latest.missingBillingOptions}`)
      console.log(`  http errors         : ${latest.httpErrors}`)
    }
    console.log('\nNewly discovered offers are NOT enabled for retail sale.')
    console.log('Enable them via the admin API after price/FX/markup/terms review.')
  } finally {
    await pool.end()
  }
  return 0
}

async function listMonthlyRows() {
  const { db, pool } = createDb()
  try {
    const rows = await db.query.providerProducts.findMany({
      where: (t, { and, eq: eqF }) => and(eqF(t.available, true), eqF(t.monthlyEligible, true)),
      orderBy: (t, { asc }) => [asc(t.providerProductId)],
    })
    const locations = await db.query.providerLocations.findMany()
    const codeById = new Map(locations.map((l) => [l.id, l.code]))
    return rows.map((r) => {
      const options = getMonthlyOptions(r.billingOptions)
      return {
        providerProductId: r.providerProductId,
        location: codeById.get(r.locationId ?? '') ?? null,
        vcpu: r.vcpu,
        memoryMb: r.memoryMb,
        diskGb: r.diskGb,
        trafficGb: r.trafficGb,
        providerPriceCents: r.providerPriceCents,
        currency: r.providerCurrency,
        billingCycle: options[0]?.billingCycle ?? null,
        contractTerm: options[0]?.contractTerm ?? null,
        monthlyEligible: true,
        retailEnabled: r.enabled,
        billingOptions: r.billingOptions,
      }
    })
  } finally {
    await pool.end()
  }
}

async function runListMonthly(json: boolean) {
  const rows = await listMonthlyRows()
  if (json) {
    console.log(JSON.stringify({ syncedAt: new Date().toISOString(), offerings: rows }, null, 2))
    return 0
  }
  if (rows.length === 0) {
    console.log('No monthly-compatible offers found. Run `npm run leaseweb -- sync-offers` first.')
    return 0
  }
  const hdr = ['PRODUCT', 'LOCATION', 'vCPU', 'RAM MB', 'DISK GB', 'TRAFFIC GB', 'EUR/mo', 'CURRENCY', 'BILLING CYCLE', 'CONTRACT TERM', 'RETAIL']
  const table = rows.map((r) => [
    r.providerProductId,
    r.location ?? '-',
    String(r.vcpu),
    String(r.memoryMb),
    String(r.diskGb),
    String(r.trafficGb ?? '-'),
    r.providerPriceCents != null ? eurCentsToEur(r.providerPriceCents) : '-',
    r.currency ?? '-',
    r.billingCycle ?? '-',
    r.contractTerm != null ? String(r.contractTerm) : '-',
    r.retailEnabled ? 'ENABLED' : 'disabled',
  ])
  console.log(hdr.join('\t'))
  for (const row of table) console.log(row.join('\t'))
  return 0
}

async function runPricePreview(json: boolean) {
  const { db, pool } = createDb()
  try {
    const rows = await listMonthlyRows()
    let fxRate: string
    try {
      fxRate = (await getActiveFxRate(db)).rate
    } catch {
      console.log('No active EUR->IRR FX rate. Set one first (admin API / seed).')
      return 1
    }
    const rules = await getPricingRules(db, 'leaseweb')
    const out = []
    for (const r of rows) {
      const options = getMonthlyOptions(r.billingOptions)
      const amountCents = options[0]?.amountCents ?? r.providerPriceCents
      if (amountCents == null || amountCents <= 0) {
        out.push({ ...r, error: 'no monthly price' })
        continue
      }
      try {
        const snap = computePriceFromRules({
          providerCurrency: r.currency ?? 'EUR',
          providerAmountCents: amountCents,
          fxRate,
          rules,
        })
        out.push({
          ...r,
          providerCostEur: eurCentsToEur(amountCents),
          fxRate,
          markupPercent: snap.markupPercent,
          markupFixedRial: snap.markupFixedRial,
          finalRial: snap.totalRial,
          finalToman: toman(snap.totalRial),
        })
      } catch (err) {
        out.push({ ...r, error: (err as Error).message })
      }
    }
    if (json) {
      console.log(JSON.stringify({ fxRate, offerings: out }, null, 2))
      return 0
    }
    console.log('PRODUCT\tLOCATION\tEUR/mo\tFX\tMARKUP %\tFINAL IRR\tFINAL (TOMAN)')
    for (const o of out) {
      if ('error' in o) {
        console.log(`${o.providerProductId}\t${o.location ?? '-'}\t-\t-\t-\tERROR: ${o.error}`)
      } else {
        console.log(
          `${o.providerProductId}\t${o.location ?? '-'}\t${o.providerCostEur}\t${o.fxRate}\t${o.markupPercent}\t${o.finalRial}\t${o.finalToman}`,
        )
      }
    }
    return 0
  } finally {
    await pool.end()
  }
}

async function main() {
  const cmd = process.argv[2] ?? ''
  loadConfig()
  await migrate()
  registerConfiguredProviders()

  const json = process.argv.includes('--json')
  switch (cmd) {
    case 'doctor':
      return runDoctor()
    case 'sync-offers':
      return runSyncOffers()
    case 'list-monthly':
      return runListMonthly(json)
    case 'price-preview':
      return runPricePreview(json)
    default:
      console.log(`Usage: npm run leaseweb -- <command> [--json]\n\nCommands:\n  doctor\n  sync-offers\n  list-monthly\n  price-preview`)
      return cmd ? 1 : 0
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[leaseweb] failed:', (err as Error).message)
    process.exit(1)
  })