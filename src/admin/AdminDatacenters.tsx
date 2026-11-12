import { useState } from 'react'
import { Link } from 'react-router-dom'
import { adminApi } from './api'
import { useApiQuery } from '../hooks/useApiQuery'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'

export function AdminDatacenters() {
  const providers = useApiQuery(adminApi.providers)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const change = async (id: string, enabled: boolean) => {
    setBusy(id); setError('')
    try { await adminApi.setProviderSales(id, enabled); providers.refetch() }
    catch { setError('ذخیره وضعیت دیتاسنتر ناموفق بود؛ دوباره تلاش کنید.') }
    finally { setBusy('') }
  }
  return <div className="page-stack admin-datacenters">
    <header><h1>مدیریت فروش دیتاسنترها</h1><p>فعال یا غیرفعال کردن خرید برای کاربران؛ مدیر همچنان می‌تواند از دیتاسنتر آمادهٔ سفارش خرید کند.</p></header>
    <p>این تنظیم روی سرورهای موجود، صورتحساب آن‌ها یا اعتبارنامه‌های ارائه‌دهنده تغییری ایجاد نمی‌کند.</p>
    {error || providers.error ? <p role="alert">{error || 'دریافت وضعیت دیتاسنترها ناموفق بود.'}</p> : null}
    {providers.loading ? <p role="status">در حال دریافت وضعیت…</p> : null}
    <div className="datacenter-admin-grid">{providers.data?.map(provider => <Card key={provider.id}>
      <img src={`/providers/${provider.id}.svg`} alt="" width="96" height="44" />
      <h2>{provider.name}</h2>
      <p>{provider.enabled ? 'خرید کاربران فعال است' : 'خرید کاربران غیرفعال است؛ فقط مدیر'}</p>
      {!provider.configured ? <p>اتصال و کاتالوگ عملیاتی باید روی سرور آماده شود؛ این کلید محدودیت فنی را دور نمی‌زند.</p> : null}
      <Button variant={provider.enabled ? 'secondary' : 'primary'} disabled={!!busy || providers.loading}
        aria-pressed={provider.enabled} onClick={() => void change(provider.id, !provider.enabled)}>
        {busy === provider.id ? 'در حال ذخیره…' : provider.enabled ? `غیرفعال کردن خرید ${provider.name}` : `فعال کردن خرید ${provider.name}`}
      </Button>
    </Card>)}</div>
    <Link to="/servers/create">خرید سرور با حساب مدیر</Link>
  </div>
}
