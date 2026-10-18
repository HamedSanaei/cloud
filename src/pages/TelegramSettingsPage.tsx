import { Link2, Unplug } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button, LinkButton } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { Input } from '../components/ui/FormControls'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { LoadingState, QueryError } from '../components/ui/States'
import { useApiQuery } from '../hooks/useApiQuery'
import { apiPost } from '../lib/apiClient'
import { getIntegrationStatus } from '../lib/platformClient'

export function TelegramSettingsPage() {
  const status = useApiQuery(getIntegrationStatus)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const perform = async (disconnect: boolean) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setResult('')
    try {
      await apiPost(`/integration/${disconnect ? 'disconnect' : 'connect'}`, disconnect ? {} : { code: code.trim() }, { timeoutMs: 50000 })
      setCode(''); setConfirm(false); status.refetch()
      window.dispatchEvent(new Event('integration-changed'))
      setResult(disconnect ? 'اعتبارنامه سایت لغو و اتصال قطع شد. دارایی و حساب تلگرام حذف نشده‌اند.' : 'حساب با موفقیت متصل شد.')
    } catch (e) { setError(e instanceof Error ? e.message : 'عملیات تکمیل نشد') }
    finally { lock.current = false; setBusy(false) }
  }
  return <div className="page-stack">
    <PageHeader title="اتصال تلگرام" subtitle="تنظیمات پنل / اتصال‌ها — مدیریت اتصال امن حساب سایت و ربات" icon={<Link2 />} actions={<LinkButton to="/settings" variant="secondary">بازگشت به تنظیمات</LinkButton>} />
    <Card>
      <SectionHeading title="وضعیت اتصال حساب" icon={<Link2 size={20} />} />
      {status.loading ? <LoadingState /> : status.error ? <QueryError message={status.error} onRetry={status.refetch} /> : !status.data?.enabled ? <p>اتصال سرویس مشترک توسط مدیر فعال نشده است.</p> : <div className="form-stack">
        <p>{status.data.linked ? 'حساب تلگرام متصل است؛ موجودی، سرورها و قیمت‌گذاری از سرویس مشترک دریافت می‌شوند.' : 'در چت خصوصی ربات دستور /website را ارسال و کد یک‌بارمصرف را وارد کنید.'}</p>
        <p className="muted-copy">قطع اتصال، دارایی‌ها را جابه‌جا نمی‌کند. اتصال مجدد فقط به همان هویت قبلی مجاز است.</p>
        <Input label="کد اتصال یک‌بارمصرف" dir="ltr" autoComplete="off" value={code} placeholder="cpl_…" disabled={busy} onChange={e => setCode(e.target.value)} />
        <div className="platform-inline">
          <Button disabled={busy || !/^cpl_[A-Za-z0-9_-]{43}$/.test(code.trim())} onClick={() => void perform(false)}>{status.data.linked ? 'جایگزینی اعتبارنامه اتصال' : 'اتصال امن حساب'}</Button>
          {status.data.linked && <Button variant="danger" icon={<Unplug size={17} />} disabled={busy} onClick={() => setConfirm(true)}>قطع اتصال (Revoke)</Button>}
        </div>
      </div>}
      {error && <p role="alert" className="platform-error">{error}</p>}
      {result && <p role="status" className="platform-result">{result}</p>}
    </Card>
    <Modal open={confirm} title="قطع اتصال تلگرام" onClose={() => { if (!busy) setConfirm(false) }}>
      <p>دسترسی این سایت به حساب مشترک لغو شود؟ حساب ربات، موجودی و سرورها باقی می‌مانند؛ برای دسترسی دوباره باید کد اتصال تازه دریافت کنید.</p>
      <div className="platform-inline"><Button variant="secondary" disabled={busy} onClick={() => setConfirm(false)}>انصراف</Button><Button variant="danger" disabled={busy} onClick={() => void perform(true)}>تأیید قطع اتصال</Button></div>
    </Modal>
  </div>
}
