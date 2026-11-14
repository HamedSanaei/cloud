import { randomUUID } from 'node:crypto'
import { mkdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg, { type PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../src/db/index.js'
import { assertWalletConsolidationApproved, migrate, resolveMigrationsFolder } from '../../src/db/migrate.js'
import * as config from '../../src/config.js'
import { walletPreflight } from '../../src/db/wallet-preflight.js'
import { creditWallet, ensureDefaultWallet, getWallet, listWallets } from '../../src/modules/wallets/service.js'
import { verifyRecharge } from '../../src/modules/payments/service.js'
import { fingerprint } from '../../src/modules/payments/tabapay.js'
import { DATABASE_URL, dbAvailable } from '../helpers.js'

describe.skipIf(!dbAvailable)('single wallet cutover on legacy PostgreSQL data', () => {
  const dbName = `wallet_cutover_${randomUUID().replaceAll('-', '')}`
  let root: pg.Pool, legacy: pg.Pool, client: PoolClient, url: URL

  beforeAll(async () => {
    root = new pg.Pool({ connectionString: DATABASE_URL })
    await root.query(`CREATE DATABASE "${dbName}"`)
    url = new URL(DATABASE_URL); url.pathname = `/${dbName}`
    legacy = new pg.Pool({ connectionString: url.href }); client = await legacy.connect()
    const folder = resolveMigrationsFolder(), preCutover = await mkdtemp(join(tmpdir(), 'wallet-legacy-'))
    try {
      const journal = JSON.parse(await readFile(join(folder, 'meta', '_journal.json'), 'utf8'))
      journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 12)
      await mkdir(join(preCutover, 'meta'))
      await writeFile(join(preCutover, 'meta', '_journal.json'), JSON.stringify(journal))
      for (const { tag } of journal.entries) await writeFile(join(preCutover, `${tag}.sql`), await readFile(join(folder, `${tag}.sql`)))
      await drizzleMigrate(drizzle(client), { migrationsFolder: preCutover })
    } finally { await rm(preCutover, { recursive: true, force: true }) }
  })
  afterAll(async () => {
    client?.release(true); await legacy?.end()
    if (root) { await root.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); await root.end() }
  })

  it('blocks bad ownership and balances, resumes after failure, and preserves ledger and executable references', async () => {
    const [owner, other, maxOwner, emptyOwner] = Array.from({ length: 4 }, () => randomUUID()) as [string,string,string,string]
    const [first, canonical, foreign, edge] = Array.from({ length: 4 }, () => randomUUID()) as [string,string,string,string]
    const [purchase, charge, payment, adjustment] = Array.from({ length: 4 }, () => randomUUID()) as [string,string,string,string]
    for (const id of [owner, other, maxOwner, emptyOwner]) await client.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', [id, `${id}@test.invalid`, 'fixture'])
    await client.query(`INSERT INTO wallets (id,user_id,name,balance_rial,is_default,currency) VALUES
      ($1,$2,'archive',123,false,'IRR'), ($3,$2,'main',0,true,'IRR'), ($4,$5,'other',0,true,'IRR'), ($6,$7,'edge',9007199254740991,true,'IRR')`,
    [first, owner, canonical, foreign, other, edge, maxOwner])
    await client.query(`INSERT INTO orders (id,order_number,user_id,wallet_id,status,total_rial,provider,provider_product_id,provider_location,hostname,operating_system)
      VALUES ($1,'ORDER-1',$2,$3,'active',40,'hetzner','test','hel1','fixture','ubuntu')`, [purchase, owner, first])
    await client.query(`INSERT INTO charge_requests (id,user_id,number,amount_rial,status) VALUES ($1,$2,'PAY-1',200000,'processing')`, [charge, owner])
    await client.query(`INSERT INTO wallet_payments (id,user_id,wallet_id,charge_request_id,idempotency_key,amount_rial,status,sandbox,merchant_fingerprint)
      VALUES ($1,$2,$3,$4,'intent',200000,'pending',true,'fixture')`, [payment, owner, first, charge])
    await client.query(`INSERT INTO admin_adjustments (id,actor_id,user_id,wallet_id,key,direction,amount_rial,reason,reference)
      VALUES ($1,$2,$3,$4,'adjustment','credit',13,'fixture reason','test')`, [adjustment, other, owner, first])
    await client.query(`INSERT INTO wallet_transactions (wallet_id,user_id,amount_rial,type,idempotency_key,balance_before_rial,balance_after_rial,reference_type,reference_id)
      VALUES ($1,$2,123,'deposit','legacy-shared',0,123,'tabapay',$4), ($3,$2,0,'adjustment','legacy-shared',0,0,null,null)`, [first, owner, canonical, payment])
    const ledger = () => client.query('SELECT row_to_json(t) AS entry FROM wallet_transactions t ORDER BY id').then(result => result.rows)
    const before = await ledger()

    await client.query('UPDATE wallets SET balance_rial=-1 WHERE id=$1', [first])
    await client.query('UPDATE wallet_payments SET wallet_id=$1 WHERE id=$2', [foreign, payment])
    const report = (await walletPreflight(client)).find(user => user.userId === owner)
    expect(report).toMatchObject({ canonicalId: canonical, invalidBalance: true, walletCount: 2, legacyKeyCollisions: 1,
      invalidReferences: [{ id: payment, kind: 'payment', walletId: foreign }], openPayments: [payment], openChargeRequests: [charge] })
    await expect(migrate(url.href)).rejects.toThrow()
    expect((await client.query("SELECT count(*) FROM information_schema.columns WHERE table_name='wallets' AND column_name='merged_into'")).rows[0].count).toBe('0')
    expect(await ledger()).toEqual(before)
    await client.query('UPDATE wallets SET balance_rial=123 WHERE id=$1', [first])
    await client.query('UPDATE wallet_payments SET wallet_id=$1 WHERE id=$2', [first, payment])
    const configuration = vi.spyOn(config, 'getConfig').mockReturnValue({ ...config.getConfig(), NODE_ENV: 'production' })
    vi.stubEnv('WALLET_CONSOLIDATION_APPROVED', 'false')
    try { await expect(assertWalletConsolidationApproved(client)).rejects.toThrow('reviewed preflight') }
    finally { configuration.mockRestore(); vi.unstubAllEnvs() }
    await migrate(url.href)
    await migrate(url.href)
    expect(await ledger()).toEqual(before)
    const { rows } = await client.query(`SELECT (SELECT wallet_id FROM orders WHERE id=$1) AS order_wallet,
      (SELECT wallet_id FROM wallet_payments WHERE id=$2) AS payment_wallet,
      (SELECT wallet_id FROM admin_adjustments WHERE id=$3) AS adjustment_wallet`, [purchase, payment, adjustment])
    expect(rows[0]).toEqual({ order_wallet: canonical, payment_wallet: canonical, adjustment_wallet: canonical })
    expect((await client.query('SELECT merged_into,balance_rial FROM wallets WHERE id=$1', [first])).rows[0]).toEqual({ merged_into: canonical, balance_rial: '0' })
    expect((await client.query("SELECT metadata FROM audit_logs WHERE action='wallet.consolidated' AND target_id=$1", [canonical])).rows).toEqual([
      { metadata: expect.objectContaining({ beforeRial: 123, afterRial: 123, currency: 'IRR', operationId: expect.any(String) }) },
    ])

    const handle = createDb(url.href)
    try {
      expect(await listWallets(handle.db, owner)).toEqual([expect.objectContaining({ id: canonical, balanceRial: 123 })])
      expect((await listWallets(handle.db, emptyOwner))[0]?.balanceRial).toBe(0)
      expect((await listWallets(handle.db, maxOwner))[0]?.balanceRial).toBe(Number.MAX_SAFE_INTEGER)
      await expect(getWallet(handle.db, other, first)).rejects.toThrow()
      await expect(client.query("INSERT INTO wallets (user_id,name) VALUES ($1,'second')", [owner])).rejects.toMatchObject({ code: '23505' })
      const replay = await creditWallet(handle.db, owner, canonical, 123, { idempotencyKey: 'legacy-shared', referenceType: 'tabapay', referenceId: payment })
      expect(replay.transaction.walletId).toBe(first)
      await expect(creditWallet(handle.db, owner, first, 99, { idempotencyKey: 'legacy-shared' })).rejects.toThrow()
      const writes = await Promise.all([first, canonical, first].map(walletId =>
        creditWallet(handle.db, owner, walletId, 13, { idempotencyKey: 'new-retry' })))
      expect(new Set(writes.map(write => write.transaction.id)).size).toBe(1)
      expect((await getWallet(handle.db, owner, first)).balanceRial).toBe(136)
      const newUser = randomUUID()
      await client.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', [newUser, `${newUser}@test.invalid`, 'fixture'])
      const provisioned = await Promise.all(Array.from({ length: 5 }, () => ensureDefaultWallet(handle.db, newUser)))
      expect(new Set(provisioned.map(wallet => wallet.id)).size).toBe(1)
      expect((await client.query('SELECT count(*) FROM wallets WHERE user_id=$1', [newUser])).rows[0].count).toBe('1')

      const token = randomUUID(), merchant = '11111111-1111-4111-8111-111111111111'
      const gateway = vi.spyOn(config, 'getConfig').mockReturnValue({ ...config.getConfig(), TABAPAY_MERCHANT: merchant })
      await client.query('UPDATE wallet_payments SET gateway_token=$1,merchant_fingerprint=$2 WHERE id=$3', [token, fingerprint(), payment])
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ responseCode: 2, status: 'success', token, amount: 200000, shaparakRefNumber: '123456789' })))
      try {
        const results = await Promise.all([verifyRecharge(handle.db, payment), verifyRecharge(handle.db, payment)])
        expect(results.map(result => result.status)).toEqual(['succeeded', 'succeeded'])
        expect((await getWallet(handle.db, owner)).balanceRial).toBe(200136)
        expect((await client.query("SELECT count(*) FROM wallet_transactions WHERE idempotency_key=$1", [`tabapay:${payment}`])).rows[0].count).toBe('1')
      } finally { gateway.mockRestore(); vi.unstubAllGlobals() }
    } finally { await handle.pool.end() }
  })
})
