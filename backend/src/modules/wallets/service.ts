import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { invoices, walletTransactions, wallets } from '../../db/schema.js'
import { ConflictError, InsufficientFundsError, NotFoundError } from '../../lib/errors.js'
import { assertNonNegative, rialToToman } from '../../lib/money.js'
import { writeAudit } from '../audit/service.js'
import { publishNotification } from '../notifications/service.js'

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

export async function ensureDefaultWallet(db: DbOrTx, userId: string) {
  const active = () => db.query.wallets.findFirst({ where: t => and(eq(t.userId, userId), isNull(t.mergedInto)) })
  const existing = await active()
  if (existing) return existing
  await db.insert(wallets).values({ userId, name: 'کیف پول', isDefault: true }).onConflictDoNothing()
  const created = await active()
  if (!created) throw new NotFoundError('کیف پول یافت نشد')
  return created
}

export async function listWallets(db: DbClient, userId: string) {
  return [await ensureDefaultWallet(db, userId)]
}

export function listWalletRecords(db: DbOrTx, userId: string) {
  return db.query.wallets.findMany({
    where: (t) => eq(t.userId, userId),
    orderBy: (t, { desc }) => [desc(t.isDefault), t.createdAt],
  })
}

export async function getWallet(db: DbOrTx, userId: string, walletId?: string) {
  if (!walletId) return ensureDefaultWallet(db, userId)
  const source = await db.query.wallets.findFirst({ where: t => and(eq(t.id, walletId), eq(t.userId, userId)) })
  const wallet = source?.mergedInto ? await db.query.wallets.findFirst({ where: t => and(eq(t.id, source.mergedInto!), eq(t.userId, userId), isNull(t.mergedInto)) }) : source
  if (!wallet) throw new NotFoundError('کیف پول یافت نشد')
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
    const canonical = await getWallet(tx, userId, walletId)
    const locked = await tx
      .select({ id: wallets.id, balanceRial: wallets.balanceRial, userId: wallets.userId })
      .from(wallets)
      .where(and(eq(wallets.id, canonical.id), isNull(wallets.mergedInto)))
      .for('update')
      .limit(1)
    const wallet = locked[0]
    if (!wallet || wallet.userId !== userId) throw new NotFoundError('کیف پول یافت نشد')

    // Idempotency check inside the lock.
    if (input.idempotencyKey) {
      const matches = await tx.query.walletTransactions.findMany({
        where: t => and(eq(t.userId, userId), eq(t.idempotencyKey, input.idempotencyKey!)),
      })
      const dup = matches.find(row => row.type === input.type && row.amountRial === signed &&
        row.referenceType === (input.referenceType ?? null) && row.referenceId === (input.referenceId ?? null))
      if (dup) return { transaction: dup, balanceAfterRial: dup.balanceAfterRial, duplicate: true as const }
      if (matches.length) throw new ConflictError('این کلید قبلاً برای گردش دیگری استفاده شده است')
    }

    const balanceBefore = wallet.balanceRial
    const balanceAfter = balanceBefore + signed
    if (!Number.isSafeInteger(balanceAfter)) throw new ConflictError('موجودی کیف پول خارج از محدودهٔ مجاز است')
    if (balanceAfter < 0) {
      throw new InsufficientFundsError(
        `موجودی کیف پول کافی نیست (نیازمند ${Math.ceil(input.amountRial / 10).toLocaleString('fa-IR')} تومان، موجودی ${Math.floor(balanceBefore / 10).toLocaleString('fa-IR')} تومان)`,
      )
    }

    const [txRow] = await tx
      .insert(walletTransactions)
      .values({
        walletId: wallet.id,
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

    await tx.update(wallets).set({ balanceRial: balanceAfter }).where(eq(wallets.id, wallet.id))
    const titles = { deposit: 'کیف پول شارژ شد', refund: 'مبلغ به کیف پول بازگشت', manual_credit: 'موجودی کیف پول افزایش یافت',
      manual_debit: 'از کیف پول برداشت شد', adjustment: 'موجودی کیف پول اصلاح شد', renewal: 'پرداخت تمدید تأیید شد' } as const
    if (input.type !== 'purchase' && input.amountRial > 0) {
      await publishNotification(tx, { userId, eventKey: `wallet-transaction:${txRow.id}`, title: titles[input.type],
        body: `مبلغ ${rialToToman(input.amountRial).toLocaleString('fa-IR')} تومان.`, href: '/wallet', type: 'success' })
    }
    return { transaction: txRow, balanceAfterRial: balanceAfter, duplicate: false as const }
  })

  if (!result.duplicate) {
    await writeAudit(db, {
      actorId: userId,
      action: isDebit ? 'wallet.debit' : 'wallet.credit',
      targetType: 'wallet',
      targetId: result.transaction.walletId,
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
  db: DbOrTx,
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
  db: DbOrTx,
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
  const rows = await db.query.walletTransactions.findMany({
    where: (t, { and, eq }) => and(eq(t.userId, userId), opts.walletId ? eq(t.walletId, opts.walletId) : undefined),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: opts.limit ?? 50,
    offset: opts.offset ?? 0,
  })
  // Resolve the existing invoice reference too, so historical renewals gain
  // scheduling context without rewriting immutable ledger metadata.
  const invoiceId = (row: typeof rows[number]) => row.type === 'renewal' && /^renewal:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(row.idempotencyKey ?? '') ? row.idempotencyKey!.slice(8) : null
  const ids = rows.flatMap(row => invoiceId(row) ? [invoiceId(row)!] : [])
  const due = ids.length ? await db.select({ id: invoices.id, dueAt: invoices.dueAt }).from(invoices).where(and(eq(invoices.userId, userId), inArray(invoices.id, ids))) : []
  const schedule = new Map(due.map(invoice => [invoice.id, invoice.dueAt]))
  return rows.map(row => ({ ...row, scheduledAt: schedule.get(invoiceId(row) ?? '') ?? null }))
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
    .where(and(eq(wallets.userId, userId), isNull(wallets.mergedInto)))
  return Number(rows[0]?.total ?? 0)
}
