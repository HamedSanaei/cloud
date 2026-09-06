import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getTestContext, truncateAll, dbAvailable } from '../helpers.js'
import { registerUser } from '../../src/modules/auth/service.js'
import {
  applyWalletTransaction,
  creditWallet,
  createWallet,
  listTransactions,
} from '../../src/modules/wallets/service.js'
import { InsufficientFundsError } from '../../src/lib/errors.js'

const skip = !dbAvailable

describe.skipIf(skip)('wallets + ledger (integration)', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>

  beforeAll(async () => {
    ctx = await getTestContext()
    await truncateAll(ctx.db)
  })

  afterAll(async () => {
    await ctx.close()
  })

  async function makeUser(email: string) {
    const user = await registerUser(ctx.db, { email, password: 'Pass123456!' })
    return user
  }

  it('creates a default wallet and credits it with ledger rows', async () => {
    const user = await makeUser('wallet1@test.local')
    const wallet = await createWallet(ctx.db, user.id, { name: 'کیف پول' })
    const credit = await creditWallet(ctx.db, user.id, wallet.id, 1_000_000, { type: 'manual_credit', description: 'شارژ' })
    expect(credit.balanceAfterRial).toBe(1_000_000)
    expect(credit.transaction.amountRial).toBe(1_000_000)
    expect(credit.transaction.balanceBeforeRial).toBe(0)
    expect(credit.transaction.balanceAfterRial).toBe(1_000_000)
  })

  it('debits and refuses overdraft', async () => {
    const user = await makeUser('wallet2@test.local')
    const wallet = await createWallet(ctx.db, user.id, { name: 'کیف پول' })
    await creditWallet(ctx.db, user.id, wallet.id, 500_000, { type: 'deposit' })

    const debit = await applyWalletTransaction(ctx.db, user.id, wallet.id, {
      amountRial: 300_000,
      type: 'purchase',
      referenceType: 'order',
      referenceId: '11111111-1111-1111-1111-111111111111',
      description: 'خرید',
    })
    expect(debit.transaction.amountRial).toBe(-300_000)
    expect(debit.balanceAfterRial).toBe(200_000)

    await expect(
      applyWalletTransaction(ctx.db, user.id, wallet.id, {
        amountRial: 300_000,
        type: 'purchase',
        description: 'بیش از موجودی',
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError)
  })

  it('serializes concurrent debits so the balance never goes negative', async () => {
    const user = await makeUser('wallet3@test.local')
    const wallet = await createWallet(ctx.db, user.id, { name: 'کیف پول' })
    await creditWallet(ctx.db, user.id, wallet.id, 100_000, { type: 'deposit' })

    // 3 parallel debits of 40,000 against 100,000 — exactly two may succeed.
    const results = await Promise.allSettled(
      [1, 2, 3].map((n) =>
        applyWalletTransaction(ctx.db, user.id, wallet.id, {
          amountRial: 40_000,
          type: 'purchase',
          referenceType: 'test',
          referenceId: `22222222-2222-2222-2222-22222222220${n}`,
          description: `همزمان ${n}`,
        }),
      ),
    )
    const ok = results.filter((r) => r.status === 'fulfilled').length
    const failed = results.filter((r) => r.status === 'rejected').length
    expect(ok).toBe(2)
    expect(failed).toBe(1)

    const rows = await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, wallet.id) })
    expect(rows?.balanceRial).toBe(20_000) // 100k - 2*40k — never negative
  })

  it('enforces idempotency — the same key cannot debit twice', async () => {
    const user = await makeUser('wallet4@test.local')
    const wallet = await createWallet(ctx.db, user.id, { name: 'کیف پول' })
    await creditWallet(ctx.db, user.id, wallet.id, 100_000, { type: 'deposit' })

    const first = await applyWalletTransaction(ctx.db, user.id, wallet.id, {
      amountRial: 30_000,
      type: 'purchase',
      idempotencyKey: 'order-pay:abc',
      description: 'پرداخت',
    })
    const second = await applyWalletTransaction(ctx.db, user.id, wallet.id, {
      amountRial: 30_000,
      type: 'purchase',
      idempotencyKey: 'order-pay:abc',
      description: 'پرداخت',
    })
    expect(second.transaction.id).toBe(first.transaction.id)
    expect(second.balanceAfterRial).toBe(first.balanceAfterRial)

    const tx = await listTransactions(ctx.db, user.id)
    expect(tx.length).toBe(2) // credit + one debit — the duplicate was a no-op
  })

  it('refunds by crediting with a reference', async () => {
    const user = await makeUser('wallet5@test.local')
    const wallet = await createWallet(ctx.db, user.id, { name: 'کیف پول' })
    await creditWallet(ctx.db, user.id, wallet.id, 100_000, { type: 'deposit' })
    await applyWalletTransaction(ctx.db, user.id, wallet.id, {
      amountRial: 100_000,
      type: 'purchase',
      referenceType: 'order',
      referenceId: '33333333-3333-3333-3333-333333333333',
    })
    const refund = await applyWalletTransaction(ctx.db, user.id, wallet.id, {
      amountRial: 100_000,
      type: 'refund',
      referenceType: 'order',
      referenceId: '33333333-3333-3333-3333-333333333333',
    })
    expect(refund.transaction.type).toBe('refund')
    expect(refund.balanceAfterRial).toBe(100_000)
  })
})