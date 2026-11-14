import { formatFaDateTime, formatToman, toFaDigits } from './format'
import type { Transaction } from './types'

export const movementHeaders = ['واریز (+)', 'برداشت (-)'] as const
export const emptyAmount = '—'

type Movement = Pick<Transaction, 'amount' | 'amountRial' | 'direction' | 'status' | 'formattedAmount'>

function formatAbsoluteRial(rial: number) {
  const whole = Math.trunc(rial / 10)
  const fraction = rial % 10
  return fraction ? formatToman(whole).replace(' تومان', `٫${toFaDigits(fraction)} تومان`) : formatToman(whole)
}

export function movementAmounts(transaction: Movement): [credit: string, debit: string] {
  const { amount, amountRial, formattedAmount, status } = transaction
  const signed = amountRial ?? amount
  if (!['success', 'completed', 'posted', 'settled'].includes(status) || !Number.isFinite(signed) || signed === 0) return [emptyAmount, emptyAmount]
  // The platform may return historic foreign-currency entries with their own format.
  const absolute = amountRial === undefined && formattedAmount
    ? formattedAmount.trim().replace(/^[\s\u061C\u200E\u200F]*[+\-−]\s*/, '')
    : amountRial === undefined ? formatToman(Math.abs(amount)) : formatAbsoluteRial(Math.abs(amountRial))
  const direction = transaction.direction ?? (signed > 0 ? 'credit' : 'debit')
  return direction === 'credit' ? [absolute, emptyAmount] : [emptyAmount, absolute]
}

const categories: Record<string, string> = {
  deposit: 'شارژ کیف پول', purchase: 'خرید', renewal: 'تمدید سرویس', refund: 'بازگشت وجه',
  manual_credit: 'واریز دستی', manual_debit: 'برداشت دستی', adjustment: 'تعدیل موجودی',
}
const referenceCategories: Record<string, string> = {
  tabapay: 'شارژ با تاباپی', primary_ipv4_replacement: 'تعویض IPv4 اصلی', traffic_overage: 'ترافیک مازاد',
}
export function transactionCategory(transaction: Pick<Transaction, 'type' | 'referenceType'>) {
  const { type, referenceType } = transaction
  if (type === 'refund' && referenceType === 'primary_ipv4_replacement') return 'بازگشت وجه تعویض IPv4 اصلی'
  if (referenceType && Object.hasOwn(referenceCategories, referenceType)) return referenceCategories[referenceType]!
  return type && Object.hasOwn(categories, type) ? categories[type]! : type || referenceType || emptyAmount
}

const statuses: Record<string, string> = {
  success: 'ثبت‌شده', completed: 'تکمیل‌شده', posted: 'ثبت‌شده', settled: 'تسویه‌شده',
  pending: 'در انتظار', processing: 'در حال پردازش', failed: 'ناموفق', rejected: 'ردشده', expired: 'منقضی‌شده',
  cancelled: 'لغوشده', void: 'باطل‌شده', voided: 'باطل‌شده', refunded: 'بازپرداخت‌شده',
}
export const transactionStatus = (status: string) => Object.hasOwn(statuses, status) ? statuses[status]! : status

export function transactionsCsv(transactions: Transaction[], timezone?: string) {
  const rows = [['شرح', 'کیف پول', ...movementHeaders, 'زمان ثبت تراکنش', 'سررسید تمدید', 'وضعیت', 'نوع', 'نوع مرجع', 'شناسه مرجع'],
    ...transactions.map(item => [item.description, item.wallet || emptyAmount, ...movementAmounts(item), formatFaDateTime(item.date, timezone),
      item.scheduledAt ? formatFaDateTime(item.scheduledAt, timezone) : emptyAmount, transactionStatus(item.status), transactionCategory(item),
      item.referenceType ?? emptyAmount, item.referenceId ?? emptyAmount])]
  const cell = (value: string) => {
    const escaped = /^[\p{White_Space}\p{Cf}]*[=+@\-＝＋＠－\t\r\n]/u.test(value) ? `'${value}` : value
    return `"${escaped.replaceAll('"', '""')}"`
  }
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')
}
