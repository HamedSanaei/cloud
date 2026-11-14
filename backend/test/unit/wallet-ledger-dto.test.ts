import { describe, expect, it } from 'vitest'
import { transactionToDto } from '../../src/lib/dto.js'

describe('wallet ledger projection', () => {
  it.each([
    ['deposit', 15000, 'tabapay', 'credit'], ['refund', 15000, 'primary_ipv4_replacement', 'credit'],
    ['manual_credit', 15000, 'admin_adjustment', 'credit'], ['manual_debit', -15000, 'admin_adjustment', 'debit'],
    ['purchase', -1500000, 'primary_ipv4_replacement', 'debit'], ['renewal', -15001, 'subscription', 'debit'],
    ['purchase', -1, 'traffic_overage', 'debit'], ['adjustment', 0, 'admin_adjustment', null],
  ])('keeps %s (%s rial, %s) signed and typed', (type, amountRial, referenceType, direction) => {
    const createdAt = new Date('2026-11-14T12:00:00Z')
    const row = { id: 'entry', type, amountRial, createdAt, balanceAfterRial: 2000000, walletId: 'wallet-id', referenceType, referenceId: 'ref' }
    expect(transactionToDto(row, 'کیف پول پرداخت')).toMatchObject({ type, amountRial, direction, status: 'success', date: createdAt.toISOString(),
      wallet: 'کیف پول پرداخت', walletId: 'wallet-id', referenceType, referenceId: 'ref' })
  })
})
