import { ShieldCheck } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { Input, Select } from '../components/ui/FormControls'
import { PageHeader } from '../components/ui/PageHeader'
import { LoadingState, QueryError } from '../components/ui/States'
import { useApiQuery } from '../hooks/useApiQuery'
import { platformGet, platformPost } from '../lib/platformClient'

const loadAccount = () => platformGet<{ superadmin: boolean }>('/account')
export function PlatformAdminPage() {
  const account = useApiQuery(loadAccount)
  const [users, setUsers] = useState<Array<{ id: string; username: string }>>([])
  const [target, setTarget] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const key = useRef(crypto.randomUUID())
  const lock = useRef(false)
  const perform = async (work: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setResult('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : 'عملیات تکمیل نشد') }
    finally { lock.current = false; setBusy(false) }
  }
  return <div className="page-stack">
    <PageHeader title="مدیریت پلتفرم" subtitle="تنظیمات پنل / دسترسی‌های مدیریتی مشترک" icon={<ShieldCheck />} />
    {account.loading ? <LoadingState /> : account.error ? <QueryError message={account.error} onRetry={account.refetch} /> : !account.data?.superadmin ? <Card><p>این بخش فقط برای سوپرادمین تأییدشده در سرویس مرجع در دسترس است.</p></Card> : <>
      <Card><SectionHeading title="سرور آزمایشی سوپرادمین‌ها" /><p>شناسایی leaseweb-test فقط هویت سرور موجود را تطبیق می‌دهد و عملیات برق یا نصب اجرا نمی‌کند. مدیریت و نتیجه عملیات از صفحه سرورها در دسترس است.</p><Button disabled={busy} onClick={() => void perform(async () => { await platformPost('/admin/test-server/register', {}); setResult('سرور آزمایشی شناسایی و به فهرست سرورها اضافه شد.') })}>شناسایی سرور آزمایشی</Button></Card>
      <Card><SectionHeading title="مدیریت موجودی مشترک کاربران" />
        <Button disabled={busy} onClick={() => void perform(async () => setUsers(await platformGet('/admin/users')))}>دریافت کاربران</Button>
        <form className="form-stack" onSubmit={e => { e.preventDefault(); void perform(async () => {
          const value = Number(amount)
          if (!Number.isSafeInteger(value) || value === 0 || !target || reason.trim().length < 4) throw new Error('کاربر، مبلغ صحیح غیرصفر و دلیل معتبر وارد کنید')
          await platformPost(`/admin/users/${target}/wallet-adjustments`, { amountMinor: value, reason: reason.trim() }, key.current)
          setAmount(''); setReason(''); key.current = crypto.randomUUID(); setResult('اصلاح حسابرسی‌شده ثبت شد و برای کاربر اعلان ارسال می‌شود.')
        }) }}>
          <Select label="کاربر" value={target} disabled={busy} onChange={e => { setTarget(e.target.value); key.current = crypto.randomUUID() }}><option value="">انتخاب کنید</option>{users.map(user => <option key={user.id} value={user.id}>{user.username || user.id}</option>)}</Select>
          <Input label="اصلاح موجودی (تومان؛ منفی برای کسر)" inputMode="numeric" value={amount} disabled={busy} onChange={e => { setAmount(e.target.value); key.current = crypto.randomUUID() }} />
          <Input label="دلیل اصلاح" value={reason} disabled={busy} onChange={e => { setReason(e.target.value); key.current = crypto.randomUUID() }} />
          <Button type="submit" disabled={busy || !target || !amount || reason.trim().length < 4}>ثبت اصلاح حسابرسی‌شده</Button>
        </form>
      </Card>
    </>}
    {error && <p className="platform-error" role="alert">{error}</p>}{result && <p className="platform-result" role="status">{result}</p>}
  </div>
}
