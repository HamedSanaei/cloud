import { useState } from 'react'
import { apiGet, apiPost } from '../../lib/apiClient'
import { useApiQuery } from '../../hooks/useApiQuery'
import { chargeReferences } from '../../lib/paymentHandoff'
import type { ChargeRequest } from '../../lib/types'
import { Button, LinkButton } from './Button'

interface Payment {
  id: string
  status: string
  paymentReference?: string | null
  verifyId?: string
  number?: string
  invoiceNumber?: string
}

export function WalletPaymentStatus({ id, byCharge, onVerified }: { id: string; byCharge?: boolean; onVerified: () => void }) {
  const query = useApiQuery(async (): Promise<Payment> => {
    if (byCharge) {
      const { data } = await apiGet<{ data: ChargeRequest }>(`/charge-requests/${encodeURIComponent(id)}`)
      return { id: data.id, status: data.paymentStatus ?? data.status, number: data.number, verifyId: data.paymentId, ...chargeReferences(data) }
    }
    const { data } = await apiGet<{ data: Payment }>(`/wallets/recharges/${encodeURIComponent(id)}`)
    return { ...data, verifyId: data.id }
  }, [id, byCharge])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const payment = query.data?.id === id ? query.data : null
  const succeeded = payment?.status === 'succeeded' || payment?.status === 'approved'
  const failed = payment?.status === 'failed' || payment?.status === 'rejected'
  const message = succeeded ? 'پرداخت تأیید شد و کیف پول شارژ شد.'
    : failed ? 'پرداخت ناموفق یا منقضی شده است.'
      : payment?.status === 'unknown' || payment?.status === 'creating' ? 'نتیجه ساخت درخواست هنوز مشخص نیست.'
        : 'پرداخت هنوز تأیید نشده است.'

  async function check() {
    setError('')
    if (!payment?.verifyId || payment.status !== 'pending') {
      query.refetch()
      return
    }
    setBusy(true)
    try {
      const response = await apiPost<{ data: Payment }>(`/wallets/recharges/${encodeURIComponent(payment.verifyId)}/verify`, {})
      if (response.data.status === 'succeeded') onVerified()
      query.refetch()
    } catch {
      setError('بررسی درگاه ممکن نشد؛ بعداً دوباره تلاش کنید.')
    } finally {
      setBusy(false)
    }
  }

  return <section className="card form-stack" aria-label="نتیجه شارژ کیف پول">
    <h2>نتیجه پرداخت</h2>
    {query.loading ? <p role="status">در حال دریافت وضعیت…</p>
      : query.error ? <p role="alert">دریافت نتیجه ممکن نشد؛ دوباره بررسی کنید.</p> : <p role="status">{message}</p>}
    <p>شناسهٔ درخواست <bdi>{payment?.number ?? id}</bdi></p>
    {payment?.paymentReference && <p>شماره پیگیری پرداخت <bdi>{payment.paymentReference}</bdi></p>}
    {payment?.invoiceNumber && <p>شماره فاکتور <bdi>{payment.invoiceNumber}</bdi></p>}
    {error && <p role="alert">{error}</p>}
    <div className="server-inline-actions">
      {!succeeded && !failed && <Button variant="secondary" disabled={busy || query.loading} onClick={() => void check()}>{busy ? 'در حال بررسی…' : 'بررسی نتیجه پرداخت'}</Button>}
      {!succeeded && <LinkButton to="/tickets" variant="secondary">تماس با پشتیبانی</LinkButton>}
    </div>
  </section>
}
