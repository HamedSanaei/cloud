/**
 * Development/bootstrap seed (npm run seed).
 *
 * Creates:
 *  - an admin user   (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD, defaults below)
 *  - a demo user     (SEED_DEMO_EMAIL / SEED_DEMO_PASSWORD)
 *  - credits the demo user's default wallet
 *  - sets the EUR->IRR FX rate
 *  - syncs the provider catalog (mock mode by default)
 *
 * NEVER run against production expectations: this is a bootstrap helper.
 * Default credentials are printed for local development only.
 */
import { loadConfig, getConfig } from '../config.js'
import { createDb } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { registerUser } from '../modules/auth/service.js'
import { ensureDefaultWallet, creditWallet } from '../modules/wallets/service.js'
import { setFxRate } from '../modules/pricing/service.js'
import { syncProviderCatalog, enableAllOffersForSale } from '../modules/catalog/service.js'
import { getProvider, registerConfiguredProviders } from '../modules/providers/registry.js'
import { users } from '../db/schema.js'
import { eq } from 'drizzle-orm'

async function main() {
  loadConfig()
  const config = getConfig()
  const { db, pool } = createDb()
  await migrate()

  await registerConfiguredProviders()

  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@cloud.local').toLowerCase()
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123456!'
  const demoEmail = (process.env.SEED_DEMO_EMAIL ?? 'demo@cloud.local').toLowerCase()
  const demoPassword = process.env.SEED_DEMO_PASSWORD ?? 'Demo123456!'

  let admin = await db.query.users.findFirst({ where: (t) => eq(t.email, adminEmail) })
  if (!admin) {
    admin = await registerUser(db, { email: adminEmail, password: adminPassword, firstName: 'مدیر', lastName: 'سیستم' })
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, admin.id))
    console.log(`[seed] admin created: ${adminEmail}`)
  } else {
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, admin.id))
    console.log(`[seed] admin exists: ${adminEmail}`)
  }

  let demo = await db.query.users.findFirst({ where: (t) => eq(t.email, demoEmail) })
  if (!demo) {
    demo = await registerUser(db, { email: demoEmail, password: demoPassword, firstName: 'کاربر', lastName: 'نمایشی' })
    console.log(`[seed] demo user created: ${demoEmail}`)
  } else {
    console.log(`[seed] demo user exists: ${demoEmail}`)
  }

  // FX rate EUR -> IRR (rials). Default ~620,000 rials per euro.
  const fxRate = process.env.SEED_FX_RATE ?? '620000'
  await setFxRate(db, fxRate, { actorId: admin.id, note: 'seed bootstrap' })
  console.log(`[seed] fx rate EUR->IRR = ${fxRate}`)

  // Credit the demo wallet (default 5,000,000 toman = 50,000,000 rials).
  const wallet = await ensureDefaultWallet(db, demo.id)
  const creditRial = Number(process.env.SEED_CREDIT_RIAL ?? 50_000_000)
  await creditWallet(db, demo.id, wallet.id, creditRial, {
    type: 'manual_credit',
    idempotencyKey: `seed-credit:${demo.id}`,
    description: 'اعتبار اولیه نمونه',
  })
  console.log(`[seed] demo wallet credited: ${creditRial} rials`)

  await syncProviderCatalog(db, getProvider(config.DEFAULT_PROVIDER), { actorId: admin.id })
  // Local/dev convenience: make the mock catalog purchasable immediately.
  await enableAllOffersForSale(db)
  console.log(`[seed] catalog synced (provider=${config.DEFAULT_PROVIDER}, mode=${config.LEASEWEB_MODE})`)

  console.log('\n[seed] done. Logins:')
  console.log(`  admin: ${adminEmail} / ${adminPassword}`)
  console.log(`  demo : ${demoEmail} / ${demoPassword}`)
  console.log('\nLogin via: POST /api/v1/auth/login  (returns token + sets cookie)')

  await pool.end()
}

main().catch((err) => {
  console.error('[seed] failed:', (err as Error).message)
  process.exit(1)
})