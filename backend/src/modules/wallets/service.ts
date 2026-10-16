import { and, eq, sql } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { walletTransactions, wallets } from '../../db/schema.js'
import { ConflictError, InsufficientFundsError, NotFoundError } from '../../lib/errors.js'
import { assertNonNegative } from '../../lib/money.js'
import { writeAudit } from '../audit/service.js'

export type WalletTxType = 'deposit' | 'purchase' | 'renewal' | 'refund' | 'manual_credit' | 'manual_debit' | 'adjustment'

export interface WalletTxInput {
  amountRial: number // positive integer; direction is implied by type below
  type: WalletTxType
  referenceType?: string
  referenceId?: string
  idempotencyKey?: string
  description?: string
  metadata?: Record<string, unknown>
}

const DEBIT_TYPES: WalletTxType[] = ['purchase', 'renewal', 'manual_debit']
const CREDIT_TYPES: WalletTxType[] = ['deposit', 'refund', 'manual_credit', 'adjustment']

export async function createWallet(
  db: DbClient,
  userId: string,
  input: { name: string; description?: string; isDefault?: boolean },
): Promise<typeof wallets.$inferSelect> {
  const existing = await db.query.wallets.findMany({
    where: (t) => eq(t.userId, userId),
    limit: 1,
  })
  const isDefault = input.isDefault ?? existing.length === 0
  if (input.isDefault) {
    await db.update(wallets).set({ isDefault: false }).where(eq(wallets.userId, userId))
  }
  const [wallet] = await db
    .insert(wallets)
    .values({ userId, name: input.name, description: input.description ?? null, isDefault })
    .returning()
  if (!wallet) throw new Error('failed to create wallet')
  await writeAudit(db, { actorId: userId, action: 'wallet.created', targetType: 'wallet', targetId: wallet.id })
  return wallet
}

export async function ensureDefaultWallet(db: DbClient, userId: string) {
  const existing = await db.query.wallets.findFirst({ where: (t) => eq(t.userId, userId) })
  if (existing) return existing
  return createWallet(db, userId, { name: 'کیف پول پیش‌فرض' })
}

export async function listWallets(db: DbClient, userId: string) {
  return db.query.wallets.findMany({
    where: (t) => eq(t.userId, userId),
    orderBy: (t, { desc }) => [desc(t.isDefault), t.createdAt],
  })
}

export async function getWallet(db: DbClient, userId: string, walletId: string) {
  const wallet = await db.query.wallets.findFirst({ where: (t) => eq(t.id, walletId) })
  if (!wallet || wallet.userId !== userId) throw new NotFoundError('کیف پول یافت نشد')
  return wallet
}

/**
 * Apply a wallet transaction atomically:
 *  - Locks the wallet row (SELECT ... FOR UPDATE) so concurrent debits cannot
 *    overspend.
 *  - Appends an immutable ledger row with balance_before/balance_after.
 *  - Updates the wallet balance.
 *  - Unique (wallet_id, idempotency_key) makes retries safe.
 *
 * The whole operation runs inside a DB transaction. Never hold this
 * transaction open while calling external providers.
 */
export async function applyWalletTransaction(
  db: DbOrTx,
  userId: string,
  walletId: string,
  input: WalletTxInput,
): Promise<{ transaction: typeof walletTransactions.$inferSelect; balanceAfterRial: number }> {
  assertNonNegative(input.amountRial, 'amountRial')
  const isDebit = DEBIT_TYPES.includes(input.type)
  const isCredit = CREDIT_TYPES.includes(input.type)
  if (!isDebit && !isCredit) throw new ConflictError(`Unsupported wallet transaction type: ${input.type}`)
  const signed = isDebit ? -input.amountRial : input.amountRial

  const result = await db.transaction(async (tx) => {
    // Row lock — serialize concurrent transactions on this wallet.
    const locked = await tx
      .select({ id: wallets.id, balanceRial: wallets.balanceRial, userId: wallets.userId })
      .from(wallets)
      .where(eq(wallets.id, walletId))
      .for('update')
      .limit(1)
    const wallet = locked[0]
    if (!wallet || wallet.userId !== userId) throw new NotFoundError('کیف پول یافت نشد')

    // Idempotency check inside the lock.
    if (input.idempotencyKey) {
      const dup = await tx.query.walletTransactions.findFirst({
        where: (t) => and(eq(t.walletId, walletId), eq(t.idempotencyKey, input.idempotencyKey ?? '')),
      })
      if (dup) return { transaction: dup, balanceAfterRial: dup.balanceAfterRial, duplicate: true as const }
    }

    const balanceBefore = wallet.balanceRial
    const balanceAfter = balanceBefore + signed
    if (balanceAfter < 0) {
      throw new InsufficientFundsError(
        `موجودی کیف پول کافی نیست (نیازمند ${Math.ceil(input.amountRial / 10).toLocaleString('fa-IR')} تومان، موجودی ${Math.floor(balanceBefore / 10).toLocaleString('fa-IR')} تومان)`,
      )
    }

    const [txRow] = await tx
      .insert(walletTransactions)
      .values({
        walletId,
        userId,
        amountRial: signed,
        type: input.type,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        balanceBeforeRial: balanceBefore,
        balanceAfterRial: balanceAfter,
        description: input.description ?? null,
        metadata: input.metadata ?? null,
      })
      .returning()
    if (!txRow) throw new Error('failed to insert wallet transaction')

    await tx.update(wallets).set({ balanceRial: balanceAfter }).where(eq(wallets.id, walletId))
    return { transaction: txRow, balanceAfterRial: balanceAfter, duplicate: false as const }
  })

  if (!result.duplicate) {
    await writeAudit(db, {
      actorId: userId,
      action: isDebit ? 'wallet.debit' : 'wallet.credit',
      targetType: 'wallet',
      targetId: walletId,
      metadata: {
        amountRial: signed,
        type: input.type,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        balanceAfterRial: result.balanceAfterRial,
      },
    })
  }
  return { transaction: result.transaction, balanceAfterRial: result.balanceAfterRial }
}

export async function debitWallet(
  db: DbClient,
  userId: string,
  walletId: string,
  amountRial: number,
  input: Omit<WalletTxInput, 'amountRial' | 'type'> & { type?: WalletTxType },
) {
  return applyWalletTransaction(db, userId, walletId, {
    ...input,
    amountRial,
    type: input.type ?? 'purchase',
  })
}

export async function creditWallet(
  db: DbClient,
  userId: string,
  walletId: string,
  amountRial: number,
  input: Omit<WalletTxInput, 'amountRial' | 'type'> & { type?: WalletTxType },
) {
  return applyWalletTransaction(db, userId, walletId, {
    ...input,
    amountRial,
    type: input.type ?? 'deposit',
  })
}

export async function listTransactions(db: DbClient, userId: string, opts: { limit?: number; offset?: number; walletId?: string } = {}) {
  return db.query.walletTransactions.findMany({
    where: (t, { and, eq }) => and(eq(t.userId, userId), opts.walletId ? eq(t.walletId, opts.walletId) : undefined),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: opts.limit ?? 50,
    offset: opts.offset ?? 0,
  })
}

export async function getWalletWithLock(db: DbClient, walletId: string) {
  const rows = await db
    .select()
    .from(wallets)
    .where(sql`${wallets.id} = ${walletId}`)
    .for('update')
  return rows[0] ?? null
}

export async function totalBalanceRial(db: DbClient, userId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${wallets.balanceRial}), 0)` })
    .from(wallets)
    .where(eq(wallets.userId, userId))
  return Number(rows[0]?.total ?? 0)
}