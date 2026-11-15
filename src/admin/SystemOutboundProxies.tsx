import { useState } from 'react'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input, Select, Toggle } from '../components/ui/FormControls'
import { useApiQuery } from '../hooks/useApiQuery'
import { apiGet, apiPost } from '../lib/apiClient'
import { useSensitive } from './SystemSettings'
import type { OutboundIntegration, OutboundStatus, OutboundTestResult, PublicProxyProfile, ProxyType, OutboundRoute } from '../../backend/src/contracts/outbound'
import './outbound-proxies.css'

const base = '/admin/settings/outbound'
const names: Record<OutboundIntegration, string> = { hetzner: 'هتزنر', leaseweb: 'لیزوب', parsgreen: 'پارس‌گرین (پیامک)', tabapay: 'تاباپی (پرداخت)', abantether: 'آبان‌تتر (نرخ ارز)' }
const categories = { none: 'موفق', policy: 'مقصد غیرمجاز', configuration: 'تنظیمات ناقص یا پراکسی غیرفعال', timeout: 'پایان مهلت اتصال', authentication: 'نیازمند بررسی اعتبارنامهٔ سرویس', dns: 'خطای یافتن نشانی میزبان', tls: 'خطای اعتبار گواهی TLS', unreachable: 'اتصال برقرار نشد', upstream: 'پاسخ ناموفق سرویس' }
const routeNames = { direct: 'مستقیم', proxy: 'پراکسی', 'direct-fallback': 'بازگشت مجاز به مسیر مستقیم', blocked: 'مسدود؛ پراکسی در دسترس نیست' }
const blank = { id: '', name: '', type: 'socks5' as ProxyType, host: '', port: '1080', timeoutMs: '10000', enabled: false, username: '', password: '', clearCredentials: false }

function TestResult({ result, revision }: { result: OutboundTestResult | null; revision: string }) {
  if (!result) return <p className="outbound-muted">هنوز آزمایش نشده است.</p>
  return <div className="outbound-test" role="status">
    <strong>{result.ok ? 'آزمایش موفق' : 'آزمایش ناموفق'} · {routeNames[result.route]}</strong>
    <span>{categories[result.category]}{result.httpStatus ? ` · HTTP ${result.httpStatus}` : ''} · {result.latencyMs} ms</span>
    <small>زمان آزمایش: {new Date(result.testedAt).toLocaleString('fa-IR')}</small>
    <small>آخرین موفقیت: {result.lastSuccessAt ? new Date(result.lastSuccessAt).toLocaleString('fa-IR') : 'ثبت نشده'}</small>
    {result.revision !== revision ? <small>تنظیمات پس از این آزمایش تغییر کرده؛ دوباره آزمایش کنید.</small> : null}
  </div>
}

export function SystemOutboundProxies() {
  const query = useApiQuery(async () => (await apiGet<{ data: OutboundStatus }>(base)).data)
  const sensitive = useSensitive()
  const [draft, setDraft] = useState(blank), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [testIntegration, setTestIntegration] = useState<OutboundIntegration>('hetzner')
  const [testResult, setTestResult] = useState<OutboundTestResult | null>(null)
  const run = (action: string, path: string, payload: object, after?: (value: unknown) => void) => {
    sensitive(action, payload, 'تغییر تنظیمات اتصال خروجی یا آزمایش غیرمخرب مقصد مجاز.', async proof => {
      setBusy(true); setNotice('')
      try {
        const result = await apiPost<{ data: unknown }>(base + path, { ...payload, proof })
        after?.(result.data); query.refetch(); setNotice('عملیات انجام شد.')
      } finally { setBusy(false) }
    })
  }
  const edit = (profile: PublicProxyProfile) => setDraft({ ...blank, ...profile, port: String(profile.port), timeoutMs: String(profile.timeoutMs), username: '', password: '' })
  const data = query.data
  if (query.loading && !data) return <p role="status">در حال دریافت تنظیمات شبکه…</p>
  if (query.error || !data) return <Card><p role="alert">{query.error || 'تنظیمات دریافت نشد.'}</p><Button onClick={query.refetch}>تلاش مجدد</Button></Card>
  const current = data.profiles.find(p => p.id === draft.id)
  const test = (integration: OutboundIntegration, profileId?: string) => run('outbound.test', '/test', { revision: data.revision, integration, ...(profileId ? { profileId } : {}), confirm: true }, value => setTestResult(value as OutboundTestResult))
  return <div className="page-stack outbound-panel">
    <Card><h2>شبکه و پراکسی خروجی</h2><p>پیش‌فرض تمام سرویس‌ها اتصال مستقیم است. فعال‌کردن پروفایل به‌تنهایی مسیر را تغییر نمی‌دهد؛ آن را جداگانه به سرویس اختصاص دهید.</p>
      <p>این قابلیت فقط اتصال سرور به APIهای مشخص را تغییر می‌دهد. آزمون‌ها سفارش، پیامک یا تراکنش نمی‌سازند. اعتبار گواهی‌های TLS همیشه بررسی می‌شود.</p>
      <p role="status">{notice}</p>
    </Card>
    <Card><h2>{draft.id ? 'ویرایش پراکسی' : 'پراکسی جدید'}</h2>
      <form className="form-stack" onSubmit={event => {
        event.preventDefault()
        const payload = { revision: data.revision, ...(draft.id ? { id: draft.id } : {}), name: draft.name, type: draft.type, host: draft.host,
          port: Number(draft.port), timeoutMs: Number(draft.timeoutMs), enabled: draft.enabled, confirm: true,
          ...(draft.clearCredentials ? { clearCredentials: true } : { ...(draft.username ? { username: draft.username } : {}), ...(draft.password ? { password: draft.password } : {}) }) }
        run('outbound.profile', '/profiles', payload, () => setDraft(blank))
      }}>
        <div className="outbound-fields">
          <Input label="نام پروفایل" required maxLength={80} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
          <Select label="نوع پراکسی" value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value as ProxyType })}><option value="socks5">SOCKS5 (DNS راه دور)</option><option value="http">HTTP CONNECT</option><option value="https">HTTPS CONNECT</option></Select>
          <Input label="میزبان عمومی پراکسی" dir="ltr" required maxLength={253} value={draft.host} onChange={e => setDraft({ ...draft, host: e.target.value })} placeholder="proxy.example.net" />
          <Input label="پورت" dir="ltr" type="number" required min={1} max={65535} value={draft.port} onChange={e => setDraft({ ...draft, port: e.target.value })} />
          <Input label="مهلت اتصال (میلی‌ثانیه)" dir="ltr" type="number" required min={1000} max={30000} value={draft.timeoutMs} onChange={e => setDraft({ ...draft, timeoutMs: e.target.value })} />
          <Input label="نام کاربری جدید (اختیاری)" dir="ltr" autoComplete="off" disabled={draft.clearCredentials} value={draft.username} onChange={e => setDraft({ ...draft, username: e.target.value })} />
          <Input label="رمز جدید (اختیاری)" dir="ltr" type="password" autoComplete="new-password" disabled={draft.clearCredentials} value={draft.password} onChange={e => setDraft({ ...draft, password: e.target.value })} />
        </div>
        {current?.authenticated ? <p>اعتبارنامه ذخیره شده است: ••••••••. خالی‌ماندن فیلدها آن را حفظ می‌کند.</p> : null}
        {draft.id ? <Toggle label="حذف اعتبارنامهٔ ذخیره‌شده" checked={draft.clearCredentials} onChange={clearCredentials => setDraft({ ...draft, clearCredentials })} /> : null}
        <Toggle label="فعال‌بودن پروفایل" checked={draft.enabled} onChange={enabled => setDraft({ ...draft, enabled })} />
        <p>اگر پروفایلِ یک مسیر فعال را غیرفعال کنید، درخواست‌ها مسدود می‌شوند؛ برای اتصال مستقیم، مسیر آن سرویس را صریحاً غیرفعال کنید.</p>
        <div className="outbound-actions"><Button type="submit" disabled={busy}>ذخیرهٔ پراکسی</Button>{draft.id ? <Button variant="secondary" onClick={() => setDraft(blank)}>انصراف از ویرایش</Button> : null}</div>
      </form>
    </Card>
    <Card><h2>پروفایل‌ها</h2>
      <Select label="مقصد مجاز برای آزمون پراکسی" value={testIntegration} onChange={e => setTestIntegration(e.target.value as OutboundIntegration)}>{Object.entries(names).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select>
      <div className="outbound-grid">{data.profiles.map(profile => <article className="outbound-profile" key={profile.id}>
        <h3>{profile.name}</h3><p dir="ltr">{profile.type.toUpperCase()} · {profile.host}:{profile.port}</p>
        <p>{profile.enabled ? 'فعال' : 'غیرفعال'} · {profile.authenticated ? 'اعتبارنامه: ••••••••' : 'بدون اعتبارنامه'}</p>
        <TestResult result={profile.lastTest} revision={data.revision} />
        <div className="outbound-actions"><Button variant="secondary" disabled={busy} onClick={() => edit(profile)}>ویرایش {profile.name}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => test(testIntegration, profile.id)}>آزمون پراکسی {profile.name}</Button>
          <Button variant="danger" disabled={busy || data.integrations.some(i => i.route.enabled && i.route.profileId === profile.id)} onClick={() => {
            if (window.confirm(`پروفایل «${profile.name}» حذف شود؟`)) run('outbound.delete', '/profiles/delete', { revision: data.revision, id: profile.id, confirm: true }, () => { if (draft.id === profile.id) setDraft(blank) })
          }}>حذف {profile.name}</Button></div>
      </article>)}</div>
      {!data.profiles.length ? <p>هنوز پراکسی تعریف نشده است؛ همهٔ سرویس‌ها مستقیم متصل می‌شوند.</p> : null}
    </Card>
    <Card><h2>مسیر سرویس‌ها</h2><p>با فعال بودن پراکسی هتزنر، API و کنسول فقط از همان پراکسی استفاده می‌کنند. برای سرویس‌های دیگر، بازگشت مستقیم فقط با انتخاب صریح و برای GET/HEAD مجاز است.</p>
      <div className="outbound-grid">{data.integrations.map(integration => <IntegrationRoute key={`${integration.id}:${data.revision}`} integration={integration} profiles={data.profiles} revision={data.revision} busy={busy}
        consoleHealth={data.hetznerConsole}
        save={route => run('outbound.route', '/routes', { revision: data.revision, integration: integration.id, ...route, confirm: true })}
        test={() => test(integration.id)} />)}</div>
    </Card>
    {testResult ? <Card><h2>نتیجهٔ آخرین آزمون: {names[testResult.integration]}</h2><TestResult result={testResult} revision={data.revision} /></Card> : null}
  </div>
}

function IntegrationRoute({ integration, profiles, revision, busy, consoleHealth, save, test }: {
  integration: OutboundStatus['integrations'][number]; profiles: PublicProxyProfile[]; revision: string; busy: boolean
  consoleHealth?: OutboundStatus['hetznerConsole']
  save: (route: OutboundRoute) => void; test: () => void
}) {
  const hetzner = integration.id === 'hetzner'
  const [route, setRoute] = useState(hetzner ? { ...integration.route, failurePolicy: 'closed' as const } : integration.route)
  const profile = profiles.find(p => p.id === integration.active.profileId)
  const latest = consoleHealth?.latest
  const failure = consoleHealth?.lastFailure
  return <article className="outbound-profile"><h3>{names[integration.id]}</h3>
    <p>مسیر فعلی: {routeNames[integration.active.route]}{profile ? ` · ${profile.name}` : ''}</p>
    <form className="form-stack" onSubmit={e => { e.preventDefault(); save(route) }}>
      <Select label={`پراکسی ${names[integration.id]}`} value={route.profileId ?? ''} onChange={e => setRoute({ ...route, profileId: e.target.value || null, enabled: !!e.target.value })}>
        <option value="">مستقیم (Direct)</option>{profiles.map(p => <option key={p.id} value={p.id} disabled={!p.enabled}>{p.name}{!p.enabled ? ' (غیرفعال)' : ''}</option>)}
      </Select>
      <Toggle label={`فعال‌بودن مسیر پراکسی ${names[integration.id]}`} checked={route.enabled} onChange={enabled => setRoute({ ...route, enabled })} />
      {!hetzner && <Select label={`سیاست خطای ${names[integration.id]}`} value={route.failurePolicy} onChange={e => setRoute({ ...route, failurePolicy: e.target.value as OutboundRoute['failurePolicy'] })}>
        <option value="closed">مسدود در خطا (پیشنهادی)</option><option value="read-only-direct">بازگشت مستقیم فقط برای خواندن</option>
      </Select>}
      <div className="outbound-actions"><Button type="submit" disabled={busy || route.enabled && !route.profileId}>ذخیرهٔ مسیر {names[integration.id]}</Button><Button variant="secondary" disabled={busy} onClick={test}>آزمون اتصال {names[integration.id]}</Button></div>
    </form><TestResult result={integration.lastTest} revision={revision} />
    {hetzner && <div className="outbound-test" role="status">
      <strong>آخرین اتصال کنسول</strong>
      {latest ? <>
        <span>{routeNames[latest.route]} · {categories[latest.category]} · {latest.latencyMs} ms</span>
        {latest.category !== 'none' && <code>{latest.category}</code>}
        <small>{new Date(latest.checkedAt).toLocaleString('fa-IR')}</small>
        {latest.revision !== revision && <small>تنظیمات پس از این اتصال تغییر کرده است.</small>}
      </> : <span>هنوز اتصالی ثبت نشده است.</span>}
      {failure && latest?.category === 'none' && <small>آخرین خطا: {categories[failure.category]} (<code>{failure.category}</code>) · {failure.latencyMs} ms · {new Date(failure.checkedAt).toLocaleString('fa-IR')}</small>}
    </div>}
  </article>
}
