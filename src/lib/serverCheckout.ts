import { ApiError } from './apiClient'
import type { BillingPeriod } from './types'

export interface CheckoutDraft {
  step: number; providerId: string; location: string; offerId: string; os: string; name: string
  walletId: string; billingPeriod: BillingPeriod | ''; purchaseKey: string
}
const storageKey = (userId: string) => `server-checkout:${userId}`
export function readCheckoutDraft(userId?: string): CheckoutDraft | null {
  if (!userId) return null
  try {
    const data = JSON.parse(sessionStorage.getItem(storageKey(userId)) ?? 'null')
    if (!data || data.expiresAt < Date.now() || !Number.isFinite(data.expiresAt)) return null
    if (!Number.isInteger(data.step) || data.step < 0 || data.step > 5) return null
    for (const key of ['providerId', 'location', 'offerId', 'os', 'name', 'walletId', 'purchaseKey']) {
      if (typeof data[key] !== 'string' || data[key].length > 200) return null
    }
    if (!['', 'hourly', 'daily', 'monthly'].includes(data.billingPeriod)) return null
    return data as CheckoutDraft
  } catch { return null }
}
export function saveCheckoutDraft(userId: string | undefined, draft: CheckoutDraft) {
  if (!userId) return
  try { sessionStorage.setItem(storageKey(userId), JSON.stringify({ ...draft, expiresAt: Date.now() + 2 * 3600000 })) } catch { /* Storage may be unavailable. */ }
}
export function clearCheckoutDraft(userId?: string) {
  if (userId) try { sessionStorage.removeItem(storageKey(userId)) } catch { /* No stored draft. */ }
}
export function minimumCreationBalance(totalRial: number, period: BillingPeriod): number {
  return totalRial * ({ hourly: 168, daily: 7, monthly: 1 }[period])
}
export interface FundingShortfall { balanceRial: number; requiredBalanceRial: number; shortfallRial: number; orderTotalRial: number }
export function checkoutFailure(error: unknown): { message: string; funding?: FundingShortfall } {
  const body = error instanceof ApiError ? error.body as { error?: string; details?: FundingShortfall } | null : null
  if (body?.error === 'insufficient_funds') {
    const funding = body.details
    const valid = funding && [funding.balanceRial, funding.requiredBalanceRial, funding.shortfallRial, funding.orderTotalRial].every(n => Number.isSafeInteger(n) && n >= 0)
    return { message: 'موجودی کیف پول شما کافی نیست.', ...(valid ? { funding } : {}) }
  }
  if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) return { message: 'نتیجه درخواست نامشخص است.' }
  return { message: 'ثبت سفارش انجام نشد. انتخاب‌ها و وضعیت کاتالوگ را بررسی کنید؛ اگر مشکل ادامه داشت با پشتیبانی تماس بگیرید.' }
}
