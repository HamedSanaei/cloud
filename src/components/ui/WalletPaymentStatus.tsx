import { useState } from 'react'
import { apiGet, apiPost } from '../../lib/apiClient'
import { useApiQuery } from '../../hooks/useApiQuery'
import { Button } from './Button'
interface Payment { id: string; status: string; amountRial: number; paymentUrl: string | null }
export function WalletPaymentStatus({ id, onVerified }: { id: string; onVerified: () => void }) {
  const query = useApiQuery(() => apiGet<{ data: Payment }>(`/wallets/recharges/${encodeURIComponent(id)}`), [id])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const payment = query.data?.data
  return <section className="card" aria-label="نتیجه شارژ کیف پول"><h2>نتیجه پرداخت</h2>
    {query.loading ? <p role="status">در حال دریافت وضعیت…</p> : query.error ? <p role="alert">دریافت نتیجه ممکن نشد؛ دوباره بررسی کنید.</p> : <p role="status">{payment?.status === 'succeeded' ? 'پرداخت تأیید شد و کیف پول شارژ شد.' : payment?.status === 'failed' ? 'پرداخت ناموفق یا منقضی شده است؛ مبلغی به کیف پول اضافه نشده است.' : payment?.status === 'unknown' || payment?.status === 'creating' ? 'نتیجه ایجاد پرداخت مشخص نیست. با پشتیبانی و شناسهٔ این درخواست پیگیری کنید؛ درخواست را خودکار تکرار نمی‌کنیم.' : 'پرداخت هنوز تأیید نشده است؛ نتیجه را دوباره بررسی کنید.'}</p>}
    <p dir="ltr">{id}</p>{error && <p role="alert">{error}</p>}
    <Button variant="secondary" disabled={busy || payment?.status === 'succeeded'} onClick={async () => {
      setBusy(true); setError('')
      try {
        const response = await apiPost<{ data: Payment }>(`/wallets/recharges/${encodeURIComponent(id)}/verify`, {})
        if (response.data.status === 'succeeded') onVerified()
        query.refetch()
      } catch { setError('بررسی درگاه ممکن نشد؛ بعداً دوباره تلاش کنید.') }
      finally { setBusy(false) }
    }}>{busy ? 'در حال بررسی…' : 'بررسی نتیجه پرداخت'}</Button>
  </section>
}
